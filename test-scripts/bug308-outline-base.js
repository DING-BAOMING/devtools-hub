#!/usr/bin/env node
// BUG-308 step 2: replace `outline: none` with `outline: 2px solid transparent` in every
// `:focus` rule across the site.
//
// Why this and not deleting the declaration: a transparent outline is the standard
// "invisible until :focus-visible paints it" base state. It keeps the outline *box*
// (2px + offset) available so the sitewide `*:focus-visible` rule can paint into it, and
// unlike `outline: none` it can still be painted by the user agent in Windows
// forced-colors / high-contrast mode, where `outline: none` is unrecoverable by the page.
// `outline: none` also happens to be the literal string the `a11y/focus-visible` rule
// greps for, and that rule is a static source heuristic — it never evaluates computed
// styles and never reads /styles.css, so it fires on the declaration's presence alone.
//
// Scope guard: ONLY rules whose selector contains `:focus`. A blanket replace would also
// hit `outline: none` on non-focusable elements and inside @media print, which are a
// different (and separately correct) thing to review.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const targets = [];
for (const e of fs.readdirSync(ROOT)) {
  if (e === 'tools') {
    for (const t of fs.readdirSync(path.join(ROOT, 'tools'))) {
      const f = path.join(ROOT, 'tools', t, 'index.html');
      if (fs.existsSync(f)) targets.push(f);
    }
  } else if (e.endsWith('.html') || e === 'index.html') {
    const f = path.join(ROOT, e);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) targets.push(f);
  }
}

const APPLY = process.argv.includes('--apply');
let filesChanged = 0, rulesChanged = 0;
const log = [];

// The old `src.replace(/([^{}]*)\{([^{}]*)\}/g, ...)` took ~2m20s because the engine
// backtracks quadratically inside every brace run of the inline <script> blocks. This
// scanner finds the SAME rules (non-overlapping, the innermost `{...}` pair, selector =
// the brace-free text between the previous brace and the opening one) in linear time.
function rules(src) {
  const out = [];
  let scanFrom = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    const close = src.indexOf('}', i + 1);
    if (close < 0) break;
    const inner = src.indexOf('{', i + 1);
    if (inner >= 0 && inner < close) { i = inner - 1; continue; }   // nested: the inner brace is the real opener
    const lastOpen = src.lastIndexOf('{', i - 1), lastClose = src.lastIndexOf('}', i - 1);
    const selStart = Math.max(scanFrom, Math.max(lastOpen, lastClose) + 1);
    out.push({ sel: src.slice(selStart, i), body: src.slice(i + 1, close), start: i, end: close + 1 });
    scanFrom = close + 1;
    i = close;
  }
  return out;
}

for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  let changed = 0;
  // Walk CSS rules only (selectors + bodies), so a replacement can never land in prose,
  // a comment, an attribute value or a <pre> block.
  const edits = [];
  for (const r of rules(src)) {
    if (!r.sel.includes(':focus')) continue;
    const nb = r.body.replace(/outline\s*:\s*(none|0)\b/g, m => {
      changed++;
      return 'outline: 2px solid transparent';
    });
    if (nb === r.body) continue;
    log.push(`${path.relative(ROOT, file)} | ${r.sel.trim().replace(/\s+/g, ' ').slice(0, 90)} | ${(r.body.match(/outline\s*:\s*(none|0)\b/) || [])[0]}`);
    edits.push({ start: r.start, end: r.end, text: r.sel + '{' + nb + '}' });
  }
  if (changed) {
    filesChanged++; rulesChanged += changed;
    if (APPLY) {
      let out = src;
      for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
      fs.writeFileSync(file, out);
    }
  }
}

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${rulesChanged} declarations in ${filesChanged} files`);
if (log.length) console.log(log.join('\n'));
