/**
 * Node harness for functions/api/ai-content-writer.js.
 * workerd cannot run on this host (glibc too old), so the function is imported
 * as plain ESM and driven through the same onRequest() entry point Pages uses.
 * `caches` is the only Cloudflare global it touches; stubbed with a Map.
 */
import assert from 'node:assert';

const store = new Map();
globalThis.caches = {
  default: {
    async match(k) { return store.get(k.url) || null; },
    async put(k, v) { store.set(k.url, v); }
  }
};

const mod = await import('../functions/api/ai-content-writer.js');

async function call(opts = {}) {
  const { env = {}, ...rest } = opts;
  const req = new Request('https://tools.scoreroute.com/api/ai-content-writer' + (rest.qs || ''), {
    method: rest.method || 'GET',
    ...(rest.method === 'POST' ? { body: JSON.stringify(rest.body || {}) } : {})
  });
  const res = await mod.onRequest({ request: req, env });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body, headers: res.headers };
}

let fails = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails++; console.log('  FAIL ' + name + ' -> ' + e.message); }
}

const env = { DEVTOOLS_DEAI_KEY: 'test-deai-key' };

console.log('ai-content-writer GET (live shape)');
const g = await call({ env });
check('HTTP 200', () => assert.strictEqual(g.status, 200));
check('tool name', () => assert.strictEqual(g.body.tool, 'ai-content-writer'));
check('status ready', () => assert.strictEqual(g.body.status, 'ready'));
check('blog_post format advertised', () => assert.ok(Array.isArray(g.body.formats) && g.body.formats.includes('blog_post')));
check('deai_available true', () => assert.strictEqual(g.body.deai_available, true));

console.log('ai-content-writer OPTIONS');
const o = await call({ method: 'OPTIONS' });
check('HTTP 204', () => assert.strictEqual(o.status, 204));

console.log('ai-content-writer POST validation');
const noTopic = await call({ method: 'POST', env, body: { topic: '', tone: 'general', length: 'medium', audience: 'general', format: 'blog_post' } });
check('empty topic -> 422', () => assert.strictEqual(noTopic.status, 422));

const longTopic = await call({ method: 'POST', env, body: { topic: 'x'.repeat(501), format: 'blog_post' } });
check('501-char topic -> 422', () => assert.strictEqual(longTopic.status, 422));

console.log('ai-content-writer POST without provider keys (local, no LLM creds)');
const noKeyEnv = { DEVTOOLS_DEAI_KEY: 'test-deai-key' };
delete noKeyEnv.DEVTOOLS_GROQ_API_KEY;
const p = await call({ method: 'POST', env: noKeyEnv, body: { topic: 'why carbon pricing matters', format: 'blog_post' } }).catch(e => ({ threw: true, err: e.message }));
check('provider failure surfaces as error (no silent hallucinated content)', () => assert.ok(p.threw, 'expected throw without provider keys, got ' + JSON.stringify(p)));

console.log('');
if (fails) { console.log('FAILURES: ' + fails); process.exit(1); }
console.log('ALL_CHECKS_PASSED');
