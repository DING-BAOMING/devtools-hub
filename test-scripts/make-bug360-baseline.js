#!/usr/bin/env node
// Regenerate functions/tools/__bug360-baseline.js — the PRE-OPTIMISATION copy of the tool-page
// Function that test-scripts/bug360-tool-cpu-gate.js imports to prove the BUG-360 CPU fix is
// byte-for-byte behaviour preserving.
//
// WHY IT EXISTED AND WHY IT HAD TO BE REGENERATED
// The baseline was a frozen snapshot of the module as of 2026-10-16. Every round since then
// legitimately changed published CONTENT (BUG-380's table headers, BUG-381's HEAD content type,
// BUG-382's comment stripping, BUG-385's category mirror, new tools, new citations), so the gate
// compared the module against a copy that no longer produced the same bytes: 352 of 352 tool
// pages "differed" on a tree where nothing was wrong. A standing gate that is red on a correct
// site trains the next session to ignore it (BUG-383's reason).
//
// WHAT THIS SCRIPT DOES
// It takes the CURRENT module and reverts ONLY the three BUG-360 CPU hunks:
//   1. countExternalAnchors(): the `href="http` early return
//   2. startsAt(): the `html.startsWith` fast path + the ASCII-uppercase charCode check
//   3. findFirstRealFooter()'s caller: the `html.charCodeAt(i) === 60` guard around the 6 probes
// Every other line — all the content changes — is kept, so the baseline stays a faithful
// "current content, old (slow) code" module.
//
// THE GATE IS ITS OWN ANTI-VACUITY HERE
// If this script accidentally left the optimisation in, the baseline would be the fast module and
// the gate's own assertion "pre-fix p95 > 10ms (the budget catches the old code)" would go RED.
// If it reverted too much, the byte-identity assertion would go RED. Neither failure is silent.
//
// Usage: node test-scripts/make-bug360-baseline.js   (run from devtools-hub-docs/)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'functions/tools/[[catchall]].js');
const OUT = path.join(ROOT, 'functions/tools/__bug360-baseline.js');

let s = fs.readFileSync(SRC, 'utf8');
const before = s.length;

function revert(anchor, replacement, label) {
  if (!s.includes(anchor)) { console.error('ANCHOR MISSING: ' + label); process.exit(1); }
  if (s.indexOf(anchor) !== s.lastIndexOf(anchor)) { console.error('ANCHOR AMBIGUOUS: ' + label); process.exit(1); }
  s = s.replace(anchor, replacement);
}

// 1. countExternalAnchors — drop the early return and its comment.
revert(
`  // BUG-360 (CPU): the two regex passes below walk the whole (script-stripped) document, and
  // most tool pages have no external anchors at all — so they ran to completion on every request
  // only to return 0. Stripping scripts can only REMOVE text, so a document with no \`href="http\`
  // anywhere cannot contain one after the strip either.
  if (html.indexOf('href="http') === -1) return 0;
`, '', 'countExternalAnchors early return');

// 2. startsAt — restore the per-character slice comparison.
revert(
`  // BUG-360 (CPU): the old body was \`html.slice(idx, idx + tag.length).toLowerCase() === tag\`,
  // which allocated one string PER CHARACTER. The top-level branch below probes 6 tags at every
  // position, so a 100 KB page allocated ~600k short-lived strings per scan, and 2-4 injection
  // helpers scan the document per request. \`startsWith\` allocates nothing; the slice path is kept
  // only for the rare uppercase-tag case (every probe tag is a lowercase literal, so a non-letter
  // first char can never match case-insensitively).
  function startsAt(idx, tag) {
    if (html.startsWith(tag, idx)) return true;
    const c = html.charCodeAt(idx);
    if (c < 65 || c > 90) return false; // not an ASCII uppercase letter -> no case-insensitive match
    return html.slice(idx, idx + tag.length).toLowerCase() === tag;
  }`,
`  function startsAt(idx, tag) {
    return html.slice(idx, idx + tag.length).toLowerCase() === tag;
  }`, 'startsAt fast path');

// 3. the charCodeAt(i) === 60 guard around the six tag probes.
revert(
`    // At top level (outside any tag).
    // BUG-360 (CPU): every probe tag below starts with '<', so one charCode check replaces six
    // \`startsWith\` calls at each of the ~100k text positions of a page. Equivalent, not a
    // behaviour change: at a position where html[i] !== '<' none of the six can match.
    if (html.charCodeAt(i) === 60 /* < */) {
      if (startsAt(i, '<!--')) { inComment = true; i += 4; continue; }
      if (startsAt(i, '<textarea') && !startsAt(i, '<textarean')) { inTextarea++; i += 9; continue; }
      if (startsAt(i, '<pre') && !startsAt(i, '<pre>') && !startsAt(i, '<preview')) { inPre++; i += 3; continue; }
      if (startsAt(i, '<script') && !startsAt(i, '<scriptlet')) { inScript++; i += 6; continue; }
      if (startsAt(i, '<style') && !startsAt(i, '<style>') && !startsAt(i, '<styled')) { inStyle++; i += 5; continue; }
      // Real <footer at top level
      if (startsAt(i, '<footer')) {
        const after = html[i + 7];
        if (!after || after === '>' || after === ' ' || after === '\\t' || after === '\\n' || after === '\\r' || after === '/') {
          return i;
        }
      }
      inTag = true;
      i++; continue;
    }`,
`    if (startsAt(i, '<!--')) { inComment = true; i += 4; continue; }
    if (startsAt(i, '<textarea') && !startsAt(i, '<textarean')) { inTextarea++; i += 9; continue; }
    if (startsAt(i, '<pre') && !startsAt(i, '<pre>') && !startsAt(i, '<preview')) { inPre++; i += 3; continue; }
    if (startsAt(i, '<script') && !startsAt(i, '<scriptlet')) { inScript++; i += 6; continue; }
    if (startsAt(i, '<style') && !startsAt(i, '<style>') && !startsAt(i, '<styled')) { inStyle++; i += 5; continue; }
    // Real <footer at top level
    if (startsAt(i, '<footer')) {
      const after = html[i + 7];
      if (!after || after === '>' || after === ' ' || after === '\\t' || after === '\\n' || after === '\\r' || after === '/') {
        return i;
      }
    }
    if (html[i] === '<') {
      inTag = true;
      i++; continue;
    }`, 'charCodeAt(i)===60 guard');

// The header must be a PURE FUNCTION of the source module, or regenerating the baseline dirties
// the working tree on every run for no reason. It used to carry the generation date, so every
// day the gate rewrote the file with a new date and the publish button stopped at "working tree
// is not clean" — the file had to be committed even when nothing else changed. The source's own
// content hash is stable and says the same thing: which source this baseline was cut from.
const SRC_HASH = createHash('sha256').update(fs.readFileSync(SRC)).digest('hex').slice(0, 12);
const header = `// BUG-360 BASELINE — the PRE-OPTIMISATION copy of functions/tools/[[catchall]].js.
//
// Generated by test-scripts/make-bug360-baseline.js from a source with sha256:${SRC_HASH}. It is the CURRENT module with ONLY
// the three BUG-360 CPU hunks reverted (the countExternalAnchors() early return, the startsAt()
// fast path, and the charCodeAt(i) === 60 guard around the six tag probes). Every published
// content change since is kept, so the file stays a faithful "current content, old (slow) code"
// module.
//
// The first version was a frozen 2026-10-16 snapshot, and content rounds kept changing published
// content — so the gate compared the module against a copy that no longer produced the same bytes
// and reported pages as "differing" on a tree where nothing was wrong. A standing gate that is red
// on a correct site trains the next session to ignore it (BUG-383). REGENERATE, do not hand-edit.
//
// It must NEVER deploy: it is 190 KB of dead code and would open a public route at
// /tools/__bug360-baseline. scripts/pre-deploy.sh parks it outside the deploy root (the
// HARNESS_FILES glob) and restores it afterwards.
//
`;
fs.writeFileSync(OUT, header + s);
console.log(`baseline regenerated: ${before} B -> ${fs.statSync(OUT).size} B (header ${header.length} B)`);
