#!/usr/bin/env node
// Static gate for /tools/excel-formula-translator/.
//
// The page carries a 490-function x 17-language localization table inline. That data is the
// product, so the gate checks the DATA against published ground truth, not the page's shape.
//
// Ground truth it is pinned to:
//   SUM     -> SUMA/SUMME/SOMME/SOMA/VERKKEN/SOMA ...
//   VLOOKUP -> BUSCARV/SVERWEIS/RECHERCHEV/CERCA.VERT/PROCV ...
//   IFERROR -> SI.ERROR/WENNFEHLER/SIERREUR ...
//   XLOOKUP -> BUSCARX/XVERWEIS/RECHERCHEX/CERCA.X/PROCX (dynamic arrays are absent from the
//              2019-era public tables, so these were read off Microsoft's own locale-specific
//              support pages, which is why they are pinned separately)
//
// Anti-vacuity: --inject <dir> runs the same gate against a copy of the page with the data
// blob emptied, and requires the ground-truth assertions to FAIL. A gate that has never been
// seen red measures nothing.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const rootArg = (() => { const i = argv.indexOf('--root'); return i >= 0 ? argv[i + 1] : null; })();
const inject = (() => { const i = argv.indexOf('--inject'); return i >= 0 ? argv[i + 1] : null; })();
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const root = path.resolve(rootArg || positional[0] || path.join(__dirname, '..'));
const PAGE = path.join(root, 'tools', 'excel-formula-translator', 'index.html');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };

if (!fs.existsSync(PAGE)) { console.log('FAIL: no page at ' + PAGE); process.exit(1); }
let html = fs.readFileSync(PAGE, 'utf8');
if (inject) {
  html = html.replace(/var FNB = "[^"]*"/, 'var FNB = ""').replace(/var ERRB = "[^"]*"/, 'var ERRB = ""');
}

console.log('gate: ' + PAGE + (inject ? '  [anti-vacuity: data stripped]' : ''));

// ---- pull the data straight out of the shipped page (not a side file) -------------
function blob(name) {
  const m = html.match(new RegExp('var ' + name + ' = ("(?:[^"\\\\]|\\\\.)*")'));
  if (!m) return null;
  return JSON.parse(m[1]);
}
const FN = blob('FNB'), ERR = blob('ERRB'), CAT = blob('CATB');
ok('function blob present in the page', !!FN);
ok('error blob present in the page', !!ERR);
ok('category blob present in the page', !!CAT);
if (!FN || !ERR || !CAT) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const LOC = JSON.parse(html.match(/var LOC = (\[[\s\S]*?\]);/)[1]);
const rows = FN.split('\n').map(l => l.split('|'));
const errs = ERR.split('\n').map(l => l.split('|'));
const cats = {};
CAT.split('\n').forEach(l => { const p = l.split('|'); cats[p[0]] = p[1]; });

ok('17 locales declared', LOC.length === 17, 'got ' + LOC.length);
ok('490 functions', rows.length === 490, 'got ' + rows.length);
ok('7 error codes', errs.length === 7, 'got ' + errs.length);
ok('every function row has one field per locale', rows.every(r => r.length === LOC.length + 1));
ok('every error row has one field per locale', errs.every(r => r.length === LOC.length + 1));
ok('no duplicate English names', new Set(rows.map(r => r[0])).size === rows.length);

const L = LOC.map(l => l[0]);
const g = (en, loc) => { const r = rows.find(x => x[0] === en); return r ? r[L.indexOf(loc) + 1] : undefined; };

// ---- published ground truth ------------------------------------------------------
const TRUTH = {
  SUM:     { Spanish: 'SUMA', German: 'SUMME', French: 'SOMME', Italian: 'SOMMA', 'Portuguese, Brazil': 'SOMA', Dutch: 'SOM', Russian: 'СУММ' },
  VLOOKUP: { Spanish: 'BUSCARV', German: 'SVERWEIS', French: 'RECHERCHEV', Italian: 'CERCA.VERT', 'Portuguese, Brazil': 'PROCV', Dutch: 'VERT.ZOEKEN' },
  IFERROR: { Spanish: 'SI.ERROR', German: 'WENNFEHLER', French: 'SIERREUR', Italian: 'SE.ERRORE' },
  IF:      { Spanish: 'SI', German: 'WENN', French: 'SI', Italian: 'SE' },
  MATCH:   { Spanish: 'COINCIDIR', German: 'VERGLEICH', French: 'EQUIV' },
  COUNTIF: { Spanish: 'CONTAR.SI', German: 'ZÄHLENWENN', French: 'NB.SI' },
  FALSE:   { German: 'FALSCH', French: 'FAUX', Spanish: 'FALSO' },
  TRUE:    { German: 'WAHR', French: 'VRAI', Spanish: 'VERDADERO' },
  // read off Microsoft's own locale-specific support pages
  XLOOKUP: { Spanish: 'BUSCARX', German: 'XVERWEIS', French: 'RECHERCHEX', Italian: 'CERCA.X', 'Portuguese, Brazil': 'PROCX' },
  UNIQUE:  { Spanish: 'UNICOS', German: 'EINDEUTIG', Italian: 'UNICI' },
  FILTER:  { Spanish: 'FILTRAR', Italian: 'FILTRO' },
  SORT:    { German: 'SORTIEREN', French: 'TRIER', Italian: 'DATI.ORDINA' },
  SORTBY:  { German: 'SORTIERENNACH', French: 'TRIERPAR', Italian: 'DATI.ORDINA.PER' },
  SEQUENCE:{ German: 'SEQUENZ', Italian: 'SEQUENZA' },
  RANDARRAY:{ German: 'ZUFALLSMATRIX', French: 'TABLEAU.ALEA', Italian: 'MATR.CASUALE' },
};
for (const [en, map] of Object.entries(TRUTH)) {
  for (const [loc, want] of Object.entries(map)) {
    ok(`${en} in ${loc} = ${want}`, g(en, loc) === want, 'got ' + JSON.stringify(g(en, loc)));
  }
}

// names that are identical in every locale must not be in the table at all
ok('LAMBDA absent (identical everywhere we have data)', g('LAMBDA', 'Spanish') === undefined);
ok('LET absent (identical everywhere we have data)', g('LET', 'Spanish') === undefined);

// ---- error codes -----------------------------------------------------------------
const E = {}; errs.forEach(r => { E[r[0]] = r; });
const ERR_TRUTH = {
  '#VALUE!':  { German: '#WERT!', French: '#VALEUR!', Spanish: '#¡VALOR!' },
  '#N/A':     { German: '#NV' },
  '#REF!':    { German: '#BEZUG!', Spanish: '#¡REF!' },
  '#NUM!':    { German: '#ZAHL!', French: '#NOMBRE!' },
  '#DIV/0!':  { Spanish: '#¡DIV/0!' },
  '#NAME?':   { Spanish: '#¿NOMBRE?', French: '#NOM?' },
  '#NULL!':   { French: '#NUL!', Spanish: '#¡NULO!' },
};
// Absences are facts, not gaps: these codes are genuinely NOT localized in these languages,
// and the page renders them as "same as English" rather than inventing a spelling.
const ERR_NOT_LOCALIZED = {
  '#N/A':     ['French', 'Spanish'],
  '#DIV/0!':  ['German', 'French'],
  '#NAME?':   ['German'],
  '#NULL!':   ['German'],
  '#REF!':    ['French'],
};
for (const [en, map] of Object.entries(ERR_TRUTH)) {
  ok(`${en} row exists`, !!E[en]);
  for (const [loc, want] of Object.entries(map)) {
    ok(`${en} in ${loc} = ${want}`, E[en] && E[en][L.indexOf(loc) + 1] === want, E[en] ? JSON.stringify(E[en][L.indexOf(loc) + 1]) : 'no row');
  }
}

for (const [en, locs] of Object.entries(ERR_NOT_LOCALIZED)) {
  for (const loc of locs) {
    const cell = E[en] && E[en][L.indexOf(loc) + 1];
    ok(`${en} is NOT localized in ${loc}`, E[en] && !cell, E[en] ? JSON.stringify(cell) : 'no row');
  }
}

// ---- page-level SEO / a11y / bug regressions this repo has already been bitten by ----
const head = html.slice(0, html.indexOf('</head>'));
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
ok('title <= 60 chars', title.length <= 60, title.length + ': ' + title);
ok('description <= 155 chars', ((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '').length <= 155);
ok('canonical present', /<link rel="canonical" href="https:\/\/tools\.scoreroute\.com\/tools\/excel-formula-translator\/">/.test(head));
ok('robots meta present', /<meta name="robots" content="index, follow/.test(head));
ok('every JSON-LD block parses (BUG-312b)',
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].every(m => { try { return !!JSON.parse(m[1])['@type']; } catch (e) { return false; } }));
ok('no data-cf-beacon tag (BUG-309)', !/data-cf-beacon/.test(html));
ok('no outline: none (BUG-308)', !/outline\s*:\s*none/i.test(html));
ok('links /styles.css', /<link rel="stylesheet" href="\/styles\.css">/.test(head));
ok('no HTML entity in the shipped meta description (BUG-297)', !/&(amp|lt|gt|quot);/.test((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || ''));
ok('breadcrumb links to its own category', /<a href="\/tools\/converters\/">Converters<\/a>/.test(html));
ok('feedback link', /\/tools\/feedback\//.test(html));
ok('both tables have an sr-only caption (BUG-343)', (html.match(/<caption class="sr-only">/g) || []).length === 2);
ok('both tbodies ship a placeholder row the script replaces (BUG-333)',
  (html.match(/<tbody><tr><td colspan="3">No data yet\.<\/td><\/tr><\/tbody>/g) || []).length === 2);
ok('FAQ details present and match the FAQPage', (html.match(/class="faq-item"/g) || []).length === 8);
ok('no external script besides /tools.js', (html.match(/<script[^>]*src="([^"]*)"/g) || []).every(m => m.includes('/tools.js')));

// ---- tokenizer / data-shape invariants the page relies on -------------------------
const IDENT = html.match(/var IDENT = (\/.*?\/[a-z]*);/);
const ERRTOK = html.match(/var ERRTOK = (\/.*?\/[a-z]*);/);
ok('IDENT is /u-flagged (BUG-329: without u it strips every letter)', IDENT && IDENT[1].endsWith('uy'), IDENT && IDENT[1]);
ok('ERRTOK is /u-flagged', ERRTOK && ERRTOK[1].endsWith('uy'), ERRTOK && ERRTOK[1]);
ok('ERRTOK has a quantifier (it did not once, so only #W was ever read)',
  ERRTOK && /[+*]\/[a-z]*$/.test(ERRTOK[1]), ERRTOK && ERRTOK[1]);
ok('row separator is 1 byte, not \\u0001 (page weight)', /var U = '\|'/.test(html));
ok('analyse() is given the destination locale', /function analyse\(formula, srcIdx, dstIdx\)/.test(html));

// a blob containing a quote or </script> would break out of the JS string / the page
ok('data blobs contain no character that can terminate the string or a tag',
  [FN, ERR, CAT].every(b => !/["'<>\u2028\u2029]|<!--/.test(b)));

console.log(`${pass} passed, ${fail} failed`);
if (inject && fail === 0) { console.log('anti-vacuity FAILED: the stripped page still passes, so this gate measures nothing'); process.exit(1); }
process.exit(fail ? 1 : 0);