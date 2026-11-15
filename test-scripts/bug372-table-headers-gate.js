#!/usr/bin/env node
// BUG-372 gate — a shipped data table must carry its header row, not an empty <thead>.
//
// WHY
// The 2026-10-17 fresh 40-page squirrel audit (v0.0.111) named a11y/table-headers (warning) on
// two pages — /tools/ai-crawler-log-analyzer/ ("1 to 5 table(s) without <th> headers") and
// /tools/apca-contrast-checker/ ("Table 1"). The class, enumerated from the tree and NOT copied
// from the finding: 10 tables on 6 files whose shipped source has rows + <td> but ZERO <th>.
//
//   ai-crawler-log-analyzer  ac-bots / ac-pivot / ac-paths / ac-status-t / ac-spoof
//   apca-contrast-checker    ap-weights-table
//   csv-to-sql               cs-preview
//   html-table-generator     htgTable
//   image-to-excel           dataTable
//   mock-data-generator      table-preview
//
// All 10 are runtime-filled ("fill()"/renderWeightTable/OcrBeginner builds <th scope="col"> when
// data arrives), so the RENDERED page is correct — but the audit (render off) reads the shipped
// bytes, and every one of these tools already KNOWS its column set when its own JS runs, so the
// empty <thead> is information the page has and withholds from the source.
//
// THE BOUNDARY, stated and enforced (same shape as BUG-355/BUG-358 "say where the gate stops"):
// the fix covers the FIXED-COLUMN tables only — 5 tables on 2 files, where the column list is a
// constant the JS re-generates identically on every run. The other 5 are DATA-DEPENDENT (the
// columns come from a parsed CSV, a user-built table, OCR output, a generated field set, or the
// top paths of a submitted log) and there is NO honest header to ship pre-run: inventing one is
// exactly BUG-355's "prose in a <th>" defect and BUG-320's aria-label="None" lie. They are listed
// by slug + table id — ids do not drift like the line-number pins BUG-355 deleted — and the gate
// asserts each exclusion still exists AS an empty-thead table, so the list cannot quietly
// outlive its reason.
//
// The two-rule trap both were read out of the binary first:
//   a11y/table-headers          — warn when a table has 0 <th>
//   a11y/th-has-data-cells      — warn when a <th> has no <td> in its row AND none in its column
// A full header row over a single colspan=N placeholder <td> satisfies BOTH (the colspan covers
// every column, so every <th> sees a data cell in its column). A header row over an EMPTY tbody
// would satisfy the first and re-fire the second.
//
// Usage: node bug372-table-headers-gate.js [rootDir]
//   rootDir defaults to ../../devtools-hub. Pass a pre-fix tree to prove the gate goes red —
//   the gate must be shown red before it is believed.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

// Non-DOM containers are blanked before enumerating tables — a table inside a <script> string is
// not DOM (BUG-343/BUG-355 lesson; the 15 raw hits of previous rounds were 5 hits of text).
const strip = (s) => s
  .replace(/<(script|style|noscript|template|textarea)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

// slug -> table ids whose column set is only knowable at runtime (see THE BOUNDARY above).
const DATA_DEPENDENT = new Map([
  ['ai-crawler-log-analyzer', ['ac-pivot']],
  ['csv-to-sql', ['cs-preview']],
  ['html-table-generator', ['htgTable']],
  ['image-to-excel', ['dataTable']],
  ['mock-data-generator', ['table-preview']],
]);
const DDEP_TABLES = [...DATA_DEPENDENT.values()].reduce((a, v) => a + v.length, 0);

function tablesOf(html) {
  return [...strip(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((m) => {
    const t = m[1];
    return {
      id: (m[0].match(/\bid="([^"]+)"/) || [])[1] || '(no id)',
      th: (t.match(/<th[\s>]/g) || []).length,
      tr: (t.match(/<tr[\s>]/g) || []).length,
      td: (t.match(/<td[\s>]/g) || []).length,
      html: m[0],
    };
  });
}

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (f === 'index.html') out.push(p);
  }
  return out;
}

// ── Tier A: the whole authored tree — every static table with cells carries a header row ──
let seenTables = 0;
let seenHeaderless = [];
for (const file of walk(path.join(ROOT, 'tools'))) {
  const slug = file.split('/tools/')[1].split('/index.html')[0];
  for (const t of tablesOf(fs.readFileSync(file, 'utf8'))) {
    if (t.tr === 0 || (t.tr === 0 && t.td === 0)) continue; // empty shells are not tables yet
    seenTables++;
    const exempt = DATA_DEPENDENT.get(slug)?.includes(t.id);
    if (t.th === 0) {
      if (exempt) continue;
      seenHeaderless.push(`${slug} ${t.id}`);
      continue; // collected; reported once below
    }
    if (exempt) {
      // The exclusion list must never outlive its reason: a listed id that now HAS headers means
      // the class changed — the list entry is stale and must be deleted, not hidden behind a pass.
      failures.push(`STALE EXCLUSION: ${slug}#${t.id} now carries ${t.th} <th> — delete the id from DATA_DEPENDENT`);
    }
  }
}
ok(seenHeaderless.length === 0,
  `${seenHeaderless.length} static table(s) with rows/cells but ZERO <th>: ${seenHeaderless.join(' | ')}`);

// ── Tier B: the exclusion list is exactly 5 tables, each still present as an empty-thead table ──
ok(DDEP_TABLES === 5, `DATA_DEPENDENT must stay 5 tables (is ${DDEP_TABLES}) — rot check: a shrunken list hides what it stopped watching`);
for (const [slug, ids] of DATA_DEPENDENT) {
  const src = fs.readFileSync(path.join(ROOT, 'tools', slug, 'index.html'), 'utf8');
  for (const id of ids) {
    const t = tablesOf(src).find((x) => x.id === id);
    if (!ok(t, `excluded table ${slug}#${id} is gone from the file`)) continue;
    if (!ok(t.th === 0, `excluded table ${slug}#${id} unexpectedly carries ${t.th} <th>`)) continue;
    // the placeholder state must stay a spanning single cell over an empty thead — if the JS was
    // edited to fill headers at load, the exclusion above is stale and this table belongs in Tier D.
    ok(/<thead><\/thead>/i.test(t.html) || /<thead>\s*<\/thead>/i.test(t.html),
      `excluded table ${slug}#${id} its <thead> is no longer empty`);
  }
}

// ── Tier C: for every fixed table, the static header row equals what the JS generates at runtime ──
// (fill('<id>', [{label, num}, …], …) is the single writer of those 4 theads; if the source row
// and the runtime row ever disagree, one of them is stale.)
function runtimeColsFor(id, src) {
  const re = new RegExp(`fill\\(['"]${id}['"]\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*,`);
  const m = src.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/\{ label: '([^']*)'(, num: true)? \}/g)]
    .map((x) => ({ label: x[1], num: Boolean(x[2]) }));
}
const FIXED_TW = { slug: 'ai-crawler-log-analyzer', ids: ['ac-bots', 'ac-paths', 'ac-status-t', 'ac-spoof'] };
{
  const src = fs.readFileSync(path.join(ROOT, 'tools', FIXED_TW.slug, 'index.html'), 'utf8');
  for (const id of FIXED_TW.ids) {
    const cols = runtimeColsFor(id, src);
    if (!ok(cols && cols.length > 2, `no runtime column list found for ${id} (fill() signature changed?)`)) continue;
    const t = tablesOf(src).find((x) => x.id === id);
    if (!ok(t, `fixed table ${id} is gone`)) continue;
    const headRow = t.html.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1] || '';
    const ths = [...headRow.matchAll(/<th\b([^>]*)>([^<]*)<\/th>/g)].map((x) => ({
      attrs: x[1], label: x[2].trim(),
    }));
    if (!ok(ths.length === cols.length, `${id}: static <th> count ${ths.length} ≠ runtime columns ${cols.length}`)) continue;
    ths.forEach((th, i) => {
      ok(th.label === cols[i].label, `${id}: col ${i} static "${th.label}" ≠ runtime "${cols[i].label}"`);
      ok(/scope="col"/.test(th.attrs), `${id}: col ${i} ${th.label} missing scope="col"`);
      ok(Boolean(cols[i].num) === /class="num"/.test(th.attrs),
        `${id}: col ${i} ${th.label} num class mismatch (runtime ${cols[i].num}, static has it: ${/class="num"/.test(th.attrs)})`);
    });
    // placeholder cell spans every column (the th-has-data-cells interplay, see header comment)
    const ph = t.html.match(/<t[dh][^>]*colspan="(\d+)"/);
    ok(ph && Number(ph[1]) === cols.length,
      `${id}: placeholder colspan ${ph ? ph[1] : '(none)'} ≠ column count ${cols.length}`);
  }
}
// apca-contrast-checker: weights thead must equal [Lc, ...WEIGHTS]
{
  const src = fs.readFileSync(path.join(ROOT, 'tools/apca-contrast-checker/index.html'), 'utf8');
  const weights = src.match(/var WEIGHTS = \[([^\]]*)\]/)?.[1].split(',').map((x) => x.trim());
  if (ok(weights, 'WEIGHTS array not found')) {
    const t = tablesOf(src).find((x) => x.id === 'ap-weights-table');
    if (ok(t, 'ap-weights-table is gone')) {
      const headRow = t.html.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1] || '';
      const labels = [...headRow.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map((x) => x[1].trim());
      const expected = ['Lc', ...weights];
      ok(JSON.stringify(labels) === JSON.stringify(expected),
        `ap-weights-table static headers ${JSON.stringify(labels)} ≠ runtime shape ${JSON.stringify(expected)}`);
      ok(/<tbody><tr id="ap-weights-row"><td colspan="10">/.test(t.html),
        'ap-weights-table placeholder row changed shape');
    }
  }
}

// ── Tier D: overall volume still holds (an assertion that cannot go red is not an assertion) ──
ok(seenTables >= 40, `expected ≥40 static tables in the tree, counted ${seenTables}`);

if (failures.length) {
  console.log(`bug372-table-headers-gate: ${failures.length} FAIL`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
console.log(`bug372-table-headers-gate: ${checks} checks, 0 FAIL (${seenTables} static tables, ${seenHeaderless.length} headerless)`);
