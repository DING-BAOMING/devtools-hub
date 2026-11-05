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

  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
  if (!domainPattern.test(cleanDomain)) {
    return new Response(JSON.stringify({ error: 'Invalid domain format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const apiKey = env.DEVTOOLS_NINJAS_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const whoisResponse = await fetch(
      'https://api.api-ninjas.com/v1/whois?domain=' + encodeURIComponent(cleanDomain),
      { headers: { 'X-Api-Key': apiKey } }
    );

    if (!whoisResponse.ok) {
      const errorText = await whoisResponse.text();
      return new Response(JSON.stringify({ error: 'WHOIS lookup failed: ' + errorText }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const data = await whoisResponse.json();

    function extractDate(val) {
      if (!val) return null;
      if (Array.isArray(val)) val = val[0];
      if (typeof val === 'number') return new Date(val * 1000);
      return new Date(val);
    }

    function formatDateStr(val) {
      if (!val) return null;
      if (Array.isArray(val)) val = val[0];
      if (typeof val === 'number') {
        var d = new Date(val * 1000);
        return d.toISOString().split('T')[0];
      }
      return String(val);
    }

    var now = new Date();
    var ageData = null;
    var creationDate = extractDate(data.creation_date);

    if (creationDate && !isNaN(creationDate.getTime())) {
      var ageMs = now.getTime() - creationDate.getTime();
      var ageYears = Math.floor(ageMs / (365.25 * 24 * 60 * 60 * 1000));
      var ageMonths = Math.floor((ageMs % (365.25 * 24 * 60 * 60 * 1000)) / (30.44 * 24 * 60 * 60 * 1000));
      var ageDays = Math.floor((ageMs % (30.44 * 24 * 60 * 60 * 1000)) / (24 * 60 * 60 * 1000));
      var ageTotalDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

      ageData = {
        years: ageYears,
        months: ageMonths,
        days: ageDays,
        total_days: ageTotalDays,
        creation_date: formatDateStr(data.creation_date)
      };
    }

    var expiryData = null;
    var expDate = extractDate(data.expiration_date);
    if (expDate && !isNaN(expDate.getTime())) {
      var expMs = expDate.getTime() - now.getTime();
      var expDays = Math.max(0, Math.floor(expMs / (24 * 60 * 60 * 1000)));
      expiryData = {
        expiration_date: formatDateStr(data.expiration_date),
        days_remaining: expDays,
        is_expired: expMs < 0
      };
    }

    var updatedDate = formatDateStr(data.last_updated || data.updated_date);

    return new Response(JSON.stringify({
      domain: cleanDomain,
      age: ageData,
      expiry: expiryData,
      registrar: data.registrar || null,
      name_servers: data.name_servers || [],
      updated_date: updatedDate,
      status: data.status || null,
      whois_data: {
        registrar: data.registrar,
        whois_server: data.whois_server,
        name_servers: data.name_servers,
        dnssec: data.dnssec,
        status: data.status
      }
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to fetch WHOIS data: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
