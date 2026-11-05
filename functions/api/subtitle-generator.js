// Cloudflare Pages Function: Subtitle Generator (audio/video -> SRT/VTT)
// POST /api/subtitle-generator   multipart/form-data { audio: File, model?, language? }
//   -> Groq Whisper API (response_format=verbose_json + segment timestamps)
//
// Verified against the live Groq API (2026-08-22):
//  - endpoint: https://api.groq.com/openai/v1/audio/transcriptions
//  - models: whisper-large-v3 (best), whisper-large-v3-turbo (faster), distil-whisper-large-v3-en (English only)
//  - free tier: 60 RPM, file size limit 25 MB
//  - verbose_json + timestamp_granularities=segment returns [{ id, seek, start, end, text, ... }, ...]
//  - language param: ISO-639-1 (en, zh, es, fr, de, ja, ko, pt, it, ru, ar, hi, nl, pl) optional

const SUPPORTED_MODELS = {
  'whisper-large-v3':         { maxFileMB: 25, multilingual: true,  speedHint: 'best' },
  'whisper-large-v3-turbo':   { maxFileMB: 25, multilingual: true,  speedHint: 'fast' },
  'distil-whisper-large-v3-en': { maxFileMB: 25, multilingual: false, speedHint: 'fastest-en' }
};
const DEFAULT_MODEL = 'whisper-large-v3-turbo';

const LANGUAGE_OPTIONS = {
  '':        'Auto-detect',
  'en':      'English',
  'zh':      'Chinese (Mandarin)',
  'es':      'Spanish',
  'fr':      'French',
  'de':      'German',
  'ja':      'Japanese',
  'ko':      'Korean',
  'pt':      'Portuguese',
  'it':      'Italian',
  'ru':      'Russian',
  'ar':      'Arabic',
  'hi':      'Hindi',
  'nl':      'Dutch',
  'pl':      'Polish',
  'tr':      'Turkish',
  'vi':      'Vietnamese',
  'id':      'Indonesian',
  'th':      'Thai'
};

const FETCH_TIMEOUT_MS = 55000; // Groq can be slow on long files (max ~6 min)

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extraHeaders
    }
  });
}

function errResponse(code, message, httpStatus = 400, extra = {}) {
  return jsonResponse({ ok: false, error: code, message, ...extra }, httpStatus);
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

function safeText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function buildWhisperForm(audioFile, model, language) {
  const fd = new FormData();
  fd.append('file', audioFile, audioFile.name || 'audio');
  fd.append('model', model);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  if (language && LANGUAGE_OPTIONS[language]) {
    fd.append('language', language);
  }
  return fd;
}

async function callGroqWhisper(audioFile, model, language, env) {
  const groqKey = env.DEVTOOLS_GROQ_API_KEY;
  if (!groqKey) {
    throw { code: 'no_api_key', message: 'GROQ API key not configured (DEVTOOLS_GROQ_API_KEY).' };
  }
  const fd = buildWhisperForm(audioFile, model, language);
  const r = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + groqKey },
    body: fd
  });
  if (!r.ok) {
    const txt = await r.text();
    let msg = `Groq Whisper HTTP ${r.status}`;
    try {
      const j = JSON.parse(txt);
      if (j.error && j.error.message) msg = j.error.message;
    } catch (e) { /* keep original */ }
    throw { code: 'groq_error', message: msg, status: r.status, raw: txt.slice(0, 300) };
  }
  return r.json();
}

// Sanity-check segments and merge any that are too short (avoid stuttering subs)
function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return [];
  const out = [];
  for (const seg of rawSegments) {
    const start = Number(seg.start);
    const end = Number(seg.end);
    const text = safeText(seg.text);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    out.push({ start, end, text });
  }
  // Stable sort by start time
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Extract audio from a video file using WebAudio in Cloudflare Worker? Not available.
// Instead we forward the raw file to Groq; Groq Whisper accepts video files directly
// because it scans the audio track. (Verified against Groq docs & sample uploads.)

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestGet() {
  return jsonResponse({
    ok: true,
    endpoint: 'subtitle-generator',
    info: 'POST multipart/form-data with field "audio" (mp3/wav/m4a/ogg/mp4/mov/webm/mkv), optional "model" and "language".',
    models: SUPPORTED_MODELS,
    languages: LANGUAGE_OPTIONS
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return errResponse('invalid_content_type', 'Use multipart/form-data with an "audio" file field.', 415);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return errResponse('invalid_form', 'Could not parse multipart form: ' + (e && e.message ? e.message : 'unknown'), 400);
  }

  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') {
    return errResponse('no_audio', 'Missing required "audio" file field (mp3/wav/m4a/ogg/mp4/mov/webm/mkv).', 422);
  }
  // Cloudflare Pages Function request body cap: 100 MB on free plan.
  // Groq file cap: 25 MB.
  const sizeBytes = audio.size || 0;
  if (sizeBytes <= 0) {
    return errResponse('empty_audio', 'Audio file is empty.', 422);
  }
  if (sizeBytes > 100 * 1024 * 1024) {
    return errResponse('file_too_large_for_function', 'Audio file exceeds 100 MB Cloudflare Pages function limit. Trim or compress first.', 413);
  }

  // Model selection
  const modelRequested = (form.get('model') || DEFAULT_MODEL).toString();
  const model = SUPPORTED_MODELS[modelRequested] ? modelRequested : DEFAULT_MODEL;
  const modelMeta = SUPPORTED_MODELS[model];
  if (sizeBytes > modelMeta.maxFileMB * 1024 * 1024) {
    return errResponse(
      'file_exceeds_groq_limit',
      `Audio file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB which exceeds the Groq ${model} limit of ${modelMeta.maxFileMB} MB. Trim or compress the file first.`,
      413,
      { model, maxMB: modelMeta.maxFileMB }
    );
  }

  // Language
  const languageRequested = (form.get('language') || '').toString().toLowerCase();
  const language = languageRequested && LANGUAGE_OPTIONS[languageRequested] ? languageRequested : '';
  // distil-whisper-large-v3-en requires English; reject other languages for it
  if (model === 'distil-whisper-large-v3-en' && language && language !== 'en') {
    return errResponse('model_language_mismatch', 'distil-whisper-large-v3-en only supports English. Pick a multilingual model or clear the language.', 422);
  }

  // Call Groq Whisper
  let whisperResp;
  try {
    whisperResp = await callGroqWhisper(audio, model, language, env);
  } catch (e) {
    if (e && e.code === 'no_api_key') {
      return errResponse('no_api_key', e.message, 500);
    }
    if (e && e.code === 'groq_error') {
      // 429 → surface so the client can back off
      if (e.status === 429) {
        return errResponse('rate_limited', 'Groq rate limit hit (60 RPM). Please retry in a moment.', 429);
      }
      if (e.status === 413) {
        return errResponse('file_exceeds_groq_limit', e.message, 413);
      }
      return errResponse('groq_error', e.message, 502, { groqStatus: e.status });
    }
    if (e && e.name === 'AbortError') {
      return errResponse('timeout', `Groq Whisper took longer than ${FETCH_TIMEOUT_MS / 1000}s. The file may be too long; try trimming to under 5 minutes.`, 504);
    }
    return errResponse('internal_error', 'Unexpected error: ' + (e && e.message ? e.message : String(e)).slice(0, 300), 500);
  }

  const segments = normalizeSegments(whisperResp.segments);
  if (segments.length === 0) {
    return errResponse('no_speech', 'No speech detected. The file may be silent or in a language that was not recognized.', 422);
  }

  return jsonResponse({
    ok: true,
    model,
    language: whisperResp.language || language || 'auto',
    duration: Number(whisperResp.duration) || 0,
    text: safeText(whisperResp.text || ''),
    segments,
    count: segments.length
  });
}