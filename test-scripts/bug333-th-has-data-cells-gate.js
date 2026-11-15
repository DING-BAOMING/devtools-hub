#!/usr/bin/env node
// BUG-333 gate — a data table whose body is filled by JS must still ship ONE data cell in
// its own source.
//
// WHY
// `<thead><tr><th>Source</th>…</tr></thead><tbody></tbody>` means the served HTML contains a
// header row and NO rows under it. WCAG 1.3.1 / `a11y/th-has-data-cells`: every header must be
// associated with data cells. It also means a no-JS visitor, a crawler and an AI agent reading
// the raw source see a table header describing data that is not there. The fix is one line —
// BUG-249's placeholder row, the same one caffeine-calculator, auto-loan-calculator,
// body-fat-calculator, compound-interest-calculator and debt-payoff-calculator already carry:
//
//     <tbody><tr><td colspan="5">No data yet.</td></tr></tbody>
//
// Every affected page REPLACES its tbody on first render (`tbody.innerHTML = …`), so the
// placeholder is overwritten before the user can see it. A page that only APPENDED would keep
// the placeholder forever — that is why the check is not "does the gate go green".
//
// A JS-STRING TABLE IS NOT A TABLE — blank the bodies, do not keep a known-good list.
// 48 of the `<th>` tables this gate used to count exist only as text inside a `<script>`/`<template>`/
// `<textarea>` body (`graphing-calculator` #tableOut/#fitTable, `blood-type-calculator`'s `tbl()`
// helper, `stopwatch`'s lap list, `ping-test`'s ptCompareTable(), `html-to-pdf`'s DEFAULT_SAMPLE,
// `excel-viewer`, `pdf-to-excel`, `excel-to-pdf`, `json-csv-converter`, `email-signature-generator`'s
// 9 previews …).
// (`graphing-calculator` #tableOut/#fitTable, `blood-type-calculator`'s `tbl()` helper, `stopwatch`'s
// lap list, `ping-test`'s ptCompareTable(), `html-to-pdf`'s DEFAULT_SAMPLE, `excel-viewer`,
// `pdf-to-excel`, `excel-to-pdf`, `json-csv-converter`, `email-signature-generator`'s 9 previews …).
// They are never DOM, they concatenate their own rows between the header and `</table>`, and there
// is no static `<tbody>` to give a row to. This gate used to carry them in a `JS_BUILT` map keyed by
// **line number**: 5 pins, and an edit above any one of them moved it and turned a known-good table
// into a FAIL. `blood-type-calculator` drifted 827 -> 828 that way and the gate shipped RED on a
// correct page. Blank the bodies instead and the exclusion is structural: no pin, nothing to
// re-pin, and a NEW JS-built table needs no allowance either. (BUG-343's lesson, same shape.)
//
// WHY THE CHECK TREATS AN EMPTY <tbody> AND A MISSING ONE DIFFERENTLY
// Counting `<td>` across the table passes `blood-type-calculator`'s odds table, whose `<tbody>`
// is empty but whose `<tfoot>` carries `<td colspan="3">Total</td>` — the header really had no data
// cells and the defect shipped anyway. The `<tbody>` is what the rule is about.
//
// WHY THERE IS NO colspan ASSERTION HERE
// Three live tables have a colspan that is correct but not equal to the column count:
// `apca-contrast-checker` (#ap-weights-table, BUG-298's `<th colspan="10">` + `<td colspan="10">`
// pair where the runtime header has 11 columns), `ping-test` (an unreachable row merging the 9
// middle columns) and `blood-type-calculator`'s `<tfoot>Total` spanning 3 of 5. A rule demanding
// `colspan == th count` fires on all three and would have to be weakened to mean anything. The
// defect being gated is "a header with no data cells", so that is the whole rule.
//
// SECOND DEFECT (BUG-355): a placeholder MESSAGE sitting in the header row.
//     <thead><tr><th colspan="6">Column headers appear after the log is parsed.</th></tr></thead>
// A `<th>` is a column or row header, so that announces a column *named* "Column headers appear
// after the log is parsed" — `a11y/th-has-data-cells`, WCAG 1.3.1. The `<tbody>` placeholder below
// it looked fine to the first version of this gate, which is why the rule shipped on 10 tables.
// It is also a GEO lie: `libs/html-md.js` turns the table into markdown, so `/tools/csv-to-sql/.md`
// published `| Column headers appear after the CSV is parsed. |` as a column heading. The message
// belongs where the rest of the empty-state copy already is — the `<tbody>` row — or nowhere.
//
// WHY THE PREDICATE IS "ONE <th> AND NO <td>" AND NOT "colspan != column count"
// Scoping the check to script-free source, that predicate selects exactly the 10 defective tables on
// 6 pages and nothing else. The ungated version of the same scan walks into `<script>` strings and
// reports 15, 5 of which are not DOM. A `colspan == th count` rule was tried and cut — BUG-333's
// note on the three live tables it fires on still stands.
//
// WHAT IS NOT IN SCOPE (measured, deliberately left for another round)
//   · tables with no accessible name (`a11y/table-duplicate-name` — closed site-wide by BUG-343).
//   · 11 tables on 7 pages have no `<th>` AT ALL — a different defect (`a11y/table-headers`),
//     and for `email-signature-generator`'s 9 preview tables the honest fix is to admit they are
//     not data tables, not to bolt a header row onto a preview.
// Both are recorded in BUGS.md BUG-333 so they cannot rot.
//
// Run: node test-scripts/bug333-th-has-data-cells-gate.js [--root <dir>]

const { readdirSync, statSync, readFileSync } = require('fs');
const { join } = require('path');

const HUB = join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = arg('--root', HUB);

const slugs = readdirSync(join(ROOT, 'tools')).filter(d => {
  try {
    return statSync(join(ROOT, 'tools', d)).isDirectory() &&
      statSync(join(ROOT, 'tools', d, 'index.html')).isFile();
  } catch { return false; }
});

const TABLE_RE = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
// A <table> inside one of these bodies is source text, not DOM. Blanked, not allow-listed.
const NON_DOM_RE = /<(script|style|noscript|template|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi;

let pass = 0, fail = 0, skipped = 0, blankedTables = 0, checked = 0;
const bad = [];

for (const slug of slugs) {
  const raw = readFileSync(join(ROOT, 'tools', slug, 'index.html'), 'utf8');
  const html = raw.replace(NON_DOM_RE, m => ' '.repeat(m.length));
  blankedTables += (raw.match(TABLE_RE) || []).length - (html.match(TABLE_RE) || []).length;
  TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_RE.exec(html)) !== null) {
    const line = html.slice(0, m.index).split('\n').length;
    const inner = m[2];
    const th = (inner.match(/<th\b/gi) || []).length;
    if (th === 0) { skipped++; continue; }          // a different defect — not this gate's
    checked++;
    const id = (m[1].match(/id\s*=\s*"([^"]+)"/) || [])[1] || '(no id)';
    const tbody = (inner.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i) || [])[1];
    const anyCell = (inner.match(/<td\b/gi) || []).length;
    // Two ways to ship the defect. A `<tbody>` that exists but is empty — even when a `<tfoot>`
    // elsewhere in the same table carries cells. Or no data cell anywhere under the header,
    // whether the rows sit in an explicit `<tbody>` or not (implicit tbody is normal HTML5, so
    // "there is no <tbody> tag" is NOT the defect).
    if (tbody !== undefined && (tbody.match(/<td\b/gi) || []).length === 0) {
      fail++;
      bad.push({ slug, id, th, line, why: `${th} <th> and an empty <tbody>` });
      continue;
    }
    if (anyCell === 0) {
      fail++;
      bad.push({ slug, id, th, line, why: `${th} <th> and no data cell anywhere in the table` });
      continue;
    }
    // BUG-355: a header row that is one <th> and no <td> is a message, not a header. Checked
    // AFTER the tbody rule so the pre-BUG-333 shape (empty tbody AND a message header) is still
    // reported once, under the name it shipped under.
    const thead = (inner.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i) || [])[1];
    const headerMsg = thead !== undefined && (thead.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).some(r =>
      (r.match(/<th\b/gi) || []).length === 1 && (r.match(/<td\b/gi) || []).length === 0);
    if (headerMsg) {
      fail++;
      bad.push({ slug, id, th, line, why: 'a placeholder message sitting in the <thead> row as its only <th>' });
      continue;
    }
    pass++;
  }
}

console.log(`\nDOM tables with <th> headers: ${checked} · pass: ${pass} · FAIL: ${fail}`);
bad.forEach(b => console.log(`  ✗ FAIL /tools/${b.slug}/ line ${b.line} — table #${b.id}: ${b.why}`));
console.log(`  (${skipped} table(s) with no <th> at all are out of scope — see the header comment)`);
console.log(`  (${blankedTables} table(s) inside <script>/<template>/<textarea> bodies — not DOM, not scanned)`);

// An empty enumeration is a silent green: if the table regex ever stopped matching, this gate
// would report 0/0 and PASS. Require the catalogue to have been read.
if (slugs.length < 300 || checked < 50) {
  console.log(`  ✗ FAIL the scan itself is degenerate — ${slugs.length} pages / ${checked} tables.\n`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);