#!/usr/bin/env node
// BUG-343 gate — `a11y/table-duplicate-name` (check id `tables-without-names`).
//
// WHY THE PREDICATE IS NOT "EVERY UNNAMED TABLE"
// A 29-page probe against squirrelscan 0.0.111 (`--rule-include a11y/table-duplicate-name`,
// local static server, --http --offline) pinned the rule's real semantics:
//
//   probe                                  fires?
//   v01  1 table, no name                      no   <- a lone unnamed table is NOT a finding
//   v14  2 tables, 1 named + 1 unnamed         YES
//   v15  2 tables, both unnamed                YES
//   v18  3 tables, 1 named + 2 unnamed         YES
//   v11/20 2 tables, different sr-only captions no
//   v02/19 1 or 2 tables with <caption>        no   <- a caption IS a name
//   v16/17 2 tables with the SAME name         YES  (the rule's other check: duplicates)
//   v24/25  role="presentation" tables          no   <- presentation tables are skipped
//   v21/22  tables only inside a <script>       no   <- a parser never sees them
//   v23     tables only inside a <textarea>     no
//
// So the gate models the RULE, not the defect class: a page fires only when it has >=2
// parser-visible tables and at least one of them is unnamed. That is why the class is
// 35 tables on 14 pages and not the "117 tables on 71 pages" a raw source grep reports —
// a lone unnamed table is invisible to the rule, and ~77 of the raw count live inside JS
// strings that no parser ever turns into DOM.
//
// WHAT IS MODELLED AS A PARSER SEES IT
// <script> and <textarea> bodies are raw text in HTML, so their contents are blanked before
// scanning. Without that, email-signature-generator's 9 template tables (the signature HTML
// the tool generates for the user, several already `role="presentation"`) would read as the
// page's own tables and would be "fixed" for a finding that does not exist.
//
// AN EMPTY ENUMERATION IS A SILENT GREEN
// If the table regex ever stops matching, this gate would print 0/0 and exit 0. The floor
// assertions at the bottom make a degenerate scan a FAIL.
//
// Anti-vacuity: pass a rootDir whose captions have been stripped and the gate must go red.
//   node bug343-table-name-gate.js /tmp/bug343-inject          (positional)
//   node bug343-table-name-gate.js --root /tmp/bug343-inject   (both accepted)
//
// BUG-345 — section [B], THE CLASS INSTEAD OF THE RULE
// Section [A] models the rule, and the rule cannot see a lone unnamed table, so it declared the
// site clean while 37 pages each shipped exactly one table with no name. BUG-343's own note
// guessed "15 pages"; measured with this same parser model it is 37 (the earlier count came from
// a raw grep that also counted `<script>`/`<textarea>` tables). [B] models the class — every
// parser-visible, non-presentation table carries a name — which is what WCAG's table-naming
// requirement and an AI agent reading raw HTML both care about. [A] must still pass, so this
// file stays a two-section gate rather than growing a second parser.

const SECTION_B_JS_CAPTIONS = {
  // These three tables are EMPTY SHELLS in the source and are rebuilt by JS, which wipes the
  // markup. A caption typed into the HTML would therefore exist only in the source — the
  // "looks instrumented, nothing a browser can see" trap (BUG-309 / BUG-312b). The caption has
  // to be emitted by the rebuild, so the class check has to accept it from the script body.
  'html-table-generator': /createElement\('caption'\)[\s\S]{0,200}?Preview of the table you are building/,
  'image-to-excel': /createElement\('caption'\)[\s\S]{0,200}?rows recognised in your image/,
  'mock-data-generator': /<caption class="sr-only">Preview of the generated rows<\/caption>/,
};
// [B] CANNOT SEE THESE — the live-DOM sweep (test-scripts/bug345-sweep-unnamed-tables.js, a
// browser, not this file) found 5 more tables that exist only after JS runs, and BUG-345 gave all
// five a caption in the rebuild: blood-type-calculator x3 (`bt-ps` x2 + `bt-compat`),
// speech-time-calculator x1 (the words-to-time result breakdown), recipe-converter x1 (the 101-row
// density table). A static gate cannot hold that line; the browser sweep is what keeps it.

const { readdirSync, statSync, readFileSync } = require('fs');
const { join } = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
// Both spellings are accepted. A `--root`-only parser silently ignored the positional form
// documented in the header, so the gate read the REAL tree and reported green for a copy
// that had every caption removed — a green gate measuring something other than its argument.
const ROOT = arg('--root', process.argv[2] && process.argv[2].startsWith('/') ? process.argv[2]
  : join(__dirname, '..'));
if (!ROOT.startsWith('/')) { console.log(`✗ root must be an absolute path, got ${ROOT}`); process.exit(1); }

const TABLE_RE = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
const RAW_TEXT_RE = /<(script|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi;

const slugs = readdirSync(join(ROOT, 'tools')).filter(d => {
  try {
    return statSync(join(ROOT, 'tools', d)).isDirectory() &&
      statSync(join(ROOT, 'tools', d, 'index.html')).isFile();
  } catch { return false; }
});

const named = (attrs, inner) =>
  /aria-label\s*=/i.test(attrs) || /aria-labelledby\s*=/i.test(attrs) ||
  /\stitle\s*=/i.test(attrs) || /<caption\b/i.test(inner);

let pagesScanned = 0, tablesSeen = 0, unnamed = 0;
const fires = [];
const loneUnnamed = [];
let allTables = 0, allNamed = 0;

for (const slug of slugs) {
  const raw = readFileSync(join(ROOT, 'tools', slug, 'index.html'), 'utf8');
  // A parser never turns markup inside <script>/<textarea> into DOM.
  const html = raw.replace(RAW_TEXT_RE, (m, tag) => `</${tag}>`);
  const tables = [];
  TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TABLE_RE.exec(html)) !== null) {
    // role="presentation" removes the table from the rule AND from the class: a layout table
    // has no subject to name.
    if (/role\s*=\s*"presentation"/i.test(m[1])) continue;
    tables.push({ id: (m[1].match(/id\s*=\s*"([^"]+)"/) || [])[1] || '(no id)', ok: named(m[1], m[2]) });
  }
  // [B] the class: every parser-visible table, not only the ones the rule can reach.
  for (const t of tables) {
    allTables++;
    if (t.ok) { allNamed++; continue; }
    if (SECTION_B_JS_CAPTIONS[slug] && SECTION_B_JS_CAPTIONS[slug].test(raw)) { allNamed++; continue; }
    if (tables.length === 1) loneUnnamed.push(`${slug} (${t.id})`);
  }
  if (tables.length < 2) continue;
  pagesScanned++;
  tablesSeen += tables.length;
  const bad = tables.filter(t => !t.ok);
  if (bad.length) {
    unnamed += bad.length;
    fires.push({ slug, total: tables.length, bad: bad.map(t => t.id) });
  }
}

console.log(`\n[A] pages with >=2 tables: ${pagesScanned} · parser-visible tables on those pages: ${tablesSeen}`);
console.log(`    a11y/table-duplicate-name · pages that fire: ${fires.length} · unnamed tables on them: ${unnamed}`);
fires.forEach(f => console.log(`  ✗ FAIL /tools/${f.slug}/ — ${f.total} tables, ${f.bad.length} unnamed: ${f.bad.join(', ')}`));
if (!fires.length) console.log('  ✓ no page fires the rule');

console.log(`\n[B] THE CLASS (BUG-345): parser-visible tables ${allTables} · named ${allNamed} · unnamed ${loneUnnamed.length}`);
loneUnnamed.forEach(s => console.log(`  ✗ FAIL /tools/${s}/ — the page's only table has no accessible name`));
if (!loneUnnamed.length) console.log('  ✓ every parser-visible table carries a name');

if (slugs.length < 300 || tablesSeen < 40 || pagesScanned < 10 || allTables < 60) {
  console.log(`  ✗ FAIL the scan itself is degenerate — ${slugs.length} pages / ${pagesScanned} multi-table pages / ${tablesSeen} tables / ${allTables} tables total.\n`);
  process.exit(1);
}
console.log(`\n${fires.length === 0 && loneUnnamed.length === 0 ? 'PASS' : `FAIL (${fires.length + loneUnnamed.length} page(s))`}\n`);
process.exit(fires.length === 0 && loneUnnamed.length === 0 ? 0 : 1);
