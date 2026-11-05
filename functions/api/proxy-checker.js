// proxy-checker v1
export async function onRequest({ request, env }) {
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
  var input = url.searchParams.get('host');
  if (!input) {
    return new Response(JSON.stringify({ error: 'Host parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  input = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  var port = null;
  var host = input;
  if (input.includes(':')) {
    var parts = input.split(':');
    host = parts[0];
    port = parseInt(parts[1]);
  }

  var isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  var isDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host);
  if (!isIP && !isDomain) {
    return new Response(JSON.stringify({ error: 'Invalid host. Enter a valid IP or domain.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  var result = { host, port, isIP, geo: null, whois: null, proxyDetection: null, portChecks: null };
  var ninjasKey = env.DEVTOOLS_NINJAS_KEY;
  var errors = [];

  // 1. Resolve domain to IP
  var targetIP = isIP ? host : null;
  if (!isIP) {
    try {
      var dnsResp = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A', {
        headers: { 'Accept': 'application/dns-json' }
      });
      if (dnsResp.ok) {
        var dnsData = await dnsResp.json();
        if (dnsData.Answer) {
          for (var a of dnsData.Answer) {
            if (a.type === 1) { targetIP = a.data; break; }
          }
        }
      }
    } catch(e) { errors.push('DNS: ' + e.message); }
  }

  // 2. Geolocation
  if (targetIP) {
    try {
      var geoResp = await fetch('https://ipapi.co/' + encodeURIComponent(targetIP) + '/json/', {
        headers: { 'User-Agent': 'DevToolsHub/1.0' }
      });
      if (geoResp.ok) {
        var geoData = await geoResp.json();
        if (!geoData.error) {
          result.geo = {
            ip: geoData.ip, country: geoData.country_name, countryCode: geoData.country_code,
            region: geoData.region, city: geoData.city, isp: geoData.org,
            asn: geoData.asn, latitude: geoData.latitude, longitude: geoData.longitude,
            hosting: geoData.hosting || false, timezone: geoData.timezone
          };
        }
      }
    } catch(e) { errors.push('Geo: ' + e.message); }
  }

  // 3. WHOIS for domains
  if (ninjasKey && !isIP) {
    try {
      var whoisResp = await fetch('https://api.api-ninjas.com/v1/whois?domain=' + encodeURIComponent(host), {
        headers: { 'X-Api-Key': ninjasKey }
      });
      if (whoisResp.ok) {
        var wd = await whoisResp.json();
        result.whois = { registrar: wd.registrar, creationDate: wd.creation_date, expirationDate: wd.expiration_date, nameServers: wd.name_servers, organization: wd.org, country: wd.country };
      }
    } catch(e) { errors.push('WHOIS: ' + e.message); }
  }

  // 4. Port checking
  var proxyPorts = [80, 443, 1080, 3128, 8080, 8118, 8888, 9999];
  var openPorts = [];
  if (targetIP) {
    for (var p of proxyPorts) {
      if (port && p !== port) continue;
      try {
        var ctrl = new AbortController();
        var tid = setTimeout(() => ctrl.abort(), 3000);
        var pResp = await fetch('http://' + targetIP + ':' + p + '/', { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(tid);
        if (pResp.ok || [400,401,403,502].includes(pResp.status)) {
          openPorts.push({ port: p, status: pResp.status, type: {80:'HTTP',443:'HTTPS',1080:'SOCKS',3128:'Squid',8080:'HTTP Proxy',8118:'Privoxy',8888:'HTTP Proxy',9999:'HTTP Proxy'}[p] || 'Unknown' });
        }
      } catch(e) {}
      if (port) break;
    }
  }
  result.portChecks = { checked: port ? [port] : proxyPorts, open: openPorts };

  // 5. Proxy detection
  var indicators = [];
  var isProxy = false;
  if (result.geo && result.geo.hosting) { indicators.push('IP hosted in data center (hosting/proxy provider)'); isProxy = true; }
  var proxyPortsOpen = openPorts.filter(p => [1080,3128,8080,8118,8888].includes(p.port));
  if (proxyPortsOpen.length > 0) { indicators.push('Common proxy ports open: ' + proxyPortsOpen.map(p => p.port).join(', ')); isProxy = true; }
  if (port && openPorts.length > 0) { indicators.push('Specified port ' + port + ' is open'); isProxy = true; }
  if (!isProxy) indicators.push('No proxy indicators detected');

  result.proxyDetection = {
    isProxy,
    confidence: isProxy ? (openPorts.length > 0 && result.geo && result.geo.hosting ? 'high' : 'medium') : 'low',
    indicators
  };

  if (errors.length) result.errors = errors;
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...headers } });
}
