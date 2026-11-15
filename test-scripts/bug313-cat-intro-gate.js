#!/usr/bin/env node
// BUG-313 static gate — category intro copy.
//
// Asserts, over the real source, that every one of the four claims the BUG-142 template made and
// got wrong is now actually false, and that the replacement is not a new lie:
//
//   1. every tool slug linked from CAT_INTRO exists in manifest.txt AND is a member of that
//      category (a typo here is a 404 internal link on one of 11 index pages)
//   2. all 11 categories have a CAT_INTRO block
//   3. the spun template is gone: no "Need a JSON formatter online", no
//      "are free online developer tools you can use instantly", no "image compressor free"
//   4. HTML and markdown render from the SAME array, so a per-format template cannot reappear
//   5. the h1-duplicating "N free online X. No signup required." line is gone from the category body
//
// Usage: node bug313-cat-intro-gate.js [repoRoot]   (rootDir lets you re-inject a defect and
// prove the gate goes red — the anti-vacuity tier.)

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const CATCHALL = path.join(ROOT, 'functions/tools/[[catchall]].js');
const MANIFEST = path.join(ROOT, 'manifest.txt');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const src = fs.readFileSync(CATCHALL, 'utf8');

// --- manifest: slug -> category ---
const cat = {};
for (const line of fs.readFileSync(MANIFEST, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const p = t.split('|');
  if (p.length < 2) continue;
  cat[p[0].trim()] = p[1].trim();
}
const CATS = ['formatters','calculators','generators','converters','media','network','code-testing','pdf-tools','life','finance','ai-language'];

// --- extract CAT_INTRO from source by brace matching (not by regex over markup) ---
function extractObject(name) {
  const at = src.indexOf('const ' + name + ' = {');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

console.log('BUG-313 category intro gate — ' + ROOT);

const introSrc = extractObject('CAT_INTRO');
ok('CAT_INTRO block exists in source', !!introSrc);
if (!introSrc) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

// 1. all 11 categories present
for (const c of CATS) ok('CAT_INTRO has a block for /' + c + '/', new RegExp("'" + c + "':\\s*\\[").test(introSrc));

// 2. every linked slug resolves and is in the right category
const linkRe = /\['([a-z0-9\-]+)',\s*'([^']*)'\]/g;
let m, total = 0, bad = [];
const perCat = {};
while ((m = linkRe.exec(introSrc))) {
  total++;
  const slug = m[1];
  // which category block is this link in?
  const before = introSrc.slice(0, m.index);
  const keys = [...before.matchAll(/'([a-z\-]+)':\s*\[/g)];
  const c = keys.length ? keys[keys.length - 1][1] : '?';
  perCat[c] = (perCat[c] || 0) + 1;
  if (!(slug in cat)) bad.push(c + ': /' + slug + '/ is not in manifest.txt');
  else if (cat[slug] !== c) bad.push(c + ': /' + slug + '/ is in "' + cat[slug] + '", not "' + c + '"');
}
console.log('  ..    ' + total + ' tool links across ' + Object.keys(perCat).length + ' categories: ' + JSON.stringify(perCat));
ok('all ' + total + ' CAT_INTRO tool links resolve to a manifest tool in the same category', bad.length === 0, bad.join(' | '));

// 3. spun template is gone
//    Checked against CODE, not raw source: this project's convention is to document each fix in a
//    comment next to the fix, and a fix comment necessarily quotes the string it removed. A gate
//    that matched raw source would therefore forbid documenting the bug it exists to prevent.
const code = src
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const SPUN = [
  'Need a JSON formatter online',
  'are free online developer tools you can use instantly',
  'image compressor free',
  'Popular free tools in this category include',
  'DevTools Hub is a collection of',
];
for (const s of SPUN) ok('spun template removed from code: "' + s + '"', !code.includes(s));

// 4. one renderer for both formats (no second hand-maintained template)
ok('catIntro() is the single renderer', /function catIntro\(parts, fmt\)/.test(code));
ok('HTML call site uses catIntro(...,"html")', code.includes("catIntro(CAT_INTRO[category], 'html')"));
ok('markdown call site uses catIntro(...,"md")', code.includes("catIntro(CAT_INTRO[category], 'md')"));
ok('no leftover flagship* template functions', !/flagshipHtml|flagshipMarkdown|CAT_FLAGSHIP|SITE_FLAGSHIP|siteFlagship/.test(code));

// 5. h1-duplicating count line gone from the category body
ok('category body no longer repeats the h1 count as a sentence', !/free online ' \+ esc\(displayName\)\.toLowerCase\(\) \+ '\. No signup required\./.test(code));

// 6. sanity: each intro is real prose, not a keyword list
for (const c of CATS) {
  const at = introSrc.indexOf("'" + c + "': [");
  if (at < 0) continue;
  const seg = introSrc.slice(at, at + 1800);
  const end = seg.indexOf('\n    ],');
  const body = end > 0 ? seg.slice(0, end) : seg;
  const words = body.replace(/\['[^']*',\s*'[^']*'\]/g, ' ').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const freeOnline = (body.match(/free online/gi) || []).length;
  ok('/' + c + '/ intro is real prose (' + words.length + ' words, ' + freeOnline + 'x "free online")', words.length >= 45 && freeOnline === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
