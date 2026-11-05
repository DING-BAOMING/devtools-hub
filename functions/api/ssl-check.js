/**
 * SSL Checker API
 * 
 * Uses Qualys SSL Labs free API (no key required).
 * Flow:
 * 1. Start assessment with fromCache=on (fast if cached)
 * 2. If status is DNS or IN_PROGRESS, return polling info
 * 3. If status is READY, return full results
 * 4. If status is ERROR, return error
 * 
 * SSL Labs API limits:
 * - Max concurrent assessments: 7
 * - New assessment cooldown: 1000ms
 * - fromCache=on returns cached results instantly if available
 * - Full scan takes 1-3 minutes
 */

var GRADE_EXPLANATIONS = {
  'A+': 'Excellent - This site has exceptional TLS configuration. No known issues.',
  'A': 'Very Good - Strong TLS configuration with minor improvements possible.',
  'A-': 'Good - Solid TLS but has small areas for improvement.',
  'B+': 'Acceptable - TLS is configured but some weaknesses exist.',
  'B': 'Needs Improvement - Some TLS issues that should be addressed.',
  'B-': 'Below Average - Several TLS weaknesses detected.',
  'C+': 'Weak - Notable TLS problems that may affect security.',
  'C': 'Poor - Significant TLS security issues.',
  'C-': 'Very Poor - Serious TLS vulnerabilities detected.',
  'D+': 'Bad - Critical TLS issues found.',
  'D': 'Very Bad - TLS configuration is dangerously weak.',
  'D-': 'Extremely Bad - TLS is severely compromised.',
  'F': 'Failed - TLS is broken or virtually absent.',
  'T': 'No Trust - Certificate is not trusted by browsers.',
  'M': 'Mixed - Some endpoints are secure, some are not.'
};

var COMMON_ISSUES = {
  'rc4': 'RC4 cipher is weak and should be disabled.',
  'beast': 'BEAST vulnerability detected. Enable TLS 1.1 or 1.2.',
  'forwardSecrecy': 'Perfect Forward Secrecy is not enabled. Use ECDHE or DHE cipher suites.',
  'hsts': 'HTTP Strict Transport Security (HSTS) is not enabled. Add the HSTS header.',
  'protocol': 'Outdated TLS protocol detected. Disable TLS 1.0 and 1.1.',
  'certificate': 'Certificate issue detected. Check expiry, chain, or hostname.',
  'renegotiation': 'Insecure TLS renegotiation detected.',
  'heartbeat': 'Heartbleed vulnerability detected. Update OpenSSL immediately.',
  'poodle': 'POODLE vulnerability detected. Disable SSL 3.0.'
};

function explainGrade(grade) {
  if (!grade) return 'No grade available.';
  return GRADE_EXPLANATIONS[grade] || 'Unknown grade.';
}

function analyzeIssues(endpoints) {
  var issues = [];
  var warnings = [];
  
  for (var i = 0; i < endpoints.length; i++) {
    var ep = endpoints[i];
    
    if (ep.hasWarnings) {
      warnings.push('Endpoint ' + ep.ipAddress + ' has warnings.');
    }
    
    if (ep.grade && ['C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'T'].indexOf(ep.grade) !== -1) {
      issues.push('Endpoint ' + ep.ipAddress + ' has grade ' + ep.grade + ' which indicates serious issues.');
    }
    
    if (ep.gradeTrustIgnored && ep.gradeTrustIgnored !== ep.grade) {
      warnings.push('Endpoint ' + ep.ipAddress + ': Grade without trust issues is ' + ep.gradeTrustIgnored + ' (vs ' + ep.grade + ' with trust).');
    }
  }
  
  var uniqueIssues = [];
  var seen = {};
  for (var j = 0; j < issues.length; j++) {
    if (!seen[issues[j]]) {
      uniqueIssues.push(issues[j]);
      seen[issues[j]] = true;
    }
  }
  
  return { issues: uniqueIssues, warnings: warnings };
}

function generateRecommendations(grade, endpoints) {
  var recs = [];
  var g = grade || '';
  
  if (['A+', 'A'].indexOf(g) === -1) {
    recs.push('Enable HTTP Strict Transport Security (HSTS) to force HTTPS connections.');
  }
  
  if (['A+', 'A', 'A-'].indexOf(g) === -1) {
    recs.push('Disable TLS 1.0 and TLS 1.1 - they are deprecated and insecure.');
    recs.push('Remove weak cipher suites (RC4, 3DES, SHA-1).');
  }
  
  if (['A+', 'A', 'A-', 'B+', 'B'].indexOf(g) === -1) {
    recs.push('Check your SSL/TLS certificate chain for completeness.');
    recs.push('Ensure your server certificate is not expired or misconfigured.');
  }
  
  if (['A+'].indexOf(g) === -1) {
    recs.push('Consider enabling OCSP Stapling for faster certificate validation.');
  }
  
  return recs;
}

export async function onRequest({ request, env }) {
  var responseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
  }

  var url = new URL(request.url);
  var host = url.searchParams.get('host');
  var fromCache = url.searchParams.get('fromCache') !== 'false';

  if (!host) {
    return new Response(JSON.stringify({ error: 'Host parameter required. Usage: /api/ssl-check?host=example.com' }), { status: 400, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
  }

  host = host.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host)) {
    return new Response(JSON.stringify({ error: 'Invalid hostname. Please enter a valid domain name.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
  }

  var cacheParam = fromCache ? '&fromCache=on' : '';
  var sslLabsUrl = 'https://api.ssllabs.com/api/v3/analyze?host=' + encodeURIComponent(host) + '&publish=off' + cacheParam;

  try {
    var sslResponse = await fetch(sslLabsUrl, {
      headers: { 'User-Agent': 'DevTools-Hub-SSL-Checker/1.0' }
    });

    if (!sslResponse.ok) {
      return new Response(JSON.stringify({ error: 'SSL Labs API request failed: ' + sslResponse.status }), { status: 502, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
    }

    var data = await sslResponse.json();
    var status = data.status;
    
    if (data.errors && data.errors.length > 0) {
      return new Response(JSON.stringify({ error: 'SSL Labs error: ' + data.errors.map(function(e) { return e.message; }).join('; ') }), { status: 502, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
    }

    if (status === 'ERROR') {
      var errorMsg = data.statusMessage || 'SSL scan failed. The domain may not exist or may not have HTTPS.';
      return new Response(JSON.stringify({ error: errorMsg, host: host }), { status: 200, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
    }

    if (status === 'DNS' || status === 'IN_PROGRESS') {
      var eta = status === 'DNS' ? 'Starting DNS resolution...' : 'Scan in progress...';
      return new Response(JSON.stringify({
        host: host,
        status: status,
        statusMessage: data.statusMessage || eta,
        endpoints: (data.endpoints || []).map(function(ep) {
          return { ipAddress: ep.ipAddress, statusMessage: ep.statusMessage || 'Pending...' };
        }),
        estimatedTime: status === 'DNS' ? '60-180 seconds' : '30-120 seconds remaining',
        pollInterval: 10
      }), { headers: { 'Content-Type': 'application/json', ...responseHeaders } });
    }

    if (status === 'READY') {
      var endpoints = (data.endpoints || []).map(function(ep) {
        return {
          ipAddress: ep.ipAddress,
          grade: ep.grade,
          gradeTrustIgnored: ep.gradeTrustIgnored,
          hasWarnings: ep.hasWarnings,
          isExceptional: ep.isExceptional,
          statusMessage: ep.statusMessage
        };
      });

      var grades = endpoints.map(function(ep) { return ep.grade; }).filter(Boolean);
      var worstGrade = grades.length > 0 ? grades.sort()[grades.length - 1] : 'Unknown';
      var bestGrade = grades.length > 0 ? grades.sort()[0] : 'Unknown';

      if (worstGrade === bestGrade) {
        worstGrade = bestGrade = grades[0] || 'Unknown';
      }

      var analysis = analyzeIssues(endpoints);
      var recommendations = generateRecommendations(worstGrade, endpoints);

      return new Response(JSON.stringify({
        host: host,
        status: 'READY',
        overallGrade: worstGrade,
        gradeExplanation: explainGrade(worstGrade),
        endpoints: endpoints,
        issues: analysis.issues,
        warnings: analysis.warnings,
        recommendations: recommendations,
        scanTime: new Date(data.startTime).toISOString(),
        engineVersion: data.engineVersion,
        sslLabsUrl: 'https://www.ssllabs.com/ssltest/analyze.html?d=' + encodeURIComponent(host)
      }), { headers: { 'Content-Type': 'application/json', ...responseHeaders } });
    }

    return new Response(JSON.stringify({ host: host, status: status, statusMessage: data.statusMessage || 'Unknown status' }), { headers: { 'Content-Type': 'application/json', ...responseHeaders } });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...responseHeaders } });
  }
}
