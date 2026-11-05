// Dynamic sitemap - reads /manifest.txt, generates all tool + category URLs
// Single source of truth: manifest.txt

export async function onRequest(context) {
  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);
  const tools = new Set();
  const categories = new Set();
  // SEO-P3: tools the manifest marks featured get a higher <priority>. The flag is already in
  // manifest.txt (field 3), so this adds no second source of truth.
  const featured = new Set();
  const CAT_NAMES = ['formatters','calculators','generators','converters','media','network','code-testing','pdf-tools','life','finance','ai-language'];
  // BUG-300: only about/privacy/contact have a functions/<page>/[path].js markdown
  // handler; /subprocessors/.md and /whats-new/.md had none, which used to matter
  // because the `.md` variants were listed here, so a missing handler meant the
  // sitemap advertised a soft-404 (HTTP 200 with the homepage's HTML).
  // BUG-349 (2026-10-14): all five now serve a real markdown mirror
  // (libs/page-md.js, shared by the four static pages; /whats-new/ builds its own),
  // so this list is again "every URL here has a working .md". The `.md` URLs stay
  // OUT of this sitemap (noindex mirrors, see the AUDIT-2026-10-07 note below).
  const TOP_PAGES = ['about', 'privacy', 'contact', 'subprocessors', 'whats-new'];

  try {
    const mr = await assets.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
    if (!mr.ok) throw new Error('Manifest ' + mr.status);
    const manifest = await mr.text();
    for (const line of manifest.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const p = t.split('|');
      if (p.length < 2) continue;
      const slug = p[0].trim();
      const cat = p[1].trim();
      if (slug) tools.add(slug);
      if (cat && CAT_NAMES.includes(cat)) categories.add(cat);
      if (slug && p[2] && p[2].trim().toLowerCase() === 'yes') featured.add(slug);
    }
  } catch (e) {
    // BUG-289: do not echo the raw error into a crawler-facing response.
    console.error('sitemap.xml failed: ' + (e && e.message));
    return new Response('Sitemap temporarily unavailable', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const base = 'https://tools.scoreroute.com';

  // BUG-303: top-level static pages get their REAL dateModified instead of the build
  // date. Audit rule crawl/sitemap-lastmod-drift: all URLs were stamped `today` while
  // /contact/ reports dateModified 2026-08-24, so Google was told an unchanged page
  // changed daily. Read the date out of the page's own JSON-LD rather than keeping a
  // table here, so the sitemap cannot drift from the page again.
  //
  // The canonical check is load-bearing, not belt-and-braces: a page with no
  // static file (/whats-new/ is a Function) makes assets.fetch fall through to
  // the SPA fallback, which answers 200 with the HOMEPAGE html. Trusting r.ok
  // there stamped /whats-new/ with the homepage's dateModified — the same drift,
  // reversed. Each real page names itself in its canonical, so only accept a
  // date from html that actually belongs to this URL.
  const mod = { };
  await Promise.all(TOP_PAGES.map(async (p) => {
    try {
      const r = await assets.fetch(new URL('/' + p + '/index.html?cb=' + Date.now(), baseUrl));
      if (!r.ok) return;
      const html = await r.text();
      if (!html.includes('href="' + base + '/' + p + '/"')) return;
      const m = html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
      if (m) mod[p] = m[1];
    } catch (e) { /* keep unknown */ }
  }));
  const lastmod = (p) => mod[p] || '';

  // BUG-375: tool URLs get their REAL last edit date from /tool-dates.json, the same map
  // patchToolHtml serves as the page's dateModified — page and sitemap cannot disagree.
  // Slugs without a map entry emit no `<lastmod>` (it is optional; absent beats wrong).
  // Missing/unparseable map = no tool lastmod at all, not a failed sitemap.
  let toolMod = {};
  try {
    const dr = await assets.fetch(new URL('/tool-dates.json?cb=' + Date.now(), baseUrl));
    if (dr.ok) toolMod = await dr.json();
  } catch (e) { /* no map, no lastmod */ }

  // AUDIT-2026-10-07: the per-page `.md` mirrors and the per-tool OG `.svg` images used to
  // be listed here as separate URLs. That put 684 non-HTML documents into a 1037-URL sitemap
  // (66%) and invited the index to keep a text mirror of every tool page. Bing Webmaster
  // Guidelines §3: a sitemap should "list only canonical URLs"; §6: consolidate duplicate URLs;
  // §21: reduce crawl waste. They stay fully published and discoverable via llms.txt and
  // /.well-known/agent-skills/ (350 and 335 references respectively) and now carry
  // `X-Robots-Tag: noindex, follow` from functions/_middleware.js. Agent discovery is
  // unaffected; only indexing of the duplicate representation is suppressed.
  //
  // BUG-333 (2026-10-12): every tool and category URL used to be stamped `today` on every
  // regeneration — 357 of 361 URLs. Google uses `<lastmod>` only "if it's consistently and
  // verifiably (for example by comparing to the last modification of the page) accurate"
  // (developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap, read
  // 2026-10-12), and Bing asks for "accurate lastmod values" (blogs.bing.com/webmaster,
  // 2025-10-15). A value that moves daily for an unchanged page fails both conditions, so
  // it is worse than absent. `<lastmod>` is optional in the sitemaps protocol: emit it only
  // where the date is real. The per-URL "this one actually changed" signal lastmod was
  // standing in for is delivered truthfully by IndexNow on every deploy.
  const url = (loc, mod, freq, pri) =>
    '  <url>\n    <loc>' + loc + '</loc>\n' +
    (mod ? '    <lastmod>' + mod + '</lastmod>\n' : '') +
    '    <changefreq>' + freq + '</changefreq>\n    <priority>' + pri + '</priority>\n  </url>\n';

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += url(base + '/', '', 'weekly', '1.0');
  // SEO-P3 (2026-11-04): <priority> is layered instead of flat 0.8 — homepage 1.0, category
  // 0.9, manifest-featured tools 0.8, everything else 0.6. The signal is weak (Google mostly
  // ignores priority) but it is free and it now says something true: the flat 0.8 claimed every
  // one of the 371 pages was equally important. NO URL was removed: the sitemap was never
  // submitted to Search Console, so it is the site's only discovery channel for 47 URLs that
  // Google has never heard of — dropping URLs would deepen the hole.
  for (const slug of [...tools].sort()) {
    xml += url(base + '/tools/' + slug + '/', toolMod[slug] || '', 'monthly', featured.has(slug) ? '0.8' : '0.6');
  }
  for (const cat of [...categories].sort()) {
    xml += url(base + '/tools/' + cat + '/', '', 'weekly', '0.9');
  }
  for (const top of TOP_PAGES) {
    xml += url(base + '/' + top + '/', lastmod(top), 'monthly', '0.6');
  }
  // Special pages that are not in manifest.txt but should be in sitemap.
  // BUG-302 (2026-10-01): /tools/feedback/ was hardcoded here AND is a manifest
  // slug, so the tool loop above already emitted it — the sitemap listed it twice
  // (685 URLs, 684 unique). Skip anything the manifest already covers.
  xml += url(base + '/tools/', '', 'weekly', '0.9');
  if (!tools.has('feedback')) {
    xml += url(base + '/tools/feedback/', '', 'monthly', '0.5');
  }
  xml += '</urlset>';

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
