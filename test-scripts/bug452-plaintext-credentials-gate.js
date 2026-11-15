#!/usr/bin/env node
// BUG-452 gate — no credential may live in a TRACKED file of any of the three repos.
//
// WHY
// A secret that is committed is a PUBLISHED secret: the history keeps it forever and the
// repo is one `git clone` away. The 2026-11-05 round found credentials in all three repos
// (n8n automation repo, devtools-hub docs, devtools-hub site) — API keys, a WordPress app
// password, an OAuth refresh token, a Cloudflare token — written as plain literals in
// Python, JavaScript, JSON workflow files, logs and Markdown.
//
// The fix has three halves and this gate owns the one that keeps them from coming back:
//   1. the VALUES moved to an untracked 0600 store outside every repo
//      (/home/ubuntu/.secrets/devtools-hub.env)
//   2. the CODE reads them from there (credential_store.secret / api_call.curl_post)
//   3. ⭐ this gate: if a value ever shows up in a tracked file again, the build goes red
//
// WHAT THIS GATE ENFORCES
//   1. no value of the credential store may appear in a tracked file (text or binary)
//   2. no string with a known credential PREFIX may appear in a tracked file
//      (a key that was never in the store is still a key — the prefix is the net)
//   3. ⭐ no bearer token may be passed on a command line (the leak vector of BUG-452:
//      `curl -H "Authorization: Bearer $KEY"` puts the key in argv, so it lands in the
//      process list and in every error message — the fix is `curl -H @-`, the header on
//      stdin)
//   4. anti-vacuity: the detector must go red on a synthetic leak
//
// Usage: node bug452-plaintext-credentials-gate.js [--store <path>]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const DOCS = path.resolve(__dirname, '..');
const SITE = path.join(DOCS, '..', 'devtools-hub');
const N8N = process.env.N8N_REPO || '/home/ubuntu/n8n-workflow';
const STORE = arg('--store', process.env.DEVTOOLS_SECRET_STORE || '/home/ubuntu/.secrets/devtools-hub.env');

const REPOS = [
  { name: 'docs', dir: DOCS },
  { name: 'site', dir: SITE },
  { name: 'n8n', dir: N8N },
];

// Values that are identifiers, not secrets — a project id, an email, a token endpoint, a
// site URL. They stay readable on purpose; publishing them leaks nothing.
const NOT_SECRET = new Set([
  'GOOGLE_GSC_PROJECT_ID', 'GOOGLE_GSC_CLIENT_EMAIL', 'GOOGLE_GSC_CLIENT_ID',
  'GOOGLE_GSC_TOKEN_URI', 'BING_WEBMASTER_SITE_URL', 'DEVTO_ORG',
]);

// Literal values that are allowed to stay in a tracked file, with the reason.
const ALLOWED = new Map([
  ['devtools-hub-admin-2026', 'admin gate fixture (bug362/bug325) — not a live credential'],
]);

// Known credential shapes. A key that was never in the store is still a key.
const PATTERNS = [
  ['cloudflare-token', /cfat_[A-Za-z0-9_-]{20,}/g],
  ['github-token', /ghp_[A-Za-z0-9]{20,}/g],
  ['groq-key', /gsk_[A-Za-z0-9]{20,}/g],
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['nvidia-key', /nvapi-[A-Za-z0-9_-]{20,}/g],
  ['deai-key', /deai-[A-Za-z0-9]{20,}/g],
  ['openai-style-key', /sk-[A-Za-z0-9]{30,}/g],
  // A Google refresh token starts with "1//0" and is not part of a base64 blob — the
  // lookbehind keeps a vendored minified bundle from matching on its own "1//" bytes.
  ['google-oauth-refresh-token', /(?<![A-Za-z0-9+/=])1\/\/0[A-Za-z0-9_-]{20,}/g],
  ['emailvalidation-key', /ema_live_[A-Za-z0-9]{20,}/g],
  ['agnes-key', /wk-[A-Za-z0-9]{30,}/g],
  ['coingecko-key', /CG-[A-Za-z0-9]{20,}/g],
  ['tavily-key', /tvly-[A-Za-z0-9-]{20,}/g],
];

// The leak vector: the token on the argv of a command.
const ARGV_TOKEN = /Authorization:\s*Bearer\s+[A-Za-z0-9_.=-]{16,}/g;

const SELF = path.basename(__filename);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const no = (m) => { fail++; console.log('  FAIL ' + m); };

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function trackedFiles(repo) {
  try {
    return git(['ls-files', '-z'], repo).split('\0').filter(Boolean);
  } catch (e) {
    return [];
  }
}

function readStore() {
  if (!fs.existsSync(STORE)) return null;
  const out = [];
  for (const raw of fs.readFileSync(STORE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!v || v.length < 8 || NOT_SECRET.has(k)) continue;
    out.push({ name: k, value: v });
  }
  return out;
}

const allowed = (s) => {
  for (const [lit, why] of ALLOWED) if (s.includes(lit)) return why;
  return null;
};

/** The rule under test: the problems a single file carries. */
function scanFile(file, text, store) {
  const problems = [];
  for (const { name, value } of store || []) {
    const i = text.indexOf(value);
    if (i < 0) continue;
    const why = allowed(value);
    if (why) continue;
    problems.push({ kind: 'store-value', why: `the credential ${name} is written in this file` });
  }
  for (const [label, rx] of PATTERNS) {
    const m = text.match(rx);
    if (!m) continue;
    for (const hit of new Set(m)) {
      const why = allowed(hit);
      if (why) continue;
      problems.push({ kind: 'pattern', why: `a ${label} is written in this file` });
      break;
    }
  }
  const argv = text.match(ARGV_TOKEN);
  if (argv) {
    for (const hit of new Set(argv)) {
      const why = allowed(hit);
      if (why) continue;
      problems.push({ kind: 'argv', why: 'a bearer token is passed on a command line (use `curl -H @-`)' });
      break;
    }
  }
  return problems;
}

function scanRepo(repo, store) {
  const files = trackedFiles(repo.dir);
  if (!files.length) {
    no(`${repo.name}: no tracked files found (${repo.dir})`);
    return { scanned: 0, problems: [] };
  }
  const problems = [];
  let scanned = 0;
  for (const rel of files) {
    if (path.basename(rel) === SELF) continue;         // this file carries the patterns
    const p = path.join(repo.dir, rel);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile() || st.size > 40 * 1024 * 1024) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); }
    catch (e) { text = fs.readFileSync(p, 'latin1'); }
    scanned++;
    for (const pr of scanFile(rel, text, store)) problems.push({ repo: repo.name, file: rel, ...pr });
  }
  return { scanned, problems };
}

// ── 1/2/3. the repos ───────────────────────────────────────────────────────────────────
const store = readStore();
if (!store) {
  no(`the credential store ${STORE} is missing — the "no store value in a tracked file" rule cannot run`);
} else {
  ok(`the credential store is readable (${store.length} secret values)`);
}

let total = 0, scanned = 0;
for (const repo of REPOS) {
  const res = scanRepo(repo, store);
  scanned += res.scanned;
  total += res.problems.length;
  if (!res.problems.length) ok(`${repo.name}: ${res.scanned} tracked file(s) carry no credential`);
  for (const pr of res.problems) no(`${repo.name}/${pr.file}: ${pr.why}`);
}
console.log(`  scanned ${scanned} tracked file(s) in ${REPOS.length} repo(s)`);

// ── 4. anti-vacuity ───────────────────────────────────────────────────────────────────
// The detector must actually fire — otherwise "no leaks" is a statement about nothing.
{
  const fakeStore = [{ name: 'FAKE_KEY', value: 'FAKEKEY_0123456789abcdefghijklmnop' }];
  const hit = scanFile('fixture', 'KEY = FAKEKEY_0123456789abcdefghijklmnop', fakeStore);
  if (hit.length) ok('anti-vacuity: a store value in a file is caught');
  else no('anti-vacuity: a store value in a file was NOT caught');

  const hit2 = scanFile('fixture', 'token: gsk_abcdefghijklmnopqrstuvwxyz012345', []);
  if (hit2.length) ok('anti-vacuity: a prefixed key in a file is caught');
  else no('anti-vacuity: a prefixed key in a file was NOT caught');

  const hit3 = scanFile('fixture', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://api.example.com', []);
  if (hit3.length) ok('anti-vacuity: a bearer token on the argv is caught');
  else no('anti-vacuity: a bearer token on the argv was NOT caught');

  const clean = scanFile('fixture', 'const key = secret("GROQ_API_KEY"); curl -H @- https://api.example.com', fakeStore);
  if (!clean.length) ok('anti-vacuity: the fixed shape (store + `curl -H @-`) is clean');
  else no('anti-vacuity: the fixed shape was flagged: ' + clean[0].why);

  // the allowed fixture must really be allowed, or the allow-list is a hole
  const allowHit = scanFile('fixture', 'secret = devtools-hub-admin-2026', []);
  if (!allowHit.length) ok('the allow-list entry (admin gate fixture) is honoured');
  else no('the allow-list entry (admin gate fixture) was NOT honoured');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
