// Dynamic homepage - single source of truth: /manifest.txt
// Format: slug|category|featured|isnew|name|description|tags
// Function reads manifest only (1 subrequest, no per-tool fetch).
// To add a tool: append 1 line to /manifest.txt
// Supports pagination: /?page=N (50 tools per page), scales to 500+ tools.
// BUG-161: Serves markdown variant at /.md and via Accept: text/markdown content negotiation
// (Warning 2/15 markdown-url-support + Warning 3/15 content-negotiation — was 9/10 since
// / and /tools/ had no .md / Accept negotiation, only /about/, /privacy/, and /tools/<slug>/ did).

const PAGE_SIZE = 50;
const nl = '\n';

import { parseManifest } from '../libs/manifest.js';

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// BUG-353: `agentimization/page-size-markdown` — "keep the .md version of each page under 50 KB
// so it fits in an LLM context window". The homepage mirror shipped every one of the 346 tool
// descriptions inline, which made /.md 96 KB and /tools/.md 182 KB: 15-40x every other mirror on
// the site (all 346 tool mirrors average 6.2 KB; the 11 category mirrors are 4.7-20 KB).
//
// The descriptions are not lost — every one of them is still published at the URL on the same
// line (llms-full.txt, llms.txt, /api/tools and /tools/<slug>/.md). What was removed is the
// FOURTH copy of a catalogue that already exists three times. `describe` is what the mirror is
// for: the curated Popular / Recently Updated bands keep their descriptions, and — since
// BUG-400 — the alphabetical index carries its description on exactly the 50 entries the page's
// "View all N tools" disclosure renders (page 1 of the same by-name slice, see below).
// Held at 50 KiB since BUG-466 (2026-11-08): the 56 KiB budget BUG-400 raised it to was this
// file's own number, and the review bot still fires `agentimization/page-size-markdown` at
// 50 KB — "1/10 markdown pages exceed 50K chars", Warning 4 of every 2026-11-07/08 round. The
// budget was never the binding constraint: the 28-byte origin prefix on every link was. /.md
// carried 373 absolute URLs (10.4 KB of `https://tools.scoreroute.com`) and every other mirror
// on the site — all 373 tool mirrors and all 11 category mirrors, from libs/html-md.js — has
// always linked root-relative, with the document's own base declared once in its `URL:` line.
// Root-relative links therefore lost nothing and took /.md from 56.2 KB to ~45 KB, under 50 KB
// with room for ~50 more tools. llms.txt / llms-full.txt stay absolute on purpose: they are
// standalone indexes an agent reads with no page to resolve against, which is not what a
// mirror is. Asserted by bug353-md-page-size-gate.js and its production suite — a red gate on
// overrun, never silent trimming.
const MD_BUDGET = 50 * 1024;
const describe = (t) =>
  '- [' + mdEscape(t.name) + '](/tools/' + t.slug + '/.md): ' + mdEscape(t.desc) +
  (t.isnew ? ' _(New)_' : (t.featured ? ' _(Popular)_' : '')) + nl;
const CATALOGUE_POINTER = () =>
  'Full description for every entry: [llms-full.txt](/llms-full.txt) ' +
  '(machine-readable catalogue: [/api/tools](/api/tools), compact index: ' +
  '[llms.txt](/llms.txt)). Each name above links to that tool\'s own markdown mirror, ' +
  'which carries its description in full.' + nl + nl;

export function homepageFaqs(totalCount) {
  return [
    { q: 'Are all ' + totalCount + ' developer tools really free?',
      a: 'Yes — every tool on DevTools Hub is 100% free with no signup, no trial, no daily limit, and no watermark. The site is supported by optional cloud functions and ad-free by design.' },
    { q: 'Do you upload my data to a server?',
      a: 'Most tools process everything in your browser. Only AI-backed tools (AI Chat, AI Detector, Image Generator, Story Animator, Translator, Paraphrasing Tool, Plagiarism Checker, Resume Builder, Cover Letter Generator, Citation Generator, ATS Resume Checker, AI Humanizer, Text-to-Speech, Text-to-Video, Text Summarizer, Math Solver, Grammar Checker, Subtitle Generator, and a few others) call a server API for GPU compute. Uploads are transient and never logged. Each tool page documents exactly what leaves your device.' },
    { q: 'Why use these tools instead of asking an AI chatbot?',
      a: 'AI chatbots hallucinate exact arithmetic, produce invalid JSON/XML, drop SVG attributes, and cannot compute dates, fractions, or compound interest reliably. DevTools Hub uses deterministic code — same input always yields the same verified output.' },
    { q: 'Do I need to create an account?',
      a: 'No account, no email, no tracking cookies. Open any tool, use it, close the tab. Your inputs never leave your browser unless you explicitly call a cloud-backed AI tool.' },
    { q: 'How often are new tools added?',
      a: 'New tools ship 2-3 times per week. The homepage shows a ' + totalCount + ' tool count that updates automatically as new entries are added to the public manifest. See the sitemap.xml for the complete list.' },
    { q: 'Can I use these tools commercially?',
      a: 'Yes. The outputs you generate belong to you — use them in client work, internal tools, or commercial products without attribution. The tool code itself is MIT-licensed on GitHub.' }
  ];
}

// BUG-353: exported and shared. `functions/[file].js` (which serves the literal `/.md` URL) used
// to carry its own ~120-line copy of everything below, despite the comment in it promising "to
// avoid duplicating ~120 lines of markdown construction, we proxy to /?_md=1". Two builders for
// one URL is how the two drifted: production `/.md` emitted `## All Tools (alphabetical)` while
// `/?_md=1` emitted `## All Tools (alphabetical, page 1)` from the same source tree — BUG-114's
// shape, third instance.
export function buildHomepageMarkdown(tools, HOMEPAGE_FAQS) {
  const base = 'https://tools.scoreroute.com';
  const totalCount = tools.length;
  const popular = tools.filter(t => t.featured).slice(0, 8);
  const RECENT_COUNT = 6;
  const popularSlugs = new Set(popular.map(t => t.slug));
  const recentOnly = tools.slice(-RECENT_COUNT).reverse().filter(t => !popularSlugs.has(t.slug));
  const byCategory = {};
  for (const t of tools) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }
  const CAT_ORDER = [
    ['formatters', 'Code Formatters'], ['calculators', 'Calculators'],
    ['generators', 'Generators'], ['converters', 'Converters'],
    ['media', 'Media Tools'], ['network', 'Network Tools'],
    ['code-testing', 'Code Testing'], ['pdf-tools', 'PDF Tools'],
    ['life', 'Daily Life'], ['finance', 'Money & Markets'],
    ['ai-language', 'AI Language'],
  ];
  const knownCats = new Set(CAT_ORDER.map(c => c[0]));
  for (const c of Object.keys(byCategory)) {
    if (!knownCats.has(c)) CAT_ORDER.push([c, c]);
  }
  let md = '';
  md += '# DevTools Hub — ' + totalCount + ' Free Online Developer Tools' + nl + nl;
  md += '> Free collection of ' + totalCount + ' browser-based developer tools across ' + CAT_ORDER.length + ' categories. No signup, no tracking, all processing happens in your browser.' + nl + nl;
  // BUG-397: `agentimization/markdown-content-parity` — "Markdown versions are missing ~20% of
  // HTML content on average" (Error 1/2 of the 2026-10-25 review). Measured over that review's own
  // 48-page sample, the class is exactly the two catalogue pages: / lost 26% of the page's
  // sentences and /tools/ 39%, while the 352 tool mirrors and the 11 category mirrors lost 0-6%.
  // BUG-351's gate never saw it because it enumerates manifest.txt slugs — the tool pages.
  //
  // The homepage's own hero text was the part of the page the mirror dropped: the subtitle above
  // the h1, the h2 that introduces the hero paragraph, and the "Popular: …" quick-link line under
  // the search box. All three are carried now.
  //
  // BUG-400 (2026-10-27) closes BUG-397's last residual: the "View all N tools" disclosure's 50
  // card descriptions. The disclosure renders the first PAGE_SIZE entries of the same by-name
  // sort, each card name + description; the mirror now appends its description to the link line
  // of exactly those 50 entries (no second list, no new section — the line already existed).
  // The section heading below mirrors the disclosure's <summary> text verbatim, so the
  // markdown-content-parity gate runs on / with zero carve-outs. BUG-466: links went
  // root-relative, which is what brought the mirror back under the 50 KiB budget with all 50
  // card descriptions still inline (see MD_BUDGET above).
  md += totalCount + ' free developer tools · no signup · runs in your browser' + nl + nl;
  md += 'URL: ' + base + '/' + nl + nl;
  md += 'Markdown: ' + base + '/.md' + nl + nl;
  md += '## Developer tools that work.' + nl + nl;
  md += totalCount + ' free utilities for code formatting, file conversion, online calculators, AI assistance, and more. No signup, no upload, no tracking.' + nl + nl;
  md += 'Popular: JSON formatter · Password generator · QR code · AI chat · Image compressor · Speed test' + nl + nl;
  md += '## Popular Tools' + nl + nl;
  for (const t of popular) {
    md += '- [' + mdEscape(t.name) + '](/tools/' + t.slug + '/.md): ' + mdEscape(t.desc) + (t.isnew ? ' _(New)_' : '') + nl;
  }
  md += nl;
  if (recentOnly.length) {
    md += '## Recently Updated' + nl + nl;
    for (const t of recentOnly) {
      md += '- [' + mdEscape(t.name) + '](/tools/' + t.slug + '/.md): ' + mdEscape(t.desc) + nl;
    }
    md += nl;
  }
  md += '## Browse by Category' + nl + nl;
  for (const c of CAT_ORDER) {
    const count = (byCategory[c[0]] || []).length;
    md += '- [' + mdEscape(c[1]) + ' (' + count + ' tools)](/tools/' + c[0] + '/.md)' + nl;
  }
  md += nl;
  // BUG-353: no pagination. The old heading said "page N" while listing all 346 tools whatever N
  // was — `/?_md=1&page=2` answered with the same 346 rows and the same "page 2" label. Dropping
  // the page number and the inline descriptions is one edit for both: the mirror is now the whole
  // index, honestly labelled, and sized for a context window.
  md += '## View all ' + totalCount + ' tools (alphabetical)' + nl + nl;
  md += CATALOGUE_POINTER();
  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  // Same expression and same PAGE_SIZE as the page's all-tools grid (`pagedTools` in the HTML
  // builder above), one Function — the 50 names described here are the 50 cards the page renders.
  const disclosed = new Set(sorted.slice(0, PAGE_SIZE).map((t) => t.slug));
  for (const t of sorted) {
    md += disclosed.has(t.slug)
      ? describe(t)
      : '- [' + mdEscape(t.name) + '](/tools/' + t.slug + '/.md)' + nl;
  }
  md += nl;
  md += '## Frequently Asked Questions' + nl + nl;
  for (const f of HOMEPAGE_FAQS) {
    md += '### ' + mdEscape(f.q) + nl + nl;
    md += mdEscape(f.a) + nl + nl;
  }
  md += '## About DevTools Hub' + nl + nl;
  md += 'DevTools Hub is maintained by BAOMING and ships 2-3 new tools per week. Every tool is ' + nl;
  md += '100% free, runs in your browser, requires no signup, and works offline once loaded.' + nl;
  md += 'See [About](/about/.md), [Privacy](/privacy/.md), and' + nl;
  md += '[Feedback](/tools/feedback/) for details.' + nl + nl;
  md += '## Sitemap and Feeds' + nl + nl;
  md += '- [Sitemap (HTML + .md URLs)](/sitemap.xml)' + nl;
  md += '- [llms.txt (compact catalog for AI agents)](/llms.txt)' + nl;
  md += '- [llms-full.txt (full descriptions for AI agents)](/llms-full.txt)' + nl;
  if (md.length > MD_BUDGET) {
    // ponytail: the 50 KB cap is asserted, not enforced by trimming. A tool catalogue that grows
    // past the budget should show up as a red gate, not as a mirror that silently lost rows.
    console.warn('BUG-353: /.md is ' + md.length + ' B, over the ' + MD_BUDGET + ' B budget');
  }
  return md;
}

export async function onRequest(context) {
  const cache = caches.default;

  // BUG-161: Detect markdown requests early so HEAD/cache logic uses the right cache key
  const reqUrl = new URL(context.request.url);
  const _accept = context.request.headers.get('Accept') || '';
  const _isMdPath = reqUrl.pathname === '/.md' || reqUrl.pathname === '/index.md';
  const _mdQuery = reqUrl.searchParams.get('_md') === '1';
  const _prefersMd = _accept.includes('text/markdown') && !_accept.includes('text/html');
  const _wantsMd = _isMdPath || _prefersMd || _mdQuery;

  // HEAD support: return 200 with no body (avoid running full render)
  if (context.request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': _wantsMd ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()'
      }
    });
  }

  // BUG-161: Use a separate cache key for markdown responses so HTML and markdown don't collide
  const _cacheUrl = _wantsMd ? context.request.url + '?__accept=md' : context.request.url;
  const cacheKey = new Request(_cacheUrl, context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);
  let tools = [];

  try {
    const mr = await assets.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
    if (!mr.ok) throw new Error('Manifest ' + mr.status);
    const manifest = await mr.text();
    // BUG-513: one manifest parser for every reader (libs/manifest.js).
    tools = parseManifest(manifest);
  } catch (e) {
    return new Response('Manifest error: ' + e.message, { headers: { 'Content-Type': 'text/plain' } });
  }

  const totalCount = tools.length;
  const popular = tools.filter(t => t.featured).slice(0, 8);
  // BUG-290: this was a hardcoded PINNED_SLUGS list ('audio-cutter', 'grade-calculator'), so the
  // "Recently Updated" band showed the same two month-old tools forever and never reflected what
  // was actually added. manifest.txt is append-only (tools are added at the end), so the tail of
  // the file IS the most recently added tools — derive the band from it and it self-maintains.
  const RECENT_COUNT = 6;
  const recentTools = tools.slice(-RECENT_COUNT).reverse();
  const popularSlugs = new Set(popular.map(t => t.slug));
  const recentOnly = recentTools.filter(t => !popularSlugs.has(t.slug));
  const byCategory = {};
  for (const t of tools) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }
  const CAT_ORDER = [
    // BUG-336: `formatters` was 'Formatters' here and in functions/api/tools.js but
    // 'Code Formatters' in functions/tools/{index,[[catchall]]}.js, functions/llms.txt.js,
    // functions/llms-full.txt.js and the static llms.txt — so the homepage grid, the search
    // dropdown and /api/tools all named one category differently from the page they link to.
    // One name, taken from the category page itself (the canonical surface for the slug).
    ['formatters', 'Code Formatters'], ['calculators', 'Calculators'],
    ['generators', 'Generators'], ['converters', 'Converters'],
    ['media', 'Media Tools'], ['network', 'Network Tools'],
    ['code-testing', 'Code Testing'], ['pdf-tools', 'PDF Tools'],
    ['life', 'Daily Life'], ['finance', 'Money & Markets'],
    ['ai-language', 'AI Language'],
  ];
  const knownCats = new Set(CAT_ORDER.map(c => c[0]));
  for (const c of Object.keys(byCategory)) {
    if (!knownCats.has(c)) CAT_ORDER.push([c, c]);
  }

  const today = new Date().toISOString().split('T')[0];
  const searchData = (t) => (t.tags.concat([t.name, t.slug.replace(/-/g, ',')]).join(',')).toLowerCase();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Pagination for all-tools section
  const url = new URL(context.request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const sorted = tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const start = (safePage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pagedTools = sorted.slice(start, end);

  const popHtml = popular.map(t =>
    '<div class="tool-card" data-search="' + searchData(t) + '"><h3><a href="/tools/' + t.slug + '/">' + esc(t.name) + '</a></h3><p>' + esc(t.desc) + '</p>' + (t.isnew ? '<span class="tool-tag">New</span>' : '') + '</div>'
  ).join('');

  const recentHtml = recentOnly.length > 0
    ? '<section class="section-block" id="all-tools-pinned"><div class="section-header"><h2>Recently Updated</h2><span class="section-count">' + recentOnly.length + ' tools' + '</span></div><div class="tools-grid">' + recentOnly.map(t =>
        '<div class="tool-card" data-search="' + searchData(t) + '"><h3><a href="/tools/' + t.slug + '/">' + esc(t.name) + '</a></h3><p>' + esc(t.desc) + '</p>' + (t.isnew ? '<span class="tool-tag">New</span>' : (t.featured ? '<span class="tool-tag">Popular</span>' : '')) + '</div>'
      ).join('') + '</div></section>' + nl
    : '';

  const catHtml = CAT_ORDER.map(c =>
    '<a href="/tools/' + c[0] + '/" class="category-card"><h3>' + esc(c[1]) + '</h3><p class="cat-count">' + (byCategory[c[0]] || []).length + ' tool' + ((byCategory[c[0]] || []).length !== 1 ? 's' : '') + '</p></a>'
  ).join('');

  const allHtml = pagedTools.map(t =>
    '<div class="tool-card" data-search="' + searchData(t) + '"><h3><a href="/tools/' + t.slug + '/">' + esc(t.name) + '</a></h3><p>' + esc(t.desc) + '</p>' + (t.isnew ? '<span class="tool-tag">New</span>' : (t.featured ? '<span class="tool-tag">Popular</span>' : '')) + '</div>'
  ).join('');

  // BUG-087: Homepage FAQ section + FAQPage JSON-LD (SEO/GEO backlog from
  // SITE-AUDIT-REPORT-2026-06-04.md — homepage previously had 0 <details> elements
  // and no FAQPage schema; audit recommended FAQPage schema for GEO citation).
  // BUG-353: this array was duplicated verbatim in functions/[file].js, the Function that serves
  // the literal /.md URL. It now lives at module scope (homepageFaqs) so /.md and / cannot
  // answer with different FAQ text.
  const HOMEPAGE_FAQS = homepageFaqs(totalCount);
  const faqHtml = '<section class="section-block faq-section"><div class="section-header"><h2>Frequently Asked Questions</h2></div>' +
    HOMEPAGE_FAQS.map(f => '<details class="faq-item"><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>').join('') +
    '</section>' + nl;
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'name': 'DevTools Hub FAQ',
    'mainEntity': HOMEPAGE_FAQS.map(f => ({
      '@type': 'Question',
      'name': f.q,
      'acceptedAnswer': { '@type': 'Answer', 'text': f.a }
    }))
  };

  // Pagination nav (only show if >1 page)
  let paginationHtml = '';
  if (totalPages > 1) {
    const pageUrl = (n) => n === 1 ? '/' : '/?page=' + n;
    let pages = [];
    pages.push(safePage > 1 ? '<a href="' + pageUrl(safePage - 1) + '" class="page-link">&laquo; Prev</a>' : '<span class="page-link disabled">&laquo; Prev</span>');
    // Show up to 7 page numbers with current in middle
    const range = [];
    for (let i = 1; i <= totalPages; i++) range.push(i);
    let display = range;
    if (totalPages > 7) {
      const start_p = Math.max(1, safePage - 3);
      const end_p = Math.min(totalPages, safePage + 3);
      display = [];
      if (start_p > 1) { display.push(1); if (start_p > 2) display.push('…'); }
      for (let i = start_p; i <= end_p; i++) display.push(i);
      if (end_p < totalPages) { if (end_p < totalPages - 1) display.push('…'); display.push(totalPages); }
    }
    for (const p of display) {
      if (p === '…') {
        pages.push('<span class="page-ellipsis">…</span>');
      } else if (p === safePage) {
        pages.push('<span class="page-link current">' + p + '</span>');
      } else {
        pages.push('<a href="' + pageUrl(p) + '" class="page-link">' + p + '</a>');
      }
    }
    pages.push(safePage < totalPages ? '<a href="' + pageUrl(safePage + 1) + '" class="page-link">Next &raquo;</a>' : '<span class="page-link disabled">Next &raquo;</span>');
    paginationHtml = '<nav class="pagination" aria-label="Tools pages">' + pages.join('') + '<span class="page-info">Page ' + safePage + ' of ' + totalPages + ' (' + sorted.length + ' tools)</span></nav>';
  }

  const head = '<!DOCTYPE html>' + nl +
    '<html lang="en">' + nl +
    '<head>' + nl +
    '<meta charset="UTF-8">' + nl +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' + nl +
    '<link rel="icon" type="image/x-icon" href="/favicon.ico">' + nl +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">' + nl +
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">' + nl +
    '<meta property="og:image" content="/og-image.png">' + nl +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' + nl +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' + nl +
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>' + nl +
    // BUG-323 (`perf/font-delivery`): the Google Fonts stylesheet was render-blocking — the parser
    // waited on a third-party round trip before first paint, on the homepage and all 11 category
    // pages. media="print" + the onload swap fetches it at low priority and applies it on arrival;
    // both preconnects above were already in place, so it still lands early on a warm connection.
    // `display=optional` is kept: on a slow connection the fallback stack is used for the visit
    // rather than a font swap mid-read.
    '<link rel="stylesheet" media="print" onload="this.media=\'all\'" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=optional">' + nl +
    '<link rel="stylesheet" href="/home.css">' + nl +
    '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1, ai-train:no, ai-input:no">' + nl +
    '<title>DevTools Hub - ' + totalCount + ' Free Online Developer Tools</title>' + nl +
    // BUG-172: trimmed to ≤155 chars while preserving 3 probe phrases ("free online developer tools", "JSON formatter online", "image compressor free") for SquirrelScan AI-citability (was 174/158 — Warning 1/17 `core/meta-description`)
    '<meta name="description" content="' + totalCount + ' browser-based developer tools: JSON formatter, image compressor, QR generator, AI chat, PDF merger and ' + (totalCount - 5) + ' more. No signup, no upload, no tracking.">' + nl +
    '<link rel="canonical" href="https://tools.scoreroute.com/">' + nl +
    '<meta property="og:title" content="DevTools Hub - ' + totalCount + ' Free Online Developer Tools">' + nl +
    '<meta property="og:description" content="' + totalCount + ' browser-based developer tools: JSON formatter, image compressor, QR generator, AI chat, PDF merger and ' + (totalCount - 5) + ' more. No signup, no upload, no tracking.">' + nl +
    '<meta property="og:url" content="https://tools.scoreroute.com/">' + nl +
    '<meta property="og:type" content="website">' + nl +
    '<meta name="twitter:card" content="summary_large_image">' + nl +
    '<meta name="twitter:title" content="DevTools Hub - ' + totalCount + ' Free Online Developer Tools">' + nl +
    '<meta name="twitter:description" content="' + totalCount + ' browser-based developer tools: JSON formatter, image compressor, QR generator, AI chat, PDF merger and ' + (totalCount - 5) + ' more. No signup, no upload, no tracking.">' + nl +
    '<meta name="twitter:image" content="/og-image.png">' + nl +
    '<meta name="twitter:url" content="https://tools.scoreroute.com/">' + nl +
    '<script type="application/ld+json">' + nl +
    '{"@context":"https://schema.org","@type":"WebSite","@id":"https://tools.scoreroute.com/#website","datePublished":"2026-05-21","dateModified":"' + today + '","author":{"@id":"https://tools.scoreroute.com/#author","@type":"Person","name":"BAOMING","url":"https://github.com/Evan-MJ","sameAs":["https://github.com/Evan-MJ","https://github.com/Evan-MJ/devtools-hub"]},"publisher":{"@id":"https://tools.scoreroute.com/#organization","@type":"Organization","name":"DevTools Hub","url":"https://tools.scoreroute.com/"},"name":"DevTools Hub","description":"Free online developer tools, no signup required. ' + totalCount + '+ browser-based utilities.","url":"https://tools.scoreroute.com/"}' + nl +
    '</script>' + nl +
    // BUG-310: the home page declared only WebSite, so the one thing that is unambiguously true
    // about this site — it is an application you use, not a set of articles — was never declared
    // anywhere on the page that describes it. `isPartOf` links it to the WebSite above; the
    // #website @id is what makes that reference resolvable. No @id on the static index.html copy:
    // that file is the SPA fallback for unknown paths and cannot know totalCount, so sharing an
    // @id with a different description would be the BUG-299 entity conflict all over again.
    '<script type="application/ld+json">' + nl +
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      '@id': 'https://tools.scoreroute.com/#webapp',
      'name': 'DevTools Hub',
      'url': 'https://tools.scoreroute.com/',
      'description': 'Free browser-based developer tools: JSON formatter, image compressor, QR generator, PDF merger and ' + totalCount + ' more. No signup, no upload, runs entirely in your browser.',
      'applicationCategory': 'DeveloperApplication',
      'operatingSystem': 'Any',
      'browserRequirements': 'Requires JavaScript',
      'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'USD' },
      'isPartOf': { '@id': 'https://tools.scoreroute.com/#website' },
      'author': { '@id': 'https://tools.scoreroute.com/#author', '@type': 'Person', 'name': 'BAOMING', 'url': 'https://github.com/Evan-MJ', 'sameAs': ['https://github.com/Evan-MJ', 'https://github.com/Evan-MJ/devtools-hub'] },
      'publisher': { '@id': 'https://tools.scoreroute.com/#organization', '@type': 'Organization', 'name': 'DevTools Hub', 'url': 'https://tools.scoreroute.com/' },
      'datePublished': '2026-05-21',
      'dateModified': today,
      'inLanguage': 'en'
    }) + nl +
    '</script>' + nl +
    // BUG-357: the homepage was the 1 of 11 pages with FAQPage schema that was missing
    // BreadcrumbList and CollectionPage (the other faq pages — /tools/ and the 11
    // /tools/<category>/ pages — declare both). `schema/coverage-outlier` counts @type
    // at a page's top level, so each goes in its own <script> block rather than nested
    // inside WebSite / WebApplication. CollectionPage describes the homepage as the
    // collection of all 346 tools (curated into Popular + by-category + alphabetical);
    // BreadcrumbList has a single Home item, which is the standard landing-page shape
    // (a breadcrumb with only the current page is valid schema.org). No @id on either:
    // the static /index.html SPA fallback cannot know totalCount, and a shared @id with
    // a different description would re-open BUG-299. `isPartOf` on CollectionPage
    // points at the #website entity the WebSite block above already declares, so the
    // relationship is resolvable from the same page.
    '<script type="application/ld+json">' + nl +
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      'datePublished': '2026-05-21',
      'dateModified': today,
      'name': 'DevTools Hub - ' + totalCount + ' Free Online Developer Tools',
      'description': 'A curated collection of ' + totalCount + ' free browser-based developer tools: JSON formatter, image compressor, QR generator, PDF merger, AI chat and more. No signup, no upload, runs in your browser.',
      'url': 'https://tools.scoreroute.com/',
      'isPartOf': { '@id': 'https://tools.scoreroute.com/#website' },
      'author': { '@id': 'https://tools.scoreroute.com/#author', '@type': 'Person', 'name': 'BAOMING', 'url': 'https://github.com/Evan-MJ', 'sameAs': ['https://github.com/Evan-MJ', 'https://github.com/Evan-MJ/devtools-hub'] },
      'publisher': { '@id': 'https://tools.scoreroute.com/#organization', '@type': 'Organization', 'name': 'DevTools Hub', 'url': 'https://tools.scoreroute.com/' },
      'inLanguage': 'en'
    }) + nl +
    '</script>' + nl +
    '<script type="application/ld+json">' + nl +
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://tools.scoreroute.com/' }
      ]
    }) + nl +
    '</script>' + nl +
    '<script type="application/ld+json">' + nl +
    JSON.stringify(faqSchema) + nl +
    '</script>' + nl +
    // MAINT-2026-09-22: ItemList schema for "Popular Tools" (rich result eligibility + GEO citation).
    // Scoped to the curated Popular section only (≤ 8 items) — Google flags large ItemList with all
    // site content as spammy. Ordered list to communicate ranking.
    (popular.length > 0 ? '<script type="application/ld+json">' + nl +
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        'name': 'Popular DevTools',
        'description': 'The ' + popular.length + ' most popular free online developer tools on DevTools Hub.',
        'numberOfItems': popular.length,
        'itemListOrder': 'https://schema.org/ItemListOrderAscending',
        'itemListElement': popular.map((t, i) => ({
          '@type': 'ListItem',
          'position': i + 1,
          'name': t.name,
          'url': 'https://tools.scoreroute.com/tools/' + t.slug + '/'
        }))
      }) + nl +
    '</script>' + nl : '') +
    '</head>' + nl +
    '<body>' + nl +
    '<div class="hub-page">';

  const main = nl +     '<header class="site-header"><div class="container">' + nl +
    '<h1><a href="/">DevTools Hub - ' + totalCount + ' Free Online Developer Tools</a></h1>' + nl +
    '<p class="subtitle">' + totalCount + ' free developer tools &middot; no signup &middot; runs in your browser</p>' + nl +
    '<nav class="top-nav"><a href="/about/">About</a> <a href="/privacy/">Privacy</a> <a href="/subprocessors/">Subprocessors</a> <a href="/sitemap.xml">Sitemap</a> <a href="/tools/feedback/">Feedback</a></nav>' + nl +
    '</div></header>' + nl +
    '<main><div class="container">' + nl +
    '<section class="hero">' + nl +
    '<h2>Developer tools that work.</h2>' + nl +
    '<p>' + totalCount + ' free utilities for code formatting, file conversion, online calculators, AI assistance, and more. No signup, no upload, no tracking.</p>' + nl +
    '<div class="hero-search"><input type="search" id="tool-search" aria-label="Search all ' + totalCount + ' developer tools" placeholder="Search ' + totalCount + ' tools..." autocomplete="off" autofocus><div id="tool-search-results" class="search-results" role="listbox" aria-label="Search results" hidden></div></div>' + nl +
    '<p class="hero-meta">Popular: JSON formatter &middot; Password generator &middot; QR code &middot; AI chat &middot; Image compressor &middot; Speed test</p>' + nl +
    '</section>' + nl +
    (popular.length > 0 ? '<section class="section-block" id="popular"><div class="section-header"><h2>Popular Tools</h2><span class="section-count">' + popular.length + ' most-used</span></div><div class="tools-grid">' + popHtml + '</div></section>' + nl : '') +
    recentHtml +
    '<section class="section-block" id="categories"><div class="section-header"><h2>Browse by Category</h2><span class="section-count">' + CAT_ORDER.length + ' categories</span></div><div class="category-grid">' + catHtml + '</div></section>' + nl +
    '<section class="all-tools-section"><details' + (safePage > 1 ? ' open' : '') + '><summary>View all ' + totalCount + ' tools (alphabetical)</summary><div class="tools-grid">' + allHtml + '</div>' + paginationHtml + '</details></section>' + nl +
    faqHtml +
    '</div></main>' + nl +
    '<footer class="footer-min"><div class="container"><div>&copy; 2026 DevTools Hub &middot; ' + totalCount + ' free tools &middot; no signup</div><div><a href="/about/">About</a> <a href="/privacy/">Privacy</a> <a href="/contact/">Contact</a> <a href="/tools/feedback/">Feedback</a> <a href="/sitemap.xml">Sitemap</a> <a href="/llms.txt">llms.txt</a> <a href="/llms-full.txt">llms-full.txt</a> <a href="https://developer.mozilla.org/" target="_blank" rel="noopener">MDN</a> <a href="https://llmstxt.org/" target="_blank" rel="noopener">llms.txt spec</a></div></div></footer>' + nl +
    '<script>' + nl +
    // BUG-287: the homepage only renders PAGE_SIZE (50) cards, so the old input handler could
    // only ever match 60 of ' + totalCount + ' tools — searching "pdf-ocr" returned
    // "No tools found" even though the tool exists (measured in production).
    // Fix: filter the rendered cards first (instant), then lazily load the full index from the
    // existing /api/tools endpoint (300s edge cache, manifest.txt as single source of truth) and
    // match against every tool. No new endpoint, no data duplicated in HTML.
    'document.addEventListener("DOMContentLoaded", function() {' + nl +
    'var si = document.getElementById("tool-search");' + nl +
    'if (!si) return;' + nl +
    'var det = document.querySelector(".all-tools-section details");' + nl +
    'var popSec = document.getElementById("popular");' + nl +
    'var pinnedSec = document.getElementById("all-tools-pinned");' + nl +
    'var out = document.getElementById("tool-search-results");' + nl +
    'var allCards = document.querySelectorAll(".tool-card");' + nl +
    'var nr = document.getElementById("no-results");' + nl +
    'var idx = null, idxPromise = null;' + nl +
    // BUG-387: the AI boost and the local list are written to the same dropdown by two
    // independent async paths, and the local one rewrites `out.innerHTML` wholesale. The
    // boost therefore survived only when it happened to land last — measured 1 of 9
    // searches lost it entirely, with no error anywhere. The boost now lives in `aiBlock`
    // and the local list is written UNDER it, skipping the slugs the AI already shows.
    'var aiBlock = "", aiSlugs = {};' + nl +
    'if (!nr) {' + nl +
    'nr = document.createElement("p");' + nl +
    'nr.id = "no-results";' + nl +
    'nr.className = "no-results-msg";' + nl +
    'nr.hidden = true;' + nl +
    'nr.textContent = "No tools found. Try a different search term.";' + nl +
    'si.parentNode.appendChild(nr);' + nl +
    '}' + nl +
    'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}' + nl +
    'function cardText(c) { return ((c.getAttribute("data-search") || "") + " " + (c.querySelector("h3") ? c.querySelector("h3").textContent : "")).toLowerCase(); }' + nl +
    'function loadIndex(){' + nl +
    'if (idx) return Promise.resolve(idx);' + nl +
    'if (!idxPromise) {' + nl +
    'idxPromise = fetch("/api/tools").then(function(r){return r.json();}).then(function(j){' + nl +
    'idx = ((j && j.tools) || []).map(function(t){return {slug:t.slug,name:t.name,desc:t.desc||"",tags:t.tags||[],cat:t.categoryLabel||t.category||"",hay:((t.slug||"")+" "+(t.name||"")+" "+(t.desc||"")+" "+(t.tags||[]).join(" ")).toLowerCase()};});' + nl +
    'return idx;' + nl +
    '}).catch(function(){ idxPromise = null; return []; });' + nl +
    '}' + nl +
    'return idxPromise;' + nl +
    '}' + nl +
    'function renderOut(list, q){' + nl +
    // BUG-387: the AI boost is written first, the local list under it, and the local list
    // skips the slugs the AI already shows (so the two do not duplicate each other).
    'if (!list.length && !aiBlock) { out.hidden = true; out.innerHTML = ""; return; }' + nl +
    'var h = "";' + nl +
    'var shown = 0;' + nl +
    'for (var i = 0; i < list.length && shown < 40; i++) {' + nl +
    'var t = list[i];' + nl +
    'if (aiSlugs[t.slug]) continue;' + nl +
    'shown++;' + nl +
    'h += \'<a class="search-hit" role="option" href="/tools/\' + esc(t.slug) + \'/\"><strong>\' + esc(t.name) + \'</strong><span>\' + esc(t.cat) + \' &middot; /tools/\' + esc(t.slug) + "/</span></a>";' + nl +
    '}' + nl +
    'if (list.length > shown) h += \'<p class="search-hit-more">Showing \' + shown + \' of \' + list.length + \' matches &mdash; refine your search.</p>\';' + nl +
    'out.innerHTML = aiBlock + h;' + nl +
    'out.hidden = false;' + nl +
    '}' + nl +
    'var localFilter = function(q){' + nl +
    'var n = 0, popN = 0, pinnedN = 0;' + nl +
    'allCards.forEach(function(c) {' + nl +
    'var s = (q === "" || cardText(c).indexOf(q) !== -1);' + nl +
    'c.style.display = s ? "" : "none";' + nl +
    'if (s) { n++; if (popSec && popSec.contains(c)) popN++; if (pinnedSec && pinnedSec.contains(c)) pinnedN++; }' + nl +
    '});' + nl +
    'if (popSec) popSec.style.display = (q === "" || popN > 0) ? "" : "none";' + nl +
    'if (pinnedSec) pinnedSec.style.display = (q === "" || pinnedN > 0) ? "" : "none";' + nl +
    'return n;' + nl +
    '};' + nl +
    'var timer = null;' + nl +
    'si.addEventListener("keydown", function(e) {' + nl +
    'if (e.key !== "Enter") return;' + nl +
    'var q = this.value.trim();' + nl +
    'if (!q) return;' + nl +
    '// Non-blocking: fetch semantic search and inject AI results into dropdown' + nl +
    'fetch("/api/semantic-search?q=" + encodeURIComponent(q)).then(function(r){' + nl +
    'if (!r.ok) return r.json().catch(function(){});' + nl +
    'return r.json();' + nl +
    '}).then(function(d){' + nl +
    'if (!d || !d.tools || !d.tools.length) return;' + nl +
    'var aiHits = d.tools.slice(0,3);' + nl +
    // BUG-387: the de-dupe used to be filled from d.matches, whose entries are bare slug
    // strings — so `s.slug` was undefined and it never removed a thing. Key it on what is
    // actually rendered (d.tools), which is also exactly what must not be repeated.
    'aiHits.forEach(function(t){ aiSlugs[t.slug] = true; });' + nl +
    '// Remove AI hits from existing list (avoid dupes)' + nl +
    'var hits = out.querySelectorAll(".search-hit");' + nl +
    'hits.forEach(function(h){' + nl +
    'var slug = h.getAttribute("href").replace("/tools/","").replace("/","").trim();' + nl +
    'if (aiSlugs[slug]) h.remove();' + nl +
    '});' + nl +
    '// Prepend AI-boosted results at top of dropdown' + nl +
    'var aiHtml = aiHits.map(function(t){' + nl +
    // BUG-390: label each row for what it actually is. The API reports the provenance of
    // every result: 'alias' = the hand-curated alias table, 'ai' = the model\'s pick,
    // 'keyword' = the substring matcher. Before, every row said "AI", which is a lie for a
    // curated row — and the curated row is now the FIRST one.
    'var via = t.via === "alias" ? "Curated" : (t.via === "keyword" ? "Match" : "AI");' + nl +
    'return \'<a class="search-hit ai-hit" role="option" href="/tools/\' + esc(t.slug) + \'/\"><strong>\' + esc(t.name) + \'</strong><span>\' + via + \' &middot; /tools/\' + esc(t.slug) + "/</span></a>";' + nl +
    '}).join("");' + nl +
    // BUG-390: the block header says "AI boost" only when the block really holds a model
    // pick. When the curated answer answered the query, calling the whole block "AI" would
    // be a lie about where the answer came from.
    'var hasAi = aiHits.some(function(t){ return t.via !== "alias" && t.via !== "keyword"; });' + nl +
    'var noteHtml = hasAi ? \'<p class="search-hit-note">AI boost</p>\' : \'<p class="search-hit-note">Best matches</p>\';' + nl +
    // BUG-387: keep the block in a variable so renderOut() can write it back when the
    // local list lands afterwards. Writing it only into the DOM meant the next local
    // write took it with it, and the boost silently disappeared.
    'aiBlock = noteHtml + aiHtml;' + nl +
    'out.insertAdjacentHTML("afterbegin", aiBlock);' + nl +
    'out.hidden = false;' + nl +
    '}).catch(function(){});' + nl +
    '});' + nl +
    'si.addEventListener("input", function() {' + nl +
    'var q = this.value.toLowerCase().trim();' + nl +
    'clearTimeout(timer);' + nl +
    // BUG-387: a new query invalidates the previous boost — otherwise aiBlock would be
    // written back under every later local list, and a stale answer would outlive its
    // query.
    'aiBlock = ""; aiSlugs = {};' + nl +
    'if (!q) {' + nl +
    'localFilter("");' + nl +
    'out.hidden = true; out.innerHTML = "";' + nl +
    'nr.hidden = true;' + nl +
    'return;' + nl +
    '}' + nl +
    'var localN = localFilter(q);' + nl +
    'det && det.setAttribute("open", "");' + nl +
    'nr.hidden = true;' + nl +
    'timer = setTimeout(function(){' + nl +
    'loadIndex().then(function(list){' + nl +
    'if (si.value.toLowerCase().trim() !== q) return;' + nl +
    'var terms = q.split(/\\s+/).filter(Boolean);' + nl +
    // AND first, then OR fallback: a 4-word query like "roofing calculator squares shingles"
    // must not return nothing just because one term is absent from that tool's haystack.
    'var scored = [];' + nl +
    'for (var i = 0; i < list.length; i++) {' + nl +
    'var t = list[i], m = 0;' + nl +
    'for (var k = 0; k < terms.length; k++) { if (t.hay.indexOf(terms[k]) !== -1) m++; }' + nl +
    'if (m > 0) scored.push({ t: t, m: m, all: m === terms.length ? 1 : 0, ai: t.name.toLowerCase().indexOf(q) });' + nl +
    '}' + nl +
    'scored.sort(function(a, b) {' + nl +
    'if (a.all !== b.all) return b.all - a.all;' + nl +
    'if (a.m !== b.m) return b.m - a.m;' + nl +
    'var as = a.ai === -1 ? 1 : 0, bs = b.ai === -1 ? 1 : 0;' + nl +
    'if (as !== bs) return as - bs;' + nl +
    'if (a.ai !== b.ai) return a.ai - b.ai;' + nl +
    'return a.t.name.length - b.t.name.length;' + nl +
    '});' + nl +
    'renderOut(scored.map(function(s){ return s.t; }), q);' + nl +
    'if (!scored.length) nr.hidden = false;' + nl +
    '});' + nl +
    '}, 120);' + nl +
    '});' + nl +
    // BUG-315: accept ?q= so any other surface can deep-link into this search. Added for the 404
    // page, whose search box otherwise dropped the visitor back on a blank homepage. Dispatching
    // `input` reuses the handler above verbatim rather than duplicating the scoring logic.
    'try {' + nl +
    'var q0 = new URLSearchParams(location.search).get("q");' + nl +
    'if (q0) { si.value = q0; si.dispatchEvent(new Event("input")); }' + nl +
    '} catch (err) {}' + nl +
    '});' + nl +
    '</script>' + nl +
    '</div>' + nl +
    '</body>' + nl +
    '</html>';

  const html = head + main;

  // BUG-161: Return markdown variant for /.md or Accept: text/markdown requests.
  // Re-uses the same manifest data computed above so HTML and markdown stay in sync.
  if (_wantsMd) {
    const md = buildHomepageMarkdown(tools, HOMEPAGE_FAQS);
    const mdResponse = new Response(md, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Vary': 'Accept',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      }
    });
    await cache.put(cacheKey, mdResponse.clone());
    return mdResponse;
  }

  const response = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
      'X-Served-By': 'index.js'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
