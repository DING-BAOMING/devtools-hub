// BUG-356: the 5 top-level info pages ignored `Accept: text/markdown` while every tool page,
// `/` and `/tools/` have honoured it since BUG-109/161. Answering here is the one place that
// does not depend on how Pages routes a bare `/about` against functions/about/[path].js.
import { serveNegotiatedMarkdown } from '../libs/page-md.js';
// BUG-423: the 11 category pages are not in manifest.txt (it lists TOOLS), but their
// no-slash variant is a duplicate URL of the same page. This lib is the single source
// of truth for the category list, so the middleware reads it from here.
import { CAT_DESCRIPTIONS } from '../libs/category-copy.js';
// BUG-513: one manifest parser for every reader (libs/manifest.js).
import { parseManifest } from '../libs/manifest.js';

// Security headers middleware for all Cloudflare Pages Functions.
// Cloudflare Pages _headers file only applies to STATIC assets.
// Functions responses need this middleware to get the same protection.
//
// BUG-331: this copy of the policy is the one that reaches the browser for
// every tool page, so style-src here has to name every CDN that serves a
// stylesheet — _headers listing a host is not enough. `/tools/code-to-image/`
// pulls its highlight.js theme from cdnjs.cloudflare.com and it was silently
// blocked. test-scripts/bug331-csp-style-src-gate.mjs enumerates the
// stylesheet hosts out of the tool HTML and fails on the next one.

const CSP_DEFAULT = "default-src 'self'; media-src 'self' blob: data: https://storage.googleapis.com https://platform-outputs.agnes-ai.space https://api.dictionaryapi.dev; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://static.cloudflareinsights.com https://www.googletagmanager.com; worker-src 'self' blob: https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://cdnjs.cloudflare.com; img-src 'self' data: https: blob: https://covers.openlibrary.org https://platform-outputs.agnes-ai.space https://storage.googleapis.com https://www.google-analytics.com https://www.googletagmanager.com; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://fonts.gstatic.com; connect-src 'self' https://dns.google https://fonts.googleapis.com https://api.groq.com https://api.ipify.org https://ipapi.co https://ipinfo.io https://api.exchangerate-api.com https://integrate.api.nvidia.com https://cdn.jsdelivr.net https://unpkg.com https://api.open-meteo.com https://geocoding-api.open-meteo.com https://air-quality-api.open-meteo.com https://nominatim.openstreetmap.org https://api.siliconflow.cn https://static.cloudflareinsights.com https://cloudflareinsights.com https://deai.029101.xyz https://raw.githubusercontent.com https://openlibrary.org https://api.puter.com wss://api.puter.com https://apihub.agnes-ai.com https://api.cloudflare.com https://storage.googleapis.com https://platform-outputs.agnes-ai.space https://devtools-hub-api-proxy.bm-d.workers.dev https://api.dictionaryapi.dev https://api.datamuse.com https://vpic.nhtsa.dot.gov https://en.wikipedia.org https://registry.npmjs.org https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://www.googletagmanager.com https://www.google.com";

const CSP_UNSAFE_EVAL = "default-src 'self'; media-src 'self' blob: data: https://storage.googleapis.com https://platform-outputs.agnes-ai.space https://api.dictionaryapi.dev; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://static.cloudflareinsights.com https://www.googletagmanager.com; worker-src 'self' blob: https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://cdnjs.cloudflare.com; img-src 'self' data: https: blob: https://covers.openlibrary.org https://platform-outputs.agnes-ai.space https://storage.googleapis.com https://www.google-analytics.com https://www.googletagmanager.com; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://fonts.gstatic.com; connect-src 'self' https://dns.google https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://static.cloudflareinsights.com https://cloudflareinsights.com https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com https://www.googletagmanager.com https://www.google.com";

// Google Analytics 4 — web data stream "DevTools Hub" for tools.scoreroute.com
// (measurement ID below; created in the GA4 admin UI on 2026-11-05).
//
// Why the tag is injected here instead of in the 371 tool pages: this site has
// no template system — every tool page is a hand-written HTML file — so a tag
// added per page would be missing from every page written later and from the
// pages the Functions generate. The middleware is the one place every response
// already passes through, so the tag cannot drift.
//
// Consent Mode with every storage type denied is deliberate, not laziness:
// 306 pages of this site promise "no tracking cookies" and "no analytics that
// follow you across the web" (the copy is in the tool-page footers, the meta
// descriptions and /privacy/). GA4 in its default mode writes a `_ga` cookie,
// which would make every one of those claims false and would need a consent
// banner in the EU. With `analytics_storage: 'denied'` GA4 sends cookieless
// pings instead: no cookie is written, no cross-site identifier exists, and we
// still learn page views, paths and referrers — which is what the traffic
// phase needs. The privacy policy and the subprocessor list name GA4 for what
// it is (see privacy/index.html and subprocessors/index.html).
//
// The snippet is the two-tag form Google publishes: an async script from
// googletagmanager.com plus the inline bootstrap. 'unsafe-inline' is already in
// script-src, so the inline half is allowed.
//
// BUG-467 (2026-11-08): the CSP connect-src also has to allow https://www.google.com. The tag
// emits TWO collection beacons, and connect-src listed only the analytics hosts: the page_view
// beacon goes to www.google-analytics.com/g/collect (204, recorded) but the `user_engagement`
// event goes to www.google.com/g/collect, which the site's OWN policy then refused — a CSP
// violation logged on every page load, and a silently dropped slice of the GA4 event stream.
// Measured in a real browser before the fix: `www.google-analytics.com/g/collect` -> 204 while
// `www.google.com/g/collect` -> "Refused to connect because it violates ... connect-src". Found
// by bug353-md-page-size-prod-test.js tier [E]'s "0 uncaught JS errors" assertion, and the same
// class AGENTS.md warns about: a page that looks correctly instrumented and records nothing.
// Allowing the host the tag already talks to is behaviour-preserving; the alternative
// (gtag('set','allow_google_signals',false)) would change what GA4 reports and could not be
// verified from the served bytes.
// BUG-468 (2026-11-11): the CSP was asymmetric for the GA4 tag. script-src allowed
// https://www.googletagmanager.com, but connect-src did not — so the tag's own
// `www.googletagmanager.com/td` call was refused by the site's OWN policy:
// "Refused to connect because it violates the document's Content Security Policy",
// logged on every page load, and that slice of the event stream never left the
// browser. Google lists the exact hosts GA4 needs (developers.google.com/tag-
// platform/security/guides/csp): the gtag host has to be in script-src AND
// connect-src AND img-src. Only script-src had it.
// Measured in a real browser before the fix: fetching
// `https://www.googletagmanager.com/td?id=...` from a served page -> "Failed to
// fetch" (CSP blocked). After the fix the same fetch succeeds.
const GA4_MEASUREMENT_ID = 'G-Y3GSY75PBS';
const GA4_SNIPPET =
  '<script async src="https://www.googletagmanager.com/gtag/js?id=' + GA4_MEASUREMENT_ID + '"></script>' +
  '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}' +
  "gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});" +
  "gtag('js',new Date());gtag('config','" + GA4_MEASUREMENT_ID + "');</script>";

// Insert the GA4 tag into an HTML response, just before </head>.
//
// Only text/html is rewritten: the markdown mirrors (/x/.md), the OG images and
// every other asset must stay byte-identical. The response is rebuilt rather
// than streamed through HTMLRewriter because the middleware already computes a
// content-hash ETag over the body below — the tag has to be in that body, or
// the validator would describe a document the browser never receives.
//
// ETag and Last-Modified are dropped: both describe the pre-injection bytes,
// and a validator that does not match the body is worse than none. The
// middleware recomputes an ETag from the final body.
async function injectGA4(response) {
  const ct = (response.headers.get('Content-Type') || '').toLowerCase();
  if (response.status !== 200 || !ct.includes('text/html')) return response;
  let html;
  try {
    html = await response.clone().text();
  } catch (e) {
    return response;
  }
  if (html.includes(GA4_MEASUREMENT_ID)) return response;
  const headEnd = html.search(/<\/head>/i);
  if (headEnd === -1) return response;
  const injected = html.slice(0, headEnd) + GA4_SNIPPET + html.slice(headEnd);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  // The body we re-emit is plain text. If the upstream had announced an encoding,
  // leaving the header on would make the browser try to gunzip plain HTML.
  headers.delete('Content-Encoding');
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Paths that need eval() in Web Workers (e.g., code-runner sandbox)
const EVAL_PATHS = ['/tools/online-code-runner/'];

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // BUG-480: camera=(self) + microphone=(self). The site runs media/hardware tools that call
  // getUserMedia / getDisplayMedia (guitar-tuner, microphone-test, voice-recorder, audio-to-text,
  // barcode-scanner, qr-code-reader, face-age-estimator, webcam-test, screen-recorder). The
  // bootstrapping header set denied both features for every origin INCLUDING this one, so
  // getUserMedia rejected for every real visitor while every page still advertised the mic — the
  // headless inspector reported it as `[tool_error] No microphone found` twice, then escalated.
  // (self) keeps every third-party origin locked out (the only real isolation this header buys,
  // and the CSP already allows media-src 'self' blob: data:); a per-path allowlist is why
  // speaker-test and the next media tool would ship broken — no list, nothing to rot.
  'Permissions-Policy': 'accelerometer=(), camera=(self), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=(), interest-cohort=()',
};

// ponytail: explicit name set, not a regex — a filename *pattern* here would also
// 404 legitimate paths like /tools/json-formatter/. Add a name when a new secret
// file lands in the deploy root.
const SENSITIVE_NAMES = new Set([
  '.env', '.dev.vars', '.dev.vars.example', '.git', '.gitignore', '.ssh', 'package.json', 'package-lock.json', 'wrangler.toml',
]);

// BUG-423: the set of real tool slugs, read from manifest.txt (the source of truth
// for the tool list). Cached at module scope; a failed fetch is never cached, so one
// bad fetch cannot poison the isolate. Returns null when the manifest is
// unavailable — the caller then does NOT redirect (fail open, never redirect a
// slug it could not verify).
let _knownSlugs = null;
async function loadKnownSlugs(env, baseUrl) {
  if (_knownSlugs) return _knownSlugs;
  _knownSlugs = (async () => {
    const r = await env.ASSETS.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
    if (!r.ok) throw new Error('manifest ' + r.status);
    const text = await r.text();
    // BUG-513: one manifest parser for every reader (libs/manifest.js). This file
    // used to carry its own copy of the row contract.
    const slugs = new Set();
    for (const t of parseManifest(text)) {
      if (/^[a-z0-9-]+$/.test(t.slug)) slugs.add(t.slug);
    }
    return slugs;
  })();
  try {
    return await _knownSlugs;
  } catch (e) {
    _knownSlugs = null;
    return null;
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // BUG-304: the `_redirects` block for these paths was a silent no-op — Cloudflare
  // Pages `_redirects` supports 200/301/302/303/307/308 and NOT 404, so every rule
  // of the form "/.env /nonexistent-404 404" was dropped at parse time. /.env and
  // /package.json kept returning 200 with the real file, and a stale cached
  // /.env.tmp kept serving the live CLOUDFLARE_API_TOKEN (cache-control
  // s-maxage=604800, age ~12h). Middleware runs on /* (_routes.json) and runs
  // BEFORE the asset lookup, so returning here is the only layer that can stop it.
  for (const seg of url.pathname.split('/')) {
    const s = seg.toLowerCase();
    if (!SENSITIVE_NAMES.has(s) && !s.startsWith('.env.')) continue;
    return new Response('Not Found\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
    });
  }

  // BUG-430: /scripts/* and /libs/* were served as static assets with HTTP 200 — the deploy
  // script, the generator scripts and the shared library sources, readable by anyone and
  // crawlable junk. No secret is in them (the deploy gate refuses to ship a template file
  // that carries a value), but they are a free map of the deployment. One exception:
  // /libs/exercise-db.js is loaded by tools/workout-planner at runtime, so it stays.
  if (url.pathname.startsWith('/scripts/') ||
      (url.pathname.startsWith('/libs/') && url.pathname !== '/libs/exercise-db.js')) {
    return new Response('Not Found\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS },
    });
  }

  // BUG-487: the harness scripts came back as HTTP 200 with the real script body,
  // intermittently (about half the requests, depending on the edge PoP) and for
  // Googlebot too. The current deployment does NOT contain most of them — the deploy
  // gate parks them — but Cloudflare's edge still holds asset copies from the
  // deployments that shipped them before the gate did, and revalidating a copy
  // returns 304, so the stale copy is served instead of the 404. Crawlers indexed
  // those copies. Middleware runs before the asset lookup, so returning here ends it
  // for both the stale copies and the ones that would ship next. Same house pattern
  // as /scripts/ and /libs/ above.
  //
  // /api/test is in this list even though the Function that served it is gone: the
  // edge may still hold the old Function route, and an unauthenticated echo endpoint
  // that spends nothing is still one more public route to keep shut.
  const rootFile = url.pathname.slice(1);
  const isRootHarness = !rootFile.includes('/') &&
    (/^test-/.test(rootFile) || /-(test|gate)\.js$/.test(rootFile));
  if (url.pathname === '/api/test' ||
      url.pathname.startsWith('/test-scripts') ||
      url.pathname.startsWith('/test-results') ||
      isRootHarness) {
    return new Response('Not Found\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
    });
  }

  // BUG-422: /404 and /404.html ARE the 404 page, but Pages' asset resolution
  // served them with HTTP 200 — a soft 404 whose body says "not found" while the
  // status says "found". Google's soft-404 report was right. Only the STATUS is
  // wrong here: the body, the noindex meta and the deliberate absence of a
  // canonical all stay as they are. Pages' own fallback (unknown paths) already
  // answers 404; only the explicitly requested 404 document was broken.
  if (url.pathname === '/404' || url.pathname === '/404.html') {
    // /404.html is the real file; Pages' html-handling redirects /404.html -> /404 and
    // then serves the file with a 200. Only the STATUS is wrong, so the body is fetched
    // from the asset layer and re-emitted under 404.
    // ASSETS.fetch of a MISSING path SPA-falls-back to the HOMEPAGE with a 200 — the one
    // body that must never be served under a 404 status — so every candidate is checked
    // for the real 404 document before it is used.
    let body = null;
    for (const p of ['/404', '/404.html']) {
      const r = await context.env.ASSETS.fetch(new URL(p, url));
      const t = await r.text();
      if (/Page Not Found/i.test(t)) { body = t; break; }
    }
    if (body === null) {
      const t = await (await context.next()).text();
      if (/Page Not Found/i.test(t)) body = t;
    }
    if (body === null) body = 'Not Found\n';
    return new Response(body, {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Content-Security-Policy': CSP_DEFAULT,
        ...SECURITY_HEADERS,
      },
    });
  }

  // BUG-423: /tools/<slug> and /tools/<slug>/ are the same page under two URLs.
  // The catchall serves both with byte-identical bodies, and the canonical tag
  // already named the slashed form — so every one of the 371 tools had a second
  // indexable URL that Google had to fetch and then discard. 308 (not 301) keeps
  // the method and the cache semantics, and the charset excludes dots, so the
  // .md mirrors (/tools/x.md, /tools/x/.md) and /tools/index.html are untouched.
  //
  // Only slugs that really exist are redirected: a legacy alias keeps its own 301
  // and an unknown slug keeps its 404. Existence is decided from manifest.txt (the
  // source of truth for the tool list) plus the category list in libs/category-copy.js.
  const toolSlug = url.pathname.match(/^\/tools\/([a-z0-9-]+)$/);
  if (toolSlug) {
    const slug = toolSlug[1];
    const known = await loadKnownSlugs(context.env, url);
    if (known && (known.has(slug) || Object.prototype.hasOwnProperty.call(CAT_DESCRIPTIONS, slug))) {
      return new Response(null, {
        status: 308,
        headers: {
          'Location': url.pathname + '/' + url.search,
          'Cache-Control': 'public, max-age=3600',
          ...SECURITY_HEADERS,
        },
      });
    }
  }

  // BUG-429: /tools and /whats-new answer with byte-identical bodies to /tools/ and
  // /whats-new/, so each is a second indexable URL for one page — the duplicate BUG-423
  // closed for the 371 tool pages. The canonical tag of both pages names the slashed
  // form, so the redirect sends every crawler to the URL the page itself claims.
  // (Pages already 308s /about, /privacy, /contact and /subprocessors because they are
  // static files; these two are Functions, so Pages does not.)
  if (url.pathname === '/tools' || url.pathname === '/whats-new') {
    return new Response(null, {
      status: 308,
      headers: {
        'Location': url.pathname + '/' + url.search,
        'Cache-Control': 'public, max-age=3600',
        ...SECURITY_HEADERS,
      },
    });
  }

  let response = (await serveNegotiatedMarkdown(context)) || (await context.next());
  try {
    // GA4 tag first, so the content-hash ETag below describes the bytes the
    // browser actually receives (tag included) instead of the pre-injection body.
    response = await injectGA4(response);
  } catch (e) {
    // Best-effort: a failed injection must never fail the page.
  }
  try {
    const needsEval = EVAL_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p));
    const h = response.headers;

    // The per-page machine-readable mirrors (`/x/.md`) and the per-tool OG images
    // (`/api/og/<slug>.svg`) are an API surface for AI agents, not pages to rank.
    // They were listed in sitemap.xml, which made 684 of 1037 sitemap URLs (66%)
    // non-HTML documents and invited the index to hold a text mirror of every tool
    // page. Bing Webmaster Guidelines §3 says a sitemap should "list only canonical
    // URLs" and §6 asks you to consolidate duplicate URLs; §21 is about crawl waste.
    // noindex,follow keeps them fully fetchable by crawlers and agents (discovery
    // comes from llms.txt and /.well-known/agent-skills/, not from the sitemap)
    // while keeping them out of the index. One choke point covers all 7 handlers
    // that emit markdown and any future one.
    const p = url.pathname;
    const isAuxMirror = p.endsWith('.md') || p.startsWith('/api/og/');
    if (isAuxMirror && !h.has('X-Robots-Tag')) {
      h.set('X-Robots-Tag', 'noindex, follow');
    }

    if (!h.has('Content-Security-Policy')) {
      h.set('Content-Security-Policy', needsEval ? CSP_UNSAFE_EVAL : CSP_DEFAULT);
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!h.has(name)) h.set(name, value);
    }

    // BUG-404: the validator must be content-derived, not URL+date-stamped — a daily stamp
    // leaves the tag stable across a same-day content change, so a client holding a 304 would
    // re-serve the pre-fix body. Hash the body (SHA-1) and emit a weak validator.
    if (context.request.method !== 'HEAD' && !h.has('ETag') && !h.has('Last-Modified') && response.status === 200) {
      const body = await response.clone().text();
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
      const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      h.set('ETag', 'W/"' + hex + '"');

      // A validator nobody can revalidate against is half a fix: RFC 9110 §13.1.3 requires a
      // server to EVALUATE If-None-Match on GET/HEAD, and §15.4.5 says the answer is 304.
      // Without this the tag was decoration — every repeat visit still downloaded the whole
      // body, because the origin never answered 304.
      // Weak comparison (RFC 9110 §8.8.3.2): `W/"x"` and `"x"` are the same validator.
      const inm = context.request.headers.get('If-None-Match');
      if (inm) {
        const tags = inm.split(',').map((t) => t.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1'));
        if (tags.includes(hex) || tags.includes('*')) {
          const h304 = new Headers(h);
          h304.delete('Content-Length');
          h304.delete('Content-Type');
          h304.delete('Content-Encoding');
          return new Response(null, { status: 304, headers: h304 });
        }
      }
    }
  } catch (e) {
    // Best-effort: never block the response on header injection failure
  }
  return response;
}