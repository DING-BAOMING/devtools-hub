// BUG-442 gate: a tool page must not call a third-party lyrics API directly —
// the page calls /api/lyrics (site Function), which proxies the upstream.
//  [A] every tool HTML: no raw "api.lyrics.ovh" in source (class scan, BUG-359 shape:
//      the defect lives in a second copy only when someone re-introduces the URL, so the
//      needle is the URL itself)
//  [B] functions/api/lyrics.js exists, exports onRequest, routes on artist+title,
//      and calls the upstream only after redirect:'manual' (AGENTS.md SSRF story)
//  [C] song-lyrics-finder still offers the fallback links (class boundary intact)
// Anti-vacuity: pass a rootDir where the defects are present and require the failures to return.
import fs from 'node:fs';
import path from 'node:path';

// Resolve the site repo from this file, not from the cwd: the gate is run from
// test-scripts/, and `process.cwd() + '/devtools-hub'` pointed at
// test-scripts/devtools-hub — a directory that does not exist, so the gate died
// with ENOENT before it could assert anything.
// scripts/sync-gates.py rewrites this one line when it copies the gate into the
// site repo (the site tree is one level up there, not two plus a sibling).
const rootDir = process.argv[2] || path.join(import.meta.dirname, '..');
const toolsDir = path.join(rootDir, 'tools');
const FAIL = [];

let hits = [];
for (const dir of fs.readdirSync(toolsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const f = path.join(toolsDir, dir.name, 'index.html');
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('api.lyrics.ovh')) hits.push(dir.name);
}
if (hits.length) FAIL.push('[A] raw api.lyrics.ovh in: ' + hits.join(', '));
console.log('[A] raw api.lyrics.ovh in tool HTML:', hits.length === 0 ? 'none' : hits.join(', '));

const apiFile = path.join(rootDir, 'functions', 'api', 'lyrics.js');
if (!fs.existsSync(apiFile)) FAIL.push('[B] functions/api/lyrics.js missing');
else {
  const src = fs.readFileSync(apiFile, 'utf8');
  if (!src.includes('onRequest')) FAIL.push('[B] no onRequest export');
  if (!src.includes('api.lyrics.ovh')) FAIL.push('[B] proxy does not reference the upstream');
  if (!/artist/.test(src) || !/title/.test(src)) FAIL.push('[B] does not read artist/title params');
  if (!src.includes("redirect: 'manual'")) FAIL.push('[B] upstream fetch is not redirect manual (SSRF story, AGENTS.md)');
}
console.log('[B] /api/lyrics Function:', fs.existsSync(apiFile) ? 'present' : 'MISSING');

const slf = path.join(toolsDir, 'song-lyrics-finder', 'index.html');
if (!fs.existsSync(slf)) FAIL.push('[C] song-lyrics-finder/index.html missing');
else {
  const src = fs.readFileSync(slf, 'utf8');
  const n = (src.match(/genius\.com/g) || []).length + (src.match(/azlyrics\.com/g) || []).length + (src.match(/musixmatch\.com/g) || []).length;
  if (n < 3) FAIL.push('[C] song-lyrics-finder lost its fallback links (count=' + n + ')');
  if (!src.includes('/api/lyrics')) FAIL.push('[C] song-lyrics-finder not calling /api/lyrics');
}
console.log('[C] song-lyrics-finder fallbacks + /api/lyrics call:', FAIL.some(m => m.startsWith('[C]')) ? 'PROBLEM' : 'ok');

if (FAIL.length) {
  console.error('\nFAIL:');
  FAIL.forEach(m => console.error('  ' + m));
  process.exit(1);
}
console.log('\ngate clean: no raw upstream URL in tool HTML; proxy present; fallbacks intact');
