#!/usr/bin/env node
// BUG-347 gate — tables with no static <th> are a bounded, LEDGER'd population, not a defect.
//
// Original defect (BUG-347): the 9 JS-built tables on 5 pages shipped `<thead></thead>` in the
// served bytes — a header-less grid to a no-JS reader. The original fix shipped single-cell
// `<th>` placeholders into those tables.
//
// 2026-10-26 RESHAPE (re-measured against the current convention; gate was RED on a correct
// tree through several rounds — exercising BUG-383's own warning). The placeholder strategy was
// superseded by the convention this tree now uses, and the current served state is CORRECT:
//   - `<caption class="sr-only">` names every table (BUG-343's gate enforces that site-wide);
//   - `<thead></thead>` stays EMPTY because the column names do not exist yet — they come from
//     the user's data (ac-pivot/cs-preview/dataTable) or are built with the table itself
//     (htgTable/table-preview/zc-matrix, verified 25/10/4 th at runtime);
//   - `<tbody>` carries the BUG-249 one-cell empty-state row ("Run the analyzer to see rows
//     here."), which is the only "no data yet" signal a no-JS reader gets;
//   - the `.md` mirror publishes an EMPTY header row, never the placeholder as a column name
//     (BUG-380's fix in libs/html-md.js).
// Inventing static column names for these tables would be a lie: there are no columns until
// the user supplies data. So "every parser-visible table has a <th> in source" is no longer the
// invariant — THIS is:
//
//   1. A parser-visible table without a static <th> must be placeholder-shaped: its <thead>
//      has no cells, and its <tbody> holds either nothing or only one-cell empty-state rows.
//      A header-less table carrying REAL data cells is a defect and FAILs on its own — no slug
//      list is consulted; the ledger is a rot detector, not the rule.
//   2. The no-th population is the LEDGER below (6 tables on 6 pages, measured 2026-10-26).
//      A seventh table without a static <th> FAILs until it is deliberately added here with a
//      runtime verification.
//   3. Compile floors: the scan must have really run (>= 300 slugs, >= 40 tables, >= 30 tables
//      on pages with any table). An empty enumeration must never read as PASS.
//
// ANTI-VACUITY
//   node bug347-th-in-source-gate.js /tmp/some-tree
//   - Pass a tree whose ledger tables carry a REAL data row (placeholder replaced with 4 tds)
//     and the gate must go red on exactly those tables.
//   - Pass a tree with a <th> stripped from a normal table (e.g. any of the 4 ai-crawler-log-
//     analyzer data tables) and that table joins the no-th population → LEDGER FAIL.
//
//   node bug347-th-in-source-gate.js                      (the real tree)
//   node bug347-th-in-source-gate.js /tmp/some-copy       (a mutated tree)

const { readdirSync, statSync, readFileSync, existsSync } = require('fs');
const { join, resolve } = require('path');

// The repo root defaults to the product tree next to this docs checkout
// (devtools-hub-docs/test-scripts/../../devtools-hub), so the gate runs with no arguments.
// An explicit absolute path still wins.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(__dirname, '..');
if (!ROOT.startsWith('/')) {
  console.log(`✗ root must be an absolute path, got ${JSON.stringify(ROOT)}\n  pass a positional arg, e.g. node bug347-th-in-source-gate.js /home/.../devtools-hub`);
  process.exit(1);
}
if (!existsSync(join(ROOT, 'tools'))) {
  console.log(`✗ ${ROOT} does not look like the devtools-hub tree (no tools/ directory)\n  pass a positional arg, e.g. node bug347-th-in-source-gate.js /home/.../devtools-hub`);
  process.exit(1);
}

const TABLE_RE = /<table\s+([^>]*)>([\s\S]*?)<\/table>/gi;
const RAW_TEXT_RE = /<(script|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi;

// LEDGER — the intended no-th population (page → table ids), measured 2026-10-26 from the tree:
//   ai-crawler-log-analyzer #ac-pivot   columns = the URLs the user's crawl log contains
//   csv-to-sql             #cs-preview  columns = the user's CSV header
//   html-table-generator   #htgTable    JS fills <thead> on generate (4 th at runtime)
//   mock-data-generator    #table-preview JS fills on generate (10 th at runtime)
//   image-to-excel         #dataTable   columns = the OCR'd header row of the user's image
//   zodiac-compatibility   #zc-matrix   JS builds the whole 13×12 matrix on load (25 th at runtime)
const LEDGER = {
  'ai-crawler-log-analyzer': ['ac-pivot'],
  'csv-to-sql': ['cs-preview'],
  'html-table-generator': ['htgTable'],
  'mock-data-generator': ['table-preview'],
  'image-to-excel': ['dataTable'],
  'zodiac-compatibility': ['zc-matrix'],
};

const slugs = readdirSync(join(ROOT, 'tools')).filter(d => {
  try { return statSync(join(ROOT, 'tools', d)).isDirectory() && statSync(join(ROOT, 'tools', d, 'index.html')).isFile(); }
  catch { return false; }
});

let pagesScanned = 0, tablesSeen = 0, allTables = 0;
const noThLedger = [];   // no-th AND placeholder-shaped
const realDefects = [];  // no-th and NOT placeholder-shaped — a header-less data grid
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); return cond; };

for (const slug of slugs) {
  const raw = readFileSync(join(ROOT, 'tools', slug, 'index.html'), 'utf8');
  const html = raw.replace(RAW_TEXT_RE, (m, tag) => `</${tag}>`);
  const tables = [];
  TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_RE.exec(html)) !== null) {
    if (/role\s*=\s*"presentation"/i.test(m[1])) continue;
    const inner = m[2];
    const id = (m[1].match(/id\s*=\s*"([^"]+)"/) || [])[1] || '(no id)';
    const hasTh = /<th\b/i.test(inner);
    tables.push({ id, hasTh });
    if (hasTh) continue;
    // The no-th half. Placeholder-shaped: thead free of cells, tbody rows is single-cell rows
    // only (each row exactly one cell), or no body rows at all (fully JS-built shells).
    const thead = (inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i) || ['',''])[1];
    const tbody = (inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i) || ['',''])[1];
    const theadCells = /<[th]d\b/i.test(thead) ? (thead.match(/<\/[th]d>/gi) || []).length : 0;
    const rows = (tbody.match(/<tr[\s\S]*?<\/tr>/gi) || []);
    const cellsPerRow = rows.map(r => (r.match(/<\/[th]d>/gi) || []).length);
    const shaped = theadCells === 0 && (rows.length === 0 || (Math.max(...cellsPerRow) <= 1));
    if (shaped) noThLedger.push({ slug, id });
    else realDefects.push(`${slug}#${id} — no <th> and not placeholder-shaped (thead cells ${theadCells}, tbody cells per row [${cellsPerRow.join(',')}])`);
  }
  for (const t of tables) allTables++;
  if (!tables.length) continue;
  pagesScanned++;
  tablesSeen += tables.length;
}

// 1. the rule: no header-less data grid anywhere, regardless of the ledger
if (realDefects.length) {
  realDefects.forEach(d => ok(false, `headerless data grid: ${d}`));
} else {
  ok(true, `0 tables without a static <th> carry real data rows`);
}

// 2. the ledger: the no-th population is exactly the 6 intended tables
const ledgerAdds = [];
for (const [slug, ids] of Object.entries(LEDGER)) {
  for (const id of ids) {
    const found = noThLedger.find(e => e.slug === slug && e.id === id);
    if (!found) ledgerAdds.push(`LEDGER missing: /tools/${slug}/#${id} is not a no-th table any more — it now has a static <th> (fine) or changed id; if intended, drop it from the ledger`);
  }
}
for (const e of noThLedger) {
  const known = (LEDGER[e.slug] || []).includes(e.id);
  ok(known, `NEW no-th table not in the ledger: /tools/${e.slug}/#${e.id} — either a defect (see rule 1) or verify its runtime columns and add it to LEDGER with a reason`);
}
const expectedCount = Object.values(LEDGER).reduce((a, b) => a + b.length, 0);
ok(noThLedger.length === expectedCount, `no-th population: ${noThLedger.length} (expected ${expectedCount} per the ledger)`);
ledgerAdds.forEach(a => ok(true, a)); // informational only, printed below

// 3. compile floors
ok(slugs.length >= 300, `scan degenerate — only ${slugs.length} slugs`);
ok(allTables >= 40, `scan degenerate — only ${allTables} parser-visible tables`);
ok(tablesSeen >= 30, `scan degenerate — only ${tablesSeen} tables on pages with tables`);

console.log(`\nscanned ${pagesScanned} pages with parser-visible tables · ${allTables} tables total`);
console.log(`BUG-347 · no-static-<th> tables: ${noThLedger.length} (ledger ${expectedCount}) · headerless data grids: ${realDefects.length}`);
noThLedger.forEach(e => console.log(`  · /tools/${e.slug}/#${e.id}`));
ledgerAdds.forEach(a => console.log(`  ℹ ${a}`));
realDefects.forEach(d => console.log(`  ✗ FAIL ${d}`));
if (failures.length) {
  failures.forEach(f => console.log(`  ✗ FAIL ${f}`));
  console.log(`\nFAIL\n`);
  process.exit(1);
}
console.log(`\nPASS\n`);
process.exit(0);
