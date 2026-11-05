// BUG-161: Serve markdown variant of the homepage at /.md.
// Cloudflare Pages Functions routes /<file> (single segment) to functions/[file].js,
// so this matches the URL /.md where file = ".md". All other single-segment paths
// (like /favicon.ico handled by static, or unrecognized paths) fall through to
// context.next() to keep static-asset behavior intact.
// Fixes Warning 2/15 markdown-url-support 9/10 -> 10/10 (was failing on / and /tools/).
//
// BUG-353: this file used to carry its own ~120-line copy of the homepage markdown builder,
// despite the comment it shipped with promising "to avoid duplicating ~120 lines of markdown
// construction, we proxy to /?_md=1". Two builders for one URL is BUG-114's shape, and it had
// already drifted: this one emitted `## All Tools (alphabetical)` while functions/index.js
// emitted `## All Tools (alphabetical, page 1)` from the same working tree. Both now call
// buildHomepageMarkdown() from ./index.js, so /.md and /?_md=1 cannot disagree again.
//
// BUG-182: HEAD is answered here, not downstream. Without it `HEAD /.md` returned HTTP 500,
// because the GET body constructor throws on an empty response — the exact defect BUG-182 fixed
// in /tools/.md, on the one URL an audit bot is guaranteed to probe.
import { buildHomepageMarkdown, homepageFaqs } from './index.js';

const MD_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Vary': 'Accept',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

export async function onRequest(context) {
  const file = context.params.file;

  // Only handle literal .md at root. Everything else falls through to static assets.
  if (file !== '.md') {
    return context.next();
  }

  if (context.request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: MD_HEADERS });
  }

  // BUG-161: Accept-header content negotiation — same caching pattern as about/[path].js
  const _accept = context.request.headers.get('Accept') || '';
  const _prefersMd = _accept.includes('text/markdown') && !_accept.includes('text/html');
  const _cacheUrl = _prefersMd ? context.request.url + '?__accept=md' : context.request.url;
  const cache = caches.default;
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
    for (const line of manifest.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|');
      if (parts.length < 6) continue;
      tools.push({
        slug: parts[0].trim(),
        category: (parts[1] || 'other').trim(),
        featured: (parts[2] || '').trim() === 'yes',
        isnew: (parts[3] || '').trim() === 'yes',
        name: (parts[4] || '').trim(),
        desc: (parts[5] || '').trim(),
        tags: (parts[6] || '').split(',').map(s => s.trim()).filter(Boolean)
      });
    }
  } catch (e) {
    return new Response('Manifest error: ' + e.message, { headers: { 'Content-Type': 'text/plain' } });
  }

  const md = buildHomepageMarkdown(tools, homepageFaqs(tools.length));

  const response = new Response(md, { headers: MD_HEADERS });
  await cache.put(cacheKey, response.clone());
  return response;
}
