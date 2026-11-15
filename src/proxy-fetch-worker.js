// REST API Tester - Generic HTTP Proxy Worker v2
// Proxies arbitrary HTTP requests to avoid CORS restrictions
// Deployed as standalone Cloudflare Worker: devtools-hub-api-proxy
//
// 2026-11-11 加固。这个 Worker 只有一个用户：站内的 REST API Tester，
// 但它对外完全开放（任何人 POST 一个 URL 就能用它转发），所以补三样：
//   - 限流：用 Cloudflare 原生的 Rate Limiting binding（env.RATE_LIMITER），
//     不自己写计数器。绑定没部署时这段自动跳过（功能不变）。
//   - CORS：只放行本站来源，不再是通配符 * —— 别人的网站不能从用户浏览器
//     白嫖这个中转站（命令行直连不受 CORS 限制，所以限流才是真正的闸门）。
//   - SSRF 名单：补 169.254./::1/ULA/.internal/.local，以及非 http(s) 协议。
//
// 部署：npx wrangler deploy --config wrangler.worker.toml
// 状态：**2026-11-11 已上线**（Version bb5af7d5-3557-4086-817d-19fefa10ff5a）。
// 部署用的 Workers 写权限 token 在 /home/ubuntu/.secrets/cf-workers-token.txt
// （仓库外，0600）。命令：
//   CLOUDFLARE_API_TOKEN=$(cat /home/ubuntu/.secrets/cf-workers-token.txt) \
//   CLOUDFLARE_ACCOUNT_ID=dfd1444566cc6b76eda1c8a9fabbb6f9 \
//   npx wrangler deploy --config wrangler.worker.toml
// 注意：限流 binding 的计数是近似值、按机房独立、后台更新 → 串行慢速打
// 测不出触发，必须并发突发（实测并发 250 次 → 27 个 429）。
// 自检：node test-scripts/proxy-worker-selftest.js

// 本站来源。Cloudflare Pages 的域名（含预览）也放行。
var ORIGIN_ALLOWLIST = ['https://tools.scoreroute.com', 'https://devtools-hub.pages.dev'];
// 内网 / 回环 / 链路本地 / ULA。公网主机名解析到这些地址挡不住（Worker 里
// 查不到 DNS），但把 IP 字面量和保留域名挡掉已经能挡掉绝大多数扫描。
var PRIVATE_HOST = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$|localhost$|::1$|fc[0-9a-f]{2}:|fe80:)/i;
var PRIVATE_SUFFIX = /\.(internal|local|localdomain|home\.arpa)$/i;

function originAllowed(origin) {
  if (!origin) return false;
  if (ORIGIN_ALLOWLIST.indexOf(origin) !== -1) return true;
  return /\.pages\.dev$/.test(origin);
}

export default {
  async fetch(request, env, ctx) {
    var origin = request.headers.get('Origin');
    var corsHeaders = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (originAllowed(origin)) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
      corsHeaders['Vary'] = 'Origin';
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Cloudflare 原生限流。没有绑定就跳过（老部署不受影响）。
    if (env.RATE_LIMITER) {
      try {
        var limited = await env.RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
        if (!limited.success) {
          return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
      } catch (e) {
        // 限流服务自己出问题时不要把工具整个打死，放行。
      }
    }

    try {
      var body = await request.json();
      var targetUrl = body.url;
      var method = (body.method || 'GET').toUpperCase();
      var reqHeaders = body.headers || {};
      var reqBody = body.body || null;
      var followRedirect = body.followRedirect !== false;

      if (!targetUrl || typeof targetUrl !== 'string') {
        return new Response(JSON.stringify({ error: 'URL field required' }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // 只放行 http / https。别的协议（file:、gopher: …）直接拒掉。
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetUrl) && !/^https?:\/\//i.test(targetUrl)) {
        return new Response(JSON.stringify({ error: 'Only http and https are allowed' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return new Response(JSON.stringify({ error: 'Only http and https are allowed' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // IPv6 hosts come back from URL() with the brackets still on.
      var hostname = parsedUrl.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
      if (PRIVATE_HOST.test(hostname) || PRIVATE_SUFFIX.test(hostname)) {
        return new Response(JSON.stringify({ error: 'Cannot request private/internal URLs' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

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

      for (var key in reqHeaders) {
        if (reqHeaders.hasOwnProperty(key) && reqHeaders[key]) {
          var lowerKey = key.toLowerCase();
          if (lowerKey !== 'user-agent' && lowerKey !== 'host' && lowerKey !== 'origin' && lowerKey !== 'referer') {
            fetchOptions.headers[key] = reqHeaders[key];
          }
        }
      }

      if (reqBody && ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) !== -1) {
        fetchOptions.body = reqBody;
      }

      var startTime = Date.now();
      var response = await fetch(targetUrl, fetchOptions);
      var elapsed = Date.now() - startTime;

      var respHeaders = {};
      response.headers.forEach(function(value, key) {
        respHeaders[key] = value;
      });

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
        var fullBuffer = new Uint8Array(total);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
          fullBuffer.set(chunks[i], offset);
          offset += chunks[i].length;
        }
        responseBody = decoder.decode(fullBuffer, { stream: true });
        responseBody = decoder.decode();
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
      return new Response(JSON.stringify({ error: e.message || 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
  }
};
