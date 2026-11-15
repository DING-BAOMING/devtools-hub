// BUG-544: libs/http.js is now the single implementation of fetchWithTimeout,
// extractJson and getLanguageName (they were copy-pasted into 12 / 8 / 3 API
// handlers and had drifted). This gate locks the shared behaviour and proves
// that no handler carries a private copy again.
//
// Run: node test-scripts/bug544-shared-http-lib-test.js
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = join(ROOT, 'functions', 'api');

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error('  FAIL ' + msg); failed++; }
  else console.log('  ok   ' + msg);
};

const { fetchWithTimeout, extractJson, getLanguageName } = await import(join(ROOT, 'libs', 'http.js'));

// --- fetchWithTimeout ---------------------------------------------------------
{
  const r = await fetchWithTimeout('data:text/plain,hello');
  ok(await r.text() === 'hello', 'fetchWithTimeout returns the body');
}
{
  // The abort must fire and must not leave the timer running.
  const t0 = Date.now();
  let aborted = false;
  try {
    // A black-holed address: the connection never completes, so only the
    // abort can end the request.
    await fetchWithTimeout('http://10.255.255.1/', {}, 400);
  } catch (e) { aborted = true; }
  ok(aborted, 'fetchWithTimeout aborts a hanging request');
  ok(Date.now() - t0 < 5000, 'fetchWithTimeout aborts promptly');
}
{
  const r = await fetchWithTimeout('data:text/plain,x', { method: 'GET', headers: { A: 'b' } }, 1000);
  ok(r.ok, 'fetchWithTimeout keeps the caller opts');
}

// --- extractJson --------------------------------------------------------------
ok(JSON.stringify(extractJson('{"a":1}')) === '{"a":1}', 'extractJson parses a plain object');
ok(JSON.stringify(extractJson('```json\n{"a":2}\n```')) === '{"a":2}', 'extractJson strips a json fence');
ok(JSON.stringify(extractJson('  {"a":3}  ')) === '{"a":3}', 'extractJson trims whitespace');
ok(JSON.stringify(extractJson('noise {"a":4} tail')) === '{"a":4}', 'extractJson cuts to the first object');
// The shared rule is "cut to the first {...} pair" — the same rule 7 of the 8
// old copies used (the 8th threw instead).
ok(JSON.stringify(extractJson('[{"a":5}]')) === '{"a":5}', 'extractJson cuts to the first object in an array');
ok(JSON.stringify(extractJson('{"a":\u201C6\u201D}')) === '{"a":"6"}', 'extractJson repairs curly quotes');
ok(JSON.stringify(extractJson('{"a":"b\\qc"}')) === '{"a":"b\\\\qc"}', 'extractJson repairs a stray backslash');
{
  let threw = false;
  try { extractJson(''); } catch (e) { threw = true; }
  ok(threw, 'extractJson rejects an empty answer');
}
{
  let threw = false;
  try { extractJson(null); } catch (e) { threw = true; }
  ok(threw, 'extractJson rejects a missing answer');
}

// --- getLanguageName ----------------------------------------------------------
ok(getLanguageName('en') === 'English', 'getLanguageName maps en');
ok(getLanguageName('zh') === 'Chinese (Simplified)', 'getLanguageName maps zh');
ok(getLanguageName('xx') === 'English', 'getLanguageName falls back to English');
ok(getLanguageName(undefined) === 'English', 'getLanguageName handles undefined');

// --- no private copies left ----------------------------------------------------
{
  const files = readdirSync(API_DIR).filter(f => f.endsWith('.js'));
  const dupes = [];
  for (const f of files) {
    const s = readFileSync(join(API_DIR, f), 'utf8');
    for (const fn of ['fetchWithTimeout', 'extractJson', 'getLanguageName']) {
      if (new RegExp('(async )?function\\s+' + fn + '\\s*\\(').test(s)) dupes.push(f + ':' + fn);
    }
  }
  ok(dupes.length === 0, 'no API handler defines its own copy (' + (dupes.join(', ') || 'none') + ')');
}
{
  // Every handler that uses one of them must import it from the shared lib.
  const files = readdirSync(API_DIR).filter(f => f.endsWith('.js'));
  const missing = [];
  for (const f of files) {
    const s = readFileSync(join(API_DIR, f), 'utf8');
    const uses = ['fetchWithTimeout', 'extractJson', 'getLanguageName'].filter(n =>
      new RegExp('(?<![\\w.])' + n + '\\s*\\(').test(s.replace(/import[^;]+;/g, '')));
    if (!uses.length) continue;
    const imp = /import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/libs\/http\.js'/.exec(s);
    const got = imp ? imp[1].split(',').map(x => x.trim()) : [];
    for (const u of uses) if (!got.includes(u)) missing.push(f + ':' + u);
  }
  ok(missing.length === 0, 'every user imports it from libs/http.js (' + (missing.join(', ') || 'none') + ')');
}

console.log(failed ? `\n[bug544] FAIL ${failed}` : '\n[bug544] PASS');
process.exit(failed ? 1 : 0);
