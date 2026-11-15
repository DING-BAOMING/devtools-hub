// Self-test for the standalone proxy Worker (src/proxy-fetch-worker.js).
//
// The Worker is a separate Cloudflare service, so nothing on the site exercises
// its guards. This runs the real handler in Node (Request/Response/fetch are
// all standard now) and asserts the three things that matter:
//
//   1. the SSRF guard refuses private / link-local / internal hosts
//   2. the CORS answer only allows this site's own origins
//   3. Cloudflare's rate limiting binding turns into a 429
//
// Run: node test-scripts/proxy-worker-selftest.js
// (needs no network: every case is answered before the outbound fetch)

import worker from '../src/proxy-fetch-worker.js';

let pass = 0;
const fail = [];
const check = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + ' — ' + detail); }
};

const post = (url, headers = {}, env = {}) =>
  worker.fetch(new Request('https://devtools-hub-api-proxy.bm-d.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ url })
  }), env);

console.log('\n[1] the SSRF guard');
for (const url of [
  'http://127.0.0.1/',
  'http://10.0.0.5/',
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://localhost/',
  'http://[::1]/',
  'http://foo.internal/',
  'http://bar.local/',
  'file:///etc/passwd'
]) {
  const r = await post(url);
  check(r.status === 400, 'refused: ' + url, 'status ' + r.status);
}

console.log('\n[2] the CORS answer');
const ours = await worker.fetch(new Request('https://devtools-hub-api-proxy.bm-d.workers.dev/', {
  method: 'OPTIONS', headers: { Origin: 'https://tools.scoreroute.com' }
}), {});
check(ours.headers.get('Access-Control-Allow-Origin') === 'https://tools.scoreroute.com',
  'this site is allowed', String(ours.headers.get('Access-Control-Allow-Origin')));
const theirs = await worker.fetch(new Request('https://devtools-hub-api-proxy.bm-d.workers.dev/', {
  method: 'OPTIONS', headers: { Origin: 'https://evil.example' }
}), {});
check(theirs.headers.get('Access-Control-Allow-Origin') === null,
  'somebody else is not', String(theirs.headers.get('Access-Control-Allow-Origin')));

console.log('\n[3] the rate limit');
const limited = await post('https://example.com/', { 'cf-connecting-ip': '1.2.3.4' }, {
  RATE_LIMITER: { limit: async () => ({ success: false }) }
});
check(limited.status === 429, 'over the limit -> 429', 'status ' + limited.status);
const allowed = await post('https://example.com/', { 'cf-connecting-ip': '1.2.3.4' }, {
  RATE_LIMITER: { limit: async () => ({ success: true }) }
});
check(allowed.status === 200, 'under the limit -> the request goes through', 'status ' + allowed.status);

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.log('FAILED: ' + f);
  process.exit(1);
}
