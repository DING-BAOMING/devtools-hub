// BUG-349: one implementation of "serve the markdown mirror of a static info page".
//
// BUG-114 wrote this handler three times (functions/about/[path].js,
// functions/privacy/[path].js, functions/contact/[path].js) — ~130 lines each,
// differing only in the title and the path. W5 (`agentimization/markdown-url-support`,
// "9/10 sampled pages support .md URLs") is what that duplication caused: /subprocessors/
// is in the sitemap but had no handler at all, so it fell through to the static
// index.html fallback and answered HTTP 200 with the HOMEPAGE html — a soft-404 in
// the exact slot an agent expects text/markdown from (BUG-225/227 family).
//
// `libs/` is the shared layer (see AGENTS.md); the per-page Function is now three lines.
// A page is only eligible here if it has a real STATIC file — `assets.fetch` cannot
// reach another Function, so a Function-rendered page (e.g. /whats-new/) must build its
// own markdown and must NOT be added to a functions/<page>/[path].js handler.

const BASE = 'https://tools.scoreroute.com';

// BUG-351: the page converter below used to carry its OWN copy of the html→markdown
// extraction (p / ul / details only), which is why /whats-new/.md and /contact/.md had
// lost their tables, prose-in-<div> and unwrapped lists. It now calls the same
// libs/html-md.js converter the tool pages use — one implementation, so the two surfaces
// cannot drift again the way BUG-114's three copied handlers did.
import { htmlToMarkdownBody, stripHtml, BLANK_SUBTREES } from './html-md.js';

export function pageToMarkdown(raw, title, pagePath) {
  // BUG-349: blank script/style bodies BEFORE the h1 regex — /whats-new/'s <style> block
  // carries a CSS comment quoting an <h1>, which is how its mirror once opened with
  // "# DevTools Hub". htmlToMarkdownBody blanks them too; this is for the header lines.
  const rawHtml = raw.replace(BLANK_SUBTREES, ' ');
  const h1Match = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let h1 = title;
  if (h1Match) h1 = stripHtml(h1Match[1]);
  const subMatch = rawHtml.match(/<p[^>]*class=["'][^"']*subtitle[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  const subtitle = subMatch ? stripHtml(subMatch[1]) : '';

  let md = '# ' + h1 + '\n\n';
  if (subtitle && subtitle !== h1) md += '> ' + subtitle + '\n\n';
  md += 'URL: ' + BASE + pagePath + '\n\n';
  md += 'Markdown: ' + BASE + pagePath + '.md\n\n';
  return md + htmlToMarkdownBody(rawHtml);
}

const MD_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Vary': 'Accept',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// `context.next()` for anything that is not this page's own `.md`, so the static HTML
// file and every other subpath keep working exactly as before.
export async function servePageMarkdown(context, { title, pagePath }) {
  const url = new URL(context.request.url);
  if ((context.params.path || '') !== '.md') return context.next();

  // BUG-168: HEAD returns 200 with the same headers and no body — audit bots probe
  // with HEAD, and the GET body constructor on an empty response throws.
  if (context.request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: MD_HEADERS });
  }

  // BUG-109: Accept-header content negotiation (same caching pattern as the tools).
  const accept = context.request.headers.get('Accept') || '';
  const prefersMd = accept.includes('text/markdown') && !accept.includes('text/html');
  const cache = caches.default;
  const cacheKey = new Request(prefersMd ? context.request.url + '?__accept=md' : context.request.url, context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const resp = await context.env.ASSETS.fetch(new URL(pagePath, url));
  if (!resp.ok) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const md = pageToMarkdown(await resp.text(), title, pagePath);

  const response = new Response(md, { headers: MD_HEADERS });
  await cache.put(cacheKey, response.clone());
  return response;
}

// BUG-356: the top-level info pages answered `Accept: text/markdown` with HTML.
// `/`, `/tools/` and all 346 tool pages have negotiated since BUG-109/161, and MD_HEADERS
// advertises `Vary: Accept` — but /about/ /privacy/ /subprocessors/ /whats-new/ /contact/ did
// not, so the 5 pages llms.txt links as plain URLs were the only sitemap URLs an agent could
// not read as markdown. W5 `agentimization/markdown-url-support` ("9/10 sampled pages
// support .md URLs") was logged as "1 page unidentified" because only the `/x/.md` form was
// probed; measured over all 364 sitemap URLs the gap is exactly these 5.
//
// Entry point is _middleware.js, not functions/<page>/[path].js: middleware runs on /*
// (_routes.json) before the asset lookup, so this does not depend on whether a single-bracket
// `[path]` route matches the bare `/about`. Same reason BUG-301's guard lives there.
const NEGOTIATED_PAGES = new Set(['/about/', '/privacy/', '/subprocessors/', '/contact/', '/whats-new/']);
// No static file: ASSETS.fetch answers 200 with the HOMEPAGE html (BUG-303), so this page's
// html has to come from its own Function — the same call functions/whats-new/[path].js makes.
const FUNCTION_RENDERED = new Set(['/whats-new/']);

// One predicate, so this surface cannot drift from the tools' (BUG-109's rule).
export function prefersMarkdown(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/markdown') && !accept.includes('text/html');
}

// Returns a Response to serve instead of running the normal pipeline, or null to carry on.
export async function serveNegotiatedMarkdown(context) {
  const url = new URL(context.request.url);
  const pagePath = url.pathname.replace(/\/?$/, '/');
  if (!NEGOTIATED_PAGES.has(pagePath) || !prefersMarkdown(context.request)) return null;

  // BUG-168: HEAD must not reach the body constructor — workerd rejects it with a 500,
  // which a link checker reads as a dead URL.
  if (context.request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: MD_HEADERS });
  }

  const cache = caches.default;
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set('__accept', 'md');
  const cacheKey = new Request(cacheUrl.href, context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const src = FUNCTION_RENDERED.has(pagePath)
    ? fetch(new URL(pagePath, url), { headers: { Accept: 'text/html' } })
    : context.env.ASSETS.fetch(new URL(pagePath, url));
  const res = await src;
  if (!res.ok) return null;

  // pagePath as the title is only a fallback: pageToMarkdown prefers the page's own <h1>,
  // so no second copy of these five titles exists here.
  const response = new Response(pageToMarkdown(await res.text(), pagePath, pagePath), { headers: MD_HEADERS });
  await cache.put(cacheKey, response.clone());
  return response;
}
