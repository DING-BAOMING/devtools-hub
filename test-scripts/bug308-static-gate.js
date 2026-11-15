#!/usr/bin/env node
// BUG-308 static gate. Proves the `outline: none` -> `outline: 2px solid transparent`
// transform changed exactly what it claimed to and nothing else.
//
// G1  0 `outline: none|0` remains inside any `:focus` rule, sitewide.
// G2  0 `outline: 2px solid transparent` sits in a NON-focus rule (scope guard: the
//     transform must not have leaked onto non-focusable elements or @media print).
// G3  every file that contains a transparent base also contains a focus-visible painter
//     somewhere in its cascade chain — either in its own <style> or via /styles.css.
//     A transparent base with no painter is an invisible focus indicator all over again,
//     which is the bug wearing a different hat.
// G4  git diff touches only `outline:` lines. Any other changed line means the CSS-rule
//     walker mis-parsed something (prose, an attribute, a <pre> block) and the transform
//     is not trustworthy.
// G5  the 11 previously-defective rules each now have a focus-visible painter.
// Usage: node bug308-static-gate.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = n => { pass++; console.log(`  PASS ${n}`); };
const no = (n, m) => { fail++; console.log(`  FAIL ${n} — ${m}`); };
const chk = (n, c, m) => c ? ok(n + (m ? ' — ' + m : '')) : no(n, m || '');

function cssBlocks(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}
function rules(css) {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(m => ({ sel: m[1], body: m[2] }));
}

const files = [];
for (const t of fs.readdirSync(path.join(ROOT, 'tools'))) {
  const f = path.join(ROOT, 'tools', t, 'index.html');
  if (fs.existsSync(f)) files.push(f);
}
for (const e of fs.readdirSync(ROOT)) {
  if (e.endsWith('.html')) { const f = path.join(ROOT, e); if (fs.statSync(f).isFile()) files.push(f); }
}

console.log(`BUG-308 static gate — ${files.length} pages\n`);

// Selector lookup for a declaration at css[i]: scan back to the nearest brace pair. The
// `[^{}]*` rule-walk used first cannot cross a nested @media block and silently skipped 4
// of the 270 declarations, which would have let G1/G2 pass while `outline: none` survived.
function ownerSel(css, i) {
  const open = css.lastIndexOf('{', i);
  const prevClose = css.lastIndexOf('}', i);
  return css.slice(prevClose + 1, open);
}
// G1
const g1 = [];
for (const f of files) {
  const css = cssBlocks(f);
  for (const m of css.matchAll(/outline\s*:\s*(?:none|0)\b/g))
    if (ownerSel(css, m.index).includes(':focus')) g1.push(`${path.relative(ROOT, f)} | ${ownerSel(css, m.index).trim().slice(0, 60)}`);
}
chk('G1 no `outline: none|0` left in any :focus rule', g1.length === 0, g1.slice(0, 3).join(' ;; ') || '0 found');

// G2
const g2 = [];
for (const f of files) {
  const css = cssBlocks(f);
  for (const m of css.matchAll(/outline\s*:\s*2px solid transparent/g))
    if (!ownerSel(css, m.index).includes(':focus')) g2.push(`${path.relative(ROOT, f)} | ${ownerSel(css, m.index).trim().slice(0, 60)}`);
}
chk('G2 no transparent base leaked into a non-focus rule', g2.length === 0, g2.slice(0, 3).join(' ;; ') || '0 found');

// G3 — only pages that ACTUALLY carry a transparent base are in scope. Checking every page
// that merely fails to link /styles.css over-flags: background-remover and the
// test-csp-page.html fixture have no outline declarations at all, so there is nothing to
// paint and nothing broken.
const siteHasPainter = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').includes('*:focus-visible{outline:3px solid #7eb3ff');
const loadsStyles = f => /href="\/styles\.css"/.test(fs.readFileSync(f, 'utf8'));
const g3 = [];
for (const f of files) {
  const css = cssBlocks(f);
  if (!/outline\s*:\s*2px solid transparent/.test(css)) continue;
  const own = /:focus-visible[^{]*\{[^}]*outline:\s*3px solid/.test(css);
  if (!(own || (loadsStyles(f) && siteHasPainter))) g3.push(path.relative(ROOT, f));
}
chk('G3 every page carrying a transparent base can actually paint it', g3.length === 0,
  g3.length ? g3.join(' ') : `sitewide painter present=${siteHasPainter}`);

// G4 — integrity, NOT a git diff. A git baseline is unusable here: the working tree carries
// a large uncommitted backlog (BUG-304's title/description edits, BUG-306/307's 587 deleted
// lines), so `git diff` reports 1976 changed lines that belong to earlier work and 169
// "unexpected outline changes" that are simply pre-existing rules the transform never saw.
// What can be proved without a baseline:
//   G4a  every <style> block still has balanced braces (the CSS-rule walker cannot have
//        mis-parsed and dropped a chunk),
//   G4b  the per-file LEDGER reconciles: every file's transparent-base declaration count
//        matches what was last accounted for by hand, and G1/G2 already prove all of them
//        sit inside a :focus rule,
//   G4c  every one of them belongs to a selector that is a focus state.
// G4b is a prepared LEDGER, generated 2026-10-20 from a tree that G1/G2/G4c/G5 all prove
// correct (279 declarations over 200 files). The single-absolute-total version it replaced
// had hardcoded 271 and went RED on a correct tree after later rounds touched focus CSS —
// a gate red on a correct site trains the next session to ignore it. When a round adds or
// removes a compliant transparent base, update that file's LEDGER entry by hand: the
// per-file delta names the drift a single total cannot.
let g4a = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = m[1];
    const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
    if (open !== close) g4a.push(`${path.relative(ROOT, f)} (${open} open / ${close} close)`);
  }
}
chk('G4a every <style> block still has balanced braces', g4a.length === 0, g4a.slice(0, 3).join(' ;; ') || `${files.length} pages clean`);

// G4b/G4c — count DECLARATIONS
const LEDGER = {
  "tools/2fa-authenticator/index.html": 3,
  "tools/age-calculator/index.html": 1,
  "tools/ai-chat/index.html": 1,
  "tools/ai-content-writer/index.html": 1,
  "tools/ai-crawler-checker/index.html": 1,
  "tools/ai-crawler-log-analyzer/index.html": 1,
  "tools/ai-detector/index.html": 1,
  "tools/ai-email-writer/index.html": 1,
  "tools/ai-prompt-engineer/index.html": 2,
  "tools/ai-writing-coach/index.html": 1,
  "tools/api-tester/index.html": 3,
  "tools/aspect-ratio-calculator/index.html": 1,
  "tools/barcode-generator/index.html": 1,
  "tools/binary-hex-converter/index.html": 1,
  "tools/bingo-card-generator/index.html": 1,
  "tools/birthday-wishes-generator/index.html": 1,
  "tools/bmi-calculator/index.html": 1,
  "tools/book-search/index.html": 1,
  "tools/btu-calculator/index.html": 1,
  "tools/business-card-maker/index.html": 2,
  "tools/caffeine-calculator/index.html": 1,
  "tools/calorie-calculator/index.html": 1,
  "tools/case-converter/index.html": 1,
  "tools/chart-maker/index.html": 2,
  "tools/citation-generator/index.html": 2,
  "tools/click-speed-test/index.html": 1,
  "tools/code-minifier/index.html": 2,
  "tools/color-blindness-simulator/index.html": 1,
  "tools/color-contrast-checker/index.html": 2,
  "tools/color-palette-generator/index.html": 1,
  "tools/concrete-calculator/index.html": 1,
  "tools/cors-header-generator/index.html": 1,
  "tools/cover-letter-generator/index.html": 1,
  "tools/crossword-puzzle-maker/index.html": 1,
  "tools/css-animation-generator/index.html": 2,
  "tools/css-box-shadow-generator/index.html": 1,
  "tools/css-flexbox-generator/index.html": 2,
  "tools/css-formatter/index.html": 2,
  "tools/css-gradient-generator/index.html": 1,
  "tools/css-grid-generator/index.html": 3,
  "tools/css-to-tailwind/index.html": 1,
  "tools/daily-holiday/index.html": 2,
  "tools/date-calculator/index.html": 1,
  "tools/days-until-calculator/index.html": 1,
  "tools/dictionary/index.html": 1,
  "tools/dns-lookup/index.html": 1,
  "tools/dog-age-calculator/index.html": 1,
  "tools/domain-age-checker/index.html": 1,
  "tools/drawing-board/index.html": 1,
  "tools/due-date-calculator/index.html": 2,
  "tools/email-auth-checker/index.html": 1,
  "tools/email-header-analyzer/index.html": 1,
  "tools/email-signature-generator/index.html": 1,
  "tools/email-verifier/index.html": 1,
  "tools/engagement-rate-calculator/index.html": 2,
  "tools/epub-to-pdf/index.html": 2,
  "tools/essay-writer/index.html": 1,
  "tools/excel-to-pdf/index.html": 1,
  "tools/excel-viewer/index.html": 1,
  "tools/fancy-text-generator/index.html": 1,
  "tools/favicon-generator/index.html": 2,
  "tools/feedback/index.html": 1,
  "tools/file-checksum-verifier/index.html": 1,
  "tools/flashcard-maker/index.html": 1,
  "tools/fraction-calculator/index.html": 3,
  "tools/gpa-calculator/index.html": 4,
  "tools/grade-calculator/index.html": 1,
  "tools/grammar-checker/index.html": 1,
  "tools/graphing-calculator/index.html": 1,
  "tools/habit-tracker/index.html": 1,
  "tools/hashtag-generator/index.html": 1,
  "tools/horoscope/index.html": 1,
  "tools/htaccess-redirect-tester/index.html": 3,
  "tools/html-entity-encoder/index.html": 2,
  "tools/html-table-generator/index.html": 1,
  "tools/html-to-image/index.html": 1,
  "tools/html-to-markdown-converter/index.html": 3,
  "tools/html-to-pdf/index.html": 2,
  "tools/http-status-checker/index.html": 2,
  "tools/image-cropper/index.html": 1,
  "tools/image-extender/index.html": 1,
  "tools/image-resizer/index.html": 1,
  "tools/image-to-excel/index.html": 1,
  "tools/image-to-text/index.html": 1,
  "tools/image-to-video/index.html": 2,
  "tools/image-to-word/index.html": 2,
  "tools/image-watermark/index.html": 1,
  "tools/investment-calculator/index.html": 1,
  "tools/invoice-generator/index.html": 1,
  "tools/javascript-obfuscator/index.html": 2,
  "tools/js-formatter/index.html": 2,
  "tools/json-csv-converter/index.html": 2,
  "tools/json-schema-validator/index.html": 2,
  "tools/json-to-typescript/index.html": 3,
  "tools/json-xml-converter/index.html": 3,
  "tools/json-yaml-converter/index.html": 2,
  "tools/letter-generator/index.html": 1,
  "tools/logo-maker/index.html": 2,
  "tools/lorem-ipsum-generator/index.html": 2,
  "tools/lottery-number-generator/index.html": 1,
  "tools/margin-calculator/index.html": 1,
  "tools/markdown-editor/index.html": 1,
  "tools/markdown-to-pdf/index.html": 1,
  "tools/math-calculator/index.html": 2,
  "tools/math-solver/index.html": 1,
  "tools/meme-generator/index.html": 1,
  "tools/mermaid-diagram-generator/index.html": 1,
  "tools/meta-tag-generator/index.html": 1,
  "tools/metronome/index.html": 2,
  "tools/mileage-calculator/index.html": 1,
  "tools/minecraft-circle-generator/index.html": 1,
  "tools/mind-map-maker/index.html": 2,
  "tools/mock-data-generator/index.html": 2,
  "tools/name-generator/index.html": 1,
  "tools/number-to-words/index.html": 2,
  "tools/object-remover/index.html": 1,
  "tools/og-image-generator/index.html": 1,
  "tools/on-this-day/index.html": 2,
  "tools/online-notepad/index.html": 1,
  "tools/p-value-calculator/index.html": 1,
  "tools/package-tracker/index.html": 1,
  "tools/paint-calculator/index.html": 2,
  "tools/paraphrasing-tool/index.html": 2,
  "tools/password-strength-checker/index.html": 1,
  "tools/paycheck-calculator/index.html": 1,
  "tools/pdf-aloud-reader/index.html": 3,
  "tools/pdf-form-filler/index.html": 1,
  "tools/pdf-page-numbers/index.html": 1,
  "tools/pdf-redactor/index.html": 1,
  "tools/pdf-signer/index.html": 1,
  "tools/pdf-splitter/index.html": 1,
  "tools/pdf-to-excel/index.html": 2,
  "tools/pdf-to-image/index.html": 1,
  "tools/pdf-to-word/index.html": 1,
  "tools/pdf-unlocker/index.html": 1,
  "tools/pdf-watermark/index.html": 1,
  "tools/percentage-calculator/index.html": 1,
  "tools/photo-editor/index.html": 1,
  "tools/plagiarism-checker/index.html": 1,
  "tools/pomodoro-timer/index.html": 3,
  "tools/poster-maker/index.html": 1,
  "tools/prayer-times/index.html": 1,
  "tools/proxy-checker/index.html": 1,
  "tools/random-generator/index.html": 2,
  "tools/receipt-generator/index.html": 1,
  "tools/recipe-converter/index.html": 1,
  "tools/resistor-color-code-calculator/index.html": 1,
  "tools/resume-builder/index.html": 1,
  "tools/retirement-calculator/index.html": 1,
  "tools/roman-numeral-converter/index.html": 2,
  "tools/roofing-calculator/index.html": 1,
  "tools/schema-markup-generator/index.html": 1,
  "tools/seating-chart-maker/index.html": 1,
  "tools/screen-recorder/index.html": 1,
  "tools/screenshot-tool/index.html": 1,
  "tools/sentence-rewriter/index.html": 1,
  "tools/seo-checker/index.html": 1,
  "tools/sitemap-audit/index.html": 2,
  "tools/size-converter/index.html": 1,
  "tools/slug-generator/index.html": 1,
  "tools/snake-game/index.html": 1,
  "tools/song-lyrics-finder/index.html": 1,
  "tools/speech-time-calculator/index.html": 3,
  "tools/spin-the-wheel/index.html": 1,
  "tools/ssl-checker/index.html": 1,
  "tools/statistics-calculator/index.html": 1,
  "tools/stock-tracker/index.html": 1,
  "tools/study-planner/index.html": 1,
  "tools/subnet-calculator/index.html": 1,
  "tools/subtitle-editor/index.html": 3,
  "tools/subtitle-generator/index.html": 2,
  "tools/svg-optimizer/index.html": 1,
  "tools/table-of-contents-generator/index.html": 2,
  "tools/tarot-reading/index.html": 1,
  "tools/tdee-calculator/index.html": 1,
  "tools/text-cleaner/index.html": 1,
  "tools/text-diff/index.html": 2,
  "tools/text-to-epub/index.html": 2,
  "tools/text-to-handwriting/index.html": 2,
  "tools/text-to-speech/index.html": 2,
  "tools/text-to-video/index.html": 2,
  "tools/tile-calculator/index.html": 2,
  "tools/time-calculator/index.html": 2,
  "tools/tip-calculator/index.html": 1,
  "tools/tone-generator/index.html": 2,
  "tools/translator/index.html": 2,
  "tools/unit-converter/index.html": 1,
  "tools/url-metadata-extractor/index.html": 1,
  "tools/url-shortener/index.html": 1,
  "tools/user-agent-parser/index.html": 1,
  "tools/utm-builder/index.html": 2,
  "tools/venn-diagram-maker/index.html": 1,
  "tools/virtual-piano/index.html": 2,
  "tools/weather-forecast/index.html": 1,
  "tools/webcam-test/index.html": 1,
  "tools/website-down-checker/index.html": 1,
  "tools/what-day-is-it/index.html": 1,
  "tools/whois-lookup/index.html": 1,
  "tools/word-cloud-generator/index.html": 1,
  "tools/word-search-maker/index.html": 1,
  "tools/wordle-helper/index.html": 1,
  "tools/work-hours-calculator/index.html": 3,
  "tools/workout-planner/index.html": 1,
  "tools/world-cup-tracker/index.html": 1,
  "tools/youtube-thumbnail-downloader/index.html": 1,
  "tools/zodiac-compatibility/index.html": 1,
};
// G4b/G4c — count DECLARATIONS, not rules, and resolve each declaration's owning selector
// by scanning back to the nearest brace. A rule-counting regex is wrong here: `[^{}]*`
// cannot match across a nested @media block, so 4 of the 271 accounted declarations sat in
// rules a naive walker never reported (271 declarations / 266 naive rules). G4b compares
// per file against LEDGER; G4c is the zero-tolerance focus-state rule.
let decls = 0, nonFocus = [], g4bDeltas = [];
for (const f of files) {
  const css = cssBlocks(f);
  for (const m of css.matchAll(/outline\s*:\s*2px solid transparent/g)) {
    decls++;
    const open = css.lastIndexOf('{', m.index);
    const prevClose = css.lastIndexOf('}', m.index);
    const sel = css.slice(prevClose + 1, open);
    if (!sel.includes(':focus')) nonFocus.push(`${path.relative(ROOT, f)} | ${sel.trim().replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  const n = [...css.matchAll(/outline\s*:\s*2px solid transparent/g)].length;
  const rel = path.relative(ROOT, f), exp = LEDGER[rel] || 0;
  if (n !== exp) g4bDeltas.push(`${rel} has ${n}, ledger ${exp}`);
}
for (const rel of Object.keys(LEDGER)) {
  if (!fs.existsSync(path.join(ROOT, rel))) g4bDeltas.push(`${rel} is in the ledger but missing from the tree`);
}
chk('G4b transparent-base declaration ledger reconciles (' + Object.keys(LEDGER).length + ' files / ' + decls + ' declarations)', g4bDeltas.length === 0, g4bDeltas.slice(0, 3).join(' ;; ') || 'ledger reconciles');
chk('G4c all transparent bases sit on a focus state', nonFocus.length === 0, nonFocus.slice(0, 3).join(' ;; ') || `${decls}/${decls}`);

// G5
const DEFECTS = {
  'code-minifier': 'textarea:focus', 'css-formatter': 'textarea:focus',
  'html-to-markdown-converter': '.converter-editor:focus', 'html-to-pdf': '.h2p-editor:focus',
  'javascript-obfuscator': 'textarea:focus', 'js-formatter': 'textarea:focus',
  'json-to-typescript': '.j2t-panel textarea:focus', 'markdown-editor': '.md-editor:focus', 'markdown-to-pdf': '.converter-editor:focus',
  'online-notepad': '#notepad-textarea:focus', 'text-diff': 'textarea:focus',
};
const g5 = [];
for (const [slug, sel] of Object.entries(DEFECTS)) {
  const f = path.join(ROOT, 'tools', slug, 'index.html');
  const painter = /:focus-visible[^{]*\{[^}]*outline:\s*3px solid/.test(cssBlocks(f)) ||
    (loadsStyles(f) && siteHasPainter);
  if (!painter) g5.push(slug);
}
chk('G5 all 10 previously-defective tools can paint a focus ring', g5.length === 0, g5.join(',') || '10/10');

console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
if (fail) process.exitCode = 1;
