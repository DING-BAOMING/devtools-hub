/**
 * LLM API Cost Calculator - live model pricing feed.
 *
 * Source: https://openrouter.ai/api/v1/models  (public, no auth, no key needed).
 * Normalized to a compact shape so the tool page never has to know the upstream schema.
 *
 * Prices move without warning (providers have cut headline rates by 80% inside a day),
 * so this is fetched live and edge-cached for 30 minutes. Nothing is written to disk.
 */

var UPSTREAM = 'https://openrouter.ai/api/v1/models';
var EDGE_TTL = 1800;

// Upstream prices are USD per single token, as decimal strings.
function num(v) {
  var n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// OpenRouter exposes tiers keyed on min_prompt_tokens (e.g. >200k long-context rates).
// Keep them, sorted ascending, so the tool can price a long prompt at the right tier.
function readTiers(pricing) {
  var out = [];
  var raw = Array.isArray(pricing.overrides) ? pricing.overrides : [];
  for (var i = 0; i < raw.length; i++) {
    var min = parseInt(raw[i].min_prompt_tokens, 10);
    if (!isFinite(min) || min <= 0) continue;
    out.push({
      min: min,
      in: num(raw[i].prompt),
      out: num(raw[i].completion),
      cacheRead: num(raw[i].input_cache_read)
    });
  }
  out.sort(function (a, b) { return a.min - b.min; });
  return out;
}

function normalize(m) {
  var p = m.pricing || {};
  var arch = m.architecture || {};
  var inRate = num(p.prompt);
  var outRate = num(p.completion);
  var mods = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
  return {
    id: m.id,
    name: m.name || m.id,
    provider: m.id.indexOf('/') > -1 ? m.id.split('/')[0] : 'other',
    ctx: typeof m.context_length === 'number' ? m.context_length : 0,
    vision: mods.indexOf('image') > -1,
    reasoning: Array.isArray(m.supported_parameters) &&
      (m.supported_parameters.indexOf('reasoning') > -1 || m.supported_parameters.indexOf('include_reasoning') > -1),
    in: inRate,
    out: outRate,
    // An absent cache rate means the provider bills a cache read at the full input rate.
    cacheRead: num(p.input_cache_read),
    cacheWrite: num(p.input_cache_write),
    // Reasoning tokens are output tokens. Only some models publish a separate rate;
    // for the rest the tool falls back to the tier-aware completion rate.
    reason: num(p.internal_reasoning),
    request: num(p.request),
    tiers: readTiers(p)
  };
}

export async function onRequest(context) {
  const { request } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=' + EDGE_TTL
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: headers, status: 204 });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: headers, status: 405 });
  }

  const cacheKey = new Request(UPSTREAM);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return new Response(await cached.text(), { headers: headers });
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      headers: { Accept: 'application/json', 'User-Agent': 'DevToolsHub/1.0' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Pricing source unreachable: ' + e.message }), { headers: headers, status: 502 });
  }
  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: 'Pricing source returned HTTP ' + upstream.status }), { headers: headers, status: 502 });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Pricing source returned invalid JSON' }), { headers: headers, status: 502 });
  }

  const models = (payload && Array.isArray(payload.data) ? payload.data : [])
    .map(normalize)
    // A model with no rate at all cannot be costed. Drop it rather than show a $0 row.
    .filter(function (m) { return m.in > 0 || m.out > 0; });

  if (!models.length) {
    return new Response(JSON.stringify({ error: 'Pricing source returned no usable models' }), { headers: headers, status: 502 });
  }

  const text = JSON.stringify({
    source: UPSTREAM,
    fetchedAt: new Date().toISOString(),
    count: models.length,
    models: models
  });
  await caches.default.put(cacheKey, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
  return new Response(text, { headers: headers });
}
