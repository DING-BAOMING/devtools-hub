/**
 * AI Humanizer API - Multi-stage DeAI pipeline
 *
 * Endpoints:
 *   POST /api/ai-humanizer   - Humanize text (proxy to DeAI)
 *   GET  /api/ai-humanizer   - Health check
 *
 * Env: DEVTOOLS_DEAI_KEY (required, configured in Cloudflare Pages)
 * DeAI Service: https://deai.029101.xyz (self-hosted)
 *
 * Pipeline (5 stages):
 *   1. Detector ensemble (MAGE + brandonwise + Burstiness)
 *   2. LLM rewrite with style constraints
 *   3. T5 sentence-level rephrasing
 *   4. opus-mt back-translation (en→de/fr→en)
 *   5. Token adversarial + quality gate
 *
 * Modes:
 *   safe        - skip if already human (~1-2s)
 *   balanced    - LLM + T5 rewrite (~10-30s) [default]
 *   aggressive  - all 5 stages including back-translation (~30-90s)
 *
 * Multi-run: 1-3, generates N candidates, picks lowest MAGE score
 */

var DEAI_BASE = 'https://deai.029101.xyz';
var MIN_LEN = 50;
var MAX_LEN = 20000;
var ALLOWED_MODES = { safe: 1, balanced: 1, aggressive: 1 };

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

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function deaiHumanize(env, text, mode, multiRun) {
  var key = env.DEVTOOLS_DEAI_KEY;
  if (!key) {
    throw new Error('DEAI key not configured (DEVTOOLS_DEAI_KEY)');
  }

  var body = {
    text: text,
    mode: mode,
    multi_run: multiRun,
    return_readability: false,
    wait: true
  };

  var resp = await fetch(DEAI_BASE + '/humanize', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 429) {
    throw new Error('DeAI rate limit exceeded (60 req/min). Please wait a moment.');
  }
  if (resp.status === 422) {
    var errBody = await resp.json().catch(function() { return {}; });
    throw new Error('Validation error: ' + (errBody.detail ? JSON.stringify(errBody.detail) : 'invalid input'));
  }
  if (!resp.ok) {
    var errText = await resp.text().catch(function() { return ''; });
    throw new Error('DeAI HTTP ' + resp.status + ': ' + errText.substring(0, 200));
  }

  return await resp.json();
}

function normalizeDeaiResult(raw, originalText) {
  return {
    humanized_text: raw.result || '',
    original_text: originalText,
    skipped: !!raw.skipped,
    reason: raw.reason || null,
    stage_reached: raw.stage_reached != null ? raw.stage_reached : null,
    elapsed_sec: raw.elapsed_sec != null ? raw.elapsed_sec : null,
    scores: {
      original: {
        mage: raw.mage_before != null ? raw.mage_before : null,
        bw: raw.original_score != null ? raw.original_score : null
      },
      humanized: {
        mage: raw.mage_after != null ? raw.mage_after : null,
        bw: raw.new_score != null ? raw.new_score : null
      }
    },
    ensemble: raw.ensemble || null,
    readability: raw.readability || null,
    mode: raw.mode || null
  };
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (context.request.method === 'GET') {
    return json({
      tool: 'ai-humanizer',
      version: '1.0.0',
      status: 'ready',
      upstream: 'DeAI Service v1.6.2',
      modes: Object.keys(ALLOWED_MODES),
      limits: { min_len: MIN_LEN, max_len: MAX_LEN, multi_run_max: 3 }
    });
  }

  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use GET for health or POST to humanize.' }, 405);
  }

  var body;
  try { body = await context.request.json(); }
  catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  var text = (body.text || '').toString();
  var mode = (body.mode || 'balanced').toString();
  var multiRun = parseInt(body.multi_run, 10);
  if (!multiRun || multiRun < 1) multiRun = 1;
  if (multiRun > 3) multiRun = 3;

  if (!ALLOWED_MODES[mode]) {
    return json({ error: 'Invalid mode. Use safe, balanced, or aggressive.' }, 400);
  }
  if (!text || text.length < MIN_LEN) {
    return json({ error: 'Text must be at least ' + MIN_LEN + ' characters. Current: ' + text.length }, 400);
  }
  if (text.length > MAX_LEN) {
    return json({ error: 'Text exceeds ' + MAX_LEN + ' character limit. Current: ' + text.length }, 400);
  }

  try {
    var raw = await deaiHumanize(context.env, text, mode, multiRun);
    var normalized = normalizeDeaiResult(raw, text);
    return json(normalized);
  } catch (e) {
    console.error('AI Humanizer error:', e && e.message);
    return json({ error: e.message || 'Unknown error from DeAI service' }, 500);
  }
}
