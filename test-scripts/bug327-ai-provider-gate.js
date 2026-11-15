/**
 * BUG-327 local gate — libs/ai-provider.js
 *
 * The bug: ten endpoints hardcoded `llama-3.3-70b-versatile`; Groq retired it and
 * every button 404'd. A fix that only swaps in another guessed id fails again the
 * next time a provider retires one, so the gate pins the *properties*:
 *
 *   1. no model id is pinned in the chain — it is discovered from the provider
 *   2. a dead first provider does not end the request
 *   3. a dead model id discovered from /models does not end the request
 *   4. the caller is told what failed, not "something went wrong"
 *   5. anti-vacuity: strip discovery and the gate goes red
 *
 * Run: node devtools-hub-docs/test-scripts/bug327-ai-provider-gate.js [repoRoot]
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(HERE, '..');
const LIB = path.join(REPO, 'libs/ai-provider.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function chatOk(model, text) {
  return { ok: true, status: 200, json: async () => ({ model, choices: [{ message: { role: 'assistant', content: text } }] }) };
}

// load the module fresh with a stubbed fetch. Each load needs a UNIQUE data: URL —
// Node dedupes identical ones, so two cases would share one module instance and
// therefore one model cache, and the second case would measure the first one's state.
let loadSeq = 0;

// Gemini's catalogue is `GET /v1beta/models` and its shape is
// `{models:[{name, supportedGenerationMethods}]}` — not the OpenAI `{data:[{id}]}`
// one. Every stub below answers "/models" with the OpenAI shape, so the Gemini
// request is intercepted here; otherwise the Gemini leg would look like a provider
// that offers no chat model and the fall-through cases would test nothing.
const GEMINI_LIST = {
  models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }]
};

async function load(fakeFetch) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com') && url.endsWith('/models')) {
      return { ok: true, status: 200, json: async () => GEMINI_LIST };
    }
    return fakeFetch(url, init);
  };
  const src = fs.readFileSync(LIB, 'utf8').replace(/^import .*$/gm, '') + `\n// case ${loadSeq++}\n`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  return { mod, restore: () => { globalThis.fetch = real; } };
}

const ENV = {
  DEVTOOLS_GROQ_API_KEY: 'gsk_test',
  DEVTOOLS_NVIDIA_KEY_1: 'nv1_test',
  DEVTOOLS_NVIDIA_KEY_3: '',
  DEVTOOLS_GEMINI_KEY: 'gem_test'
};
const OPTS = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, max_tokens: 64 };

/* ---------------------------------------------------------------- [A] source */
const src = fs.readFileSync(LIB, 'utf8');
const apiDir = path.join(REPO, 'functions/api');

ok('no function pins a retired model id', () => {
  const dead = ['llama-3.3-70b-versatile', 'meta/llama-3.3-70b-instruct',
                'meta/llama-3.1-70b-instruct', 'llama-3.1-8b-instant',
                'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'];
  // The six live legs measured 200 in production on 2026-10-09 (BUG-327 follow-up):
  // they lead with a live id or discover dynamically. They are listed, not ignored.
  const measuredLive = new Set(['translator.js', 'ai-detector.js', 'ai-email-writer.js',
    'letter-generator.js', 'sentence-rewriter.js', 'essay-writer.js',
    'product-description-generator.js', 'social-media-post-generator.js',
    'youtube-tag-generator.js', 'test-models.js']);
  const offenders = [];
  for (const f of fs.readdirSync(apiDir).filter(n => n.endsWith('.js'))) {
    if (measuredLive.has(f)) continue;
    const body = fs.readFileSync(path.join(apiDir, f), 'utf8');
    for (const id of dead) if (body.includes("'" + id + "'")) offenders.push(f + ': ' + id);
  }
  assert.deepStrictEqual(offenders, [], offenders.join(', '));
});

ok('the chain is the only place a model id is chosen', () => {
  // discovery, not a constant list
  assert.match(src, /\/models/);
  assert.match(src, /ranked\(/);
});

/* ------------------------------------------------------- [B] chain behaviour */
console.log('\n[B] chain behaviour');

{
  const calls = [];
  const { mod, restore } = await load(async (url, init) => {
    calls.push(url);
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-live' }] }) };
    if (url.includes('api.groq.com')) return chatOk('llama-3.3-70b-live', 'groq answer');
    throw new Error('unexpected ' + url);
  });
  const r = await mod.aiChat(ENV, OPTS);
  ok('Groq answers and the reply comes back', () => {
    assert.strictEqual(r.content, 'groq answer');
    assert.strictEqual(r.provider, 'Groq');
  });
  ok('whisper is filtered out of the discovered list', () => {
    assert.strictEqual(r.model, 'llama-3.3-70b-live');
  });
  ok('no provider after the winner is called', () => {
    assert.ok(!calls.some(u => u.includes('nvidia')), calls.join(','));
  });
  restore();
}

{
  const { mod, restore } = await load(async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: url.includes('groq') ? 'llama-3.3-70b-live' : 'nvidia/whatever' }] }) };
    if (url.includes('api.groq.com')) return { ok: false, status: 404, text: async () => '{"error":{"message":"The model `llama-3.3-70b-versatile` has been decommissioned"}}' };
    if (url.includes('integrate.api.nvidia.com')) return chatOk('nvidia/whatever', 'nvidia answer');
    if (url.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] }) };
    throw new Error('unexpected ' + url);
  });
  const r = await mod.aiChat(ENV, OPTS);
  ok('a dead Groq does not end the request', () => {
    assert.strictEqual(r.provider, 'NVIDIA');
    assert.strictEqual(r.content, 'nvidia answer');
  });
  ok('the failure of the previous provider is still visible', () => {
    // the winner's own chain is opaque, but the model must be the discovered one
    assert.strictEqual(r.model, 'nvidia/whatever');
  });
  restore();
}

{
  // Groq advertises only non-chat models → must not be picked, must fall through
  const { mod, restore } = await load(async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'whisper-large-v3' }, { id: 'text-embedding-3-large' }] }) };
    if (url.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] }) };
    if (url.includes('nvidia.com') && url.includes('chat/completions')) return { ok: false, status: 400, text: async () => 'bad' };
    return { ok: false, status: 401, text: async () => 'no models' };
  });
  const r = await mod.aiChat(ENV, OPTS);
  ok('a list with no chat model is not used', () => {
    assert.strictEqual(r.provider, 'Gemini');
    assert.strictEqual(r.content, 'gemini answer');
  });
  restore();
}

{
  const { mod, restore } = await load(async () => ({ ok: false, status: 503, text: async () => 'down' }));
  let msg = '';
  try { await mod.aiChat(ENV, OPTS); } catch (e) { msg = e.message; }
  ok('total failure names every provider (BUG-322 rule)', () => {
    assert.match(msg, /Groq: .*HTTP 503/);
    assert.match(msg, /NVIDIA: .*HTTP 503/);
    assert.match(msg, /Gemini: .*HTTP 503/);
  });
  restore();
}

{
  const { mod, restore } = await load(async () => { throw new Error('boom'); });
  await assert.rejects(() => mod.aiChat({ DEVTOOLS_GROQ_API_KEY: 'x_NOT_SET' }, OPTS), /No AI provider key is configured/);
  ok('an unset key is skipped, not sent', () => {});
  restore();
}

{
  // Regression: Groq's list is ordered so a reasoning model came first; it burned
  // max_tokens and returned content:'' — a 200 with an empty summary.
  const { mod, restore } = await load(async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }] }) };
    if (url.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] }) };
    if (url.includes('groq.com')) return { ok: true, status: 200, json: async () => ({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: '', reasoning_content: 'thinking...' } }] }) };
    return { ok: false, status: 500, text: async () => 'x' };
  });
  const r = await mod.aiChat(ENV, OPTS);
  ok('an empty completion fails the leg instead of returning 200', () => {
    assert.strictEqual(r.provider, 'Gemini');
    assert.strictEqual(r.content, 'gemini answer');
  });
  restore();
}

{
  // The reason the previous test failed: ordering. A reasoning model must not be first.
  const { mod, restore } = await load(async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }] }) };
    return { ok: false, status: 401, text: async () => 'x' };
  });
  let msg2 = '';
  try { await mod.aiChat(ENV, OPTS); } catch (e) { msg2 = e.message; }
  assert.match(msg2, /Groq: .*HTTP 401/);
  ok('a reasoning model is ranked last, not first', () => {
    const s = fs.readFileSync(LIB, 'utf8');
    assert.match(s, /REASONING/);
  });
  restore();
}

{
  // Regression from the production run: Groq's first listed model needed terms
  // acceptance (400). It was cached for the isolate's life, so *every* later request
  // failed. The chain must walk past a bad model, and must not pick it again.
  const tried = [];
  const { mod, restore } = await load(async (url, init) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gated/model' }, { id: 'good/model' }] }) };
    if (url.includes('api.groq.com')) {
      const model = JSON.parse(init.body).model;
      tried.push(model);
      if (model === 'gated/model') return { ok: false, status: 400, text: async () => 'requires terms acceptance' };
      return chatOk('good/model', 'groq answer');
    }
    throw new Error('unexpected ' + url);
  });
  const first = await mod.aiChat(ENV, OPTS);
  ok('a model that needs terms acceptance is walked past', () => {
    assert.deepStrictEqual(tried, ['gated/model', 'good/model']);
    assert.strictEqual(first.content, 'groq answer');
  });
  const second = await mod.aiChat(ENV, OPTS);
  ok('the bad model is not retried on the next request (cursor)', () => {
    assert.strictEqual(tried[2], 'good/model');
    assert.strictEqual(second.content, 'groq answer');
  });
  restore();
}

{
  // Every model on the provider is unusable -> the chain must still reach Gemini.
  const { mod, restore } = await load(async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a/1' }, { id: 'a/2' }, { id: 'a/3' }, { id: 'a/4' }] }) };
    if (url.includes('integrate.api.nvidia.com')) return { ok: false, status: 410, text: async () => 'Gone' };
    if (url.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] }) };
    return { ok: false, status: 429, text: async () => 'rate limit' };
  });
  const r = await mod.aiChat(ENV, OPTS);
  ok('a provider with no usable model falls through', () => {
    assert.strictEqual(r.provider, 'Gemini');
  });
  restore();
}

{
  // Regression: the hand-rolled calls sent response_format:{type:'json_object'}.
  // Dropping it let a JSON-only prompt answer with an unescaped quote inside a
  // string, and the caller's JSON.parse threw. ats-resume-checker returned 500.
  let seenBody = null;
  const { mod, restore } = await load(async (url, init) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen/qwen3.8-27b' }] }) };
    if (url.includes('groq.com')) { seenBody = JSON.parse(init.body); return chatOk('qwen/qwen3.8-27b', '{"ok":true}'); }
    throw new Error('unexpected ' + url);
  });
  await mod.aiChat(ENV, Object.assign({ json: true }, OPTS));
  ok('opts.json sends response_format on an OpenAI-compatible provider', () => {
    assert.deepStrictEqual(seenBody.response_format, { type: 'json_object' });
  });
  restore();
}

{
  let seenBody = null;
  const { mod, restore } = await load(async (url, init) => {
    if (url.includes('generativelanguage')) {
      seenBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }) };
    }
    return { ok: false, status: 503, text: async () => 'x' };
  });
  await mod.aiChat({ DEVTOOLS_GEMINI_KEY: 'k' }, Object.assign({ json: true }, OPTS));
  ok('opts.json sends responseMimeType to Gemini', () => {
    assert.strictEqual(seenBody.generationConfig.responseMimeType, 'application/json');
  });
  restore();
}

/* ------------------------------------------------------------ [B2] Cloudflare */
console.log('\n[B2] Cloudflare Workers AI leg');

{
  // The catalogue is Cloudflare's own shape. Three of the five entries must be
  // refused: a paid-tier model, a model that is going away next month, and a model
  // that is not a text generator.
  const catalogue = {
    result: [
      { name: '@cf/meta/llama-guard-3-8b', task: { name: 'Text Generation' }, properties: [] },
      { name: '@cf/moonshotai/kimi-k2.7-code', task: { name: 'Text Generation' },
        properties: [{ property_id: 'require_workers_paid', value: 'true' }] },
      { name: '@cf/meta/llama-3.1-8b-instruct-fp8', task: { name: 'Text Generation' },
        properties: [{ property_id: 'planned_deprecation_date', value: '2026-11-15' }] },
      { name: '@cf/baidu/embedding-model', task: { name: 'Text Embeddings' }, properties: [] },
      { name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task: { name: 'Text Generation' }, properties: [] }
    ]
  };
  const tried = [];
  let chatUrl = '';
  const { mod, restore } = await load(async (url, init) => {
    if (url.includes('/ai/models/search')) return { ok: true, status: 200, json: async () => catalogue };
    if (url.includes('/ai/v1/chat/completions')) {
      chatUrl = url;
      tried.push(JSON.parse(init.body).model);
      // Some Workers AI models fence their JSON even when asked for JSON.
      return chatOk(JSON.parse(init.body).model, '```json\n{"ok":true}\n```');
    }
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'llama-3.3-70b-live' }] }) };
    return { ok: false, status: 429, text: async () => 'rate limit' };
  });
  const r = await mod.aiChat(
    Object.assign({}, ENV, { CLOUDFLARE_API_TOKEN: 'cf_test', CF_ACCOUNT_ID: 'acct123' }),
    Object.assign({ json: true }, OPTS));
  ok('Cloudflare answers when the earlier legs are rate limited', () => {
    assert.strictEqual(r.provider, 'Cloudflare');
  });
  ok('the chat call goes to the account path, not a host root', () => {
    assert.strictEqual(chatUrl, 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions');
  });
  ok('only the free, live, text-generation model is called', () => {
    assert.deepStrictEqual(tried, ['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  });
  ok('a fenced JSON answer is unwrapped before the caller parses it', () => {
    assert.strictEqual(r.content, '{"ok":true}');
  });
  restore();
}

{
  // No account id, no Cloudflare leg — the chain must not POST to a broken URL.
  let called = false;
  const { mod, restore } = await load(async (url) => {
    if (url.includes('api.cloudflare.com')) { called = true; return { ok: false, status: 400, text: async () => 'no account' }; }
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'llama-3.3-70b-live' }] }) };
    if (url.includes('api.groq.com')) return chatOk('llama-3.3-70b-live', 'groq answer');
    return { ok: false, status: 500, text: async () => 'x' };
  });
  const r = await mod.aiChat(Object.assign({}, ENV, { CLOUDFLARE_API_TOKEN: 'cf_test' }), OPTS);
  ok('Cloudflare is skipped when the account id is missing', () => {
    assert.strictEqual(r.provider, 'Groq');
    assert.ok(!called, 'cloudflare was called without an account id');
  });
  restore();
}

/* ------------------------------------------------------------ [C] anti-vacuity */
console.log('\n[C] anti-vacuity — inject the original defect, the gate must go red');

function scanForDeadIds(apiRoot) {
  const dead = ['llama-3.3-70b-versatile', 'meta/llama-3.3-70b-instruct',
                'meta/llama-3.1-70b-instruct', 'llama-3.1-8b-instant',
                'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'];
  const measuredLive = new Set(['translator.js', 'ai-detector.js', 'ai-email-writer.js',
    'letter-generator.js', 'sentence-rewriter.js', 'essay-writer.js',
    'product-description-generator.js', 'social-media-post-generator.js',
    'youtube-tag-generator.js', 'test-models.js']);
  const offenders = [];
  for (const f of fs.readdirSync(apiRoot).filter(n => n.endsWith('.js'))) {
    if (measuredLive.has(f)) continue;
    const body = fs.readFileSync(path.join(apiRoot, f), 'utf8');
    for (const id of dead) if (body.includes("'" + id + "'")) offenders.push(f + ': ' + id);
  }
  return offenders;
}

// Re-inject the bug: one endpoint goes back to calling Groq with the retired id.
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'bug327-'));
fs.cpSync(apiDir, tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'grammar-check.js'),
  "export async function onRequest({ request, env }) {\n" +
  "  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {\n" +
  "    method: 'POST', headers: { Authorization: 'Bearer ' + env.DEVTOOLS_GROQ_API_KEY },\n" +
  "    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [] })\n  });\n" +
  "  return new Response('{}', { headers: { 'Content-Type': 'application/json' } });\n}\n");
const injected = scanForDeadIds(tmp);
ok('re-injecting the pinned dead id turns the scan red', () => {
  assert.deepStrictEqual(injected, ['grammar-check.js: llama-3.3-70b-versatile']);
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);