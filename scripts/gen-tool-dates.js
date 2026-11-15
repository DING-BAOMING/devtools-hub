// Generate devtools-hub/tool-dates.json — the real last-edit date (YYYY-MM-DD) for every
// tool page, from evidence, never from "today".
//
// Why: patchToolHtml() stamped `dateModified = today` on all ~350 tool pages, so every
// unchanged page reported fresh content daily (the last half of the lastmod honesty family:
// crawl/sitemap-lastmod-churn; the sitemap half was already fixed in BUG-333 by dropping
// the invented tool dates). This map lets the live page and the sitemap agree on a REAL
// date, or emit nothing.
//
// Evidence priority, most trustworthy first:
//   1. the tool's own authored `"dateModified"` in its index.html JSON-LD (330 tools);
//   2. the last git commit date that changed its index.html's BODY (41 of the remainder).
//      "BODY" = everything after </head> = what the visitor actually reads.
//      A commit that only rewrote the HEAD metadata does NOT count: BUG-448's
//      generator syncs the manifest-derived head into 358 page files, so a naive
//      "last commit that touched the file" would stamp today's date on all 41 of
//      those pages on every single deploy — exactly the invented-freshness family
//      this file exists to kill (Google uses lastmod "only if it's consistently and
//      accurately maintained"; the sitemap half was fixed in BUG-333).
// Tools with neither get NO entry: patchToolHtml then falls back to the page's own
// dateModified/datePublished (informative, not claimed fresh), and the sitemap simply
// omits `<lastmod>` for that URL — `<lastmod>` is optional and absent beats wrong.
//
// SHALLOW CHECKOUTS (2026-11-10): the deploy workflow checks out with the default
// fetch-depth 1, so there is no parent commit to compare against. "the body changed
// here" then cannot be told apart from "we cannot see the previous version", and the
// fallback stamped the checkout's own commit date on every tool without an authored
// dateModified (42 of them) — the invented-freshness family all over again, once per
// deploy. So: a shallow clone never guesses. It carries the date already recorded in
// the committed map (computed from real history by scripts/publish-github.sh) and, when
// there is none, emits nothing.
//
// Run by scripts/pre-deploy.sh before every deploy; safe to run any time.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const htop = import.meta.dirname + '/..';
const today = new Date().toISOString().slice(0, 10);

// The committed map: the last date that was computed from real history.
let carried = {};
try { carried = JSON.parse(readFileSync(`${htop}/tool-dates.json`, 'utf8')); } catch (e) { carried = {}; }

// No history to compare against -> never guess a date.
let shallow = true;
try {
  shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: htop }).toString().trim() === 'true';
} catch (e) { shallow = true; }

// git route: newest-first ls; the first time a slug's index.html appears is its latest edit.
// Every candidate commit is kept, because the BODY comparison below may need to walk back.
const gitDate = {};
const gitCommits = {};
let current = null;
for (const line of execFileSync('git', ['log', '--date=short', '--name-only', '--pretty=format:%H %ad'], { cwd: htop, maxBuffer: 64 * 1024 * 1024 }).toString().split('\n')) {
  const t = line.trim();
  if (!t) { current = null; continue; }
  const h = t.match(/^([0-9a-f]{40})\s+(\d{4}-\d{2}-\d{2})$/);
  if (h) { current = { hash: h[1], date: h[2] }; continue; }
  const m = t.match(/^tools\/([a-z0-9-]+)\/index\.html$/);
  if (m && current) {
    gitDate[m[1]] ??= current.date;
    (gitCommits[m[1]] ??= []).push(current);
  }
}

/** The visible part of a page: everything after </head>. */
const bodyOf = (html) => {
  const i = html.indexOf('</head>');
  return i < 0 ? html : html.slice(i);
};

const gitShow = (hash, file) => {
  try {
    return execFileSync('git', ['show', `${hash}:${file}`], { cwd: htop, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) { return null; }
};

/**
 * The date the page's BODY last changed.
 * A commit counts only if the body differs from the state BEFORE that commit — so a
 * head-only sync (BUG-448's generator) never counts, but a real content edit does.
 * The oldest candidate is the commit that created the file (its body did not exist before).
 */
const bodyDate = (slug) => {
  const file = `tools/${slug}/index.html`;
  const cands = gitCommits[slug] || [];
  for (let i = 0; i < cands.length; i++) {
    const cur = gitShow(cands[i].hash, file);
    if (cur === null) continue;
    const prev = (i + 1 < cands.length)
      ? gitShow(cands[i + 1].hash, file)              // the previous version of this file
      : gitShow(cands[i].hash + '^', file);           // the state before this commit
    if (prev === null) return cands[i].date;          // the file was created here
    if (bodyOf(cur) !== bodyOf(prev)) return cands[i].date;
  }
  return null;
};

const manifest = readFileSync(`${htop}/manifest.txt`, 'utf8');
const slugs = [...new Set(manifest.split('\n').map(l => (l.trim().split('|')[0] || '').trim()).filter(s => s && !s.startsWith('#')))];

const dates = {};
const src = {};
for (const slug of slugs) {
  const html = readFileSync(`${htop}/tools/${slug}/index.html`, 'utf8');
  let d = (html.match(/"dateModified"\s*:\s*"(2\d{3}-\d{2}-\d{2})"/) || [])[1];
  if (d) { src[slug] = 'authored'; }
  else if (!shallow && (d = bodyDate(slug))) { src[slug] = "git"; }
  else if (carried[slug]) { d = carried[slug]; src[slug] = 'carried'; }
  else continue;
  if (d > today) throw new Error(`${slug}: date ${d} is in the future`);
  dates[slug] = d;
}

writeFileSync(`${htop}/tool-dates.json`, JSON.stringify(dates) + '\n');
const n = Object.keys(dates).length;
const g = Object.values(src).filter(s => s === 'git').length;
const c = Object.values(src).filter(s => s === 'carried').length;
console.log(`tool-dates.json: ${n}/${slugs.length} tools dated - ${n - g - c} authored, ${g} git, ${c} carried, ${slugs.length - n} undated (no invention)${shallow ? ' [shallow checkout: no guessing]' : ''}`);
