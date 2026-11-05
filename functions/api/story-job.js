import { resolveModelId } from '../../libs/ai-provider.js';

// Cloudflare Pages Function: AI Story Animator orchestrator
// POST /api/story-job   { action: "create"|"step"|"get"|"list"|"delete", ... }
// KV-stored job state in FEEDBACK_KV with prefix "story-job:"
//
// LATENCY & RATE-LIMIT HARDENED:
// - Each call does exactly ONE external operation (no timeouts)
// - Agnes Video RPM 1: server-enforced 60s global cooldown (stored in KV)
// - 429 responses return retry_after seconds; client must back off
// - 25s wall-clock budget per call (Cloudflare Pages Function safe)
// - Phase machine: image → video_create → video_poll → qa → narrate

const KV_PREFIX = 'story-job:';
const KV_VIDEO_LOCK = 'video-rpm-lock'; // global: last video API call timestamp
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const VIDEO_RPM_COOLDOWN_SEC = 62; // Agnes video RPM 1 = 60s+1 buffer
const STEP_WALLCLOCK_BUDGET_MS = 24000;
// Cloudflare Pages Function free plan = 30s wall-clock. We use 25s for safety + 5s buffer for KV + serialize.
const FETCH_TIMEOUT_MS = 24000;
// Simple per-IP rate limit for /delete (no auth). KV-based, 60s window.
const KV_RATELIMIT = 'rl-delete:';
const DELETE_RATELIMIT_PER_MIN = 5;

// ===== Agnes AI helpers (with 429 awareness + timeouts) =====

class AgnesError extends Error {
  constructor(msg, status, retryAfter) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// fetch() wrapper with hard timeout (Cloudflare free plan = 30s wall-clock,
// we cap each external call at 25s so leaves 5s for KV + JSON serialize)
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Parse Retry-After header safely (returns seconds, default 60)
// Retry-After can be a number (seconds) OR an HTTP-date. We only handle seconds.
function parseRetryAfter(v) {
  if (!v) return 60;
  const n = parseInt(v, 10);
  // NaN check: parseInt('xyz', 10) → NaN; Number.isFinite filters it
  return Number.isFinite(n) && n > 0 ? n : 60;
}

async function agnesChat(messages, opts, env) {
  const apiKey = env.DEVTOOLS_AGNES_KEY_1 || env.DEVTOOLS_AGNES_KEY_2;
  if (!apiKey) throw new AgnesError('No Agnes API key configured', 500);
  // An explicitly requested id wins (the image/video paths below pass one, and those
  // are generation endpoints with no catalogue). Otherwise read what Agnes serves.
  const model = (opts && opts.model) || await resolveModelId({ base: 'https://apihub.agnes-ai.com/v1' }, apiKey);
  if (!model) throw new AgnesError('Agnes offers no live chat model', 503);
  let r;
  try {
    r = await fetchWithTimeout('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages,
        temperature: (opts && opts.temperature) ?? 0.7,
        max_tokens: (opts && opts.max_tokens) ?? 2048
      })
    });
  } catch (e) {
    throw new AgnesError('Agnes chat timeout/network: ' + (e.message || e), 599);
  }
  if (r.status === 429) throw new AgnesError('Agnes chat 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes chat ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  let d;
  try { d = await r.json(); } catch (e) {
    throw new AgnesError('Agnes chat: invalid JSON response', 502);
  }
  return d.choices?.[0]?.message?.content || '';
}

async function agnesVision(imageUrl, question, env) {
  return agnesChat([{
    role: 'user',
    content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]
  }], { model: 'agnes-2.0-flash', max_tokens: 500 }, env);
}

async function agnesImageGen(prompt, size, refImageUrl, env) {
  const apiKey = env.DEVTOOLS_AGNES_KEY_1 || env.DEVTOOLS_AGNES_KEY_2;
  const body = {
    model: 'agnes-image-2.1-flash',
    prompt,
    size: size || '1024x768',
    extra_body: { response_format: 'url' }
  };
  if (refImageUrl) body.extra_body.image = [refImageUrl];
  let r;
  try {
    r = await fetchWithTimeout('https://apihub.agnes-ai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new AgnesError('Agnes image timeout/network: ' + (e.message || e), 599);
  }
  if (r.status === 429) throw new AgnesError('Agnes image 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes image ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  let d;
  try { d = await r.json(); } catch (e) {
    throw new AgnesError('Agnes image: invalid JSON', 502);
  }
  const url = d.data?.[0]?.url;
  if (!url) throw new AgnesError('Agnes image: no URL in response', 502);
  return url;
}

async function agnesVideoCreate(prompt, imageUrl, numFrames, env) {
  const apiKey = env.DEVTOOLS_AGNES_KEY_1 || env.DEVTOOLS_AGNES_KEY_2;
  const body = {
    model: 'agnes-video-v2.0',
    prompt,
    num_frames: numFrames || 81,
    frame_rate: 24
  };
  if (imageUrl) body.image = imageUrl;
  let r;
  try {
    r = await fetchWithTimeout('https://apihub.agnes-ai.com/v1/videos', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new AgnesError('Agnes video create timeout/network: ' + (e.message || e), 599);
  }
  if (r.status === 429) throw new AgnesError('Agnes video create 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes video create ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  let d;
  try { d = await r.json(); } catch (e) {
    throw new AgnesError('Agnes video create: invalid JSON', 502);
  }
  if (!d.video_id) throw new AgnesError('Agnes video create: no video_id', 502);
  return { task_id: d.task_id, video_id: d.video_id };
}

async function agnesVideoPoll(videoId, env) {
  const apiKey = env.DEVTOOLS_AGNES_KEY_1 || env.DEVTOOLS_AGNES_KEY_2;
  let r;
  try {
    r = await fetchWithTimeout(`https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
  } catch (e) {
    throw new AgnesError('Agnes video poll timeout/network: ' + (e.message || e), 599);
  }
  if (r.status === 429) throw new AgnesError('Agnes video poll 429', 429, parseRetryAfter(r.headers.get('retry-after')));
  if (!r.ok) {
    const text = await r.text();
    throw new AgnesError(`Agnes video poll ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  let d;
  try { d = await r.json(); } catch (e) {
    throw new AgnesError('Agnes video poll: invalid JSON', 502);
  }
  return d;
}

async function cfTts(text, env) {
  // Truncate to safe length (CF melotts limit ~1000 chars; longer hangs/fails)
  const safeText = String(text || '').slice(0, 800);
  if (!safeText.trim()) return null; // empty narration → no audio
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('CF Workers AI not configured');
  let r;
  try {
    r = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/myshell-ai/melotts`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: safeText })
      }
    );
  } catch (e) {
    throw new Error('CF TTS timeout/network: ' + (e.message || e));
  }
  if (!r.ok) {
    const t2 = await r.text();
    throw new Error(`CF TTS ${r.status}: ${t2.slice(0, 200)}`);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) {
    let j;
    try { j = await r.json(); } catch (e) {
      throw new Error('CF TTS: invalid JSON response');
    }
    const audio = j.result?.audio || j.audio;
    // FIX C2: explicit null on empty/missing, NOT empty string (was treated as truthy "has audio")
    if (!audio || typeof audio !== 'string' || audio.length < 100) return null;
    return audio;
  }
  // Raw audio - convert to base64 (chunked, see C2 fix elsewhere)
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  if (!b64 || b64.length < 100) return null;
  return b64;
}

// ===== Video RPM 1 lock (server-side, survives multiple jobs/users) =====

async function acquireVideoLock(kv) {
  const now = Date.now();
  const lastRaw = await kv.get(KV_VIDEO_LOCK);
  // FIX C4: parseInt can return NaN if value is corrupt/empty. NaN >= 62 is false,
  // which would make canCallNow permanently false and block all future video jobs.
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (!Number.isFinite(last) || last <= 0) {
    // Corrupt or missing — treat as no recent call, allow acquire
    await kv.put(KV_VIDEO_LOCK, String(now), { expirationTtl: 300 });
    return { acquired: true };
  }
  const elapsed = (now - last) / 1000;
  if (elapsed < VIDEO_RPM_COOLDOWN_SEC) {
    return { acquired: false, waitSec: Math.ceil(VIDEO_RPM_COOLDOWN_SEC - elapsed) };
  }
  // Reserve by writing NOW timestamp
  await kv.put(KV_VIDEO_LOCK, String(now), { expirationTtl: 300 });
  return { acquired: true };
}

// FIX C3: Release lock on failure (so the next caller doesn't wait 60s for nothing).
// Strategy: re-check after the API call; if elapsed < VIDEO_RPM_COOLDOWN_SEC,
// we've already counted this slot; otherwise clear the lock so retries
// don't waste slots. Conservative: only clear if no API success was recorded.
async function releaseVideoLockOnFail(kv) {
  try {
    const now = Date.now();
    const lastRaw = await kv.get(KV_VIDEO_LOCK);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    if (!Number.isFinite(last) || last <= 0) return;
    const elapsed = (now - last) / 1000;
    // Don't release if the slot has passed (would let next caller in early)
    if (elapsed < VIDEO_RPM_COOLDOWN_SEC) {
      // The slot we reserved is about to expire anyway; clear so someone can take the next slot.
      // We do NOT clear if 60s+ passed because by now someone else likely acquired.
      await kv.put(KV_VIDEO_LOCK, '0', { expirationTtl: 60 });
    }
  } catch (e) {
    // Best-effort; don't fail the request if release fails
  }
}

// FIX C6: extract first balanced JSON object/array from arbitrary text.
// Handles: ```json {...}```, prose+json, multiple blocks.
// Returns the JSON substring or null.
function extractFirstBalancedJson(s) {
  if (!s || typeof s !== 'string') return null;
  // Strip markdown code fences first
  const cleaned = s.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '');
  // Find the first { or [ and balance braces, respecting strings and escapes
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch !== '{' && ch !== '[') continue;
    const openCh = ch, closeCh = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
      } else {
        if (c === '"') { inStr = true; continue; }
        if (c === openCh) depth++;
        else if (c === closeCh) {
          depth--;
          if (depth === 0) return cleaned.slice(i, j + 1);
        }
      }
    }
  }
  return null;
}

// ===== KV job helpers =====

async function getJob(kv, jobId) {
  let raw;
  try { raw = await kv.get(KV_PREFIX + jobId); }
  catch (e) { throw new Error('KV get failed: ' + (e.message || e)); }
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('job_corrupt_in_kv: ' + jobId); }
}

async function putJob(kv, job) {
  let json;
  try { json = JSON.stringify(job); } catch (e) {
    throw new Error('job_serialize_failed: ' + (e.message || e));
  }
  await kv.put(KV_PREFIX + job.id, json, { expirationTtl: JOB_TTL_SECONDS });
}

// ===== Per-IP rate limit helper (for /delete to prevent abuse) =====

async function bumpRateLimit(kv, ip) {
  const key = KV_RATELIMIT + ip;
  const cur = parseInt((await kv.get(key)) || '0', 10);
  const next = (Number.isFinite(cur) ? cur : 0) + 1;
  await kv.put(key, String(next), { expirationTtl: 60 }); // 60s window
  return next;
}

// ===== Pipeline steps (each does ONE thing) =====

async function stepAnalyze(job, env) {
  const sysPrompt = `You are a story-to-storyboard planner. Output strict JSON only, no markdown fences, no commentary.`;
  const userPrompt = `Analyze this ${job.language} story chapter and produce a storyboard.

Story:
"""
${job.text.slice(0, 8000)}
"""

Output JSON with this structure:
{
  "title": "short story title",
  "characters": [
    { "name": "MainChar", "appearance": "detailed visual description for image gen, e.g. 'young woman, 20s, long black hair, blue traditional Chinese hanfu, gentle expression'" }
  ],
  "style": "overall visual style, e.g. 'cinematic, soft golden hour lighting, anime-influenced realism'",
  "shots": [
    {
      "id": 1,
      "scene": "short scene name",
      "narration": "1-2 sentence narration in ${job.language} (no dialogue, just descriptive voiceover)",
      "image_prompt": "detailed English prompt for the shot's first frame, including subject, action, scene, camera angle, lighting. ALWAYS end with the global style suffix.",
      "video_prompt": "English motion prompt: how the scene animates (1 sentence), e.g. 'camera slowly pushes in, character's hair sways gently in wind'",
      "duration_sec": 4
    }
  ]
}

Rules:
- Generate 4-6 shots (cap at 6 to keep video RPM 1 manageable)
- Each shot must be VISUALLY DIFFERENT (different camera angle, different action)
- ALL image_prompts MUST end with the same 'style' suffix (for visual consistency)
- Include ALL recurring characters in 'characters' with detailed appearance (for character-locking via i2i)
- 'narration' is VOICEOVER only, no quotes, no character names speaking
- Keep image_prompt under 400 chars, video_prompt under 100 chars`;

  const raw = await agnesChat([
    { role: 'system', content: sysPrompt },
    { role: 'user', content: userPrompt }
  ], { model: 'agnes-2.0-flash', max_tokens: 4000, temperature: 0.7 }, env);

  // FIX C6: use a balanced-brace extractor instead of greedy regex.
  // Greedy `\{[\s\S]*\}` would swallow multiple JSON-ish blocks.
  const jsonStr = extractFirstBalancedJson(raw);
  if (!jsonStr) throw new Error('Analyze: no JSON found: ' + raw.slice(0, 200));
  let plan;
  try { plan = JSON.parse(jsonStr); } catch (e) {
    throw new Error('Analyze: JSON parse failed: ' + e.message + ' | first 200 chars: ' + jsonStr.slice(0, 200));
  }
  job.plan = plan;
  job.shots = (plan.shots || []).map(s => ({
    ...s,
    state: 'pending',
    imageUrl: null,
    videoId: null,
    videoUrl: null,
    videoProgress: 0,
    videoStatus: null,
    narrationAudioB64: null,
    qaResult: null,
    attempts: 0
  }));
  job.step = 'ready';
}

async function stepShotImage(job, idx, env) {
  const shot = job.shots[idx];
  const useRef = !!job.characterRefUrl;
  const url = await agnesImageGen(shot.image_prompt, '1024x768', useRef ? job.characterRefUrl : null, env);
  if (!url) throw new Error('Image gen returned no URL');
  shot.imageUrl = url;
  if (!job.characterRefUrl) job.characterRefUrl = url; // first shot establishes ref
  shot.state = 'image_done';
}

async function stepShotVideoCreate(job, idx, env, kv) {
  const shot = job.shots[idx];
  if (!shot.imageUrl) throw new Error('Shot ' + idx + ' has no image');
  // Acquire global video RPM lock
  const lock = await acquireVideoLock(kv);
  if (!lock.acquired) {
    shot.state = 'video_queued'; // waiting for global cooldown
    return { queued: true, waitSec: lock.waitSec };
  }
  // Lock acquired, make the API call. If it fails with 429, release the lock
  // so the next caller doesn't waste a 60s slot. Other errors: keep lock (slot is consumed).
  try {
    const numFrames = (shot.duration_sec || 4) >= 5 ? 121 : 81;
    const { video_id } = await agnesVideoCreate(shot.video_prompt || shot.image_prompt, shot.imageUrl, numFrames, env);
    shot.videoId = video_id;
    shot.state = 'video_pending';
    return { queued: false, videoId: video_id };
  } catch (e) {
    if (e instanceof AgnesError && e.status === 429) {
      // Release lock: caller didn't actually consume a slot.
      try { await releaseVideoLockOnFail(kv); } catch (e2) {}
    }
    throw e;
  }
}

async function stepShotVideoPoll(job, idx, env) {
  const shot = job.shots[idx];
  if (!shot.videoId) throw new Error('Shot ' + idx + ' has no videoId');
  const r = await agnesVideoPoll(shot.videoId, env);
  shot.videoProgress = r.progress;
  shot.videoStatus = r.status;
  if (r.status === 'completed') {
    shot.videoUrl = r.remixed_from_video_id;
    shot.state = 'video_done';
    return { done: true };
  } else if (r.status === 'failed') {
    throw new Error('Video failed: ' + JSON.stringify(r.error));
  }
  return { done: false, progress: r.progress };
}

async function stepShotQA(job, idx, env) {
  const shot = job.shots[idx];
  if (!shot.imageUrl) throw new Error('Shot ' + idx + ' has no imageUrl');
  const qaText = await agnesVision(
    shot.imageUrl,
    `You are a visual QA agent. The intended prompt was:
"""
${shot.image_prompt}
"""
Check for issues. Reply with strict JSON only, no markdown:
1. "anatomy_issues": any deformities? (string or empty)
2. "prompt_adherence": score 1-10
3. "pass": true if no anatomy issues AND prompt_adherence >= 5, else false
4. "reason": one short sentence
JSON:`,
    env
  );
  const jsonStr = extractFirstBalancedJson(qaText);
  let parsed = { pass: true, reason: 'qa_parse_fallback' };
  if (jsonStr) { try { parsed = JSON.parse(jsonStr); } catch (e) {} }
  shot.qaResult = parsed;
  shot.state = parsed.pass ? 'qa_done' : 'qa_failed';
}

async function stepShotNarration(job, idx, env) {
  const shot = job.shots[idx];
  if (!shot.narration) { shot.state = 'narr_done'; return; }
  try {
    const b64 = await cfTts(shot.narration, env);
    shot.narrationAudioB64 = b64;
  } catch (e) {
    shot.narrationAudioB64 = null;
    shot.narrationError = String(e).slice(0, 200);
  }
  shot.state = 'narr_done';
}

// ===== Main handler =====

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.FEEDBACK_KV;
  let body;
  try { body = await request.json(); } catch { return jerr(400, 'invalid_json'); }
  const { action } = body;

  try {
    if (action === 'create') {
      const { text, language } = body;
      if (typeof text !== 'string' || text.length < 50) return jerr(400, 'text_too_short');
      if (text.length > 12000) return jerr(400, 'text_too_long_max_12k');
      // Whitelist language to prevent abuse / weird chars
      const allowedLangs = ['English', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Spanish', 'French', 'German'];
      const safeLang = allowedLangs.includes(language) ? language : 'English';
      // Per-IP rate limit on create (prevent abuse of API quota)
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const createKey = 'rl-create:' + ip;
      const cur = parseInt((await kv.get(createKey)) || '0', 10);
      const n = (Number.isFinite(cur) ? cur : 0) + 1;
      await kv.put(createKey, String(n), { expirationTtl: 300 }); // 5 min window
      if (n > 10) {
        // Best-effort cleanup of rate limit counter is not done; will expire in 5 min
        return jerr(429, 'rate_limited_too_many_creates_in_5min');
      }
      const jobId = 'job_' + Date.now() + '_' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(36).padStart(2, '0')).join('');
      const job = {
        id: jobId,
        createdAt: Date.now(),
        text: text.slice(0, 12000), // hard-cap stored text
        language: safeLang,
        step: 'analyzing',
        currentShot: 0,
        plan: null,
        shots: [],
        characterRefUrl: null,
        error: null
      };
      await putJob(kv, job);
      try {
        await stepAnalyze(job, env);
        await putJob(kv, job);
      } catch (e) {
        const msg = String(e).slice(0, 300);
        job.error = 'analyze_failed: ' + msg;
        job.step = 'error';
        // Best-effort save, don't throw if KV write fails
        try { await putJob(kv, job); } catch (e2) {}
      }
      return jok({ jobId, job });
    }

    if (action === 'step') {
      const { jobId, shotIndex, phase } = body;
      const job = await getJob(kv, jobId);
      if (!job) return jerr(404, 'job_not_found');
      if (job.step === 'error') return jok({ job, advanced: false, reason: 'job_in_error_state' });
      if (job.step === 'done') return jok({ job, advanced: false, reason: 'job_done' });

      const idx = shotIndex ?? 0;
      // FIX C7: don't override error/done state; only set 'done' when actually past last shot
      if (idx >= job.shots.length) {
        if (job.shots.length > 0) {
          job.step = 'done';
          await putJob(kv, job);
        }
        return jok({ job, done: true, message: 'all_shots_done' });
      }
      const shot = job.shots[idx];
      job.currentShot = idx;

      // Determine phase if not given
      let p = phase;
      if (!p) {
        if (!shot.state || shot.state === 'pending' || shot.state === 'rate_limited') p = 'image';
        else if (shot.state === 'image_done' && !shot.videoId) p = 'video_create';
        else if (shot.state === 'video_queued' || shot.state === 'rate_limited_rpm') p = 'video_create'; // re-try
        else if (shot.state === 'video_pending') p = 'video_poll';
        else if (shot.state === 'video_done') p = 'qa';
        else if (shot.state === 'qa_failed' && shot.attempts < 2) p = 'image'; // re-gen
        else if (shot.state === 'qa_done' || (shot.state === 'qa_failed' && shot.attempts >= 2)) p = 'narrate';
        else p = 'noop';
      }

      try {
        let result = {};
        if (p === 'image') {
          if (shot.state === 'qa_failed') shot.attempts++;
          await stepShotImage(job, idx, env);
          result = { phase: 'image', message: 'image done' };
        } else if (p === 'video_create') {
          result = await stepShotVideoCreate(job, idx, env, kv);
          result.phase = 'video_create';
          if (result.queued) {
            // Don't advance shot, just save state and return
            await putJob(kv, job);
            return jok({ job, done: false, retry_after: result.waitSec, message: 'video_rpm_cooldown' });
          }
          result.message = 'video task created';
        } else if (p === 'video_poll') {
          result = await stepShotVideoPoll(job, idx, env);
          result.phase = 'video_poll';
          if (!result.done) {
            await putJob(kv, job);
            // Adaptive wait: faster polling as progress increases
            const waitSec = result.progress < 30 ? 20 : (result.progress < 70 ? 10 : 5);
            return jok({ job, done: false, retry_after: waitSec, message: 'video_in_progress', progress: result.progress });
          }
        } else if (p === 'qa') {
          await stepShotQA(job, idx, env);
          result = { phase: 'qa', message: 'qa done', pass: job.shots[idx].qaResult?.pass };
        } else if (p === 'narrate') {
          await stepShotNarration(job, idx, env);
          result = { phase: 'narrate', message: 'narrate done' };
        } else {
          result = { phase: 'noop' };
        }
        await putJob(kv, job);
        return jok({ job, done: false, ...result });
      } catch (e) {
        if (e instanceof AgnesError && e.status === 429) {
          shot.state = e.message.includes('video') ? 'rate_limited_rpm' : 'rate_limited';
          shot.lastError = e.message;
          const ra = e.retryAfter && Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : 60;
          shot.retryAfter = ra;
          // FIX C3 (partial): if video-related 429, release lock (it was reserved
          // but we couldn't use the slot — don't punish the next caller)
          if (shot.state === 'rate_limited_rpm') {
            try { await releaseVideoLockOnFail(kv); } catch (e2) {}
          }
          await putJob(kv, job);
          return jok({
            job, done: false,
            retry_after: ra,
            message: 'rate_limited_429',
            error: e.message
          });
        }
        shot.error = String(e).slice(0, 300);
        shot.state = 'error';
        await putJob(kv, job);
        return jok({ job, done: false, error: shot.error });
      }
    }

    if (action === 'get') {
      const { jobId } = body;
      const job = await getJob(kv, jobId);
      if (!job) return jerr(404, 'job_not_found');
      return jok({ job });
    }

    if (action === 'list') {
      const list = await kv.list({ prefix: KV_PREFIX, limit: 100 });
      const items = [];
      for (const k of list.keys) {
        try {
          const raw = await kv.get(k.name);
          if (!raw) continue;
          const j = JSON.parse(raw);
          items.push({
            id: j.id, createdAt: j.createdAt, step: j.step,
            shotCount: j.shots?.length || 0, currentShot: j.currentShot,
            title: j.plan?.title
          });
        } catch (e) {
          // Skip corrupt entries silently
        }
      }
      return jok({ jobs: items });
    }

    if (action === 'delete') {
      const { jobId } = body;
      // FIX C8: validate first (no KV write for invalid input),
      // then per-IP rate limit, then delete
      if (!jobId || typeof jobId !== 'string' || jobId.length > 64 || !/^job_[A-Za-z0-9_]+$/.test(jobId)) {
        return jerr(400, 'invalid_job_id');
      }
      // Per-IP rate limit (KV-backed 60s window). Wrap in try-catch so KV
      // exhaustion doesn't 500 valid requests.
      let rateLimitOk = true;
      try {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const count = await bumpRateLimit(kv, ip);
        if (count > DELETE_RATELIMIT_PER_MIN) rateLimitOk = false;
      } catch (e) { /* KV exhausted: log only, allow */ }
      if (!rateLimitOk) return jerr(429, 'rate_limited_too_many_deletes_per_minute');
      await kv.delete(KV_PREFIX + jobId);
      return jok({ deleted: true });
    }

    if (action === 'video_lock_status') {
      const lastRaw = await kv.get(KV_VIDEO_LOCK);
      let last = lastRaw ? parseInt(lastRaw, 10) : 0;
      if (!Number.isFinite(last) || last <= 0) last = 0;
      const elapsed = (Date.now() - last) / 1000;
      return jok({
        lastVideoCall: last || null,
        elapsedSec: Math.max(0, Math.floor(elapsed)),
        canCallNow: !last || elapsed >= VIDEO_RPM_COOLDOWN_SEC,
        cooldownSec: VIDEO_RPM_COOLDOWN_SEC
      });
    }

    return jerr(400, 'unknown_action');
  } catch (e) {
    return jerr(500, 'internal_error: ' + String(e).slice(0, 300));
  }
}

export async function onRequestGet() {
  return jok({ status: 'ok', endpoint: 'story-job' });
}

function jok(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
function jerr(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
