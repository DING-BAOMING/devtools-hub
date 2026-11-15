// BUG-350 static gate: no authored internal href/src may point at a URL that
// does not resolve to a file, a directory, a manifest slug or a Function page.
//
// Instrument: static source scan. `<script>/<style>/<noscript>/<template>/<textarea>`
// bodies are blanked first — favicon-generator writes `<link rel="manifest"
// href="/site.webmanifest">` into a *user-facing code sample*, and a scanner that
// reads it reports a broken link the site never makes (the BUG-343 lesson).
//
// Anti-vacuity: accepts a `rootDir` positional or `--root`, so a tree copy with the
// fix reverted must go red.
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
// Default to the project root, not the CWD: this gate lives in
// devtools-hub-docs/test-scripts/, so `process.cwd()` pointed it at the docs
// tree — where there is no manifest.txt — and it died with ENOENT instead of
// running. A dead gate reads as a green one (BUG-399's lesson: a tier that
// cannot execute must never look like a tier that passed).
const root = argv[0] || path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'test-results']);

const files = [], have = new Set(), dirs = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { dirs.add(path.relative(root, p).split(path.sep).join('/')); walk(p); }
    else have.add(path.relative(root, p).split(path.sep).join('/'));
  }
})(root);

// Pages a Cloudflare Function serves with no file on disk (BUG-303: never assume
// a file exists — and never let a miss resolve to the homepage fallback).
const manifestSlugs = new Set(
  fs.readFileSync(path.join(root, 'manifest.txt'), 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.split('|')[0].trim())
);
const CATEGORIES = new Set(['formatters', 'calculators', 'generators', 'converters', 'media',
  'network', 'code-testing', 'pdf-tools', 'life', 'finance', 'ai-language']);
const TOP_PAGES = new Set(['', 'about', 'privacy', 'contact', 'subprocessors', 'whats-new',
  'tools', 'feedback']);

// Collect every authored .html file only — a Function's injected markup is not in
// a source file, and it is covered by the production suite instead.
(function collect(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) collect(p);
    else if (e.name.endsWith('.html')) files.push(p);
  }
})(root);

const ATTR = /(?:href|src)\s*=\s*["']([^"']+)["']/g;
const GENERATED = /^\/(cdn-cgi|api|_\/|\.well-known)(\/|$)/;
const SKIP_SCHEME = /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/;
const broken = [];
let checked = 0;

for (const f of files) {
  let html = fs.readFileSync(f, 'utf8');
  // A string inside a script is not a link this page makes.
  html = html.replace(/<(script|style|noscript|template|textarea)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi,
  (m, tag, attrs) => `<${tag}${attrs}>`);
  const rel = path.relative(root, f).split(path.sep).join('/');
  let m;
  while ((m = ATTR.exec(html))) {
    let u = m[1].trim();
    if (SKIP_SCHEME.test(u)) continue;
    if (GENERATED.test(u)) continue;
    u = u.split('#')[0].split('?')[0];
    if (!u.startsWith('/')) continue;
    u = u.replace(/\/{2,}/g, '/');
    const bare = u.replace(/^\//, '');
    const slug = bare.match(/^tools\/([a-z0-9-]+)\/?$/);
    const known = bare === ''
      || have.has(bare) || have.has(bare + '/index.html') || dirs.has(bare) || dirs.has(bare + '/')
      || (slug && (manifestSlugs.has(slug[1]) || have.has('tools/' + slug[1] + '/index.html')))
      || (bare.startsWith('tools/') && CATEGORIES.has(bare.slice(6).replace(/\/$/, '')))
      || TOP_PAGES.has(bare.replace(/\/$/, ''));
    checked++;
    if (!known) broken.push(`${rel}: ${u}`);
  }
}

const uniq = [...new Set(broken)];
console.log(`scanned ${files.length} html files, ${checked} internal href/src`);
if (uniq.length === 0) { console.log('PASS  0 broken internal links'); process.exit(0); }
console.log(`FAIL  ${uniq.length} broken internal link(s):`);
for (const b of uniq) console.log('  ' + b);
process.exit(1);