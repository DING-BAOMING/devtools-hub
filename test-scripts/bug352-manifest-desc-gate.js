#!/usr/bin/env node
// BUG-352 gate — a tool description must be a sentence, not the first half of one.
//
// WHY
// `manifest.txt` field 6 is the single source for EVERY description string the site publishes:
//   · <meta name="description"> + og:description + twitter:description  (patchToolHtml -> smartDesc)
//   · the JSON-LD `description` on the tool page
//   · the lead paragraph of /tools/<slug>/.md
//   · llms.txt + llms-full.txt
//   · .well-known/agent-skills/index.json + .well-known/mcp/server-card.json
// `smartDesc()` only cuts a description that is LONGER than 155 chars, so a description that was
// trimmed by hand to fit and stopped mid-sentence is emitted verbatim, everywhere, forever.
// 29 of 346 (8.4%) were like that. What a search result and what an agent actually read:
//
//     auto-loan-calculator  "...Compare loan terms, total interest, amortization schedule. No."
//     json-diff            "...Highlights added, removed, and modified values. Side-by-side view with."
//     email-auth-checker   "Fix email deliverability. AI cannot check real DNS records - we."
//
// The site's own house style tolerates clipped marketing clauses — "No signup, 100% free." and
// "100% private." are complete claims and are NOT defects. What is a defect is a description
// whose LAST SENTENCE ends on a word that cannot end an English sentence in this position:
// `no.`, `with.`, `and.`, `we.`, `Built-in.`, `cannot.`. That is the rule below.
//
// WHAT THIS RULE IS NOT (measured, said out loud rather than implied)
// It is a LOWER BOUND. 24 of the 29 were caught by it; 5 more ended mid-enumeration on a noun —
// `loan-calculator` "…when you own your home free.", `image-to-excel` "Auto-detect rows and
// columns, 12+.", `letter-generator` "3 tones, 5.", `time-calculator` "…multi-period sum, break.",
// `virtual-piano` "…follow along with 6 songs, chord." Those 5 were found by reading the field and
// fixed in BUG-352, but no mechanical predicate separates them from the 317 correct descriptions
// that also end on a content word ("Works offline.", "No upload.", "18 fonts, 7 ink colors, PNG/JPG/PDF.").
// So this gate will catch the next 24-shaped defect, not the next noun-shaped one. That is the
// honest ceiling; widening it means flagging correct pages, which is worse than missing some.
//
// A KNOWN-GOOD LIST, not a live checker (same shape as bug333 / bug317): a wrong FAIL here is a
// one-line manifest edit, and the alternative — a heuristic loose enough to catch the 5 — fails
// on ~300 correct descriptions.
//
// Run: node test-scripts/bug352-manifest-desc-gate.js [--root <dir>]

const { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const { join } = require('path');

const HUB = join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = arg('--root', HUB);

// Words that cannot be the last word of a complete sentence here. Deliberately excludes `free`
// ("No signup, no watermark, 100% free." is correct) and every content noun.
const TAIL = new Set(['no', 'not', 'and', 'or', 'with', 'for', 'to', 'in', 'on', 'at', 'the',
  'a', 'an', 'of', 'by', 'from', 'per', 'plus', 'minus', 'vs', 'than', 'we', 'cannot', 'built-in']);

const MIN = 120, MAX = 155;

function parseManifest(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = line.split('|');
    if (p.length < 6) continue;
    rows.push({ slug: p[0].trim(), desc: p[5].trim() });
  }
  return rows;
}

// Returns { slug, why } for every description that is clipped or out of the length window.
function check(text) {
  const bad = [];
  for (const { slug, desc } of parseManifest(text)) {
    if (desc.length < MIN || desc.length > MAX) {
      bad.push({ slug, why: `description is ${desc.length} chars, outside ${MIN}-${MAX}` });
      continue;
    }
    const last = desc.split(/(?<=[.!?])\s+/).pop();
    const words = last.match(/[A-Za-z0-9+']+/g) || [];
    const tail = words.length ? words[words.length - 1].toLowerCase() : '';
    if (TAIL.has(tail)) bad.push({ slug, why: `ends mid-sentence on "${tail}." — ${JSON.stringify(last)}` });
  }
  return bad;
}

const manifestPath = join(ROOT, 'manifest.txt');
if (!existsSync(manifestPath)) {
  console.log(`  ✗ FAIL no manifest.txt at ${manifestPath}\n`);
  process.exit(1);
}
const rows = parseManifest(readFileSync(manifestPath, 'utf8'));
const bad = check(readFileSync(manifestPath, 'utf8'));

console.log(`\nmanifest descriptions: ${rows.length} · pass: ${rows.length - bad.length} · FAIL: ${bad.length}`);
bad.forEach(b => console.log(`  ✗ FAIL /tools/${b.slug}/ — ${b.why}`));

// An empty enumeration is a silent green: if the parser ever stopped matching, this gate would
// report 0/0 and PASS. Require the catalogue to have been read.
if (rows.length < 300) {
  console.log(`  ✗ FAIL the scan itself is degenerate — ${rows.length} rows parsed.\n`);
  process.exit(1);
}

// ── anti-vacuity ────────────────────────────────────────────────────────────
// Every tail shape this gate claims to catch, injected into a real manifest copy. A gate that has
// never been seen red measures nothing: if any of these does not go red, the rule is not the rule
// the header comment says it is.
const BASE = 'auto-loan-calculator|finance|no|no|Auto Loan Calculator|';
const INJECT = [
  ' aml-Calculator|calculators|no|no|A|Insurance amortization schedule. No.|x',
  BASE + 'Free auto loan calculator. Compare loan terms and total interest. Side-by-side view with.|x',
  BASE + 'Free auto loan calculator. Fix email deliverability. AI cannot check DNS records - we.|x',
  BASE + 'Free auto loan calculator. Create valid JSON-LD data for Article and more. Built-in.|x',
  BASE + 'Free auto loan calculator. Learn the rules. Step-by-step solutions and.|x',
  BASE + 'Free auto loan calculator. Live test sandbox to.|x',
  BASE + 'Free auto loan calculator. Compare interest and pick a plan in.|x',
  BASE + 'Free auto loan calculator. Check your grades on the and.|x',
  BASE + 'Free auto loan calculator. Convert slugs from and.|x',
  BASE + 'Free auto loan calculator. Track accuracy of and.|x',
  BASE + 'Free auto loan calculator. Preview it live for the from.|x',
  BASE + 'Free auto loan calculator. Padded out so the length check passes as well, and the tail is we.|x',
];
const scratch = join(ROOT, '.bug352-scratch');
let vac = 0;
try {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'manifest.txt'), readFileSync(manifestPath, 'utf8'));
  for (const tail of INJECT) {
    const hits = check(readFileSync(manifestPath, 'utf8') + '\n' + tail);
    if (hits.length === 0) {
      console.log(`  ✗ FAIL ANTI-VACUITY — this tail was NOT caught: ${JSON.stringify(tail.split('|')[5])}`);
      vac++;
    }
  }
  console.log(`  anti-vacuity: ${INJECT.length - vac}/${INJECT.length} injected tail shapes go red`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(bad.length === 0 && vac === 0 ? 0 : 1);
