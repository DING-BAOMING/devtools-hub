#!/usr/bin/env node
// BUG-404 gate — a `role="radiogroup"` whose members are not radios.
//
// WHAT THE FINDING WAS
// The 2026-10-30 fresh full-site crawl (squirrelscan 0.0.111, 381 URLs) reported
// `a11y/aria-required-children` as an ERROR on ONE page: "div[role=radiogroup]: needs child
// with role=radio" on /tools/recipe-converter/. The rule named one page; the class is
//   4 `role="radiogroup"` containers in the tree
//     tools/recipe-converter/index.html                  x3   <-- BROKEN (the finding)
//     tools/sentence-rewriter/index.html                 x1   OK (role=radio + aria-checked)
//     tools/audio-denoiser/index.html                    x1   OK (role=radio + aria-checked)
//     tools/youtube-transcript-extractor/index.html      x1   OK (JS-built: setAttribute('role','radio'))
// so the defective instance is exactly the three groups on recipe-converter, and the fix is one
// idiom the site already uses twice (sentence-rewriter, audio-denoiser).
//
// WHY IT IS NOT COSMETIC
// `role="radiogroup"` is a CONTRACT: its owned children must be `role="radio"` and each radio must
// carry `aria-checked`. recipe-converter declared the container and then put plain <button>s in
// it, so:
//   1. the ARIA structure is invalid (WCAG 4.1.2 / `aria-required-children`);
//   2. the SELECTED member was announced to nobody. The selection was painted by
//      `.rc-mode-toggle button.active` only — no `aria-checked`, no `aria-pressed` — so a screen
//      reader, a voice-control user and `getByRole('radio', {checked:true})` could not tell which
//      of US / Metric / Both was active. This is BUG-399's shape: "a control that paints a state
//      must announce it, and if the paint is keyed on the state, the state must exist before the
//      first paint".
//
// WHAT THE GATE MODELS (the rule, not a page list)
// 1. Every `role="radiogroup"` container must have at least one owned child with `role="radio"`.
//    The child may be static markup, or set at runtime by the SAME file's own script
//    (youtube-transcript-extractor builds its tracks with setAttribute('role','radio')) — so the
//    gate reads the file's <script> bodies too, instead of keeping a list of exemptions that
//    would rot.
// 2. Every `role="radio"` must declare `aria-checked` — statically or from the same file's script.
//    A radio with no state is the defect in another costume.
// 3. When the group's members are STATIC: exactly one member carries `aria-checked="true"`, and it
//    must be the same member that carries the `active` class. That is "the state exists before the
//    first paint AND the paint agrees with the announced state" — decidable from the data alone.
//
// ANTI-VACUITY
// The gate takes a rootDir (positional or --root). Point it at a copy whose fix has been stripped
// (the eight `role="radio"` / `aria-checked` pairs removed) and it MUST go red on
// tools/recipe-converter/. A scan that silently stops matching must not read as a pass, so the
// gate also asserts it saw >300 pages and >2 radiogroups.
//
// Usage: node bug404-radiogroup-required-children-gate.js [rootDir]
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let rootDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') rootDir = args[i + 1];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
rootDir = path.resolve(rootDir || path.join(__dirname, '..'));
if (!fs.existsSync(path.join(rootDir, 'tools'))) {
  console.error('FAIL: no tools/ directory under ' + rootDir);
  process.exit(1);
}

// Bodies that are never DOM: a heading inside a <template> is not a heading, and a string in a
// <script> is not markup (BUG-343's 77 phantom tables; BUG-329's 355 phantom aria-labels).
const BLIND = /<(script|style|noscript|template|textarea|svg|iframe)\b[\s\S]*?<\/\1>/gi;

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.wrangler') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name === 'index.html') out.push(p);
  }
  return out;
}

function scriptBodies(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.join('\n');
}

// A role="radio" the script creates at runtime carries its role through one of these.
const SCRIPT_ROLE_RADIO = /setAttribute\(\s*['"]role['"]\s*,\s*['"]radio['"]\s*\)|role\s*=\s*['"]radio['"]/i;
const SCRIPT_CHECKED = /setAttribute\(\s*['"]aria-checked['"]|aria-checked/i;

const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

const files = [
  ...htmlFiles(path.join(rootDir, 'tools')),
  ...htmlFiles(rootDir).filter((f) => !f.includes(`${path.sep}tools${path.sep}`)),
];

let groupCount = 0;
let radioCount = 0;

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const src = html.replace(BLIND, (m) => ' '.repeat(m.length)); // markup only, scripts blanked
  const scripts = scriptBodies(html);
  const rel = path.relative(rootDir, file);

  // --- 1. every radiogroup has radio children -------------------------------------------
  const groups = [...src.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\brole\s*=\s*["']radiogroup["'][^>]*)>/gi)];
  groupCount += groups.length;
  for (const g of groups) {
    const tag = g[1].toLowerCase();
    const open = g.index;
    const close = html.indexOf(`</${tag}`, open);
    const inner = close < 0 ? '' : html.slice(open + g[0].length, close);
    const staticRadios = [...inner.matchAll(/\brole\s*=\s*["']radio["']/gi)].length;
    const runtimeRadios = staticRadios === 0 && SCRIPT_ROLE_RADIO.test(scripts);
    ok(staticRadios > 0 || runtimeRadios,
      `${rel}: <${tag} role="radiogroup"> has no owned child with role="radio"`);

    // --- 3. static members: exactly one checked, and it is the painted one --------------
    if (staticRadios > 0) {
      const members = [...inner.matchAll(/<button\b([^>]*)>/gi)].filter((m) => /\brole\s*=\s*["']radio["']/i.test(m[1]));
      if (members.length) {
        const checked = members.filter((m) => /\baria-checked\s*=\s*["']true["']/i.test(m[1]));
        const painted = members.filter((m) => /\bclass\s*=\s*["'][^"']*\bactive\b/i.test(m[1]));
        ok(checked.length === 1,
          `${rel}: radiogroup has ${checked.length} member(s) with aria-checked="true" — exactly one must be selected`);
        ok(painted.length === 1,
          `${rel}: radiogroup has ${painted.length} member(s) with the "active" class — exactly one must be painted as selected`);
        if (checked.length === 1 && painted.length === 1) {
          ok(checked[0][0] === painted[0][0],
            `${rel}: the aria-checked="true" member is not the one painted with class="active"`);
        }
      }
    }
  }

  // --- 2. every role="radio" declares aria-checked ---------------------------------------
  for (const m of src.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\brole\s*=\s*["']radio["'][^>]*)>/gi)) {
    radioCount++;
    const has = /\baria-checked\s*=\s*["'](true|false)["']/i.test(m[2]);
    ok(has || SCRIPT_CHECKED.test(scripts),
      `${rel}: <${m[1]} role="radio"> never declares aria-checked`);
  }
}

// Degenerate-scan floor: a scan that silently stops matching would report "0 problems" and pass.
ok(files.length > 300, `FAIL: only ${files.length} pages scanned — expected >300, the scan is degenerate`);
ok(groupCount > 2, `FAIL: only ${groupCount} radiogroups seen — expected >2, the scan is degenerate`);
ok(radioCount > 2, `FAIL: only ${radioCount} radios seen — expected >2, the scan is degenerate`);

console.log(`BUG-404 radiogroup required children — ${files.length} pages, ${groupCount} radiogroups, ${radioCount} radios`);
for (const f of failures) console.log('FAIL ' + f);
console.log(failures.length ? `\n${failures.length} FAIL` : `\nPASS — ${checks}/${checks}`);
process.exit(failures.length ? 1 : 0);
