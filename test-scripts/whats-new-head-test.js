// BUG-491: HEAD on /whats-new/ returned 500.
//
// The Function wrote every response into the Cache API with `cache.put(cacheKey, ...)`.
// Cache.put() throws on anything that is not a GET request, and the throw escaped as a
// 500 — so GET worked and every HEAD probe (audit bots) failed.
//
// This test runs the real function body with a Cache API stub that enforces the same
// rule as the runtime, and asserts that HEAD answers 200 and never reaches cache.put.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'functions', 'whats-new.js'), 'utf8');
// The repo has no "type": "module", so import the function through a data: URL to get
// ESM semantics without touching package.json.
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
const { onRequest } = mod;

const MANIFEST = [
  '# comment',
  'demo-tool|demo|yes|yes|Demo Tool|A demo tool.|tag1,tag2'
].join('\n');

function makeContext(method) {
  const puts = [];
  const cache = {
    async match() { return undefined; },
    async put(key, res) {
      puts.push(key.method);
      // The real Cache API rejects a non-GET request with a TypeError.
      if (key.method !== 'GET') throw new TypeError('Cache.put() only supports GET requests');
    }
  };
  globalThis.caches = { default: cache };
  return {
    puts,
    context: {
      request: new Request('https://tools.scoreroute.com/whats-new/', { method }),
      env: {
        ASSETS: {
          async fetch() {
            return new Response(MANIFEST, { headers: { 'Content-Type': 'text/plain' } });
          }
        }
      }
    }
  };
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('  pass  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// 1. HEAD must answer 200 and must not write to the cache.
{
  const { context, puts } = makeContext('HEAD');
  let res = null, err = null;
  try { res = await onRequest(context); } catch (e) { err = e; }
  check('HEAD does not throw', !err, err && String(err));
  check('HEAD answers 200', res && res.status === 200, res && String(res.status));
  check('HEAD never calls cache.put', puts.length === 0, 'puts=' + JSON.stringify(puts));
}

// 2. GET must still answer 200 and still populate the cache.
{
  const { context, puts } = makeContext('GET');
  let res = null, err = null;
  try { res = await onRequest(context); } catch (e) { err = e; }
  check('GET does not throw', !err, err && String(err));
  check('GET answers 200', res && res.status === 200, res && String(res.status));
  check('GET still calls cache.put once', puts.length === 1 && puts[0] === 'GET',
        'puts=' + JSON.stringify(puts));
  const body = res ? await res.text() : '';
  check('GET body still lists the tool', body.includes('Demo Tool'));
}

console.log(failures ? '\n' + failures + ' FAIL' : '\nall checks passed');
process.exit(failures ? 1 : 0);
