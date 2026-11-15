#!/usr/bin/env node
// BUG-358 static gate: `agentimization/tabbed-content-serialization` — Warning 6/7 of the
// 2026-10-15 site review ("3/3 tabbed pages have hidden content that AI agents may miss").
//
// The rule's own demand — "expose all tab content in the page source" — was already met: the
// panels are real static markup, not runtime-inserted. What was actually wrong is one layer
// down, in the surface an agent reads. The .md mirrors were losing the tab STRIP, and the
// strip is the only place a panel's name appears:
//
//   size-converter ships `<div class="s-panel" id="panel-shoe">` holding an `<h3>Input</h3>`
//   and nothing that says "shoe". The identity lives in the sibling tab. Drop the tab and
//   the mirror is five identical "### Input / ### Equivalent Sizes" blocks with no way to
//   tell them apart.
//
// Two independent causes, both in libs/html-md.js, and both measured rather than assumed:
//   1. LEFTOVER_MIN = 12 deleted any label shorter than 12 characters — "Shoe Size" is 9.
//   2. 12 of the 79 strips sit OUTSIDE <main>, and the converter mirrors <main> only, so
//      their labels were discarded wholesale rather than floored.
//
//   before: 64 of 79 pages, 214 of 333 labels missing
//   after:   1 of 79 pages,   1 of 333 — and that one is a JS template string
//           (`' + escHtml(label) + '`) that the enumerator picks out of a <script> body,
//           not a label a reader ever saw.
//
// The rule named 3 pages. Tenth instance of the AGENTS.md under-report family (BUG-308
// 7→192, 316 1→53, 320 5→203, 343 117→smaller, 348 2→15, 353 1→2, 355 4→10, 357 1→0,
// 308 3→79 pages / 214 labels).
//
// What this gate does NOT assert, on purpose:
//   * It does not assert a label is attached to its panel. The DOM does not say so either
//     (`id="panel-shoe"` and `data-tab="shoe"` do, but pairing them is a per-page
//     convention and 79 pages use at least three). What an agent needs — the names, in
//     order, before the panels — is now true, and that is what is checked.
//   * It does not check the 5-page category mirrors. Their panels carry their own <h2>/<h3>
//     (e.g. `## Dice Roller`), so they were never in the affected set.
//
// Anti-vacuity, two tiers, both must go red:
//   node bug358-tab-labels-in-md-gate.js /tmp/bug358-prefix   # fix removed  -> FAIL
//   node bug358-tab-labels-in-md-gate.js /tmp/bug358-floor0   # floor zeroed -> FAIL
// The second tier is the important one: LEFTOVER_MIN = 0 also brings the 214 labels back,
// which is exactly why it was rejected as the fix (it re-admits every button verb). If
// someone "simplifies" the fix into lowering the floor, that tier is what catches it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const TOOLS = path.join(ROOT, 'tools');
let failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

const { htmlToMarkdownBody, decodeEntities, LEFTOVER_MIN } =
  await import(pathToFileURL(path.join(ROOT, 'libs/html-md.js')).href);

// --- the enumerator -----------------------------------------------------------------
// Same element test the fix uses, written out independently: a <button|div|a|li> carrying
// role="tab", or a class attribute with a `tab`-ish token that is not the plural container.
// An element whose content is a block (a panel, a row of other triggers) is a container,
// not a label. <script>/<style> bodies are blanked first — BUG-333's rule, or the
// enumerator "finds" template strings that are not DOM.
const TRIGGER = /<(button|div|a|li)\b(?=[^>]*(?:\brole\s*=\s*["']?tab["'\s>]|\bclass\s*=\s*["'][^"']*(?:^|[\s_-])tab(?!s(?![a-z0-9]))[^"']*["\']))[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const NOT_A_LABEL = /<(?:div|table|form|section|article|textarea|select|details|p|ul|ol|dl|button|nav|header)\b/i;
const BLANK = /<(script|style|noscript|template|textarea|svg|select)\b[\s\S]*?<\/\1\s*>/gi;

function tabLabels(html) {
  const src = html.replace(BLANK, ' ');
  const out = [];
  const seen = new Set();
  for (const m of src.matchAll(TRIGGER)) {
    if (NOT_A_LABEL.test(m[2])) continue;
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    // A JS string that survived the blanking above is not a label a reader ever saw.
    if (!t || /['"+\\();]/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// STRUCTURAL, not substring: the label must be its own markdown line. `md.includes(label)`
// gave a false pass on 12 pages whose label text happens to recur in the intro prose.
const lineKey = (l) => decodeEntities(l)
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  .replace(/^#+\s*|^-+\s*|\*+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const slugs = fs.readdirSync(TOOLS).filter((s) => fs.existsSync(path.join(TOOLS, s, 'index.html')));

let pagesWithTabs = 0, totalLabels = 0, lostLabels = 0, lostPages = 0;
const outsideMain = [];
const lost = [];

for (const slug of slugs) {
  const html = fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8');
  const labels = tabLabels(html);
  if (labels.length < 2) continue;          // one "tab" is not a tab set
  pagesWithTabs++;
  totalLabels += labels.length;

  const blanked = html.replace(BLANK, ' ');
  const openM = blanked.match(/<main\b[^>]*>/i);
  const mainEnd = openM ? blanked.indexOf('</main>', openM.index) : -1;
  const inMain = openM ? blanked.slice(openM.index, mainEnd === -1 ? blanked.length : mainEnd) : '';
  const stripInMain = labels.filter((l) => inMain.includes(l));
  if (stripInMain.length < labels.length) {
    outsideMain.push(`${slug} (${labels.length - stripInMain.length}/${labels.length})`);
  }

  const md = htmlToMarkdownBody(html);
  const keys = new Set(md.split('\n').map(lineKey).filter(Boolean));
  const missing = labels.filter((l) => !keys.has(lineKey(l)));
  if (missing.length) { lostPages++; lostLabels += missing.length; lost.push(`${slug}: ${missing.join(', ')}`); }
}

// --- the assertions ---------------------------------------------------------------
ok(pagesWithTabs >= 60, `expected a real tab-set population, enumerated only ${pagesWithTabs} pages`);
ok(lostPages === 0, `${lostPages} of ${pagesWithTabs} tabbed pages still lose a label in the .md mirror — ${lost.join(' | ')}`);

// The floor is what this fix deliberately did NOT move. Assert it, or the next person
// "simplifies" promoteTabLabels away and re-admits every button verb in every mirror.
ok(LEFTOVER_MIN === 12, `LEFTOVER_MIN is ${LEFTOVER_MIN}, expected 12 — the fix must not be a floor change`);

// And assert the floor still does its job, so the tier above is not a tautology. These two
// pages were picked by measurement, not by eye: zeroing LEFTOVER_MIN adds standalone lines
// to 340 of the 346 mirrors, and on these two the added lines are literally the verbs the
// floor exists to drop (`2fa-authenticator` → "clear", "next code"; `aes-encrypt-decrypt` →
// "encrypt", "decrypt", "copy"). An earlier version of this assertion used size-converter,
// where floor=0 changes nothing — a green assertion that cannot go red.
{
  const lineSet = (slug) => new Set(decodeEntities(
    htmlToMarkdownBody(fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8')))
    .split('\n').map(lineKey).filter(Boolean));
  const twofa = lineSet('2fa-authenticator');
  const aes = lineSet('aes-encrypt-decrypt');
  for (const v of ['clear', 'next code']) {
    ok(!twofa.has(v), `UI verb "${v}" leaked into the 2fa-authenticator mirror — the 12-char floor is not doing its job`);
  }
  for (const v of ['encrypt', 'decrypt', 'copy', 'show', 'sample']) {
    ok(!aes.has(v), `UI verb "${v}" leaked into the aes-encrypt-decrypt mirror — the 12-char floor is not doing its job`);
  }
}

// A new page whose strip moves outside <main> must be visible, not silently absorbed.
ok(outsideMain.length > 0, 'no tab strip found outside <main> — if that is now genuinely true, update this line and tabLabelsOutside()');

// --- report -----------------------------------------------------------------------
console.log(`[gate] pages with a tab set: ${pagesWithTabs} of ${slugs.length} tool pages`);
console.log(`[gate] tab labels enumerated: ${totalLabels} | missing from the .md mirror: ${lostLabels} (${lostPages} pages)`);
console.log(`[gate] strips sitting outside <main> (labels kept by tabLabelsOutside): ${outsideMain.length}`);
for (const p of outsideMain) console.log(`[gate]   ${p}`);
console.log(`[gate] LEFTOVER_MIN = ${LEFTOVER_MIN} (unchanged)`);

if (failures.length) {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`[gate] ${checks - failures.length}/${checks} checks passed FAIL`);
  process.exit(1);
}
console.log(`[gate] ${checks}/${checks} checks passed PASS`);
