// Port Checker API v1
// Uses Cloudflare Workers raw TCP sockets (cloudflare:sockets connect()) to test
// whether a TCP port on a remote host is open, closed, or filtered.
// GEO/ai-resistant: AI chatbots cannot make real TCP connections to test ports.

import { connect } from 'cloudflare:sockets';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PORTS_PER_REQUEST = 25;

// Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4).
// Workers block outbound TCP sockets to Cloudflare IPs, so probing one fails
// with "connection refused" in ~2ms and reads as a dead host. Measured:
// tools.scoreroute.com:443 -> "closed" while serving this very request.
// Ponytail: hardcoded copy of a rarely-changing published list, not a fetched
// one. Add a range here if Cloudflare publishes a new one.
const CF_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '1.1.1.0/24', '1.0.0.0/24'
];

const CF_BLOCK_REASON =
  'This host resolves to a Cloudflare address. Cloudflare blocks outbound TCP from this checker to Cloudflare\'s own network, so the port cannot be measured from here. A scan of a proxied hostname measures Cloudflare\'s edge, not your origin server.';

const PORT_SERVICES = {
  20: 'FTP Data',
  21: 'FTP Control',
  22: 'SSH / SFTP',
  23: 'Telnet',
  25: 'SMTP (blocked by Cloudflare)',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP3',
  111: 'RPCbind',
  135: 'MSRPC',
  137: 'NetBIOS Name',
  139: 'NetBIOS Session / SMB',
  143: 'IMAP',
  161: 'SNMP',
  443: 'HTTPS',
  445: 'SMB',
  465: 'SMTPS',
  514: 'Syslog',
  587: 'SMTP Submission',
  631: 'IPP (Printing)',
  636: 'LDAPS',
  873: 'Rsync',
  993: 'IMAPS',
  995: 'POP3S',
  1080: 'SOCKS Proxy',
  1433: 'MSSQL',
  1521: 'Oracle DB',
  1723: 'PPTP VPN',
  2049: 'NFS',
  2375: 'Docker API (unencrypted)',
  2376: 'Docker API (TLS)',
  3000: 'Dev Server (Node/Rails)',
  3128: 'HTTP Proxy (Squid)',
  3306: 'MySQL',
  3389: 'RDP (Remote Desktop)',
  4000: 'Dev Server (Phoenix)',
  4200: 'Dev Server (Angular)',
  4444: 'Metasploit (HTTP)',
  5000: 'Dev Server (Flask/Backend)',
  5001: 'Synology DSM',
  5432: 'PostgreSQL',
  5500: 'VNC Listener',
  5601: 'Kibana',
  5672: 'AMQP (RabbitMQ)',
  5900: 'VNC',
  5901: 'VNC (display :1)',
  5984: 'CouchDB',
  6379: 'Redis',
  6443: 'Kubernetes API (HTTPS)',
  7001: 'WebLogic',
  8000: 'Dev Server / HTTP alt',
  8008: 'HTTP alt',
  8009: 'Tomcat AJP',
  8080: 'HTTP Proxy / Dev Server',
  8081: 'HTTP alt / H2 console',
  8082: 'HTTP alt',
  8085: 'HTTP alt',
  8086: 'InfluxDB',
  8088: 'HTTP alt',
  8090: 'HTTP alt',
  8200: 'Vault',
  8443: 'HTTPS alt',
  8500: 'Consul',
  8888: 'Jupyter / Dev Server',
  9000: 'Dev Server / SonarQube',
  9001: 'SonarQube / Supervisor',
  9042: 'Cassandra',
  9090: 'Prometheus / Dev Server',
  9092: 'Kafka',
  9200: 'Elasticsearch',
  9300: 'Elasticsearch Transport',
  9418: 'Git daemon',
  10000: 'Webmin / Backup',
  11211: 'Memcached',
  15672: 'RabbitMQ Management',
  23717: 'Kubernetes',
  25565: 'Minecraft (Java)',
  27015: 'Source Engine (CS/HL)',
  27017: 'MongoDB',
  33890: 'RDP alt',
  49152: 'Docker registry',
  50000: 'Jenkins'
};

export async function onRequest(context) {
  const request = context.request;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const url = new URL(request.url);
  const hostRaw = (url.searchParams.get('host') || '').trim();
  const portsRaw = (url.searchParams.get('ports') || '').trim();
  const timeoutRaw = parseInt(url.searchParams.get('timeout') || '', 10);

  if (!hostRaw) {
    return new Response(JSON.stringify({ error: 'host parameter required' }), { status: 400, headers });
  }
  if (!portsRaw) {
    return new Response(JSON.stringify({ error: 'ports parameter required (comma-separated, e.g. 80,443,22)' }), { status: 400, headers });
  }

  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw >= 500 && timeoutRaw <= 15000 ? timeoutRaw : DEFAULT_TIMEOUT_MS;

  const host = hostRaw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-._]*[a-zA-Z0-9])?$/.test(host)) {
    return new Response(JSON.stringify({ error: 'Invalid host format' }), { status: 400, headers });
  }

  // Block private/internal hosts (SSRF-style safety) — Cloudflare blocks these anyway.
  if (isPrivateHost(host)) {
    return new Response(JSON.stringify({ error: 'Cannot check private/internal hosts (localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x)' }), { status: 400, headers });
  }

  const ports = parsePorts(portsRaw);
  if (ports.length === 0) {
    return new Response(JSON.stringify({ error: 'No valid ports in the provided list' }), { status: 400, headers });
  }
  if (ports.length > MAX_PORTS_PER_REQUEST) {
    return new Response(JSON.stringify({ error: 'Too many ports (max ' + MAX_PORTS_PER_REQUEST + ' per request)' }), { status: 400, headers });
  }

  const started = Date.now();
  const results = [];
  let firstError = null;

  // A hostname behind Cloudflare's proxy is unmeasurable from a Worker (see CF_IPV4).
  // Resolve it first so the answer is "not measurable" instead of a false "closed".
  const ips = await resolveHost(host);
  const cloudflared = ips.filter(isCloudflareIp);
  if (cloudflared.length > 0) {
    return new Response(JSON.stringify({
      host: host,
      ports_checked: ports.length,
      elapsed_ms: Date.now() - started,
      resolved_ips: ips,
      behind_cloudflare: true,
      results: ports.map(function(p) {
        return {
          port: p,
          status: p === 25 ? 'blocked' : 'unmeasurable',
          service: PORT_SERVICES[p] || '',
          latency_ms: 0,
          error: p === 25
            ? 'Cloudflare prohibits outbound connections on port 25 (SMTP).'
            : CF_BLOCK_REASON
        };
      })
    }), { status: 200, headers });
  }

  // Check ports with limited concurrency (3 at a time) to respect open-connection limits.
  for (let i = 0; i < ports.length; i += 3) {
    const batch = ports.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(function(p) { return checkPort(host, p, timeout); }));
    for (let j = 0; j < batchResults.length; j++) {
      if (batchResults[j].error && !firstError) firstError = batchResults[j].error;
      results.push(batchResults[j]);
    }
  }

  results.sort(function(a, b) { return a.port - b.port; });

  return new Response(JSON.stringify({
    host: host,
    ports_checked: results.length,
    elapsed_ms: Date.now() - started,
    resolved_ips: ips,
    behind_cloudflare: false,
    results: results
  }), { status: 200, headers });
}

// An IPv4 literal is already its own answer; a hostname needs one A-record lookup.
// Never fatal: on DNS failure the scan proceeds exactly as before.
async function resolveHost(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host];
  try {
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' +
      encodeURIComponent(host) + '&type=A', { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.Answer || [])
      .filter(function(a) { return a.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data); })
      .map(function(a) { return a.data; });
  } catch (e) {
    return [];
  }
}

function isCloudflareIp(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(function(n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return false;
  for (let i = 0; i < CF_IPV4.length; i++) {
    const bits = CF_IPV4[i].split('/');
    const base = bits[0].split('.').map(Number);
    const prefix = parseInt(bits[1], 10);
    let match = true;
    for (let b = 0; b < 32 && match; b++) {
      if (b >= prefix) break;
      if (((base[b >> 3] >> (7 - (b & 7))) & 1) !== ((parts[b >> 3] >> (7 - (b & 7))) & 1)) match = false;
    }
    if (match) return true;
  }
  return false;
}

function isPrivateHost(host) {
  const lower = host.toLowerCase();
  if (lower === 'localhost') return true;
  if (/\.local$/.test(lower) || lower.endsWith('.internal') || lower.endsWith('.lan')) return true;
  if (lower.startsWith('127.') || lower.startsWith('10.') || lower.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(lower)) return true;
  if (lower.startsWith('192.168.')) return true;
  if (/^::1$/.test(lower) || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  if (/^0\.0\.0\.0$/.test(lower)) return true;
  return false;
}

function parsePorts(raw) {
  const out = [];
  const seen = {};
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= 65535 && !seen[p]) { seen[p] = 1; out.push(p); }
    } else if (/^\d+\s*-\s*\d+$/.test(part)) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a >= 1 && b <= 65535 && a <= b) {
        for (let p = a; p <= b && out.length < MAX_PORTS_PER_REQUEST; p++) {
          if (!seen[p]) { seen[p] = 1; out.push(p); }
        }
      }
    }
  }
  return out;
}

function checkPort(host, port, timeoutMs) {
  return new Promise(function(resolve) {
    // Port 25 (SMTP) is prohibited by Cloudflare Workers — report it explicitly.
    if (port === 25) {
      resolve({ port: port, status: 'blocked', service: PORT_SERVICES[port] || '', latency_ms: 0, error: 'Cloudflare prohibits outbound connections on port 25 (SMTP).' });
      return;
    }
    let settled = false;
    let socket = null;
    const start = Date.now();
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      try { if (socket) socket.close(); } catch (e) {}
      resolve({ port: port, status: 'filtered', service: PORT_SERVICES[port] || '', latency_ms: Date.now() - start, error: null });
    }, timeoutMs);

    try {
      socket = connect({ hostname: host, port: port });
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      resolve({ port: port, status: 'error', service: PORT_SERVICES[port] || '', latency_ms: 0, error: e.message || 'Connection error' });
      return;
    }

    socket.opened.then(function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lat = Date.now() - start;
      try { socket.close(); } catch (e) {}
      resolve({ port: port, status: 'open', service: PORT_SERVICES[port] || '', latency_ms: lat, error: null });
    }).catch(function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = (err && err.message) || '';
      let status = 'closed';
      if (/timeout/i.test(msg) || /timed out/i.test(msg)) status = 'filtered';
      else if (/refused/i.test(msg) || /connection failed/i.test(msg) || /reset/i.test(msg)) status = 'closed';
      else if (/cloudflare/i.test(msg) || /prohibited/i.test(msg) || /blocked/i.test(msg)) status = 'blocked';
      resolve({ port: port, status: status, service: PORT_SERVICES[port] || '', latency_ms: Date.now() - start, error: status === 'blocked' ? msg : null });
    });
  });
}
