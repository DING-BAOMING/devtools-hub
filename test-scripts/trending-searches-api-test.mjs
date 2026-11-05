/**
 * Node harness for functions/api/trending-searches.js.
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

const mod = await import('../functions/api/trending-searches.js');

async function call(qs) {
  const res = await mod.onRequest({
    request: new Request('https://tools.scoreroute.com/api/trending-searches' + qs)
  });
  return { status: res.status, body: await res.json() };
}

let fails = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails++; console.log('  FAIL ' + name + ' -> ' + e.message); }
}

console.log('geo=US (live)');
const t = await call('?geo=US');
check('HTTP 200', () => assert.strictEqual(t.status, 200));
check('10 trends', () => assert.ok(t.body.data.trends.length === 10, 'got ' + t.body.data.trends.length));
check('trend fields present', () => {
  const x = t.body.data.trends[0];
  assert.ok(x.title && x.traffic && x.trafficNum > 0, JSON.stringify(x).slice(0, 200));
  assert.strictEqual(typeof x.ageHours, 'number');
});
check('news items parsed', () => {
  const withNews = t.body.data.trends.filter((x) => x.news.length);
  assert.ok(withNews.length > 0, 'no trend had news');
  const n = withNews[0].news[0];
  assert.ok(n.title && /^https?:\/\//.test(n.url), JSON.stringify(n));
  assert.ok(n.source, 'no source host');
});
check('no raw HTML entities leak', () => {
  const bad = t.body.data.trends.find((x) => /&(amp|quot|lt|gt|#\d+);/.test(x.title));
  assert.ok(!bad, 'unescaped: ' + (bad && bad.title));
});
check('sorted traffic is numeric', () => {
  const all = t.body.data.trends.map((x) => x.trafficNum);
  assert.ok(all.every(Number.isFinite), JSON.stringify(all));
});
const t2 = await call('?geo=US');
check('2nd call served from edge cache', () => assert.strictEqual(t2.body.cached, true));

console.log('geo=JP (live, non-latin)');
const j = await call('?geo=JP');
check('HTTP 200', () => assert.strictEqual(j.status, 200));
check('10 trends', () => assert.strictEqual(j.body.data.trends.length, 10));

console.log('bad geo');
const b = await call('?geo=ZZ');
check('HTTP 400', () => assert.strictEqual(b.status, 400));

console.log('q=... (live)');
const q = await call('?q=' + encodeURIComponent('halloween party ideas'));
check('HTTP 200', () => assert.strictEqual(q.status, 200));
check('google suggestions', () => assert.ok(q.body.google.length > 0, JSON.stringify(q.body).slice(0, 200)));
check('bing suggestions', () => assert.ok(q.body.bing.length > 0));
check('source flags set', () => {
  assert.strictEqual(q.body.sources.google, 'ok');
  assert.strictEqual(q.body.sources.bing, 'ok');
});

console.log('method guard');
const m = await mod.onRequest({ request: new Request('https://x/api/trending-searches', { method: 'POST' }) });
check('POST -> 405', async () => assert.strictEqual(m.status, 405));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
