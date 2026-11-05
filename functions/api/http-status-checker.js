// HTTP Status & Header Checker v1
// Proxies HTTP requests to avoid CORS, returns status code, headers, redirect chain, timing
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

  // Validate URL
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    new URL(targetUrl);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid URL format' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  // Block private/internal IPs
  var parsedUrl = new URL(targetUrl);
  var hostname = parsedUrl.hostname;
  if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0$|localhost$)/.test(hostname)) {
    return new Response(JSON.stringify({ error: 'Cannot check private/internal URLs' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  var redirectChain = [];
  var startTime = Date.now();
  var finalResponse = null;
  var maxRedirects = 10;
  var currentUrl = targetUrl;

  try {
    for (var i = 0; i <= maxRedirects; i++) {
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 15000);

      var resp;
      try {
        resp = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'DevToolsHub-HTTP-Status-Checker/1.0',
            'Accept': '*/*'
          }
        });
      } finally {
        clearTimeout(timeout);
      }

      var respHeaders = {};
      resp.headers.forEach(function(value, key) {
        respHeaders[key] = value;
      });

      var step = {
        url: currentUrl,
        statusCode: resp.status,
        statusText: resp.statusText
      };
      redirectChain.push(step);

      // Check for redirect
      var location = resp.headers.get('location');
      var isRedirect = resp.status >= 300 && resp.status < 400 && resp.status !== 304 && location;

      if (isRedirect && i < maxRedirects) {
        // Resolve relative redirect
        try {
          currentUrl = new URL(location, currentUrl).href;
        } catch (e) {
          // Invalid redirect URL - stop here
          finalResponse = {
            url: currentUrl,
            statusCode: resp.status,
            statusText: resp.statusText,
            headers: respHeaders,
            httpVersion: resp.httpVersion || 'HTTP/1.1',
            finalUrl: currentUrl,
            rawHeaders: formatRawHeaders(respHeaders)
          };
          break;
        }
      } else {
        // Final response
        var contentLength = resp.headers.get('content-length');
        finalResponse = {
          url: currentUrl,
          statusCode: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
          finalUrl: currentUrl,
          contentLength: contentLength ? parseInt(contentLength) : null,
          rawHeaders: formatRawHeaders(respHeaders),
          redirectCount: redirectChain.length - 1
        };
        break;
      }
    }

    var elapsed = Date.now() - startTime;

    if (!finalResponse) {
      return new Response(JSON.stringify({ error: 'Too many redirects or request failed', redirectChain: redirectChain }), { headers: { 'Content-Type': 'application/json', ...headers } });
    }

    var result = {
      url: targetUrl,
      finalUrl: finalResponse.finalUrl,
      statusCode: finalResponse.statusCode,
      statusText: finalResponse.statusText,
      headers: finalResponse.headers,
      contentLength: finalResponse.contentLength,
      responseTime: elapsed,
      redirectChain: redirectChain,
      redirectCount: redirectChain.length - 1,
      rawHeaders: finalResponse.rawHeaders
    };

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...headers } });
  } catch (e) {
    var elapsedErr = Date.now() - startTime;
    return new Response(JSON.stringify({
      error: e.message || 'Request failed',
      responseTime: elapsedErr,
      redirectChain: redirectChain
    }), { headers: { 'Content-Type': 'application/json', ...headers } });
  }
}

function formatRawHeaders(headers) {
  var lines = [];
  for (var key in headers) {
    lines.push(key + ': ' + headers[key]);
  }
  return lines.join('\n');
}
