// BUG-362 gate — a public admin secret must not exist in the moderation endpoints.
//
// Why this exists: `context.env.FEEDBACK_ADMIN_SECRET || 'devtools-hub-admin-2026'` sat in
// FOUR places (feedback.js PATCH+DELETE, comments.js POST-bypass+DELETE). Two independent
// reasons it was a working backdoor on production:
//   1. the literal is public (it is in the repo), and
//   2. the env binding never reached the deployed Functions, so the literal was the
//      EFFECTIVE secret — proven by probe: public string -> 404 (auth passed), the real
//      secret -> 401 (auth failed).
//
// Tiers:
//   [A] no `env.SECRET || 'literal'` fallback anywhere in functions/ or libs/
//   [B] behavioural, against the REAL libs/admin-auth.js: unbound env authenticates
//       nobody (fail closed), the correct secret works, a wrong secret does not.
//   [C] anti-vacuity — re-inject the exact pre-fix pattern and require this gate to go red.
//
// ponytail: source shape (A) + behaviour (B). The source grep alone would pass on a tree
// where the helper was correct but a caller bypassed it, and behaviour alone would not
// catch a new endpoint reintroducing the literal.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const FAIL = [];
let checks = 0;

const ok = (cond, msg) => { checks++; if (!cond) FAIL.push(msg); };

// ---------- Tier A: source shape over every Functions/libs file ----------
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'functions')), ...walk(join(ROOT, 'libs'))];
ok(files.length > 10, `expected to scan the Functions tree, found ${files.length} files`);

const FALLBACK = /env\.[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z_]*\s*\|\|\s*['"][^'"]{6,}['"]/;
for (const f of files) {
  const rel = relative(ROOT, f);
  // strip comments so the lib's own "this used to be here" doc note cannot trip the gate
  const src = readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!FALLBACK.test(src),
    `${rel}: hardcoded fallback secret — an env secret with a source-level default is a public key`);
}

// ---------- Tier A2: no libs/ file may QUOTE a secret value ----------
// `libs/` is publicly served (GET /libs/<file>.js -> 200, full source). A rotated-but-still-
// printed literal in a comment is not an active hole, but it makes the repo's own leak scan
// flag its own files, which is how people learn to ignore a leak scan.
for (const f of files) {
  const rel = relative(ROOT, f);
  if (!rel.startsWith('libs/')) continue;
  const src = readFileSync(f, 'utf8');
  ok(!/env\.[A-Z_]*SECRET[A-Z_]*\s*\|\|\s*['"][^'"]+['"]/.test(src),
    `${rel}: serves a quoted secret value over HTTP`);
  ok(!/devtools-hub-admin-/.test(src), `${rel}: serves the retired admin literal over HTTP`);
}

// ---------- Tier B: behaviour of the real helper ----------
const { isAdmin } = await import(pathToFileURL(join(ROOT, 'libs/admin-auth.js')).href);
const REAL = 'test-secret-value';  // any non-empty string: tier B is synthetic, not a real secret
const params = (q) => new URL('https://x/api/feedback?' + q).searchParams;

ok(isAdmin({ env: { FEEDBACK_ADMIN_SECRET: REAL } }, params('admin_secret=' + REAL)) === true,
  'the correct secret must authenticate');
ok(isAdmin({ env: { FEEDBACK_ADMIN_SECRET: REAL } }, params('admin_secret=wrong')) === false,
  'a wrong secret must not authenticate');
ok(isAdmin({ env: { FEEDBACK_ADMIN_SECRET: REAL } }, params('')) === false,
  'a missing admin_secret must not authenticate');
ok(isAdmin({ env: {} }, params('admin_secret=devtools-hub-admin-2026')) === false,
  'FAIL CLOSED: with FEEDBACK_ADMIN_SECRET unbound nothing may authenticate (this was the live backdoor)');
ok(isAdmin({ env: {} }, params('admin_secret=' + REAL)) === false,
  'FAIL CLOSED: unbound env must reject even the real value');
ok(isAdmin({ env: { FEEDBACK_ADMIN_SECRET: '' } }, params('admin_secret=')) === false,
  'an empty secret must not authenticate');

// ---------- Tier C: anti-vacuity ----------
{
  const target = join(ROOT, 'functions/api/comments.js');
  const original = readFileSync(target, 'utf8');
  try {
    const injected = original.replace(
      "const adminBypass = isAdmin(context, new URL(context.request.url).searchParams);",
      "const adminBypass = new URL(context.request.url).searchParams.get('admin_secret') === (context.env.FEEDBACK_ADMIN_SECRET || 'devtools-hub-admin-2026');"
    );
    ok(injected !== original, 'anti-vacuity: injection must change the file, else tier A cannot be proven');
    const { writeFileSync } = await import('fs');
    writeFileSync(target, injected);
    const src = readFileSync(target, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(FALLBACK.test(src), 'anti-vacuity FAILED: re-injecting the pre-fix pattern must trip tier A');
  } finally {
    const { writeFileSync } = await import('fs');
    writeFileSync(target, original);
  }
  ok(readFileSync(target, 'utf8') === original, 'anti-vacuity: pre-fix file must be restored');
}

// ---------- report ----------
console.log(`bug362-admin-secret-gate: ${checks} checks, ${FAIL.length} FAIL`);
if (FAIL.length) { FAIL.forEach(f => console.log('  FAIL ' + f)); process.exit(1); }
console.log('  PASS no public admin secret in ' + files.length + ' files; fails closed when unbound');
