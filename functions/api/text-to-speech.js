/**
 * Text-to-Speech API
 *
 * Primary: Cloudflare Workers AI TTS (@cf/myshell-ai/melotts) - free 10000 neurons/day
 * Fallback: SiliconFlow CosyVoice2 - paid (audio models require credits)
 *
 * Cloudflare Workers AI:
 *   Endpoint: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/@cf/myshell-ai/melotts
 *   Auth: Authorization: Bearer {CLOUDFLARE_API_TOKEN}
 *   Body: { "prompt": "text" } -> { "result": { "audio": "base64-wav-data" } }
 *
 * SiliconFlow CosyVoice2 (legacy):
 *   Voice format: FunAudioLLM/CosyVoice2-0.5B:<voice_name>
 *   Output: MP3 (default) or WAV
 */

var VOICES = [
  { id: 'FunAudioLLM/CosyVoice2-0.5B:alex', name: 'Alex', gender: 'male', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:anna', name: 'Anna', gender: 'female', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:bella', name: 'Bella', gender: 'female', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', name: 'Benjamin', gender: 'male', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:charles', name: 'Charles', gender: 'male', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:claire', name: 'Claire', gender: 'female', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:david', name: 'David', gender: 'male', lang: 'en,zh' },
  { id: 'FunAudioLLM/CosyVoice2-0.5B:diana', name: 'Diana', gender: 'female', lang: 'en,zh' }
];

var CF_ACCOUNT_ID = 'dfd1444566cc6b76eda1c8a9fabbb6f9';
var CF_TTS_MODEL = '@cf/myshell-ai/melotts';
var MAX_TEXT_LENGTH = 5000;

function base64ToArrayBuffer(base64) {
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function callCloudflareTTS(text, apiToken) {
  var ttsResponse = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/run/' + CF_TTS_MODEL,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: text })
    }
  );

  if (!ttsResponse.ok) {
    var errBody = await ttsResponse.text();
    return { ok: false, status: ttsResponse.status, error: 'Cloudflare TTS ' + ttsResponse.status + ': ' + errBody.slice(0, 200) };
  }

  var data = await ttsResponse.json();
  if (!data.success || !data.result || !data.result.audio) {
    return { ok: false, status: 502, error: 'Cloudflare TTS returned no audio: ' + JSON.stringify(data).slice(0, 200) };
  }

  var audioBuffer = base64ToArrayBuffer(data.result.audio);
  return { ok: true, audio: audioBuffer, contentType: 'audio/wav' };
}

async function callSiliconFlowTTS(text, voice, format, speed, apiKey) {
  var sampleRate = format === 'wav' ? 24000 : 32000;
  var ttsResponse = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: text,
      voice: voice,
      response_format: format,
      sample_rate: sampleRate,
      stream: false,
      speed: speed,
      gain: 0
    })
  });

  if (ttsResponse.status === 429) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  if (!ttsResponse.ok) {
    return { ok: false, status: ttsResponse.status, error: 'SiliconFlow TTS error' };
  }

  var audioBuffer = await ttsResponse.arrayBuffer();
  var contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
  return { ok: true, audio: audioBuffer, contentType: contentType };
}

export async function onRequest({ request, env }) {
  var responseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      voices: VOICES,
      provider: 'cloudflare-workers-ai',
      note: 'AI voice mode uses Cloudflare Workers AI TTS (free). SiliconFlow CosyVoice2 voices are listed for legacy compatibility.'
    }), {
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    });
  }

  var text, voice, format, speed;
  try {
    var body = await request.json();
    text = (body.text || '').toString();
    voice = body.voice || 'FunAudioLLM/CosyVoice2-0.5B:anna';
    format = (body.format || 'mp3').toString().toLowerCase();
    speed = body.speed || 1;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    });
  }

  if (!text || !text.trim()) {
    return new Response(JSON.stringify({ error: 'No text provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return new Response(JSON.stringify({ error: 'Text exceeds ' + MAX_TEXT_LENGTH + ' character limit' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    });
  }

  if (speed < 0.25 || speed > 4) {
    speed = Math.min(Math.max(speed, 0.25), 4);
  }

  if (!['mp3', 'wav'].includes(format)) {
    format = 'mp3';
  }

  var cfToken = env.CLOUDFLARE_API_TOKEN;
  console.log('[TTS] env keys:', Object.keys(env || {}).join(','));
  console.log('[TTS] cfToken present:', !!cfToken, 'length:', cfToken ? cfToken.length : 0);

  if (cfToken) {
    try {
      var cfResult = await callCloudflareTTS(text, cfToken);
      console.log('[TTS] CF result:', JSON.stringify(cfResult).slice(0, 300));
      if (cfResult.ok) {
        return new Response(cfResult.audio, {
          headers: {
            'Content-Type': cfResult.contentType,
            'Content-Length': cfResult.audio.byteLength.toString(),
            'X-TTS-Provider': 'cloudflare-workers-ai',
            'Cache-Control': 'no-store',
            ...responseHeaders
          }
        });
      }
    } catch (e) {
      // fall through to SiliconFlow
    }
  }

  var validVoice = VOICES.find(function(v) { return v.id === voice; });
  if (validVoice) {
    var siliconKey = env.DEVTOOLS_SILICONFLOW_KEY;
    if (siliconKey) {
      try {
        var sfResult = await callSiliconFlowTTS(text, voice, format, speed, siliconKey);
        if (sfResult.ok) {
          return new Response(sfResult.audio, {
            headers: {
              'Content-Type': sfResult.contentType,
              'Content-Length': sfResult.audio.byteLength.toString(),
              'X-TTS-Provider': 'siliconflow-cosyvoice2',
              'Cache-Control': 'no-store',
              ...responseHeaders
            }
          });
        }
        if (sfResult.status === 429) {
          return new Response(JSON.stringify({
            error: 'AI voices temporarily unavailable. Try Browser TTS mode instead.',
            code: 'rate_limited'
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', ...responseHeaders }
          });
        }
      } catch (e) {
        // fall through
      }
    }
  }

  return new Response(JSON.stringify({
    error: 'AI voices unavailable. Please use Browser TTS mode (free, offline, works with Chrome/Edge/Firefox/Safari).',
    code: 'all_providers_failed',
    hint: 'switch to Browser TTS'
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', ...responseHeaders }
  });
}
