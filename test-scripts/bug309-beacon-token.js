#!/usr/bin/env node
// BUG-309 static gate — the site must ship ZERO hand-written Cloudflare Web Analytics
// beacon tags, and must keep the CSP entries the edge-injected beacon needs.
//
// Why: Cloudflare Web Analytics auto-injection is enabled for this zone, and Cloudflare
// already injects exactly one beacon into every page (verified with a browser UA: /,
// /tools/, /about/, /tools/monitor-test/ and even a 404 path all carry it). That beacon
// posts to the first-party endpoint https://<site>/cdn-cgi/rum and is accepted — 204.
// A hand-written <script src=static.cloudflareinsights.com/beacon.min.js data-cf-beacon="…">
// makes the beacon singleton initialise against the LEGACY third-party endpoint
// https://cloudflareinsights.com/cdn-cgi/rum, which the browser CORS-blocks
// (net::ERR_FAILED) — and because it is a singleton it pre-empts the auto-injected
// instance. Measured: / (0 shipped tags) -> 204 accepted; every page that shipped a tag
// -> 0 recorded. So a shipped tag is not a token to be corrected, it is a redundant
// integration that silently deletes the analytics. BUG-309 removed 244 of them.
//
// Run: node test-scripts/bug309-beacon-token.js
// Exit 0 = pass, 1 = fail.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (id, m, x) => { pass++; console.log(`  PASS ${id} ${m}${x ? ' — ' + x : ''}`); };
const no = (id, m, x) => { fail++; console.log(`  FAIL ${id} ${m}${x ? ' — ' + x : ''}`); };

const offenders = [];
let htmlFiles = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    // shipped source only — functions/ is deployed, *.test.js / test-*.js are not
    const isSrc = e.isFile() && (e.name === 'index.html'
      || (e.name.endsWith('.js') && p.startsWith(path.join(ROOT, 'functions'))));
    if (!isSrc) continue;
    if (e.name === 'index.html') htmlFiles++;
    const s = fs.readFileSync(p, 'utf8');
    // 2026-11-03: the old rule required BOTH a beacon script AND a data-cf-beacon token in the
    // same file, so a page that shipped the beacon script WITHOUT a token passed the gate —
    // and that is the same defect: the beacon is a singleton, so a page-shipped instance
    // pre-empts the edge-injected one and the page records nothing. `prayer-times` shipped the
    // script with no token and `pdf-to-text` shipped it with a placeholder token; the gate saw
    // neither. The rule is now: any reference to the beacon script, or to a beacon token, in a
    // SHIPPED page is an offender. The CSP in functions/_middleware.js names the ORIGIN (not
    // the script), so it is not an offender.
    if (/beacon\.min\.js|data-cf-beacon/.test(s)) {
      offenders.push(path.relative(ROOT, p));
    }
  }
})(ROOT);

console.log(`BUG-309 gate — ${htmlFiles} shipped html file(s) scanned`);

// G1 — the invariant itself.
offenders.length === 0
  ? ok('G1', 'no shipped file contains a hand-written data-cf-beacon tag')
  : no('G1', `${offenders.length} file(s) still ship a beacon tag`, offenders.slice(0, 8).join(' '));

// G2 — the Function that used to inject the beacon into tool pages must not do it any more.
// Re-adding it would silently break analytics on the 96 tool pages that ship no tag, and it
// would do so invisibly, because those pages are the ones the gate cannot see in the HTML.
const catchall = path.join(ROOT, 'functions', 'tools', '[[catchall]].js');
const caSrc = fs.readFileSync(catchall, 'utf8');
!caSrc.includes('cloudflareinsights')
  ? ok('G2', 'patchToolHtml() no longer injects a beacon (BUG-293 block removed)')
  : no('G2', 'patchToolHtml() still injects a beacon tag — it will overwrite the edge-injected one');

// G3 — the beacon itself must still be *allowed*. The auto-inject serves the script from
// static.cloudflareinsights.com and POSTs to /cdn-cgi/rum, so removing the tag from the HTML
// is only safe while the CSP still permits that origin. Dropping it would trade a broken
// beacon for a beacon that cannot load at all — a regression that looks identical in HTML.
const mw = fs.readFileSync(path.join(ROOT, 'functions', '_middleware.js'), 'utf8');
mw.includes('static.cloudflareinsights.com')
  ? ok('G3', 'CSP script-src still allows static.cloudflareinsights.com')
  : no('G3', 'CSP no longer allows static.cloudflareinsights.com — the injected beacon cannot load');
mw.includes('connect-src')
  ? ok('G4', 'CSP defines a connect-src directive (the RUM POST is a connection)')
  : no('G4', 'CSP has no connect-src — the RUM POST may be blocked');

// G5 — reconciliation: the gate must actually be looking at the pages it claims to be.
// A file-discovery bug that scanned 0 files would report G1 PASS forever.
htmlFiles > 300
  ? ok('G5', `scan reached the whole site`, `${htmlFiles} html files`)
  : no('G5', `scan looks too small to be meaningful`, `${htmlFiles} html files`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
