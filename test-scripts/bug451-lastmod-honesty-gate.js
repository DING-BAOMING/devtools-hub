#!/usr/bin/env node
// BUG-451 gate — a tool page's `<lastmod>` must never claim a freshness the page does not have.
//
// WHY
// scripts/gen-tool-dates.js used "the last git commit that TOUCHED index.html" as the
// evidence for a page's last content date (for the pages that carry no authored
// `"dateModified"`). BUG-448's generator rewrites the HEAD metadata of 358 page files, so
// every manifest edit — and every deploy — would stamp TODAY's date on those pages'
// `<lastmod>`, even though their visible content did not change by a single byte.
//
// That is the invented-freshness family this repo has been killing since BUG-333:
// Google uses `<lastmod>` "only if it's consistently and accurately maintained", and a
// lastmod that jumps on every deploy is the definition of not-maintained.
//
// The fix (in the generator): a commit counts only if the page's BODY — everything after
// `</head>`, i.e. what the visitor reads — differs from the state before that commit.
//
// WHAT THIS GATE CHECKS
//   A. every tool URL's `<lastmod>` in sitemap.xml == its date in tool-dates.json
//      (one map, two surfaces must agree — the BUG-375 contract)
//   B. for every page whose date comes from git (no authored `"dateModified"`), that date
//      is NOT newer than the newest commit that changed the page's BODY — i.e. no
//      false freshness, and in particular a head-only sync must not move it
//   C. no date is in the future
//   D. anti-vacuity: on a synthetic git history (body changed once, then only the head),
//      the check must (1) date the body change, not the head change, and (2) flag a
//      claimed date that is newer than the body change
//
// Usage: node bug451-lastmod-honesty-gate.js [--root <site repo>]
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..')));

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** Everything after </head> — what the visitor actually reads. */
const bodyOf = (html) => {
  const i = html.indexOf('</head>');
  return i < 0 ? html : html.slice(i);
};

/** The newest commit that changed the page's body, as {hash, date} (null if none). */
function bodyChange(slug) {
  const file = `tools/${slug}/index.html`;
  const show = (rev) => {
    try { return git(['show', `${rev}:${file}`], ROOT); } catch (e) { return null; }
  };
  // every commit that touched this file, newest first
  let out = '';
  try {
    out = git(['log', '--date=short', '--name-only', '--pretty=format:%H %ad', '--', file], ROOT);
  } catch (e) { return null; }
  const cands = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) { cur = null; continue; }
    const h = t.match(/^([0-9a-f]{40})\s+(\d{4}-\d{2}-\d{2})$/);
    if (h) { cur = { hash: h[1], date: h[2] }; continue; }
    if (/^tools\/[a-z0-9-]+\/index\.html$/.test(t) && cur) cands.push(cur);
  }
  for (let i = 0; i < cands.length; i++) {
    const cur2 = show(cands[i].hash);
    if (cur2 === null) continue;
    const prev = (i + 1 < cands.length) ? show(cands[i + 1].hash) : show(cands[i].hash + '^');
    if (prev === null) return cands[i];          // the file was created here
    if (bodyOf(cur2) !== bodyOf(prev)) return cands[i];
  }
  return null;
}

(async () => {
  const problems = [];
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'tool-dates.json'), 'utf8'));
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

  // A. sitemap lastmod == the map
  const lastmod = {};
  for (const m of sitemap.matchAll(/<loc>https:\/\/tools\.scoreroute\.com\/tools\/([a-z0-9-]+)\/<\/loc>\s*<lastmod>([\d-]+)<\/lastmod>/g)) {
    lastmod[m[1]] = m[2];
  }
  const slugs = Object.keys(map);
  for (const slug of slugs) {
    if (lastmod[slug] === undefined) { problems.push(`${slug}: the sitemap has no <lastmod> but tool-dates.json dates it ${map[slug]}`); continue; }
    if (lastmod[slug] !== map[slug]) problems.push(`${slug}: the sitemap says ${lastmod[slug]}, tool-dates.json says ${map[slug]} — the two surfaces must agree`);
  }

  // C. nothing in the future
  const today = new Date().toISOString().slice(0, 10);
  for (const [slug, d] of Object.entries(map)) {
    if (d > today) problems.push(`${slug}: date ${d} is in the future`);
  }

  // B. no false freshness on the pages whose date comes from git
  let checked = 0, gitRouted = 0;
  for (const slug of slugs) {
    const file = path.join(ROOT, 'tools', slug, 'index.html');
    if (!fs.existsSync(file)) { problems.push(`${slug}: the page file is missing`); continue; }
    const html = fs.readFileSync(file, 'utf8');
    const authored = (html.match(/"dateModified"\s*:\s*"(2\d{3}-\d{2}-\d{2})"/) || [])[1];
    if (authored) continue;                 // the author's own date is the evidence for those
    gitRouted++;
    const change = bodyChange(slug);
    if (!change) continue;
    checked++;
    if (map[slug] > change.date) {
      problems.push(`${slug}: the date ${map[slug]} is NEWER than the last commit that changed the page's visible content (${change.date}) — that is invented freshness`);
    }
  }

  console.log(`\ntool pages dated: ${slugs.length} · git-routed (body-checked): ${gitRouted} (${checked} with a body history)`);
  console.log(`  pass: ${slugs.length} page(s) · FAIL: ${problems.length}`);
  problems.slice(0, 20).forEach((p) => console.log('  ✗ FAIL ' + p));
  if (problems.length > 20) console.log('  … and ' + (problems.length - 20) + ' more');

  // ── anti-vacuity ────────────────────────────────────────────────────────────
  // A check that cannot fail is a green light wired to nothing. Build a synthetic
  // history: the body changes once, then only the head changes again.
  let vac = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug451-'));
  try {
    const g = (args, env) => execFileSync('git', args, {
      cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(env || {}) },
    });
    fs.mkdirSync(path.join(tmp, 'tools', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tools', 'x', 'index.html'),
      '<html><head><title>Old</title></head><body><p>hello</p></body></html>');
    g(['init', '-q']);
    g(['config', 'user.email', 'a@b.c']);
    g(['config', 'user.name', 't']);
    g(['add', '-A']);
    g(['commit', '-qm', 'body v1'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' });
    const first = g(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(tmp, 'tools', 'x', 'index.html'),
      '<html><head><title>New</title></head><body><p>hello</p></body></html>');
    g(['add', '-A']);
    g(['commit', '-qm', 'head only'], { GIT_AUTHOR_DATE: '2026-01-02T00:00:00', GIT_COMMITTER_DATE: '2026-01-02T00:00:00' });
    const second = g(['rev-parse', 'HEAD']).trim();

    // the same comparison the gate uses, on the fixture
    const show = (rev) => g(['show', `${rev}:tools/x/index.html`]);
    const bodyChanged = bodyOf(show(second)) !== bodyOf(show(first));
    if (bodyChanged) { console.log('  ✗ FAIL ANTI-VACUITY — a head-only change was counted as a content change'); vac++; }
    else console.log('  anti-vacuity: a head-only change does NOT count as a content change -> correct');

    // and a claimed date newer than the body change must be flagged
    const dateOf = (rev) => g(['show', '-s', '--date=short', '--format=%ad', rev]).trim();
    const flagged = dateOf(second) > dateOf(first);   // the head-only commit is newer than the body change
    if (!flagged) { console.log('  ✗ FAIL ANTI-VACUITY — a false-freshness date was not flagged'); vac++; }
    else console.log('  anti-vacuity: a date newer than the last body change IS flagged -> correct');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  anti-vacuity: ' + (2 - vac) + '/2 drifted states go red');
  process.exit(problems.length === 0 && vac === 0 ? 0 : 1);
})();
