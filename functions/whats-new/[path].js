// BUG-349: serve /whats-new/.md (markdown mirror) for AI agents.
//
// W5 (`agentimization/markdown-url-support`, "9/10 sampled pages support .md URLs")
// and W2 (`llms-txt-freshness`, "2 sitemap pages not in llms.txt") both came from
// these two pages: /subprocessors/ and /whats-new/ are in sitemap.xml but had no
// `.md` route, so the request fell through to the SPA index.html fallback and
// answered HTTP 200 with the HOMEPAGE's html — a soft-404 in the one slot an agent
// expects text/markdown from (BUG-225/227 family). /subprocessors/.md is handled by
// libs/page-md.js via functions/subprocessors/[path].js; this page cannot use that
// path because its HTML is generated here, not by a static file.
//
// The self-fetch below is deliberate and NOT the BUG-303 trap: `context.env.ASSETS`
// only reaches static assets, and /whats-new/ has no static file, so ASSETS.fetch
// would answer 200 with the HOMEPAGE html and this mirror would publish the homepage
// under /whats-new/.md. Fetching the public URL instead goes through this same
// Function, which renders the real page (and serves it from caches.default).
import { pageToMarkdown } from '../../libs/page-md.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if ((context.params.path || '') !== '.md') return context.next();

  const headers = {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };

  // BUG-168: audit bots probe with HEAD; an empty body must not reach the constructor.
  if (context.request.method === 'HEAD') return new Response(null, { status: 200, headers });

  const cache = caches.default;
  const cacheKey = new Request(context.request.url, context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const page = await fetch(new URL('/whats-new/', url), { headers: { 'Accept': 'text/html' } });
  if (!page.ok) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

  // The converter is the shared one, so the mirrors of the info pages and of this
  // page cannot drift into two different prose styles.
  const md = pageToMarkdown(await page.text(), "What's New", '/whats-new/');

  const response = new Response(md, { headers });
  await cache.put(cacheKey, response.clone());
  return response;
}
