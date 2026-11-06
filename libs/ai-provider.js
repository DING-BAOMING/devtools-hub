/**
 * Shared AI provider fan-out.
 *
 * One chat completion, tried across providers until one answers.
 *
 * Why this exists (BUG-327): ten tools hardcoded `model: 'llama-3.3-70b-versatile'`
 * and called Groq directly. Groq decommissioned it, so every one of their buttons
 * returned 404. The hand-written "fallback" ids were dead too — NVIDIA answered
 * `410 Gone` for `meta/llama-3.3-70b-instruct` — so the chain still ended in an error.
 *
 * Rule learned here: never hardcode a provider's model id. Ask the provider what it
 * serves (`GET /models`) and cache the answer for the isolate. A retired id then
 * cannot reach a user's button, and the next retirement costs one GET, not a fix.
 * Every leg discovers its own id now — Groq, NVIDIA, Cloudflare Workers AI and
 * Gemini alike. Gemini is last because its free quota is per *project*, not per key:
 * it is the leg that runs out when the site is busy.
 *
 * Chain: Groq → NVIDIA #1 → NVIDIA #3 → Cloudflare Workers AI → Gemini.
 * Cloudflare sits before Gemini because it has a daily allowance of its own
 * (10,000 neurons/day) and needs no quota that the site owner has to babysit.
 */

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts/';
const TIMEOUT_MS = 15000; // one hung provider must not hold the visitor's button open
const CHAIN_BUDGET_MS = 45000; // a chain that runs past this gives up loudly instead of 502ing
const MAX_MODELS_PER_PROVIDER = 3;

// Discovered once per isolate, keyed by base URL. The whole *list* is cached, not one
// id: a model that needs terms acceptance, is out of quota, or has been retired must
// be walked past, not retried on every request for the life of the isolate.
var modelCache = {};

function usable(key) {
  return !!key && key.indexOf('_NOT_SET') === -1 && key.indexOf('NOT_SET') === -1;
}

// A model list also contains whisper / guard / vision / embedding ids, which reject
// a chat completion. Keep only what can answer /chat/completions.
function chatModels(ids) {
  return ids.filter(function(id) {
    return !/(whisper|guard|tts|vision|embed|moderation|rerank|image|audio)/i.test(id);
  });
}

// A reasoning model (gpt-oss, deepseek-r1, qwq) spends the whole max_tokens budget
// thinking and returns content:"" — a 200 with an empty summary. Rank them last.
var REASONING = /(gpt-oss|deepseek-r|qwq|reasoning|thinking)/i;

function ranked(ids) {
  // Llama first: these prompts were written against a llama and are format-sensitive
  // (several ask for JSON only). Any live chat model beats a dead pinned id.
  var rank = function(id) { return (REASONING.test(id) ? 4 : 0) + (/llama/i.test(id) ? 0 : 2); };
  return ids.slice().sort(function(a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
}

async function discover(base, key) {
  if (modelCache[base]) return modelCache[base];
  var res = await fetch(base + '/models', {
    headers: { 'Authorization': 'Bearer ' + key },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' (model list)');
  var body = await res.json();
  var ids = ranked(chatModels((body.data || body.models || []).map(function(m) { return m.id; })));
  if (!ids.length) throw new Error('no chat model offered');
  modelCache[base] = { list: ids, cursor: 0 };
  return modelCache[base];
}

/**
 * Cloudflare Workers AI has its own catalogue shape: `/ai/models/search` answers
 * `{result:[{name, task:{name}, properties:[{property_id,value}]}]}`, not the
 * OpenAI `{data:[{id}]}` one. Only a "Text Generation" model can answer a chat
 * completion, and the ones flagged `require_workers_paid` are not on the free
 * tier (the free allowance is 10,000 neurons/day).
 */
async function discoverCloudflare(account, token) {
  var cacheKey = 'cf:' + account;
  if (modelCache[cacheKey]) return modelCache[cacheKey];
  var res = await fetch(CF_BASE + account + '/ai/models/search', {
    headers: { 'Authorization': 'Bearer ' + token },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' (model list)');
  var body = await res.json();
  var ids = (body.result || []).filter(function(m) {
    return m && m.task && m.task.name === 'Text Generation';
  }).filter(function(m) {
    var props = {};
    (m.properties || []).forEach(function(p) { props[p.property_id] = p.value; });
    if (String(props.require_workers_paid).toLowerCase() === 'true') return false;
    var dep = props.planned_deprecation_date;
    // A model that goes away next month is a model that breaks next month.
    return !(dep && new Date(dep).getTime() <= Date.now() + 30 * 86400000);
  }).map(function(m) { return m.name; });
  ids = ranked(chatModels(ids));
  if (!ids.length) throw new Error('no chat model offered');
  modelCache[cacheKey] = { list: ids, cursor: 0 };
  return modelCache[cacheKey];
}

/**
 * Gemini's catalogue is `GET /v1beta/models` → `{models:[{name, supportedGenerationMethods}]}`.
 * A model that cannot `generateContent` (an image model, a clip, a transcribe model)
 * is not in the list at all — it is in the list but does not answer a chat prompt.
 */
async function discoverGemini(key) {
  if (modelCache.gemini) return modelCache.gemini;
  var res = await fetch(GEMINI_BASE, {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' (model list)');
  var body = await res.json();
  var ids = (body.models || []).filter(function(m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
  }).map(function(m) { return String(m.name || '').replace(/^models\//, ''); });
  ids = rankedGemini(chatModels(ids));
  if (!ids.length) throw new Error('no chat model offered');
  modelCache.gemini = { list: ids, cursor: 0 };
  return modelCache.gemini;
}

// Gemini's quota is per project, so the cheapest model that can answer wins: the
// flash-lite family first, then flash, then the rest. No id is written down here —
// a retired one cannot reach a visitor (BUG-328).
function rankedGemini(ids) {
  var rank = function(id) {
    if (/flash-lite/i.test(id)) return 0;
    if (/flash/i.test(id)) return 1;
    if (/pro/i.test(id)) return 3;
    return 2;
  };
  return ids.slice().sort(function(a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
}

// Some Workers AI models answer a JSON prompt inside a ```json fence even when
// `response_format` asked for JSON. The fence is not JSON, so it is stripped here
// rather than making every caller write a tolerant parser.
function unfence(text) {
  var m = /^\s*```[a-z]*\s*([\s\S]*?)\s*```\s*$/i.exec(text || '');
  return m ? m[1] : text;
}

// Try this provider's models from the cursor, up to the per-provider cap. The cursor
// only moves forward, so a model that failed once is not the first choice again.
async function tryOpenAI(base, key, opts, deadline) {
  var entry = await discover(base, key);
  var errors = [];
  var tries = Math.min(MAX_MODELS_PER_PROVIDER, entry.list.length);
  for (var n = 0; n < tries; n++) {
    if (Date.now() > deadline) break;
    var i = (entry.cursor + n) % entry.list.length;
    try {
      var data = await callOpenAI(base, key, entry.list[i], opts);
      entry.cursor = i;
      return data;
    } catch (e) {
      errors.push(entry.list[i] + ': ' + e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

// Cloudflare Workers AI speaks the OpenAI chat shape, but its catalogue and its
// base URL are its own (a per-account path, not a host).
async function tryCloudflare(account, token, opts, deadline) {
  var entry = await discoverCloudflare(account, token);
  var errors = [];
  var tries = Math.min(MAX_MODELS_PER_PROVIDER, entry.list.length);
  for (var n = 0; n < tries; n++) {
    if (Date.now() > deadline) break;
    var i = (entry.cursor + n) % entry.list.length;
    try {
      var data = await callOpenAI(CF_BASE + account + '/ai/v1', token, entry.list[i], opts);
      var message = data.choices[0].message;
      message.content = unfence(message.content);
      entry.cursor = i;
      return data;
    } catch (e) {
      errors.push(entry.list[i] + ': ' + e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

// Gemini answers in its own envelope and its quota is per project, so it is the
// last leg: everything cheaper is tried first.
async function tryGemini(key, opts, deadline) {
  var entry = await discoverGemini(key);
  var errors = [];
  var tries = Math.min(MAX_MODELS_PER_PROVIDER, entry.list.length);
  for (var n = 0; n < tries; n++) {
    if (Date.now() > deadline) break;
    var i = (entry.cursor + n) % entry.list.length;
    try {
      var data = await callGemini(key, entry.list[i], opts);
      entry.cursor = i;
      return data;
    } catch (e) {
      errors.push(entry.list[i] + ': ' + e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

/**
 * This provider's live, ranked chat-model ids — or `[]`.
 *
 * For the endpoints that keep their own multi-provider *shape* (ai-detector needs a
 * vote from every provider, not the first that answers) and so cannot just call
 * `aiChat`. Those had hardcoded ids, which is how BUG-327 happened and how its
 * residual shipped: `llama-3.3-70b-versatile` was retired and three tools kept
 * asking for it. They resolve the id here instead.
 *
 * `[]` means discovery failed — key rejected, or the provider offers nothing that can
 * answer a chat completion. Callers must skip the provider; there is deliberately no
 * hardcoded id to fall back to.
 *
 * @param base  provider base URL ending in `/v1` — the list is read from base + '/models'
 */
export async function discoverChatModels(base, key) {
  if (!usable(key)) return [];
  try {
    var entry = await discover(base, key);
    return entry.list;
  } catch (e) {
    return [];
  }
}

/**
 * Gemini's live, ranked chat-model ids — or `[]`.
 *
 * Same contract as `discoverChatModels`, for Gemini's own catalogue shape. The two
 * endpoints that keep their own provider shape (translator, ai-detector) use this
 * so no Gemini model id is written down anywhere.
 */
export async function discoverGeminiModels(key) {
  if (!usable(key)) return [];
  try {
    var entry = await discoverGemini(key);
    return entry.list;
  } catch (e) {
    return [];
  }
}

/**
 * Resolve the model id a PROVIDERS-array entry should actually send.
 *
 * The remaining AI endpoints keep their own multi-provider loop and their own
 * `maxTokens` per provider, so they do not go through `aiChat` — but they carried the
 * same defect BUG-327 describes. They each listed ids like
 * `llama-3.3-70b-versatile` (decommissioned) and `meta/llama-3.3-70b-instruct`
 * (`410 Gone`), so each request first spent a round trip on a dead leg: measured 22s
 * for `essay-writer` and 48s for `product-description-generator` on 2026-10-10, and
 * `translator` returned 402 outright.
 *
 * @param entry  one PROVIDERS-array entry. `base` (…/v1) is read for the live list.
 * @returns the id to send, or null when the provider offers none — callers must skip
 *          the provider. `null` is deliberately not a licence to send a hardcoded id.
 */
export async function resolveModelId(entry, key) {
  var base = entry.base || entry.url.replace(/\/chat\/completions$/, '');
  var models = await discoverChatModels(base, key);
  if (models.length) return models[0];
  // A provider with no /models list (or one that just rejected the key) still has to
  // work, so its own declared id is the last resort — but only here, in one place,
  // where the gate can see it.
  return entry.model || null;
}

async function callOpenAI(base, key, model, opts) {
  var res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: opts.messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: opts.max_tokens || 2048,
      // Six of these prompts end "Return valid JSON only". Asking is not enough: without
      // this a model returns JSON with a raw quote inside a string and JSON.parse throws
      // (ats-resume-checker 500: "Bad escaped character in JSON").
      response_format: opts.json ? { type: 'json_object' } : undefined
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) {
    var text = await res.text().catch(function() { return ''; });
    throw new Error('HTTP ' + res.status + ' ' + text.substring(0, 160));
  }
  var data = await res.json();
  var content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    // Reasoning models emit their answer into `reasoning` and leave content empty.
    // That is not an answer: fail the leg so the chain moves on.
    throw new Error('empty completion' + (data.choices?.[0]?.message?.reasoning_content ? ' (reasoning model)' : ''));
  }
  data.provider = opts.providerName;
  data.model = data.model || model;
  return data;
}

async function callGemini(key, model, opts) {
  // Gemini takes one prompt, not a message list, and answers in its own envelope.
  var prompt = opts.messages.map(function(m) { return m.content; }).join('\n\n');
  var res = await fetch(
    GEMINI_BASE + '/' + model + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts.temperature == null ? 0.3 : opts.temperature,
          maxOutputTokens: opts.max_tokens || 2048,
          responseMimeType: opts.json ? 'application/json' : undefined
        }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  );
  if (!res.ok) {
    var text = await res.text().catch(function() { return ''; });
    throw new Error('HTTP ' + res.status + ' ' + text.substring(0, 160));
  }
  var body = await res.json();
  var content = body.candidates?.[0]?.content?.parts?.map(function(p) { return p.text; }).join('') || '';
  if (!content) throw new Error('empty response');
  return {
    provider: 'Gemini',
    model: model,
    choices: [{ message: { role: 'assistant', content: content } }]
  };
}

/**
 * @param opts.json  true when the caller's prompt demands JSON. Sent as
 *        `response_format` / `responseMimeType` so a valid document comes back.
 * @returns {{content: string, model: string, provider: string, data: object}}
 *          `data` is OpenAI-shaped, so any caller that used to pass the provider
 *          response straight through to its page still can.
 * @throws  Error naming every provider it tried, so the page can show the reason
 *          instead of "something went wrong" (the BUG-322 rule).
 */
export async function aiChat(env, opts) {
  var targets = [
    { name: 'Groq', kind: 'openai', key: env.DEVTOOLS_GROQ_API_KEY, base: GROQ_BASE },
    { name: 'NVIDIA', kind: 'openai', key: env.DEVTOOLS_NVIDIA_KEY_1, base: NVIDIA_BASE },
    { name: 'NVIDIA', kind: 'openai', key: env.DEVTOOLS_NVIDIA_KEY_3, base: NVIDIA_BASE },
    { name: 'Cloudflare', kind: 'cf', key: env.CLOUDFLARE_API_TOKEN, account: env.CF_ACCOUNT_ID },
    { name: 'Gemini', kind: 'gemini', key: env.DEVTOOLS_GEMINI_KEY }
  ];

  var deadline = Date.now() + CHAIN_BUDGET_MS;
  var failures = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    if (!usable(t.key)) continue;
    if (t.kind === 'cf' && !usable(t.account)) continue;
    try {
      var call = Object.assign({ providerName: t.name }, opts);
      var data;
      if (t.kind === 'openai') {
        data = await tryOpenAI(t.base, t.key, call, deadline);
      } else if (t.kind === 'cf') {
        data = await tryCloudflare(t.account, t.key, call, deadline);
      } else {
        data = await tryGemini(t.key, call, deadline);
      }
      return { content: data.choices[0].message.content, model: data.model, provider: data.provider, data: data };
    } catch (e) {
      failures.push(t.name + ': ' + e.message);
      if (Date.now() > deadline) {
        failures.push('stopped after ' + CHAIN_BUDGET_MS / 1000 + 's');
        break;
      }
    }
  }
  throw new Error(failures.length
    ? 'All AI providers failed — ' + failures.join(' | ')
    : 'No AI provider key is configured on this site.');
}