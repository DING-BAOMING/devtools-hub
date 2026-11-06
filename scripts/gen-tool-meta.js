// Generate the manifest-derived head metadata inside every tool page file.
//
// WHY (the drift this exists to stop)
// manifest.txt is the single source of truth for a tool's title and description.
// functions/tools/[[catchall]].js -> patchToolHtml() rewrites <title>, the meta description,
// og:title, og:description, twitter:title, twitter:description and the JSON-LD name/description
// from the manifest on EVERY request (through smartTitle() <=60 escaped chars and smartDesc()
// <=155). The page files ALSO carry a static copy of that head — and nothing in the repo kept
// the two in sync. Every round that edited manifest rows left the file copies behind: as of
// 2026-11-05, 358 of the 371 tool pages had a static head that differs from the head the
// Function actually serves.
//
// It was never a live-site bug (the Function always overwrote it, so Google saw the manifest
// strings all along) — but it is the same class of defect as BUG-447's 12 pages, it is visible
// to anyone reading the repo or the public GitHub mirror, and it re-accumulates with every
// future manifest edit. Hand-syncing the 358 files would fix today's symptom and tomorrow's
// drift; a generator makes the file copy equal the served copy BY CONSTRUCTION.
//
// HOW
// The served head is the ORACLE, never a copy of the rules: this script renders each page
// through the REAL functions/tools/[[catchall]].js (disk-backed ASSETS stub, same runtime
// model as scripts/regen-static-fallbacks.js) and copies the manifest-derived values it
// renders back into the page file. No smartTitle()/smartDesc() logic is duplicated here, so
// the generator cannot disagree with the Function.
//
// SCOPE (deliberately narrow)
// Only the manifest-derived values are synced: <title>, meta description, og:title,
// og:description, twitter:title, twitter:description and the JSON-LD name/description of the
// top-level nodes. Everything else the Function injects at runtime (og:url, og:image, robots,
// GA4, breadcrumbs, FAQ schema, related tools) is left alone — the file copy is a fallback
// copy of the manifest promise, not a byte-mirror of the whole rendered page.
//
// INVARIANT (what the BUG-447 gate checks)
// For every tool page: the manifest-derived head in the FILE == the manifest-derived head the
// Function SERVES. twitter:* is replace-only in the runtime (never injected), so a page without
// twitter tags keeps having none.
//
// Idempotent: a second run with an unchanged manifest writes 0 files.
// Run by scripts/pre-deploy.sh before every deploy; safe to run any time.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = 'https://tools.scoreroute.com';

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

function makeAssets() {
  return {
    async fetch(u) {
      const rel = new URL(u).pathname.replace(/^\//, '') || 'index.html';
      const cands = [rel, rel.replace(/\/$/, '') + '/index.html', rel + 'index.html'];
      for (const c of rel.endsWith('/') || rel === '' ? [] : cands) {
        if (fs.existsSync(path.join(ROOT, c))) {
          return new Response(fs.readFileSync(path.join(ROOT, c), 'utf8'), { status: 200 });
        }
      }
      for (const c of ['index.html', '../index.html']) {
        if (fs.existsSync(path.join(ROOT, c))) {
          return new Response(fs.readFileSync(path.join(ROOT, c), 'utf8'), {
            status: 200, headers: { 'X-Spa-Fallback': '1' },
          });
        }
      }
      return new Response('', { status: 404 });
    },
  };
}

const noCache = { default: { match: async () => undefined, put: async () => {} } };
const ASSETS = makeAssets();

const unescapeHtml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const attr = (html, re) => { const m = html.match(re); return m ? m[1] : null; };

/** The manifest-derived head, as the Function serves it. */
async function servedHead(slug) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'functions/tools/[[catchall]].js')).href);
  const res = await mod.onRequest({
    params: {},
    request: new Request(`${SITE}/tools/${slug}/`),
    next: async () => new Response('NEXT', { status: 404 }),
    env: { ASSETS },
    caches: noCache,
  });
  if (res.status !== 200) throw new Error(`${slug}: Function returned ${res.status}`);
  const html = await res.text();
  const head = {
    title: attr(html, /<title>([\s\S]*?)<\/title>/i),
    metaDesc: attr(html, /<meta name="description" content="([^"]*)"/i),
    ogTitle: attr(html, /<meta property="og:title" content="([^"]*)"/i),
    ogDesc: attr(html, /<meta property="og:description" content="([^"]*)"/i),
    twTitle: attr(html, /<meta name="twitter:title" content="([^"]*)"/i),
    twDesc: attr(html, /<meta name="twitter:description" content="([^"]*)"/i),
  };
  if (!head.title || !head.metaDesc || !head.ogTitle || !head.ogDesc) {
    throw new Error(`${slug}: the served head is incomplete — ${JSON.stringify(head)}`);
  }
  // The runtime writes the JSON-LD name/description UNESCAPED.
  head.ldName = unescapeHtml(head.title);
  head.ldDesc = unescapeHtml(head.metaDesc);
  return head;
}

/** Replace the value of one head tag in the page file, in place. */
function setTag(html, what, pattern, value, { required = true } = {}) {
  const re = new RegExp(pattern);
  if (!re.test(html)) {
    if (required) throw new Error(`${what}: not found in the page file`);
    return html;
  }
  return html.replace(re, value);
}

/**
 * og:title / og:description are the two manifest-derived tags the runtime INJECTS when the
 * page file lacks them (BUG-393's addOg) — so a file without them still serves them. The
 * fallback copy must carry them too. The insertion point mirrors addOg exactly: right after
 * og:image when it exists, else before </head>.
 */
function setOgTag(html, what, prop, value) {
  const pattern = `<meta property="${prop}" content="[^"]*"\\s*/?>`;
  if (new RegExp(pattern).test(html)) {
    return html.replace(new RegExp(pattern), `<meta property="${prop}" content="${value}">`);
  }
  const tag = `<meta property="${prop}" content="${value}">`;
  if (/<meta property="og:image"[^>]*>/.test(html)) {
    return html.replace(/(<meta property="og:image"[^>]*>)/, (m) => m + '\n    ' + tag);
  }
  return html.replace('</head>', '    ' + tag + '\n  </head>');
}

function syncJsonLd(html, slug, head) {
  return html.replace(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    (match, raw) => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return match; }
      const nodes = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
      let out = raw;
      for (const node of nodes) {
        for (const [field, value] of [['name', head.ldName], ['description', head.ldDesc]]) {
          if (node[field] === undefined) continue;
          const old = JSON.stringify(node[field]);
          const next = JSON.stringify(value);
          if (old === next) continue;
          if (out.split(old).length - 1 !== 1) {
            // Ambiguous in-place replacement (the same string appears twice in the block):
            // re-serialise the block instead of guessing which occurrence is the field.
            const nodes2 = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
            for (const n of nodes2) {
              if (n[field] !== undefined) n[field] = value;
            }
            return '<script type="application/ld+json">' + JSON.stringify(parsed, null, 4) + '</script>';
          }
          out = out.replace(old, next);
        }
      }
      return '<script type="application/ld+json">' + out + '</script>';
    }
  );
}

const manifest = fs.readFileSync(path.join(ROOT, 'manifest.txt'), 'utf8');
const slugs = manifest
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('|')[0].trim())
  .filter((s) => s && !s.includes(' '));
if (slugs.length < 300) throw new Error('manifest parsed to only ' + slugs.length + ' slugs');

let changed = 0, checked = 0;
const problems = [];

for (const slug of slugs) {
  const file = path.join(ROOT, 'tools', slug, 'index.html');
  if (!fs.existsSync(file)) { problems.push(`${slug}: page file missing`); continue; }
  const before = fs.readFileSync(file, 'utf8');
  let html = before;

  const head = await servedHead(slug);

  html = setTag(html, `${slug} <title>`, '<title>[\\s\\S]*?</title>', `<title>${head.title}</title>`);
  html = setTag(html, `${slug} meta description`, '<meta name="description" content="[^"]*"\\s*/?>',
    `<meta name="description" content="${head.metaDesc}">`);
  html = setOgTag(html, `${slug} og:title`, 'og:title', head.ogTitle);
  html = setOgTag(html, `${slug} og:description`, 'og:description', head.ogDesc);
  // twitter:* is replace-only in the runtime: a page without them keeps having none.
  html = setTag(html, `${slug} twitter:title`, '<meta name="twitter:title" content="[^"]*"\\s*/?>',
    `<meta name="twitter:title" content="${head.twTitle}">`, { required: head.twTitle !== null });
  html = setTag(html, `${slug} twitter:description`, '<meta name="twitter:description" content="[^"]*"\\s*/?>',
    `<meta name="twitter:description" content="${head.twDesc}">`, { required: head.twDesc !== null });

  html = syncJsonLd(html, slug, head);

  if (html !== before) {
    fs.writeFileSync(file, html, 'utf8');
    changed++;
  }
  checked++;
}

// Verify, do not assume: re-read every file and compare with a fresh render.
let drift = 0;
for (const slug of slugs) {
  const file = path.join(ROOT, 'tools', slug, 'index.html');
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  const head = await servedHead(slug);
  const pairs = [
    ['<title>', attr(html, /<title>([\s\S]*?)<\/title>/i), head.title],
    ['meta description', attr(html, /<meta name="description" content="([^"]*)"/i), head.metaDesc],
    ['og:title', attr(html, /<meta property="og:title" content="([^"]*)"/i), head.ogTitle],
    ['og:description', attr(html, /<meta property="og:description" content="([^"]*)"/i), head.ogDesc],
  ];
  for (const [what, got, want] of pairs) {
    if (got !== want) { problems.push(`${slug}: ${what} is "${got}", served "${want}"`); drift++; }
  }
  for (const [what, re, want] of [
    ['twitter:title', /<meta name="twitter:title" content="([^"]*)"/i, head.twTitle],
    ['twitter:description', /<meta name="twitter:description" content="([^"]*)"/i, head.twDesc],
  ]) {
    const got = attr(html, re);
    if (got !== want) { problems.push(`${slug}: ${what} is "${got}", served "${want}"`); drift++; }
  }
}

console.log(`[gen-tool-meta] ${checked} tool pages checked · ${changed} file(s) rewritten · ${drift} drift(s) left`);
if (problems.length) {
  for (const p of problems.slice(0, 20)) console.error('[gen-tool-meta] FAIL ' + p);
  console.error(`[gen-tool-meta] ${problems.length} problem(s) — refusing to continue`);
  process.exit(1);
}
