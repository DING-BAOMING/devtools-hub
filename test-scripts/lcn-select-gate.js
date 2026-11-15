#!/usr/bin/env node
// GATE for the a11y/label-content-name-mismatch fix on <select> (WCAG 2.5.3 Label in Name).
//
// The rule fires on any element carrying BOTH an aria-label and visible child text. A <select>'s
// visible child text is its whole <option> list, so an aria-label can never contain it: EVERY
// select with an aria-label is a guaranteed finding, and the audit only names 5 of them per crawl
// because it caps at 100 of 353 URLs. So the source is the right instrument here — the property is
// decidable from markup, unlike a rendered-text comparison.
//
// Asserts, over every tool page:
//   1. no <select> carries an aria-label            (the rule's trigger)
//   2. every <select> with a static id is still named -- by <label for>, a WRAPPING <label>,
//      or aria-labelledby. v1 of this gate only counted <label for> and reported 25 failures that
//      were all correct markup: <label>Heading: <select id="headingStyle">…</select></label> names
//      the select implicitly. An instrument that flags correct code gets ignored, so it was fixed
//      rather than the 25 pages.
//   3. no NEW <label for=X> targeting a missing id
//   4. no NEW duplicate id in a page
//
// Assertions 3 and 4 are not this rule. They are here because they are the invariants that make
// fix 1 safe -- a `for=` on a duplicated id names the wrong control. They are held to a KNOWN-BAD
// BASELINE rather than to zero, for the BUG-317 reason: a gate that reports pre-existing defects
// nobody asked about trains you to ignore it. Both lists are pre-existing and untouched by the
// fix; they are worth their own pass. Two entries are source-scanner artefacts (`#' + f.id + '`)
// -- the DOM only exists after the page's JS runs, so only a browser can rule on them.
//
// ANTI-VACUITY: pass a rootDir whose defects have been re-injected and the gate MUST fail.
//   node lcn-select-gate.js [rootDir]
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { fail++; console.log('  FAIL ' + m); };

// KNOWN-BAD baseline, measured 2026-10-07 before the fix and unchanged by it.
const KNOWN_BAD_FOR = new Set([
  'aspect-ratio-calculator :: for="arc-base-dim"',
  'debt-payoff-calculator :: for="debt-name-0"',
  'debt-payoff-calculator :: for="debt-balance-0"',
  'debt-payoff-calculator :: for="debt-apr-0"',
  'debt-payoff-calculator :: for="debt-min-0"',
  'tax-calculator :: for="us-filing-status-children"',
  'tdee-calculator :: for="tc-unit"',
]);
const KNOWN_DUPE_ID = new Set([
  'area-calculator :: #ac-out-floor-u x2',
  'area-calculator :: #ac-out-wall-u x2',
  'area-calculator :: #ac-out-total-u x2',
  'area-calculator :: #ac-out-paint-u x2',
  'audio-converter :: #bitrate x2',
  'cors-header-generator :: #copy-code-btn x2',
  'mileage-calculator :: #empty-year x2',
  'paint-calculator :: #pc-wall-area-u x2',
  'paint-calculator :: #pc-openings-u x2',
  'paint-calculator :: #pc-paintable-u x2',
  'pdf-to-excel :: #px-btn-text x2',
  'roofing-calculator :: #rc-area-u x2',
  'text-to-epub :: #cover-image x2',
  'video-cutter :: #download-link x3',
  'world-clock :: #hero-hours x2',
  'world-clock :: #hero-mins x2',
  'world-clock :: #hero-seconds x2',
]);

const files = [];
for (const d of fs.readdirSync(path.join(ROOT, 'tools'))) {
  const f = path.join(ROOT, 'tools', d, 'index.html');
  if (fs.existsSync(f)) files.push([d, f]);
}
for (const f of ['index.html', 'tools/index.html', 'about/index.html', 'contact/index.html',
  'privacy/index.html', 'subprocessors/index.html']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push([f.split('/')[0] || 'home', p]);
}
console.log(`scanning ${files.length} pages under ${ROOT}`);

const t0 = Date.now();
const selWithAria = [], selUnnamed = [], dupeLabels = [], badFor = [], dupeIds = [];
let selTotal = 0;

// A <label> that is still open at offset `at` encloses it: implicit labelling, no `for` needed.
const wrappedInLabel = (h, at) => {
  const opens = (h.slice(0, at).match(/<label\b/gi) || []).length;
  const closes = (h.slice(0, at).match(/<\/label\s*>/gi) || []).length;
  return opens > closes;
};

for (const [name, file] of files) {
  const h = fs.readFileSync(file, 'utf8');
  const selMatches = [...h.matchAll(/<select\b[^>]*>/gi)];
  selTotal += selMatches.length;

  for (const m of selMatches) {
    const tag = m[0];
    if (/\baria-label=/i.test(tag)) selWithAria.push(`${name}: ${tag.slice(0, 70)}`);
    const id = (tag.match(/\bid="([^"]*)"/i) || [])[1];
    if (!id || !/^[A-Za-z][\w-]*$/.test(id)) continue;      // JS template, no static id
    const n = (h.match(new RegExp(`<label[^>]*for="${id}"[\\s>]`, 'g')) || []).length;
    if (n > 1) dupeLabels.push(`${name}#${id} (${n})`);
    if (n === 0 && !wrappedInLabel(h, m.index) && !/\baria-labelledby=/i.test(tag)) {
      selUnnamed.push(`${name}#${id} ${tag.slice(0, 60)}`);
    }
  }

  const ids = [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((i) => !i.includes('+'));
  const seen = new Map();
  for (const i of ids) seen.set(i, (seen.get(i) || 0) + 1);
  for (const [i, n] of seen) if (n > 1) dupeIds.push(`${name} :: #${i} x${n}`);

  for (const m of h.matchAll(/<label[^>]*for="([^"]+)"/g)) {
    // A `for` containing `+` is inside a JS template string — the id only exists after the page's
    // JS runs, so this scanner cannot judge it. The browser tier (lcn-select-prod-test.js) is what
    // rules on these; asserting they are broken here would be asserting something untrue.
    if (m[1].includes('+')) continue;
    if (!new RegExp(`\\sid="${m[1]}"`).test(h)) badFor.push(`${name} :: for="${m[1]}"`);
  }
}
console.log(`  ${selTotal} <select> in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const check = (label, arr) => {
  if (arr.length) { bad(`${label}: ${arr.length}`); arr.slice(0, 8).forEach((x) => console.log('       ' + x)); }
  else ok(`${label}: 0`);
};
// A known-bad entry that has been FIXED is progress, not failure -- only unlisted ones are new.
const againstBaseline = (label, arr, known) => {
  const fresh = arr.filter((x) => !known.has(x));
  const healed = [...known].filter((x) => !arr.includes(x));
  if (fresh.length) { bad(`${label}: ${fresh.length} NEW`); fresh.slice(0, 8).forEach((x) => console.log('       ' + x)); }
  else ok(`${label}: 0 new (${arr.length} known-bad baseline${healed.length ? `, ${healed.length} healed` : ''})`);
};

check('selects still carrying an aria-label', selWithAria);
check('selects left with no accessible name', selUnnamed);
check('ids with more than one <label for>', dupeLabels);
againstBaseline('<label for> pointing at a missing id', badFor, KNOWN_BAD_FOR);
againstBaseline('duplicate ids in a page', dupeIds, KNOWN_DUPE_ID);

console.log(fail ? `\nGATE RED: ${fail} assertion(s) failed` : '\nGATE GREEN');
process.exit(fail ? 1 : 0);