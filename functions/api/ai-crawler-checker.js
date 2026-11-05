import { audit, isValidDomain, normalizeDomain } from '../../libs/ai-crawl-audit.js';

const UA = 'Mozilla/5.0 (compatible; DevToolsHub-AI-Crawler-Audit/1.0; +https://tools.scoreroute.com/tools/ai-crawler-checker/)';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 300000;

// status 0 = could not be retrieved at all (DNS failure, TLS error, timeout)
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/plain,text/markdown,text/html;q=0.6,*/*;q=0.4' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) return { status: res.status, text: '', type };
    const text = await res.text();
    return { status: res.status, text: text.slice(0, MAX_BYTES), type };
  } catch (e) {
    return { status: 0, text: '', type: '', error: e && e.name === 'AbortError' ? 'Timed out after ' + TIMEOUT_MS / 1000 + 's' : (e && e.message) || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Some sites only answer on one scheme; try the other before calling it unreachable.
async function fetchEither(httpUrl, httpsUrl) {
  const first = await fetchText(httpsUrl);
  if (first.status !== 0) return first;
  const second = await fetchText(httpUrl);
  return second.status !== 0 ? second : first;
}

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }
  if (context.request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Use GET' }), { status: 405, headers });
  }

  try {
    const domain = normalizeDomain(new URL(context.request.url).searchParams.get('domain'));
    if (!domain) {
      return new Response(JSON.stringify({ error: 'Enter a public domain such as example.com. Private hosts and IP addresses are not accepted.' }), { status: 400, headers });
    }

    const [robots, llms, llmsFull, home] = await Promise.all([
      fetchEither('http://' + domain + '/robots.txt', 'https://' + domain + '/robots.txt'),
      fetchEither('http://' + domain + '/llms.txt', 'https://' + domain + '/llms.txt'),
      fetchEither('http://' + domain + '/llms-full.txt', 'https://' + domain + '/llms-full.txt'),
      fetchEither('http://' + domain + '/', 'https://' + domain + '/'),
    ]);

    const report = audit({
      domain,
      robotsTxt: robots.text,
      robotsStatus: robots.status,
      robotsType: robots.type,
      llmsTxt: llms.text,
      llmsStatus: llms.status,
      llmsType: llms.type,
      llmsFullStatus: llmsFull.status,
      homepageHtml: home.status === 200 ? home.text : '',
      homeStatus: home.status,
    });

    return new Response(JSON.stringify(Object.assign(report, {
      reachable: report.domainResolves,
      probeErrors: {
        robots: robots.error || null,
        llms: llms.error || null,
        llmsFull: llmsFull.error || null,
        home: home.error || null,
      },
      validInput: isValidDomain(domain),
    })), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e && e.message) || 'Audit failed' }), { headers, status: 500 });
  }
}
