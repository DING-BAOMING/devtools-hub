// Cloudflare Pages Function: AI Video Generator (text-to-video / image-to-video)
// POST /api/text-to-video   { action: "create"|"poll", ... }
// KV-stored job in FEEDBACK_KV with prefix "t2v:" (reuses the same global
// "video-rpm-lock" as story-job so Agnes Video RPM 1 is shared across tools).
//
// Verified against the live Agnes API (2026-08-11):
//  - create: POST /v1/videos { model:"agnes-video-v2.0", prompt, num_frames, frame_rate, ratio, image? }
//            returns { video_id }; may return 503 {"code":"video_queue_full"} → retry with backoff
//  - poll:   GET /agnesapi?video_id=... → { status:"pending"|"in_progress"|"completed"|"failed", progress, url }
//            completed carries "url" (the MP4 on platform-outputs.agnes-ai.space).
//            Polling too fast returns 429 {"code":429,"message":"video status query rate limit exceeded"}.
//  - url field: "url" (NOT remixed_from_video_id) for single-shot jobs.

const KV_PREFIX = 't2v:';
const KV_VIDEO_LOCK = 'video-rpm-lock'; // shared with story-job
const JOB_TTL_SECONDS = 6 * 60 * 60;
const VIDEO_RPM_COOLDOWN_SEC = 62; // Agnes video RPM 1 = 60s + 1s buffer
const FETCH_TIMEOUT_MS = 24000;
const CREATE_BUDGET_MS = 23000; // includes queue-full retry backoffs + create call
const POLL_BUDGET_MS = 23000;

const RATIOS = ['16:9', '9:16', '1:1', '4:3'];
// num_frames = 8n + 1 → ~2s/3.4s/5s at 24fps (verified 81 & 121 accepted)
const FRAME_PRESETS = { '2s': 49, '3s': 81, '5s': 121 };

class AgnesError extends Error {
  constructor(msg, status, retryAfter) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(v) {
  if (!v) return 60;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function agnesKey(env) {
  return env.DEVTOOLS_AGNES_KEY_1 || env.DEVTOOLS_AGNES_KEY_2;
}

async function agnesVideoCreate(prompt, opts, env) {
  const apiKey = agnesKey(env);
  if (!apiKey) throw new AgnesError('No Agnes API key configured', 500);
  const body = {
    model: 'agnes-video-v2.0',
    prompt,
    num_frames: opts.numFrames || 81,
    frame_rate: 24,
    ratio: opts.ratio || '16:9'
  };
  if (opts.imageUrl) body.image = opts.imageUrl;
  const r = await fetchWithTimeout('https://apihub.agnes-ai.com/v1/videos', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429) throw new AgnesError('Agnes video create 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes video create ${r.status}: ${text.slice(0, 200)}`, r.status, r.status === 503 ? 15 : undefined);
  }
  const d = await r.json();
  if (!d.video_id) throw new AgnesError('Agnes video create: no video_id', 502);
  return d.video_id;
}

async function agnesVideoPoll(videoId, env) {
  const apiKey = agnesKey(env);
  if (!apiKey) throw new AgnesError('No Agnes API key configured', 500);
  const r = await fetchWithTimeout(`https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
  if (r.status === 429) throw new AgnesError('Agnes video poll 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes video poll ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  return r.json();
}

async function acquireVideoLock(kv) {
  const now = Date.now();
  const lastRaw = await kv.get(KV_VIDEO_LOCK);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (!Number.isFinite(last) || last <= 0) {
    await kv.put(KV_VIDEO_LOCK, String(now), { expirationTtl: 300 });
    return { acquired: true };
  }
  const elapsed = (now - last) / 1000;
  if (elapsed < VIDEO_RPM_COOLDOWN_SEC) {
    return { acquired: false, waitSec: Math.ceil(VIDEO_RPM_COOLDOWN_SEC - elapsed) };
  }
  await kv.put(KV_VIDEO_LOCK, String(now), { expirationTtl: 300 });
  return { acquired: true };
}

async function releaseVideoLockOnFail(kv) {
  try {
    const now = Date.now();
    const lastRaw = await kv.get(KV_VIDEO_LOCK);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    if (!Number.isFinite(last) || last <= 0) return;
    const elapsed = (now - last) / 1000;
    if (elapsed < VIDEO_RPM_COOLDOWN_SEC) {
      await kv.put(KV_VIDEO_LOCK, '0', { expirationTtl: 60 });
    }
  } catch (e) { /* best-effort */ }
}

async function getJob(kv, jobId) {
  try {
    const raw = await kv.get(KV_PREFIX + jobId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function putJob(kv, job) {
  await kv.put(KV_PREFIX + job.id, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

// Basic SSRF guard for the optional image-to-video URL: https only, no
// localhost / private / reserved hosts, sane length. Agnes fetches the URL
// server-side so we minimize abuse surface.
function isValidImageUrl(u) {
  if (typeof u !== 'string' || u.length < 12 || u.length > 2000) return false;
  let url;
  try { url = new URL(u); } catch (e) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^0\./.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // raw IP
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata.google.internal') return false;
  return true;
}

function makeJobId() {
  return 't2v_' + Date.now() + '_' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(36).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK_KV;
  let body;
  try { body = await request.json(); } catch { return jerr(400, 'invalid_json'); }
  const { action } = body;

  try {
    if (action === 'create') {
      const { prompt, ratio, duration, imageUrl } = body;
      if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > 2000) {
        return jerr(400, 'prompt_10_to_2000_chars');
      }
      const safeRatio = RATIOS.includes(ratio) ? ratio : '16:9';
      const safeFrames = FRAME_PRESETS[duration] || 81;
      let safeImage = null;
      if (imageUrl) {
        if (!isValidImageUrl(imageUrl)) return jerr(400, 'invalid_image_url_https_only');
        safeImage = imageUrl.trim();
      }

      // Per-IP rate limit on create (protect API quota): 4 creates / 5 min
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const rlKey = 'rl-t2v-create:' + ip;
      const cur = parseInt((await kv.get(rlKey)) || '0', 10);
      const n = (Number.isFinite(cur) ? cur : 0) + 1;
      await kv.put(rlKey, String(n), { expirationTtl: 300 });
      if (n > 4) return jerr(429, 'rate_limited_too_many_videos_in_5min');

      // Global Agnes video RPM 1 lock (shared with story-job)
      const lock = await acquireVideoLock(kv);
      if (!lock.acquired) {
        return jok({ code: 'cooldown', waitSec: lock.waitSec, message: 'waiting_for_video_rpm' });
      }

      let videoId = null;
      let lastErr = null;
      const deadline = Date.now() + CREATE_BUDGET_MS;
      try {
        // Retry queue-full (503) with backoff until budget runs out (max ~2 retries)
        for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
          try {
            videoId = await agnesVideoCreate(prompt.trim(), { ratio: safeRatio, numFrames: safeFrames, imageUrl: safeImage }, env);
            break;
          } catch (e) {
            lastErr = e;
            if (e instanceof AgnesError && e.status === 503 && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, Math.min(8000, deadline - Date.now())));
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        if (e instanceof AgnesError && e.status === 429) {
          try { await releaseVideoLockOnFail(kv); } catch (e2) {}
          return jok({ code: 'rate_limited', waitSec: e.retryAfter || 60, message: e.message });
        }
        if (lastErr) {
          try { await releaseVideoLockOnFail(kv); } catch (e2) {}
          return jok({ code: 'queue_full', message: lastErr.message.slice(0, 200), retryAfter: 30 });
        }
        return jerr(500, 'create_failed: ' + String(e).slice(0, 300));
      }

      if (!videoId) {
        try { await releaseVideoLockOnFail(kv); } catch (e2) {}
        return jok({ code: 'queue_full', message: 'queue_still_full_after_retries', retryAfter: 30 });
      }

      const job = {
        id: makeJobId(),
        createdAt: Date.now(),
        prompt: prompt.trim().slice(0, 2000),
        ratio: safeRatio,
        duration: duration || '3s',
        imageUrl: safeImage,
        videoId,
        status: 'pending',
        progress: 0,
        videoUrl: null,
        error: null
      };
      await putJob(kv, job);
      return jok({ jobId: job.id, videoId, job });
    }

    if (action === 'poll') {
      const { jobId } = body;
      if (!jobId || typeof jobId !== 'string' || !/^t2v_[A-Za-z0-9_]+$/.test(jobId)) {
        return jerr(400, 'invalid_job_id');
      }
      const job = await getJob(kv, jobId);
      if (!job) return jerr(404, 'job_not_found');
      if (job.status === 'completed') return jok({ job, done: true });

      try {
        const d = await agnesVideoPoll(job.videoId, env);
        job.status = d.status || job.status;
        job.progress = Number.isFinite(d.progress) ? d.progress : job.progress;
        if (d.status === 'completed') {
          // Verified: completed carries "url", fallback to legacy field
          job.videoUrl = (d.url && typeof d.url === 'string' && d.url.startsWith('https://')) ? d.url : (d.remixed_from_video_id || null);
          job.status = 'completed';
          job.progress = 100;
          await putJob(kv, job);
          return jok({ job, done: true });
        }
        if (d.status === 'failed') {
          job.error = JSON.stringify(d.error || d).slice(0, 300);
          job.status = 'failed';
          await putJob(kv, job);
          return jok({ job, done: true });
        }
        await putJob(kv, job);
        return jok({ job, done: false });
      } catch (e) {
        if (e instanceof AgnesError && e.status === 429) {
          return jok({ job, done: false, rate_limited: true, waitSec: e.retryAfter || 8, error: e.message });
        }
        return jerr(502, 'poll_failed: ' + String(e).slice(0, 300));
      }
    }

    if (action === 'get') {
      const { jobId } = body;
      const job = jobId && /^t2v_[A-Za-z0-9_]+$/.test(jobId) ? await getJob(kv, jobId) : null;
      if (!job) return jerr(404, 'job_not_found');
      return jok({ job });
    }

    // Health/status helper (client uses it to show RPM cooldown)
    if (action === 'status') {
      const lastRaw = await kv.get(KV_VIDEO_LOCK);
      const last = lastRaw ? parseInt(lastRaw, 10) : 0;
      const elapsed = (Number.isFinite(last) && last > 0) ? (Date.now() - last) / 1000 : Infinity;
      return jok({
        canCreate: !(Number.isFinite(last) && last > 0) || elapsed >= VIDEO_RPM_COOLDOWN_SEC,
        cooldownSec: Number.isFinite(last) && last > 0 && elapsed < VIDEO_RPM_COOLDOWN_SEC ? Math.ceil(VIDEO_RPM_COOLDOWN_SEC - elapsed) : 0
      });
    }

    return jerr(400, 'unknown_action');
  } catch (e) {
    return jerr(500, 'internal_error: ' + String(e).slice(0, 300));
  }
}

export async function onRequestGet() {
  return jok({ status: 'ok', endpoint: 'text-to-video' });
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

function jok(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
function jerr(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}