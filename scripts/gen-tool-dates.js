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
//   1. the tool's own authored `"dateModified"` in its index.html JSON-LD (312 tools);
//   2. the last git commit date that touched its index.html (27 of the remainder are tracked).
// Tools with neither get NO entry: patchToolHtml then falls back to the page's own
// dateModified/datePublished (informative, not claimed fresh), and the sitemap simply
// omits `<lastmod>` for that URL — `<lastmod>` is optional and absent beats wrong.
//
// Run by scripts/pre-deploy.sh before every deploy; safe to run any time.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const htop = import.meta.dirname + '/..';
const today = new Date().toISOString().slice(0, 10);

// git route: newest-first ls; the first time a slug's index.html appears is its latest edit.
const gitDate = {};
let current = null;
for (const line of execFileSync('git', ['log', '--date=short', '--name-only', '--pretty=format:%ad'], { cwd: htop, maxBuffer: 64 * 1024 * 1024 }).toString().split('\n')) {
  const t = line.trim();
  if (!t) { current = null; continue; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { current = t; continue; }
  const m = t.match(/^tools\/([a-z0-9-]+)\/index\.html$/);
  if (m && current) gitDate[m[1]] ??= current;
}

const manifest = readFileSync(`${htop}/manifest.txt`, 'utf8');
const slugs = [...new Set(manifest.split('\n').map(l => (l.trim().split('|')[0] || '').trim()).filter(s => s && !s.startsWith('#')))];

const dates = {};
const src = {};
for (const slug of slugs) {
  let d = (readFileSync(`${htop}/tools/${slug}/index.html`, 'utf8').match(/"dateModified"\s*:\s*"(2\d{3}-\d{2}-\d{2})"/) || [])[1];
  if (d) { src[slug] = 'authored'; }
  else if ((d = gitDate[slug])) { src[slug] = 'git'; }
  else continue;
  if (d > today) throw new Error(`${slug}: date ${d} is in the future`);
  dates[slug] = d;
}

writeFileSync(`${htop}/tool-dates.json`, JSON.stringify(dates) + '\n');
const n = Object.keys(dates).length;
const g = Object.values(src).filter(s => s === 'git').length;
console.log(`tool-dates.json: ${n}/${slugs.length} tools dated - ${n - g} authored, ${g} git, ${slugs.length - n} undated (no invention)`);
