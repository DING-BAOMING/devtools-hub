/**
 * Audio File Transcriber API
 *
 * Transcribes uploaded audio files using Groq Whisper API.
 * Supports: MP3, WAV, M4A, OGG, FLAC, AAC, WEBM, MP4, MOV, AVI (audio extraction)
 *
 * Endpoints:
 *   POST /api/audio-transcriber     - Transcribe audio (multipart/form-data)
 *   GET  /api/audio-transcriber     - Health check + available models
 *
 * Env: DEVTOOLS_GROQ_API_KEY (required, configured in Cloudflare Pages)
 *
 * Groq Whisper API:
 *   POST https://api.groq.com/openai/v1/audio/transcriptions
 *   Content-Type: multipart/form-data
 *   Body: file=<binary>, model=<whisper-model>, language=<lang>, response_format=<json|verbose_json>
 *
 * Free tier limits: 60 req/min, files up to 25MB
 */

var GROQ_BASE = 'https://api.groq.com/openai/v1';
var MAX_FILE_SIZE = 25 * 1024 * 1024;

var ALLOWED_MODELS = {
  'whisper-large-v3': 1,
  'whisper-large-v3-turbo': 1,
  'distil-whisper-large-v3-en': 1
};

var ALLOWED_FORMATS = {
  'json': 1,
  'verbose_json': 1,
  'text': 1,
  'srt': 1,
  'vtt': 1
};

var ALLOWED_LANGUAGES = {
  'auto': 1, 'en': 1, 'es': 1, 'fr': 1, 'de': 1, 'it': 1, 'pt': 1, 'ru': 1,
  'zh': 1, 'ja': 1, 'ko': 1, 'ar': 1, 'hi': 1, 'nl': 1, 'pl': 1, 'tr': 1,
  'sv': 1, 'id': 1, 'vi': 1, 'th': 1, 'uk': 1, 'cs': 1, 'fi': 1, 'he': 1
};

var ALLOWED_MIME = {
  'audio/mpeg': 1, 'audio/mp3': 1, 'audio/wav': 1, 'audio/wave': 1, 'audio/x-wav': 1,
  'audio/mp4': 1, 'audio/m4a': 1, 'audio/x-m4a': 1,
  'audio/ogg': 1, 'audio/vorbis': 1, 'audio/flac': 1, 'audio/x-flac': 1,
  'audio/aac': 1, 'audio/webm': 1, 'audio/opus': 1,
  'video/mp4': 1, 'video/quicktime': 1, 'video/x-msvideo': 1, 'video/webm': 1,
  'application/ogg': 1, 'application/octet-stream': 1
};

var ALLOWED_EXT = /\.(mp3|wav|m4a|ogg|oga|flac|aac|webm|opus|mp4|mov|avi|m4b|3gp)$/i;

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

function err(message, status) {
  return json({ error: message }, status || 400);
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function callGroqWhisper(env, fileBlob, filename, mime, model, language, responseFormat) {
  var key = env.DEVTOOLS_GROQ_API_KEY;
  if (!key || key === 'GROQ_API_KEY_NOT_SET') {
    throw new Error('Groq API key not configured (DEVTOOLS_GROQ_API_KEY)');
  }

  var form = new FormData();
  form.append('file', fileBlob, filename);
  form.append('model', model);
  if (language && language !== 'auto') {
    form.append('language', language);
  }
  form.append('response_format', responseFormat);
  form.append('temperature', '0');

  var resp = await fetch(GROQ_BASE + '/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key
    },
    body: form
  });

  if (resp.status === 429) {
    throw new Error('Groq rate limit exceeded (60 req/min). Please wait a moment.');
  }
  if (resp.status === 413) {
    throw new Error('File too large for Groq Whisper API (max 25MB).');
  }
  if (resp.status === 400) {
    var body = await resp.text().catch(function() { return ''; });
    throw new Error('Groq validation error: ' + body.substring(0, 300));
  }
  if (!resp.ok) {
    var body2 = await resp.text().catch(function() { return ''; });
    throw new Error('Groq HTTP ' + resp.status + ': ' + body2.substring(0, 300));
  }

  var ct = resp.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) {
    return await resp.json();
  }
  var text = await resp.text();
  return { text: text, format: responseFormat };
}

function srtTime(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = Math.floor(sec % 60);
  var ms = Math.floor((sec - Math.floor(sec)) * 1000);
  function pad(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms, 3);
}

function vttTime(sec) {
  return srtTime(sec).replace(',', '.');
}

function segmentsToSrt(segments) {
  if (!segments || !segments.length) return '';
  var out = '';
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    out += (i + 1) + '\n';
    out += srtTime(seg.start) + ' --> ' + srtTime(seg.end) + '\n';
    out += (seg.text || '').trim() + '\n\n';
  }
  return out;
}

function segmentsToVtt(segments) {
  if (!segments || !segments.length) return '';
  var out = 'WEBVTT\n\n';
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    out += (i + 1) + '\n';
    out += vttTime(seg.start) + ' --> ' + vttTime(seg.end) + '\n';
    out += (seg.text || '').trim() + '\n\n';
  }
  return out;
}

function secondsFromTimecode(tc) {
  if (!tc) return 0;
  var parts = tc.toString().split(':');
  if (parts.length === 3) {
    var secParts = parts[2].split(/[.,]/);
    var h = parseFloat(parts[0]) || 0;
    var m = parseFloat(parts[1]) || 0;
    var s = parseFloat(secParts[0]) || 0;
    var ms = parseFloat(secParts[1]) || 0;
    return h * 3600 + m * 60 + s + ms / 1000;
  }
  return 0;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (context.request.method === 'GET') {
    return json({
      tool: 'audio-transcriber',
      version: '1.0.0',
      status: 'ready',
      upstream: 'Groq Whisper API',
      models: Object.keys(ALLOWED_MODELS),
      formats: Object.keys(ALLOWED_FORMATS),
      languages: Object.keys(ALLOWED_LANGUAGES),
      max_file_size_mb: 25,
      limits: { max_file_size: MAX_FILE_SIZE, rate_limit_per_min: 60 }
    });
  }

  if (context.request.method !== 'POST') {
    return err('Method not allowed. Use GET for health or POST with multipart/form-data.', 405);
  }

  var contentType = context.request.headers.get('content-type') || '';
  if (contentType.indexOf('multipart/form-data') === -1) {
    return err('Content-Type must be multipart/form-data', 400);
  }

  let formData;
  try {
    formData = await context.request.formData();
  } catch (e) {
    return err('Failed to parse multipart form data: ' + e.message, 400);
  }

  var fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string') {
    return err('No audio file provided. Use field name "file".', 400);
  }

  var filename = fileEntry.name || 'audio.mp3';
  var fileBlob = fileEntry;
  var size = fileEntry.size || 0;

  if (size === 0) {
    return err('Empty file uploaded.', 400);
  }
  if (size > MAX_FILE_SIZE) {
    return err('File too large. Max 25MB. Got ' + (size / 1024 / 1024).toFixed(1) + 'MB.', 413);
  }

  var mime = fileEntry.type || '';
  var extMatch = filename.match(ALLOWED_EXT);
  if (!extMatch && !ALLOWED_MIME[mime]) {
    return err('Unsupported file type. Allowed: mp3, wav, m4a, ogg, flac, aac, webm, opus, mp4, mov, avi.', 415);
  }

  var model = (formData.get('model') || 'whisper-large-v3-turbo').toString();
  if (!ALLOWED_MODELS[model]) {
    return err('Invalid model. Use whisper-large-v3, whisper-large-v3-turbo, or distil-whisper-large-v3-en.', 400);
  }

  var language = (formData.get('language') || 'auto').toString();
  if (!ALLOWED_LANGUAGES[language]) {
    return err('Unsupported language code.', 400);
  }

  var responseFormat = (formData.get('response_format') || 'verbose_json').toString();
  if (!ALLOWED_FORMATS[responseFormat]) {
    return err('Invalid response_format. Use json, verbose_json, text, srt, or vtt.', 400);
  }

  try {
    var result = await callGroqWhisper(context.env, fileBlob, filename, mime, model, language, responseFormat);

    var payload = {
      ok: true,
      model: model,
      language: language,
      filename: filename,
      file_size: size,
      text: result.text || '',
      segments: null,
      detected_language: null,
      duration: null
    };

    if (responseFormat === 'verbose_json' && result.segments) {
      payload.segments = result.segments.map(function(s) {
        return {
          id: s.id,
          start: typeof s.start === 'number' ? s.start : secondsFromTimecode(s.start),
          end: typeof s.end === 'number' ? s.end : secondsFromTimecode(s.end),
          text: (s.text || '').trim()
        };
      });
      if (result.language) payload.detected_language = result.language;
      if (typeof result.duration === 'number') payload.duration = result.duration;
    }

    if (responseFormat === 'srt' && typeof result.text === 'string' && result.text.indexOf('-->') !== -1) {
      payload.text = result.text;
      payload.srt = result.text;
    }
    if (responseFormat === 'vtt' && typeof result.text === 'string' && result.text.indexOf('-->') !== -1) {
      payload.text = result.text;
      payload.vtt = result.text;
    }

    return json(payload, 200);
  } catch (e) {
    var msg = (e && e.message) ? e.message : 'Unknown transcription error';
    return err(msg, e.status || 500);
  }
}