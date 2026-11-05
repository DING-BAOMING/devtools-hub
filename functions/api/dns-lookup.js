export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');
  const type = url.searchParams.get('type') || 'all';

  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
  if (!domainPattern.test(domain)) {
    return new Response(JSON.stringify({ error: 'Invalid domain format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const apiKey = env.DEVTOOLS_NINJAS_KEY;
  if (!apiKey || apiKey === 'NINJAS_KEY_NOT_SET') {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const results = {};

  if (type === 'all' || type === 'dns') {
    try {
      const dnsResponse = await fetch(
        'https://api.api-ninjas.com/v1/dnslookup?domain=' + encodeURIComponent(domain),
        { headers: { 'X-Api-Key': apiKey } }
      );
      if (dnsResponse.ok) {
        results.dns = await dnsResponse.json();
      } else {
        results.dns = { error: 'DNS lookup failed: ' + dnsResponse.status };
      }
    } catch (e) {
      results.dns = { error: e.message };
    }
  }

  if (type === 'all' || type === 'whois') {
    try {
      const whoisResponse = await fetch(
        'https://api.api-ninjas.com/v1/whois?domain=' + encodeURIComponent(domain),
        { headers: { 'X-Api-Key': apiKey } }
      );
      if (whoisResponse.ok) {
        results.whois = await whoisResponse.json();
      } else {
        results.whois = { error: 'WHOIS lookup failed: ' + whoisResponse.status };
      }
    } catch (e) {
      results.whois = { error: e.message };
    }
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
