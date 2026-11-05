// Single-page technical SEO audit. Input: any public page URL.
//
// Two fetches, no more: the page, and robots.txt on the same origin. Everything else is parsed
// from those two. SSRF guard is normalizeDomain() from libs/ai-crawl-audit.js — the same guard
// sitemap-audit and ai-crawler-checker use, so one host name cannot be probed privately through
// one tool and publicly through another.
import { normalizeDomain } from '../../libs/ai-crawl-audit.js';
import { auditPage } from '../../libs/seo-audit.js';

const UA = 'Mozilla/5.0 (compatible; DevToolsHub-SEO-Checker/1.0; +https://tools.scoreroute.com/tools/seo-checker/)';
const TIMEOUT_MS = 9000;
const MAX_BYTES = 500000;

async function fetchRaw(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // redirect: 'manual' on every request. Following a hop would let a public host bounce us to
    // a private address, and a redirect is itself a finding worth showing rather than hiding.
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept }, redirect: 'manual', signal: controller.signal });
    return { status: res.status, location: res.headers.get('location'), type: (res.headers.get('content-type') || '').toLowerCase(), xRobotsTag: res.headers.get('x-robots-tag'), res, error: null };
  } catch (e) {
    return { status: 0, location: null, type: '', xRobotsTag: null, res: null, error: e && e.name === 'AbortError' ? 'timed out after ' + TIMEOUT_MS / 1000 + 's' : (e && e.message) || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, max) {
  if (!res || !res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    while (total < max) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
      total += chunk.value.length;
    }
  } catch (e) { /* a truncated body is fine: the audit reads the head and the first pass of <body> */ }
  try { await reader.cancel(); } catch (e) { /* already closed */ }
  return out;
}

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (context.request.method !== 'GET') return new Response(JSON.stringify({ error: 'Use GET' }), { status: 405, headers });

  try {
    const raw = String(new URL(context.request.url).searchParams.get('url') || '').trim();
    if (!raw) return new Response(JSON.stringify({ error: 'Enter the address of the page you want checked.' }), { status: 400, headers });

    const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    let parsed;
    try { parsed = new URL(withScheme); } catch (e) { parsed = null; }
    if (!parsed) return new Response(JSON.stringify({ error: 'That does not parse as a URL.' }), { status: 400, headers });
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'Only http and https addresses can be checked.' }), { status: 400, headers });
    }

    // SSRF guard: rejects IP literals, bare hostnames and private suffixes. Everything fetched
    // below is on this one host or a validated redirect target, so one check covers the run.
    const domain = normalizeDomain(parsed.hostname);
    if (!domain) return new Response(JSON.stringify({ error: 'Enter a public web address such as example.com/page. Private hosts, IP addresses and local names are not accepted.' }), { status: 400, headers });

    const origin = parsed.protocol + '//' + domain;
    const started = Date.now();

    // robots.txt first: it is small, it never times out in practice, and having it in hand makes
    // every indexability verdict complete rather than provisional.
    const robotsProbe = await fetchRaw(origin + '/robots.txt', 'text/plain,*/*;q=0.5');
    const robotsTxt = robotsProbe.status === 200 ? (await readCapped(robotsProbe.res, 200000)).slice(0, 200000) : '';

    const first = await fetchRaw(withScheme, 'text/html,application/xhtml+xml,*/*;q=0.5');
    let page = first;
    let redirectStatus = null;
    let finalUrl = withScheme;

    // Exactly one hop, and only to a host that passes the same guard. Most sites redirect the
    // bare host to www or to https; refusing to follow would report "unreachable" on a large
    // share of healthy sites. The hop is reported, never hidden.
    if (first.status >= 300 && first.status < 400 && first.location) {
      let target;
      try { target = new URL(first.location, withScheme).toString(); } catch (e) { target = null; }
      if (target && normalizeDomain(new URL(target).hostname) === domain) {
        const second = await fetchRaw(target, 'text/html,application/xhtml+xml,*/*;q=0.5');
        if (second.status !== 0) {
          redirectStatus = first.status;
          finalUrl = target;
          page = second;
        }
      }
    }

    const html = page.status === 200 ? (await readCapped(page.res, MAX_BYTES)) : '';
    const result = auditPage({
      url: withScheme,
      finalUrl,
      domain,
      status: page.status,
      redirectStatus,
      contentType: page.type,
      xRobotsTag: page.xRobotsTag,
      fetchError: page.error,
      html,
      bytes: html.length,
      elapsedMs: Date.now() - started,
      robotsTxt,
      robotsStatus: robotsProbe.status,
    });

    return new Response(JSON.stringify(result), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e && e.message) || 'Audit failed' }), { headers, status: 500 });
  }
}
