#!/usr/bin/env node
// BUG-405 gate — a tool TITLE must not end on a word that needs a word after it.
//
// WHY
// `manifest.txt` field 5 (the name) is the single source for every title string the site publishes:
//   · <title>            (functions/tools/[[catchall]].js -> smartTitle())
//   · og:title + twitter:title
//   · the JSON-LD `name`
//   · the homepage card and the /tools/ index card
//   · llms.txt + llms-full.txt
//   · .well-known/agent-skills/index.json
// BUG-352 fixed field 6 (the description) — 29 of 346 ended mid-sentence and were published
// verbatim, everywhere, forever. Field 5 was never audited, and it has the same defect: a title
// compressed to fit a length budget, stopped mid-phrase, and published verbatim.
//
// The three this gate found, and what a reader saw in the SERP:
//
//   json-diff             "JSON Diff - Compare Two JSON Documents and Find"     <- a verb with no object
//   html-entity-encoder  "HTML Entity Encoder and Decoder - Encode Special"   <- an adjective with no noun
//   pdf-compare           "PDF Compare - Free Online PDF Diff & Side-by-Side"   <- an elliptical adjective
//
// WHAT THIS RULE IS (and is not)
// A title's last word must not be a DANGLING word — one that cannot end a title in this position —
// UNLESS the word before it completes it. "8 Modes Side-by-Side" is a complete phrase (a noun
// modifies it); "PDF Diff & Side-by-Side" is not (a conjunction precedes it). That distinction is
// decidable from the data alone, which is what makes it a gate and not a reading.
//
// IT IS A LOWER BOUND, said out loud. It catches the "verb/adjective after a conjunction or another
// dangling word" shape. A title that ends on a dangling word after an ordinary noun ("... JavaScript
// Code", "... Prime Factor") is terse, not cut, and no mechanical predicate separates it from the
// 361 correct titles — the same ceiling BUG-352's description gate declared, for the same reason.
//
// A KNOWN-SHAPED LIST, not a live checker: the word sets below are the shapes this corpus uses.
// Widening them means flagging correct titles, which is worse than missing some.
//
// ANTI-VACUITY
// The three pre-fix titles are injected into a copy of the manifest and the gate MUST go red on
// exactly them.
//
// Usage: node bug405-title-fragment-gate.js [--root <dir>]
'use strict';

const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..')));

// A word that cannot END a title on its own: a transitive verb with no object, or an adjective
// with no noun. `test` and `split` are here because they are nouns in this corpus ("Content
// Originality Test", "Appliance kWh & Bill Split") — the predecessor test below is what keeps
// those two titles legal.
const DANGLING = new Set(['find', 'encode', 'decode', 'compare', 'create', 'convert', 'validate',
  'format', 'beautify', 'minify', 'generate', 'translate', 'detect', 'show', 'track', 'build',
  'edit', 'remove', 'merge', 'count', 'measure', 'scan', 'analyze', 'optimise', 'optimize',
  'reverse', 'extract', 'parse', 'render', 'resize', 'crop', 'split', 'test', 'check',
  'special', 'sidebyside', 'printable']);

// A word before the last one that does NOT complete it: a conjunction, or another dangling word.
const NON_COMPLETER = new Set(['and', 'or', '&', '+', 'to', 'of', 'for', 'with', 'from']);

// smartTitle() drops the brand suffix and cuts with an ellipsis only past 60 escaped characters.
const MAX_ESCAPED = 60;
const escapeHtmlAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseManifest(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('|');
    if (p.length < 6) continue;
    rows.push({ slug: p[0].trim(), name: p[4].trim(), desc: p[5].trim() });
  }
  return rows;
}

function tailWords(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] || '';
  const prev = words[words.length - 2] || '';
  return { last: last.replace(/[^\w&+]/g, '').toLowerCase(), prev: prev.replace(/[^\w&+]/g, '').toLowerCase() };
}

function check(text) {
  const bad = [];
  for (const { slug, name } of parseManifest(text)) {
    const { last, prev } = tailWords(name);
    if (DANGLING.has(last) && NON_COMPLETER.has(prev)) {
      bad.push({ slug, name, why: `ends on the dangling word "${last}" after "${prev}"` });
      continue;
    }
    if (DANGLING.has(last) && DANGLING.has(prev)) {
      bad.push({ slug, name, why: `ends on the dangling word "${last}" after the dangling word "${prev}"` });
      continue;
    }
    const esc = escapeHtmlAttr(name).length;
    if (esc > MAX_ESCAPED) {
      bad.push({ slug, name, why: `escapes to ${esc} chars — smartTitle() would cut the title with an ellipsis` });
    }
  }
  return bad;
}

const manifestPath = path.join(ROOT, 'manifest.txt');
if (!fs.existsSync(manifestPath)) {
  console.log(`  ✗ FAIL no manifest.txt at ${manifestPath}`);
  process.exit(1);
}
const text = fs.readFileSync(manifestPath, 'utf8');
const rows = parseManifest(text);
const bad = check(text);

console.log(`\nmanifest titles: ${rows.length} · pass: ${rows.length - bad.length} · FAIL: ${bad.length}`);
bad.forEach(b => console.log(`  ✗ FAIL /tools/${b.slug}/ — ${b.why}\n      "${b.name}"`));

// An empty enumeration is a silent green: if the parser stopped matching, this gate would report
// 0/0 and PASS.
if (rows.length < 300) {
  console.log(`  ✗ FAIL the scan itself is degenerate — ${rows.length} rows parsed.`);
  process.exit(1);
}

// ── anti-vacuity ────────────────────────────────────────────────────────────
// The three pre-fix titles, re-injected. Each must go red on exactly its own slug.
const INJECT = [
  ['json-diff', 'JSON Diff - Compare Two JSON Documents and Find'],
  ['html-entity-encoder', 'HTML Entity Encoder and Decoder - Encode Special'],
  ['pdf-compare', 'PDF Compare - Free Online PDF Diff & Side-by-Side'],
];
let vac = 0;
for (const [slug, name] of INJECT) {
  const injected = text + '\n' + slug + '|formatters|no|no|' + name + '|A description long enough to pass the length window here.|x\n';
  const hits = check(injected);
  const hit = hits.find(h => h.slug === slug);
  if (!hit) {
    console.log(`  ✗ FAIL ANTI-VACUITY — the pre-fix title was NOT caught: ${JSON.stringify(name)}`);
    vac++;
  }
}
console.log(`  anti-vacuity: ${INJECT.length - vac}/${INJECT.length} pre-fix titles go red`);

process.exit(bad.length === 0 && vac === 0 ? 0 : 1);
