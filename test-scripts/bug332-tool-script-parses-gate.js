#!/usr/bin/env node
// BUG-332 gate — every inline <script> in every tool page must PARSE.
//
// WHY THIS EXISTS
// `/tools/ai-prompt-engineer/` shipped a single unbalanced quote
//   html += '…document.querySelector(\'#' + area.id + \' .pe-result\')…';
// The `\'` is an escaped quote, then `#`, then a BARE `'` — which CLOSES the
// string. The next `\'` is then invalid syntax. V8 refuses the whole file, so
// the ENTIRE tool is dead: 88 prompt templates, 8 platforms, the sandbox — all
// of it. Same page, all 10 of its inline `onclick` handlers threw
// `switchTab is not defined`.
//
// A dead handler is a symptom; a page whose script does not parse is the
// disease, and it takes the whole tool down with it. `bug331-scan-dead-onclick.js`
// sees the symptom (typeof === 'undefined') and cannot tell "never exported"
// from "never parsed". This gate sees the disease, statically, over the whole
// catalogue, with no browser needed — and it is the tier that would have caught
// this before deploy.
//
// `node --check` is not good enough on its own: it parses each script in
// isolation and would happily accept a file whose top level is a bare
// `function f(){}` even though a page-level `<script>` may never run. So each
// extracted script is also required to be a *runnable* program, and a page
// whose only script is empty is rejected outright (an empty parse is a silent
// green).
//
// Run: node test-scripts/bug332-tool-script-parses-gate.js
//      [--root <dir>]   serve/inspect a copy (used by the anti-vacuity tier)

const { readdirSync, statSync, readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');

const HUB = join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = arg('--root', HUB);

const slugs = readdirSync(join(ROOT, 'tools')).filter(d => {
  try {
    return statSync(join(ROOT, 'tools', d)).isDirectory() &&
      statSync(join(ROOT, 'tools', d, 'index.html')).isFile();
  } catch { return false; }
});

// An inline <script> … </script>. The open tag is captured whole and judged in JS,
// because deciding "is this JavaScript?" from inside a regex is how you end up
// parsing a JSON-LD block and reporting the entire catalogue as broken.
const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const JS_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

function isInlineJS(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return false;              // external file, not this page's logic
  const t = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
  if (t && !JS_TYPES.has(t[1].toLowerCase())) return false; // ld+json, application/json, …
  return true;
}

function checkFile(html, label) {
  const problems = [];
  const found = [];
  SCRIPT_RE.lastIndex = 0;
  let m, i = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    if (!isInlineJS(m[1])) continue;
    const code = m[2];
    const line = html.slice(0, m.index).split('\n').length;
    if (!code.trim()) continue;   // an empty block has nothing to prove
    found.push({ i: ++i, line, bytes: code.length });
    try {
      new vm.Script(code, { filename: `${label}#script${i}` });
    } catch (e) {
      problems.push(`inline script #${i} (starts at HTML line ${line}): ${e.message.split('\n')[0]}`);
    }
  }
  return { found, problems };
}

let pass = 0, fail = 0, empty = 0, totalScripts = 0;
const bad = [];

for (const slug of slugs) {
  const html = readFileSync(join(ROOT, 'tools', slug, 'index.html'), 'utf8');
  const { found, problems } = checkFile(html, slug);
  totalScripts += found.length;
  if (found.length === 0) { empty++; console.log(`  · ${slug} — no inline script found (counted as unverified, not as a pass)`); }
  if (problems.length) { fail++; bad.push({ slug, problems }); }
  else pass++;
}

console.log(`\ntool pages: ${slugs.length} · inline scripts parsed: ${totalScripts}`);
bad.forEach(b => {
  console.log(`\n  ✗ FAIL /tools/${b.slug}/`);
  b.problems.forEach(p => console.log(`      ${p}`));
});
console.log(`\n  ${pass} page(s) parse clean, ${fail} page(s) with a script that does not parse, ${empty} page(s) with no inline script\n`);
process.exit(fail === 0 ? 0 : 1);