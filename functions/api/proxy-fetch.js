// REST API Tester - Generic HTTP Proxy v1
// Proxies arbitrary HTTP requests to avoid CORS restrictions
export async function onRequest(context) {
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  try {
    var body = await context.request.json();
    var targetUrl = body.url;
    var method = (body.method || 'GET').toUpperCase();
    var reqHeaders = body.headers || {};
    var reqBody = body.body || null;
    var followRedirect = body.followRedirect !== false;

    if (!targetUrl || typeof targetUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'URL field required' }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    var parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL format' }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    var hostname = parsedUrl.hostname;
    if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0$|localhost$)/.test(hostname)) {
      return new Response(JSON.stringify({ error: 'Cannot request private/internal URLs' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Block dangerous ports
    var port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    var blockedPorts = { '21': true, '22': true, '23': true, '25': true, '53': true, '110': true, '135': true, '139': true, '143': true, '445': true, '1433': true, '1521': true, '2049': true, '3306': true, '3389': true, '5432': true, '6379': true, '8080': true, '8443': true, '27017': true };
    if (blockedPorts[port]) {
      return new Response(JSON.stringify({ error: 'Port ' + port + ' is blocked for security reasons' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    var fetchOptions = {
      method: method,
      redirect: followRedirect ? 'follow' : 'manual',
      headers: { 'User-Agent': 'DevToolsHub-API-Tester/1.0 (https://tools.scoreroute.com)', 'Accept': '*/*' }
    };

    // Add user-specified headers
    for (var key in reqHeaders) {
      if (reqHeaders.hasOwnProperty(key) && reqHeaders[key]) {
        var lowerKey = key.toLowerCase();
        if (lowerKey !== 'user-agent' && lowerKey !== 'host' && lowerKey !== 'origin' && lowerKey !== 'referer') {
          fetchOptions.headers[key] = reqHeaders[key];
        }
      }
    }

    // Add body for methods that support it
    if (reqBody && ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) !== -1) {
      fetchOptions.body = reqBody;
    }

    var startTime = Date.now();
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 30000);
    var response;

    try {
      response = await fetch(targetUrl, { ...fetchOptions, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    var elapsed = Date.now() - startTime;

    // Collect response headers
    var respHeaders = {};
    response.headers.forEach(function(value, key) {
      respHeaders[key] = value;
    });

    // Read response body (limit to 500KB)
    var responseBody = '';
    var contentLength = 0;
    try {
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var chunks = [];
      var total = 0;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        total += chunk.value.length;
        if (total > 512000) {
          chunks.push(new TextEncoder().encode('\n\n... [Response body truncated at 500KB]'));
          break;
        }
      }
      var fullBuffer = new Uint8Array(total > 512000 ? total + 50 : total);
      var offset = 0;
      for (var i = 0; i < chunks.length; i++) {
        fullBuffer.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      responseBody = decoder.decode(fullBuffer, { stream: true }) + (decoder.decode() || '');
      contentLength = offset;
    } catch (e) {
      responseBody = '[Error reading response body: ' + e.message + ']';
    }

    var result = {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
      body: responseBody,
      responseTime: elapsed,
      responseSize: contentLength,
      finalUrl: response.url
    };

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  } catch (e) {
    if (e.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Request timed out (30s)' }), { status: 504, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    return new Response(JSON.stringify({ error: e.message || 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
}
