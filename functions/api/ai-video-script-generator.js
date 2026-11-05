import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Video Script Generator API - viral video scripts
 *
 * Endpoints:
 *   POST /api/ai-video-script-generator - Generate a video script
 *   GET  /api/ai-video-script-generator - Health check
 *
 * Env: DEVTOOLS_GROQ_API_KEY / DEVTOOLS_NVIDIA_KEY_1 / DEVTOOLS_AGNES_KEY_1 / DEVTOOLS_AGNES_KEY_2 / DEVTOOLS_DEAI_KEY
 * DeAI: https://deai.029101.xyz (self-hosted) - humanizes the generated script, falls back to raw script
 */

var DEAI_BASE = 'https://deai.029101.xyz';
var MIN_SCRIPT_LEN = 10;
var MAX_SCRIPT_LEN = 6000;

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

var PLATFORMS = {
  'youtube-shorts': { label: 'YouTube Shorts', kind: 'short', max_seconds: 60, min_seconds: 15, default_seconds: 30 },
  tiktok: { label: 'TikTok', kind: 'short', max_seconds: 60, min_seconds: 15, default_seconds: 30 },
  'instagram-reels': { label: 'Instagram Reels', kind: 'short', max_seconds: 90, min_seconds: 15, default_seconds: 60 },
  youtube: { label: 'YouTube (long-form)', kind: 'long', max_seconds: 300, min_seconds: 60, default_seconds: 120 },
  generic: { label: 'Generic social video', kind: 'short', max_seconds: 60, min_seconds: 15, default_seconds: 30 }
};

var TONES = ['professional', 'casual', 'humorous', 'inspirational', 'educational'];
var LANGUAGES = ['en', 'zh', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'it'];

function buildSystemPrompt(platform, tone, language, niche, includeCta) {
  var pl = PLATFORMS[platform] || PLATFORMS.generic;
  var langName = language === 'en' ? 'English' : language.toUpperCase() + ' language';
  var nicheLine = niche ? 'Niche/Industry: ' + niche + '.' : '';
  var ctaLine = includeCta ? 'Include a call-to-action in the final beat (subscribe, follow, comment, try). Keep it natural.' : 'Do not force a call-to-action.';
  return 'You are a world-class viral video scriptwriter for short-form and long-form video content.\n' +
    'Write a complete, shoot-ready video script for: platform=' + platform + ' (' + pl.label + ', target ' + pl.default_seconds + 's).\n' +
    'Tone: ' + tone + '. Language: ' + langName + '. ' + ctaLine + ' ' + nicheLine + '\n\n' +
    'Structure the script around a proven viral arc:\n' +
    '1. HOOK - first 1-3 seconds, stop-the-scroll line. Specific, curiosity gap, or bold claim.\n' +
    '2. BODY - delivers value / story / explanation. Pace for ' + pl.default_seconds + 's target.\n' +
    '3. PAYOFF - the turn, revelation, or satisfying conclusion.\n' +
    '4. CTA - optional natural call-to-action.\n\n' +
    'Output language for all text: ' + langName + '. Write the hook, body and payoff as natural spoken-style prose (short sentences, rhythm, contractions where the language allows). No emojis unless tone allows. No markdown fences. No preamble.\n\n' +
    'Return ONLY a valid JSON object with exactly these keys: "hook", "body", "payoff", "cta", "full_text".\n' +
    '  "hook" - the opening line(s), <= 25 words.\n' +
    '  "body" - the main script content, <= ' + (platform === 'youtube' ? 550 : 260) + ' words.\n' +
    '  "payoff" - the closing beat, <= 30 words.\n' +
    '  "cta" - call-to-action text or empty string.\n' +
    '  "full_text" - the complete script combining hook + body + payoff (+ cta), ready to paste into a script app or teleprompter.\n' +
    'Respect the platform target duration. Stay inside the word budget. Return only the JSON.';
}

function buildUserPrompt(topic, platform, tone, language, niche, includeCta) {
  var pl = PLATFORMS[platform] || PLATFORMS.generic;
  return 'Topic/idea: ' + topic + '\n\n' +
    'Write the viral video script for ' + platform + ' (' + pl.label + ').\n' +
    'Tone: ' + tone + '. Include call-to-action: ' + (includeCta ? 'yes' : 'no') + '. ' + (niche ? 'Niche: ' + niche + '.' : '') + '\n\n' +
    'Return only the JSON object.';
}

function fallbackScript(topic, tone, includeCta) {
  var hook = 'Most people get ' + topic + ' wrong - and it quietly costs them the outcome they wanted.';
  var body = 'Here is the honest version. ' + topic + ' is not about doing more of the obvious thing. It is about sequencing, focus and one sharp idea executed well. That is exactly what this script breaks down, step by step, without the filler.';
  var payoff = 'That is the real insight: small inputs, extreme consistency, compounding output.';
  var cta = includeCta ? 'Want the full playbook? Start with the first step and go deep.' : '';
  var full = [hook, body, payoff].filter(Boolean).join('\n\n');
  if (cta) full += '\n\n' + cta;
  return { hook: hook, body: body, payoff: payoff, cta: cta, full_text: full };
}

function extractJson(text) {
  var cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) {
    var m = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) cleaned = m[1];
  }
  var first = cleaned.indexOf('{');
  var last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) cleaned = cleaned.substring(first, last + 1);
  return JSON.parse(cleaned);
}

function assembleScript(parsed) {
  var hook = (parsed.hook || '').toString().trim();
  var body = (parsed.body || '').toString().trim();
  var payoff = (parsed.payoff || '').toString().trim();
  var cta = (parsed.cta || '').toString().trim();
  var full = (parsed.full_text || '').toString().trim();
  if (!full) {
    full = [hook, body, payoff, cta].filter(function(s) { return s && s.length > 0; }).join('\n\n');
  }
  var wordCount = full.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  var estSeconds = Math.max(5, Math.round(wordCount / 2.5));
  return { hook: hook, body: body, payoff: payoff, cta: cta, full_text: full, word_count: wordCount, est_seconds: estSeconds, char_count: full.length };
}

async function fetchWithTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var timer = setTimeout(function() { ctl.abort('timeout'); }, ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function callAI(env, messages, maxTokens) {
  var errors = [];
  var providers = [
    { name: 'agnes1', url: 'https://apihub.agnes-ai.com/v1/chat/completions', base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', envKey: 'DEVTOOLS_AGNES_KEY_1' },
    { name: 'agnes2', url: 'https://apihub.agnes-ai.com/v1/chat/completions', base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', envKey: 'DEVTOOLS_AGNES_KEY_2' },
    // BUG-327: Groq decommissioned the id this used to declare and NVIDIA answers 410 Gone for
    // its one. A declared id is only the LAST resort inside resolveModelId, so a dead one is a
    // guaranteed dead round trip. Neither provider declares an id here — the shared resolver
    // asks the provider which chat models it serves (BUG-328: never write a model id down).
    { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', base: 'https://api.groq.com/openai/v1', envKey: 'DEVTOOLS_GROQ_API_KEY' },
    { name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', base: 'https://integrate.api.nvidia.com/v1', envKey: 'DEVTOOLS_NVIDIA_KEY_1' }
  ];
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    var apiKey = env[p.envKey];
    if (!apiKey) continue;
    try {
      var model = await resolveModelId({ base: p.base, model: p.model }, apiKey);
      // null = the provider offered no model we could read. Skip it; sending model:null would
      // be a guaranteed dead leg.
      if (!model) { errors.push(p.name + ': no_model_offered'); continue; }
      var body = { model: model, messages: messages, temperature: 0.85, max_tokens: maxTokens };
      var response = await fetchWithTimeout(p.url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000);
      if (response.status === 429) { errors.push(p.name + ': rate_limited'); await new Promise(function(r) { setTimeout(r, 1500); }); continue; }
      if (!response.ok) { var errTxt = await response.text().catch(function() { return ''; }); errors.push(p.name + ': HTTP ' + response.status + ' ' + errTxt.substring(0, 80)); continue; }
      var data = await response.json();
      var content = data && data.choices ? data.choices[0].message.content : null;
      if (content) return { content: content, provider: p.name };
      errors.push(p.name + ': empty_content');
    } catch (e) {
      errors.push(p.name + ': ' + (e.message || 'unknown'));
    }
  }
  throw new Error('All providers failed: ' + errors.join(' | '));
}

async function deaiHumanize(env, text, mode) {
  var key = env.DEVTOOLS_DEAI_KEY;
  if (!key) throw new Error('DEAI key not configured (DEVTOOLS_DEAI_KEY)');
  var resp = await fetch(DEAI_BASE + '/humanize', {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text, mode: mode, multi_run: 1, return_readability: false, wait: true })
  });
  if (resp.status === 429) throw new Error('DeAI rate limit exceeded (60 req/min). Please wait a moment.');
  if (resp.status === 422) { var errBody = await resp.json().catch(function() { return {}; }); throw new Error('Validation error: ' + (errBody.detail ? JSON.stringify(errBody.detail) : 'invalid input')); }
  if (!resp.ok) { var errText = await resp.text().catch(function() { return ''; }); throw new Error('DeAI HTTP ' + resp.status + ': ' + errText.substring(0, 200)); }
  return await resp.json();
}

export async function onRequest(context) {
  var env = context.env;
  var request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'ai-video-script-generator',
      version: '1.0.0',
      status: 'ready',
      upstream_ai: ['Groq', 'NVIDIA', 'Agnes'],
      deai: 'https://deai.029101.xyz',
      platforms: Object.keys(PLATFORMS),
      tones: TONES,
      languages: LANGUAGES
    }), { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }

  var body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }); }

  var topic = (body.topic || '').toString().trim();
  var platform = (body.platform || 'youtube-shorts').toString();
  var tone = (body.tone || 'professional').toString();
  var language = (body.language || 'en').toString();
  var niche = (body.niche || '').toString().trim();
  var includeCta = body.include_cta !== false;
  var mode = (body.mode || 'balanced').toString();

  if (!PLATFORMS[platform]) platform = 'youtube-shorts';
  if (!TONES.includes(tone)) tone = 'professional';
  if (!LANGUAGES.includes(language)) language = 'en';
  if (mode !== 'safe' && mode !== 'balanced' && mode !== 'aggressive') mode = 'balanced';

  if (!topic || topic.length < MIN_SCRIPT_LEN) {
    return new Response(JSON.stringify({ error: 'topic is required and must be at least ' + MIN_SCRIPT_LEN + ' characters. Current: ' + topic.length }), { status: 422, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }
  if (topic.length > MAX_SCRIPT_LEN) {
    return new Response(JSON.stringify({ error: 'topic must be ' + MAX_SCRIPT_LEN + ' characters or less. Current: ' + topic.length }), { status: 422, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
  }

  var fallback = fallbackScript(topic, tone, includeCta);
  var script = fallback;
  var aiProvider = null;
  var aiError = null;

  try {
    var systemPrompt = buildSystemPrompt(platform, tone, language, niche, includeCta);
    var userPrompt = buildUserPrompt(topic, platform, tone, language, niche, includeCta);
    var aiResult = await callAI(env, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], 2500);
    aiProvider = aiResult.provider;
    var parsed = extractJson(aiResult.content);
    var assembled = assembleScript(parsed);
    if (assembled.full_text && assembled.word_count > 0) script = assembled;
    else aiError = 'AI returned incomplete script';
  } catch (e) {
    aiError = e.message;
  }

  var humanized = null;
  var deai = { ok: false, skipped: false, reason: null };
  try {
    var deaiRaw = await deaiHumanize(env, script.full_text, mode);
    humanized = deaiRaw.result || script.full_text;
    deai = { ok: true, skipped: !!deaiRaw.skipped, reason: deaiRaw.reason || null, stage_reached: deaiRaw.stage_reached != null ? deaiRaw.stage_reached : null, elapsed_sec: deaiRaw.elapsed_sec != null ? deaiRaw.elapsed_sec : null };
  } catch (e) {
    deai = { ok: false, skipped: false, reason: e.message || 'DeAI unavailable' };
    humanized = script.full_text;
  }

  var finalText = humanized || script.full_text;
  var finalScript = assembleScript({ hook: script.hook, body: script.body, payoff: script.payoff, cta: script.cta, full_text: finalText });
  finalScript.platform = platform;

  return new Response(JSON.stringify({
    script: finalScript,
    meta: {
      platform: platform,
      tone: tone,
      language: language,
      niche: niche,
      include_cta: includeCta,
      ai_provider: aiProvider,
      ai_error: aiError,
      deai: deai,
      mode: mode
    }
  }), { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}
