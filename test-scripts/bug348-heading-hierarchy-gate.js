#!/usr/bin/env node
// BUG-348 gate — heading levels must increase by at most one, on every tool page.
//
// THE FINDING WAS "2/10 PAGES"; THE CLASS IS 15 PAGES / 364 URLS
// The 2026-10-14 automated site review reported Warning 7 `agentimization/section-header-quality`
// as "2/10 pages have heading hierarchy issues (skipped levels, missing H1, or multiple H1s)" out
// of a 40-page crawl — and did not name the pages. Enumerating the whole catalogue (every HTML URL
// in sitemap.xml, 364 of them, measured on the rendered production page) found 15 pages whose
// outline jumps a level. Same under-report shape as BUG-308 (7 -> 192), BUG-316 (1 -> 53),
// BUG-320 (5 -> 203), BUG-343 (117 -> 35).
//
// A skipped level is not cosmetic. A screen-reader user navigating by heading (the standard way to
// skim a page without reading it) hears "Heading level 3" directly under the page title with no
// level 2 anywhere, and cannot tell whether "1. Choose your audio file" is a peer of the page or a
// child of something they never heard. The same outline is what an AI agent gets from raw HTML and
// what functions/tools/[[catchall]].js:1774 turns into `##`/`###` in the `.md` mirrors.
//
// WHAT THE GATE MODELS
// 1. Exactly one <h1> per page, and every later heading at most one level deeper than the one
//    before it. Heading order is document order, so an <h1> living in <header> (313 pages) and one
//    living in <main> (23 hero-layout pages) are both counted the same way — see BUG-324, where a
//    test that assumed "the h1 is inside <header>" failed against pages that lay out differently.
// 2. <script>/<style>/<noscript>/<template>/<textarea>/<svg>/<iframe> bodies are blanked first. A
//    parser never turns those into DOM, so counting headings inside them would report defects the
//    rule does not see (BUG-343's 77 phantom tables; BUG-329's 355 aria-labels).
// 3. Injected <h2>s cannot create a skip, so this is decidable from source: the Function appends
//    Related Free Tools / Comments & Ratings / References / FAQ as h2 at the end of <main>, and an
//    h2 never follows an h2 by more than one level. A static scan is therefore the honest
//    instrument here — the opposite of BUG-333, where the defect was a *runtime* tbody and no
//    source scan could see it.
//
// ANTI-VACUITY
// 1. Pass a rootDir (positional or --root) whose fixes have been stripped and the gate must go red
//    on the same 15 pages. `sed 's|<h2 class="pc-section-h">|<h3 class="pc-section-h">|'` on a copy
//    of one page is enough.
// 2. The floor assertion makes a degenerate scan a FAIL. A regex that silently stops matching
//    headings would report "0 pages with issues" and pass — so the gate also asserts it saw >300
//    pages and >2000 headings. It has been red: before the fix it reported 15 FAILs.
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let rootDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') rootDir = args[i + 1];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
rootDir = path.resolve(
  rootDir || path.join(__dirname, '..')
);
if (!fs.existsSync(path.join(rootDir, 'tools'))) {
  console.error('FAIL: no tools/ directory under ' + rootDir);
  process.exit(1);
}

// Tags whose text content is never DOM, so their headings must not be counted.
const BLIND = /<(script|style|noscript|template|textarea|svg|iframe)\b[\s\S]*?<\/\1>/gi;

function headings(html) {
  const src = html.replace(BLIND, t => ' '.repeat(t.length));
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ level: +m[1], text });
  }
  return out;
}

function check(file) {
  const html = fs.readFileSync(file, 'utf8');
  const hs = headings(html);
  const issues = [];
  const h1s = hs.filter(h => h.level === 1);
  if (h1s.length === 0) issues.push('no <h1>');
  else if (h1s.length > 1) issues.push(h1s.length + ' <h1>s');
  let prev = null;
  for (const h of hs) {
    if (prev !== null && h.level > prev + 1) {
      issues.push(`h${prev} -> h${h.level} at "${h.text.slice(0, 40)}"`);
      break; // one finding per page is enough to fail it
    }
    prev = h.level;
  }
  return { slug: path.basename(path.dirname(file)), count: hs.length, issues };
}

const toolsDir = path.join(rootDir, 'tools');
const slugs = fs
  .readdirSync(toolsDir)
  .filter(s => fs.existsSync(path.join(toolsDir, s, 'index.html')))
  .sort();

const fails = [];
let headingTotal = 0;
for (const slug of slugs) {
  const r = check(path.join(toolsDir, slug, 'index.html'));
  headingTotal += r.count;
  if (r.issues.length) fails.push({ slug, issues: r.issues });
}

console.log(`scanned ${slugs.length} tool pages, ${headingTotal} headings`);
for (const f of fails) {
  console.log(`FAIL /tools/${f.slug}/  ${f.issues.join('; ')}`);
}

// Degenerate-scan floor: an empty or truncated scan must not read as a pass.
if (slugs.length < 300) {
  console.log(`FAIL: only ${slugs.length} pages scanned — expected >300, the scan is degenerate`);
  process.exit(1);
}
if (headingTotal < 2000) {
  console.log(`FAIL: only ${headingTotal} headings seen — expected >2000, the heading regex is broken`);
  process.exit(1);
}

console.log(fails.length ? `\n${fails.length} page(s) with a broken heading outline` : 'GATE GREEN: heading levels never skip a level');
process.exit(fails.length ? 1 : 0);
