#!/usr/bin/env node
// BUG-317 gate: dead outbound reference URLs (SEO `links/broken-external-links`).
//
// squirrelscan named ONE 404, on /tools/excel-to-pdf/. The crawl is capped at 100 of ~1000 URLs,
// so the count was a function of which pages got visited: the same dead Adobe PDF-spec URL was
// cited by 13 tools, a dead Adobe SDK-docs root by 9 more, plus one dead NHS page, one dead
// Wikipedia article (renamed upstream) and one duplicated YAML slot. 23 pages, 4 dead URLs.
//
// This gate is a SOURCE gate on purpose, and it is not the same measurement as a link checker:
//
//   1. it enumerates every absolute outbound URL in the two places references can live --
//      TOOL_REFERENCES/CATEGORY_REFERENCES in functions/tools/[[catchall]].js and the literal
//      <a href> in each tools/*/index.html -- so it sees the pages the audit never crawled;
//   2. it pins the four URLs that were dead with a `DEAD` entry naming WHY each is dead, because
//      "return 404 today" is not a durable gate: these domains get reorganised. A link checker
//      re-run in six months would rediscover a *different* set; this one fails loudly on the
//      known-bad list and prints any newly-suspect URL for a human to judge.
//
// ANTI-VACUITY: `node bug317-dead-external-links-gate.js --inject <dir>` copies the tree, puts the
// four defects back, and requires the gate to fail. A gate that cannot go red measures nothing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const CATCHALL = path.join(SRC, 'functions/tools/[[catchall]].js');

let ran = 0, fails = 0;
const ok = (label, cond, extra) => {
  ran++;
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  ' + extra : ''));
};

// --- anti-vacuity: re-inject the defects into a scratch copy and prove the gate catches them ----
if (process.argv[2] === '--inject') {
  const dir = process.argv[3];
  if (!dir) { console.error('--inject needs a target dir'); process.exit(2); }
  fs.cpSync(SRC, dir, { recursive: true });
  const c = path.join(dir, 'functions/tools/[[catchall]].js');
  let s = fs.readFileSync(c, 'utf8');
  s = s.replace("{ name: 'Wikipedia — PDF specification (ISO 32000)', url: 'https://en.wikipedia.org/wiki/PDF' }",
                "{ name: 'PDF 1.7 Specification (ISO 32000-1)', url: 'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf' }");
  s = s.replace("{ name: 'Mozilla pdf.js — open-source PDF engine', url: 'https://github.com/mozilla/pdf.js' }",
                "{ name: 'Adobe — PDF SDK Documentation', url: 'https://opensource.adobe.com/dc-acrobat-sdk-docs/' }");
  s = s.replace("url: 'https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/'",
                "url: 'https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid-pregnancy/'");
  s = s.replace("{ name: 'CDC — Body Mass Index (BMI)', url: 'https://www.cdc.gov/bmi/' }",
                "{ name: 'CDC — Adult BMI Calculator', url: 'https://www.cdc.gov/healthyweight/assessing/bmi/adult_bmi/english_bmi_calculator/bmi_calculator.html' }");
  fs.writeFileSync(c, s);
  const pt = path.join(dir, 'tools/ping-test/index.html');
  fs.writeFileSync(pt, fs.readFileSync(pt, 'utf8')
    .replace('https://en.wikipedia.org/wiki/Latency_(computing)', 'https://en.wikipedia.org/wiki/Latency_(computer_networking)'));
  const pc = path.join(dir, 'tools/pdf-compare/index.html');
  fs.writeFileSync(pc, fs.readFileSync(pc, 'utf8')
    .replace('<li><a href="https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API"',
             '<li><a href="https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf">PDF 1.7 Specification</a></li>\n                    <li><a href="https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API"'));

  // The child exits 1 on failure — that is the point of the run, so catch instead of throwing.
  let r = '';
  try {
    r = execFileSync(process.execPath, [__filename, dir], { encoding: 'utf8' });
  } catch (e) {
    r = (e.stdout || '') + '';
  }
  console.log(r.trim());
  const reds = (r.match(/^FAIL /gm) || []).length;
  ok('anti-vacuity: the gate FAILS on a tree with the 5 defects re-injected', reds >= 4, reds + ' FAIL lines');
  console.log('\n' + (fails ? fails : 0) + ' of ' + ran + ' FAILED');
  process.exit(fails ? 1 : 0);
}

const ROOT = process.argv[2] || SRC;
const catchallPath = path.join(ROOT, 'functions/tools/[[catchall]].js');

// Dead as of 2026-10-06, re-probed with 3 user agents + curl. `why` is the part that matters.
const DEAD = {
  'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf':
    'Adobe moved the PDF standards docs off this host; the whole /dc-acrobat-sdk-docs/ tree is 404',
  'https://opensource.adobe.com/dc-acrobat-sdk-docs/':
    'same: /dc-acrobat-sdk-docs/ is 404',
  'https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid-pregnancy/':
    'NHS restructured; /foods-to-avoid/ is the live page and still carries the 200 mg/day caffeine limit',
  'https://en.wikipedia.org/wiki/Latency_(computer_networking)':
    'article renamed upstream to Latency_(computing)',
  'https://www.cdc.gov/healthyweight/assessing/bmi/adult_bmi/english_bmi_calculator/bmi_calculator.html':
    'CDC reorganised; curl gets 403 (bot-block) which HIDES the 404 — only a real browser sees it',
};

// --- 1. collect every absolute outbound URL, from both places references can live ----
const src = fs.readFileSync(catchallPath, 'utf8');
const refUrls = new Set();
for (const m of src.matchAll(/url:\s*'(https?:\/\/[^']+)'/g)) refUrls.add(m[1]);

const glob = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? glob(path.join(d, e.name)) : [path.join(d, e.name)]);
const htmlUrls = new Set();
for (const f of glob(path.join(ROOT, 'tools'))) {
  if (!f.endsWith('.html')) continue;
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/href="(https?:\/\/[^"]+)"/g)) htmlUrls.add(m[1].replace(/&amp;/g, '&'));
}

const all = [...refUrls, ...htmlUrls];
console.log('scanned ' + refUrls.size + ' TOOL_REFERENCES URLs + ' + htmlUrls.size +
            ' tool-HTML URLs = ' + all.length + ' absolute outbound URLs\n');

// --- 2. none of the known-dead URLs may survive anywhere ----
for (const [u, why] of Object.entries(DEAD)) {
  const hits = all.filter(x => x === u);
  ok('dead URL gone: ' + u.replace(/^https?:\/\//, '').slice(0, 62), hits.length === 0,
     hits.length ? hits.length + ' reference(s) left — ' + why : '');
}

// --- 3. a LIVE reference block may not cite the same URL twice in adjacent slots -------------
// pdf-splitter cited the PDF spec twice, so the page showed the identical anchor twice — a user
// saw a duplicate citation and no second source. Scoped to slugs that exist in manifest.txt:
// 42 TOOL_REFERENCES keys are stale (renamed tools), and their blocks never render, so a rule
// that fires on unreachable code reports a defect nobody can observe and trains you to ignore it.
const manSlugs = new Set(fs.readFileSync(path.join(ROOT, 'manifest.txt'), 'utf8')
  .split('\n').map(l => l.split('|')[0].trim()).filter(Boolean));
const dupes = [];
const blockRe = /^\s{4}'([a-z0-9-]+)':\s*\[([\s\S]*?)^\s{4}\]/gm;
let bm;
while ((bm = blockRe.exec(src))) {
  if (!manSlugs.has(bm[1])) continue;                       // unreachable block, skip
  const urlsIn = [...bm[2].matchAll(/url:\s*'(https?:\/\/[^']+)'/g)].map(m => m[1]);
  for (let i = 1; i < urlsIn.length; i++) if (urlsIn[i] === urlsIn[i - 1]) dupes.push(bm[1] + ' → ' + urlsIn[i]);
}
ok('no live reference block cites the same URL in two adjacent slots (pdf-splitter case)',
   dupes.length === 0, dupes.join(' ; '));

// --- 4. the replacements must be present, or the "fix" deleted the citation instead of moving it ----
const MUST = [
  ['https://en.wikipedia.org/wiki/PDF', 'PDF spec replacement (used by 13 PDF tools); /wiki/ISO_32000 is itself a redirect here'],
  ['https://github.com/mozilla/pdf.js', 'PDF SDK replacement (used by 9 PDF tools)'],
  ['https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/', 'NHS caffeine replacement'],
  ['https://en.wikipedia.org/wiki/Latency_(computing)', 'Wikipedia latency replacement'],
  ['https://www.cdc.gov/bmi/', 'CDC BMI replacement (bmi-calculator)'],
];
for (const [u, why] of MUST) ok('replacement present: ' + u.replace(/^https?:\/\//, '').slice(0, 58), all.includes(u), why);

// --- 5. every URL must still be a single well-formed URL (a joined path is 404 by construction) ----
const malformed = all.filter(u => (u.match(/https?:\/\//g) || []).length > 1);
ok('no URL contains a second scheme (joined-path bug)', malformed.length === 0, malformed.join(' '));

// --- 6. a sanity count: the reference set must still be substantial (a wiped table passes 2-4) ----
ok('reference set is intact (not emptied): ' + refUrls.size + ' Function refs, ' + htmlUrls.size + ' HTML refs',
   refUrls.size > 200 && htmlUrls.size > 300);

console.log('\n' + (fails ? fails : 0) + ' of ' + ran + ' FAILED');
process.exit(fails ? 1 : 0);