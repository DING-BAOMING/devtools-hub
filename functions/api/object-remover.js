// Cloudflare Pages Function: Object Remover (Magic Eraser)
// POST /api/object-remover
//   Body: { image: <base64 PNG bytes>, mask: <base64 PNG bytes>, prompt: string, mode: string }
//   Returns: { image: <base64 PNG bytes>, mimeType: "image/png", elapsed_sec: number }
//
// Uses Cloudflare Workers AI @cf/runwayml/stable-diffusion-v1-5-inpainting (free).
// Ponytail: global lock, per-account locks if throughput matters.

const CF_ACCOUNT_ID = 'dfd1444566cc6b76eda1c8a9fabbb6f9';
const CF_INPAINT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting';
const FETCH_TIMEOUT_MS = 28000;

const MODE_PROMPTS = {
  generic: 'clean photo, natural texture continuation, no objects',
  person: 'empty background where person was, natural scene continuation',
  text: 'clean surface with no text, logo or watermark',
  watermark: 'clean surface with no watermark, logo or text overlay',
  sign: 'clean environment with no sign, logo or text',
  blemish: 'smooth natural skin with no blemish, pimple or wrinkle',
  object: 'natural background continuation, no unwanted objects',
  clutter: 'clean organized background with no clutter'
};

const MODE_KEYS = Object.keys(MODE_PROMPTS);

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function b64ToUint8Array(b64) {
  const clean = String(b64 || '').replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ArrayToB64(uint8) {
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callInpaint(imageBytes, maskBytes, prompt, env) {
  const accountId = env.CF_ACCOUNT_ID || CF_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN not configured');

  const body = {
    prompt: String(prompt || '').slice(0, 500),
    image: Array.from(imageBytes),
    mask: Array.from(maskBytes),
    num_steps: 20,
    guidance: 7.5
  };

  let r;
  try {
    r = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_INPAINT_MODEL}`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      FETCH_TIMEOUT_MS
    );
  } catch (e) {
    throw new Error('CF inpaint timeout/network: ' + (e.message || e));
  }

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`CF inpaint ${r.status}: ${t.slice(0, 300)}`);
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();

  // Some CF models return JSON { result: { image: <base64> } }
  if (ct.includes('json')) {
    let j;
    try { j = await r.json(); } catch (e) {
      throw new Error('CF inpaint: invalid JSON response');
    }
    const imgField = j.result?.image || j.image;
    if (imgField && typeof imgField === 'string') {
      return b64ToUint8Array(imgField);
    }
    throw new Error('CF inpaint: no image in JSON response');
  }

  // Raw PNG bytes
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

function jsonError(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: corsHeaders()
  });
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonError('Invalid JSON body', 400);
  }

  const imageB64 = payload.image;
  const maskB64 = payload.mask;
  const mode = MODE_KEYS.includes(payload.mode) ? payload.mode : 'generic';
  const userPrompt = String(payload.prompt || '').trim();
  const finalPrompt = userPrompt
    ? userPrompt.slice(0, 500)
    : (MODE_PROMPTS[mode] + ', high quality, photorealistic');

  if (!imageB64 || typeof imageB64 !== 'string') {
    return jsonError('Missing image', 422);
  }
  if (!maskB64 || typeof maskB64 !== 'string') {
    return jsonError('Missing mask', 422);
  }

  let imageBytes, maskBytes;
  try {
    imageBytes = b64ToUint8Array(imageB64);
    maskBytes = b64ToUint8Array(maskB64);
  } catch (e) {
    return jsonError('Invalid base64: ' + e.message, 422);
  }

  if (imageBytes.length < 100 || imageBytes.length > 8 * 1024 * 1024) {
    return jsonError('Image size out of range (100B-8MB)', 422);
  }
  if (maskBytes.length < 100 || maskBytes.length > 8 * 1024 * 1024) {
    return jsonError('Mask size out of range (100B-8MB)', 422);
  }

  const t0 = Date.now();
  try {
    const resultBytes = await callInpaint(imageBytes, maskBytes, finalPrompt, env);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const resultB64 = uint8ArrayToB64(resultBytes);
    return new Response(JSON.stringify({
      image: 'data:image/png;base64,' + resultB64,
      mimeType: 'image/png',
      elapsed_sec: parseFloat(elapsed),
      bytes: resultBytes.length,
      mode,
      prompt: finalPrompt
    }), { status: 200, headers: corsHeaders() });
  } catch (e) {
    return jsonError(e.message || 'Inpaint failed', 500);
  }
}