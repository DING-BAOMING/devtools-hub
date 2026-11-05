const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DKIM_SELECTORS = ['google', 'default', 's1', 's2', 'dkim', 'selector1', 'selector2', 'mail', 'mx', 'protonmail', 'outlook', 'mandrill', 'sparkpost', 'sendgrid', 'zoho', 'mailgun', 'postmark', 'amazonses', 'sendinblue', 'mailchimp'];

async function dnsQuery(name, type) {
  const url = DOH_URL + '?name=' + encodeURIComponent(name) + '&type=' + type;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/dns-json' }
  });
  if (!response.ok) throw new Error('DNS query failed for ' + name + ': ' + response.status);
  return await response.json();
}

function extractTXT(answers) {
  if (!answers || !Array.isArray(answers)) return [];
  return answers.filter(function(a) { return a.type === 16; }).map(function(a) { return a.data; });
}

function extractMX(answers) {
  if (!answers || !Array.isArray(answers)) return [];
  return answers.filter(function(a) { return a.type === 15; }).map(function(a) {
    var parts = (a.data || '').split(' ');
    return { exchange: parts.slice(1).join(' ') || a.data, priority: parseInt(parts[0], 10) || 0 };
  }).sort(function(a, b) { return a.priority - b.priority; });
}

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  try {
    const url = new URL(context.request.url);
    const domain = url.searchParams.get('domain');

    if (!domain) {
      return new Response(JSON.stringify({ error: 'Domain parameter is required' }), { status: 400, headers });
    }

    const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
    if (!domainPattern.test(domain)) {
      return new Response(JSON.stringify({ error: 'Invalid domain format' }), { status: 400, headers });
    }

    const results = { domain: domain, spf: null, dkim: null, dmarc: null, mx: null, errors: [] };

    // Query all DNS records in parallel
    const queries = await Promise.allSettled([
      dnsQuery(domain, 'TXT'),
      dnsQuery(domain, 'MX'),
      dnsQuery('_dmarc.' + domain, 'TXT'),
      // DKIM selectors
      Promise.all(DKIM_SELECTORS.map(function(sel) {
        return dnsQuery(sel + '._domainkey.' + domain, 'TXT').then(function(d) {
          return { selector: sel, records: extractTXT(d.Answer) };
        }).catch(function() {
          return { selector: sel, records: [] };
        });
      }))
    ]);

    // SPF
    if (queries[0].status === 'fulfilled') {
      const txtRecords = extractTXT(queries[0].value.Answer);
      const spfRecords = txtRecords.filter(function(r) { return r.startsWith('v=spf1'); });
      if (spfRecords.length > 0) {
        const record = spfRecords[0];
        const warnings = [];
        let status = 'pass';
        if (spfRecords.length > 1) {
          warnings.push('Multiple SPF records found (only one allowed)');
          status = 'fail';
        }
        if (record.indexOf('+all') !== -1) {
          warnings.push('Uses +all (allow all) - disables SPF protection');
          status = 'fail';
        }
        const includeCount = (record.match(/include:/g) || []).length;
        const mxMechCount = (record.match(/\bmx\b/g) || []).length;
        const aMechCount = (record.match(/\ba\b/g) || []).length;
        const ptrCount = (record.match(/\bptr\b/g) || []).length;
        const existsCount = (record.match(/exists:/g) || []).length;
        const totalLookups = includeCount + mxMechCount + aMechCount + ptrCount + existsCount;
        if (totalLookups > 10) {
          warnings.push('Exceeds 10 DNS lookup limit (' + totalLookups + ' lookups)');
          status = 'fail';
        }
        if (record.indexOf('~all') === -1 && record.indexOf('-all') === -1 && record.indexOf('+all') === -1) {
          if (record.indexOf('?all') === -1) {
            warnings.push('No all mechanism at end');
            if (status === 'pass') status = 'warn';
          }
        }
        results.spf = { record: record, status: status, warnings: warnings };
      } else {
        results.spf = { record: null, status: 'fail', warnings: ['No SPF record found'] };
      }
    } else {
      results.spf = { record: null, status: 'fail', warnings: ['SPF lookup failed'] };
    }

    // MX
    if (queries[1].status === 'fulfilled') {
      const mxRecords = extractMX(queries[1].value.Answer);
      if (mxRecords.length > 0) {
        results.mx = { records: mxRecords, status: 'pass', warnings: [] };
      } else {
        results.mx = { records: [], status: 'fail', warnings: ['No MX records found'] };
      }
    } else {
      results.mx = { records: [], status: 'fail', warnings: ['MX lookup failed'] };
    }

    // DMARC
    if (queries[2].status === 'fulfilled') {
      const dmarcRecords = extractTXT(queries[2].value.Answer);
      const dmarcRecord = dmarcRecords.filter(function(r) { return r.startsWith('v=DMARC1'); });
      if (dmarcRecord.length > 0) {
        const record = dmarcRecord[0];
        const warnings = [];
        let status = 'pass';
        if (dmarcRecord.length > 1) {
          warnings.push('Multiple DMARC records found');
          status = 'fail';
        }
        const policyMatch = record.match(/\bp=(\w+)/);
        const policy = policyMatch ? policyMatch[1] : null;
        if (!policy) {
          warnings.push('No p= policy found');
          status = 'warn';
        } else if (policy === 'none') {
          warnings.push('p=none - monitor only, no protection');
          status = 'warn';
        } else if (policy === 'quarantine' || policy === 'reject') {
          // good policy
        } else {
          warnings.push('Unknown policy: p=' + policy);
          status = 'warn';
        }
        results.dmarc = { record: record, status: status, warnings: warnings, policy: policy };
      } else {
        results.dmarc = { record: null, status: 'fail', warnings: ['No DMARC record found'], policy: null };
      }
    } else {
      results.dmarc = { record: null, status: 'fail', warnings: ['DMARC lookup failed'], policy: null };
    }

    // DKIM
    if (queries[3].status === 'fulfilled') {
      const dkimResults = queries[3].value;
      const foundSelectors = dkimResults.filter(function(s) { return s.records.length > 0; });
      const allDkimSelectors = dkimResults.map(function(s) { return { selector: s.selector, found: s.records.length > 0, record: s.records.length > 0 ? s.records[0] : null }; });
      if (foundSelectors.length > 0) {
        results.dkim = { selectors: allDkimSelectors, found: foundSelectors.map(function(s) { return s.selector; }), status: 'pass', warnings: [] };
      } else {
        results.dkim = { selectors: allDkimSelectors, found: [], status: 'warn', warnings: ['No DKIM records found for common selectors'] };
      }
    } else {
      results.dkim = { selectors: [], found: [], status: 'fail', warnings: ['DKIM lookup failed'] };
    }

    return new Response(JSON.stringify(results), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers, status: 500 });
  }
}
