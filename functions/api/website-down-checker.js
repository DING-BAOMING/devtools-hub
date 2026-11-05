// Website Down Checker API v1
// Makes a server-side HTTP request to check if a website is reachable
export async function onRequest(context) {
  var request = context.request;
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  var url = new URL(request.url);
  var targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'URL parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    new URL(targetUrl);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid URL format' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  var parsedUrl = new URL(targetUrl);
  var hostname = parsedUrl.hostname;
  if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0$|localhost$)/.test(hostname)) {
    return new Response(JSON.stringify({ error: 'Cannot check private/internal URLs' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  var startTime = Date.now();
  var result = { url: targetUrl, isUp: false, statusCode: 0, statusText: '', responseTime: 0, error: null };

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);

    var resp;
    try {
      resp = await fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'DevToolsHub-IsItDown/1.0',
          'Accept': '*/*'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    var elapsed = Date.now() - startTime;
    var code = resp.status;

    result.isUp = code >= 200 && code < 500;
    result.statusCode = code;
    result.statusText = resp.statusText;
    result.responseTime = elapsed;

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...headers } });
  } catch (e) {
    var elapsedErr = Date.now() - startTime;
    result.error = e.message || 'Request failed';
    result.responseTime = elapsedErr;
    result.isUp = false;
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...headers } });
  }
}
