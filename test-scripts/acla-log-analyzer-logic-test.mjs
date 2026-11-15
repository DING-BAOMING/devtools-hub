#!/usr/bin/env node
// Logic gate for /tools/ai-crawler-log-analyzer/.
//
// The page ships its parser and aggregator as one inline <script>. This extracts that script,
// runs it in Node against real fixtures for all five supported log formats, and asserts the
// numbers the page will render. A test that only clicks the button cannot tell a wrong count
// from a right one, and a wrong count here is the whole product.
//
//   node acla-log-analyzer-logic-test.mjs
//
// ANTI-VACUITY: the same script re-injects three defects into a COPY of the page (the
// longest-token-wins rule removed, the status buckets collapsed, the timestamp parser zeroed)
// and requires each one to be observable. If a defect cannot be seen here it would not be seen
// in a browser either. This gate has been seen red — it is what found all four of the first
// pass's bugs (m[10] read the referer instead of the user agent, Googlebot counted as an AI
// crawler, the CLF offset ignored, and IIS comment lines defeating format detection).

import fs from 'fs';
import vm from 'vm';
import path from 'node:path';

const PAGE = path.join(import.meta.dirname, '..', 'tools', 'ai-crawler-log-analyzer', 'index.html');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- extract the page's own code -------------------------------------------------
function loadFrom(html) {
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map(m => m[1]);
  const inline = scripts[scripts.length - 1];
  if (!inline) throw new Error('no inline script found in the page');
  // The wiring block at the bottom touches the DOM and FileReader; the pure functions under
  // test never do. Stub only what the wiring block needs so the whole script still loads.
  const noop = () => {};
  const stubEl = () => new Proxy({}, { get: () => stubFn, apply: () => stubFn });
  const stubFn = function () { return stubEl(); };
  const sandbox = {
    console, Math, Date, JSON, Number, String, Object, Array, Set, Map, Promise, TextDecoder, Blob, URL,
    DecompressionStream: function () {}, FileReader: function () { this.readAsText = noop; this.readAsArrayBuffer = noop; },
    fetch: () => Promise.reject(new Error('no network in the logic gate')),
    setTimeout, clearTimeout,
    document: { getElementById: stubEl, createElement: stubEl, querySelector: stubEl, body: stubEl }
  };
  vm.createContext(sandbox);
  new vm.Script(inline).runInContext(sandbox);
  return sandbox;
}

const html = fs.readFileSync(PAGE, 'utf8');
let S;
try { S = loadFrom(html); } catch (e) { console.log('FATAL: page script did not load — ' + e.message); process.exit(1); }

for (const fn of ['parseLog', 'aggregate', 'matchBot', 'isAiBot', 'statusOf', 'parseClfTs', 'detectFormat', 'splitW3C', 'bytes', 'reverseName']) {
  ok(typeof S[fn] === 'function', `page exports ${fn}()`);
}
if (fail) { console.log('\nfatal — page code incomplete'); process.exit(1); }

// ---- fixtures -------------------------------------------------------------------
const UAS = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  oai: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  claudeBot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  claudeSearch: 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)',
  perplexity: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  perplexityUser: 'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bing: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  ccbot: 'Mozilla/5.0 (compatible; CCBot/2.0; +https://commoncrawl.org/faq/)',
  human: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
};
const BOTH = 'Mozilla/5.0 (compatible; ClaudeBot/1.0) Claude-SearchBot/1.0';

const clf = (ip, day, hh, path, status, size, ua, ref) =>
  `${ip} - - [${day}/Oct/2026:${hh} +0000] "GET ${path} HTTP/1.1" ${status} ${size} "${ref || '-'}" "${ua}"`;
const common = (ip, day, hh, path, status, size) =>
  `${ip} - - [${day}/Oct/2026:${hh} +0000] "GET ${path} HTTP/1.1" ${status} ${size}`;

const combined = [
  clf('20.171.206.72', 10, '02:00:01', '/', 200, 5120, UAS.gptbot),
  clf('20.171.206.72', 10, '02:10:01', '/pricing', 200, 4096, UAS.gptbot),
  clf('52.230.152.32', 10, '03:00:01', '/', 200, 5120, UAS.oai),
  clf('172.64.146.201', 10, '04:00:01', '/docs', 403, 300, UAS.claudeBot),
  clf('172.64.146.202', 10, '04:05:01', '/docs', 403, 300, UAS.claudeSearch),
  clf('5.45.207.1', 10, '05:00:01', '/blog/post', 200, 8000, UAS.perplexity),
  clf('5.45.207.1', 11, '05:00:01', '/blog/post', 200, 8000, UAS.perplexityUser),
  clf('66.249.66.1', 10, '06:00:01', '/', 200, 5120, UAS.googlebot),
  clf('157.55.39.24', 10, '06:10:01', '/', 301, 0, UAS.bing),
  clf('104.26.11.90', 10, '07:00:01', '/', 200, 400, UAS.facebook),
  clf('77.75.77.79', 10, '08:00:01', '/', 200, 400, UAS.ahrefs),
  clf('91.204.116.9', 10, '09:00:01', '/', 200, 400, UAS.ccbot),
  clf('45.83.88.10', 10, '10:00:01', '/', 200, 1200, UAS.human),
  clf('45.83.88.10', 10, '10:00:02', '/api/v1/status', 500, 200, UAS.human),
  common('45.83.88.11', 10, '10:00:03', '/old', 404, 100)
].join('\n');

const aggFor = t => S.aggregate(S.parseLog(t));
const byToken = (a, t) => a.bots.find(b => b.token === t.toLowerCase());
const pathOf = (a, u) => a.paths.find(p => p.uri === u);

console.log('[1] user agent matching and classification');
eq(S.matchBot(UAS.gptbot)?.token, 'gptbot', 'GPTBot recognised');
eq(S.matchBot(UAS.oai)?.token, 'oai-searchbot', 'OAI-SearchBot recognised');
eq(S.matchBot(UAS.claudeBot)?.token, 'claudebot', 'ClaudeBot recognised');
eq(S.matchBot(UAS.claudeSearch)?.token, 'claude-searchbot', 'Claude-SearchBot recognised');
eq(S.matchBot(UAS.perplexity)?.token, 'perplexitybot', 'PerplexityBot recognised');
eq(S.matchBot(UAS.perplexityUser)?.token, 'perplexity-user', 'Perplexity-User recognised');
eq(S.matchBot(BOTH)?.token, 'claude-searchbot', 'longest matching token wins when a user agent names two crawlers');
eq(S.matchBot(UAS.human), null, 'a normal browser is not a bot');
eq(S.matchBot(''), null, 'an empty user agent is not a bot');
eq(S.matchBot('Mozilla/5.0 (compatible; Google-Extended)'), null, 'Google-Extended is a robots.txt token and never a user agent');
eq(S.matchBot(UAS.gptbot)?.kind, 'ai-train', 'GPTBot is an AI training crawler');
eq(S.matchBot(UAS.gptbot)?.label, 'GPTBot', 'the display label keeps the real user-agent casing');
eq(S.matchBot(UAS.claudeBot)?.label, 'ClaudeBot', 'ClaudeBot label casing');
eq(S.matchBot(UAS.googlebot)?.label, 'Googlebot', 'Googlebot label casing');
eq(S.matchBot(UAS.claudeBot)?.kind, 'ai-train', 'ClaudeBot is AI training');
eq(S.matchBot(UAS.claudeSearch)?.kind, 'ai-search', 'Claude-SearchBot is AI retrieval');
eq(S.matchBot(UAS.perplexity)?.kind, 'ai-search', 'PerplexityBot is AI retrieval');
eq(S.matchBot(UAS.ccbot)?.kind, 'ai-train', 'CCBot is AI training');
eq(S.matchBot(UAS.googlebot)?.kind, 'search', 'Googlebot is a classic search engine');
eq(S.matchBot(UAS.bing)?.kind, 'search', 'bingbot is a classic search engine');
eq(S.matchBot(UAS.facebook)?.kind, 'social', 'facebookexternalhit is a link preview bot');
eq(S.matchBot(UAS.ahrefs)?.kind, 'monitor', 'AhrefsBot is an SEO tool');
ok(S.isAiBot(S.matchBot(UAS.oai)), 'isAiBot() is true for OAI-SearchBot');
ok(!S.isAiBot(S.matchBot(UAS.googlebot)), 'isAiBot() is FALSE for Googlebot');
ok(!S.isAiBot(S.matchBot(UAS.bing)), 'isAiBot() is FALSE for bingbot');
ok(!S.isAiBot(S.matchBot(UAS.facebook)), 'isAiBot() is FALSE for facebookexternalhit');
ok(!S.isAiBot(S.matchBot(UAS.ahrefs)), 'isAiBot() is FALSE for AhrefsBot');
eq(S.matchBot(UAS.gptbot)?.ptr, '.openai.com', 'OpenAI reverse-DNS domain recorded');
eq(S.matchBot(UAS.googlebot)?.ptr, '.googlebot.com', 'Google reverse-DNS domain recorded');
eq(S.matchBot(UAS.ccbot)?.ptr, '.commoncrawl.org', 'Common Crawl reverse-DNS domain recorded');

console.log('[2] status classes');
eq(S.statusOf(200), '2xx', '200');
eq(S.statusOf(301), '3xx', '301');
eq(S.statusOf(403), '4xx', '403');
eq(S.statusOf(429), '4xx', '429');
eq(S.statusOf(500), '5xx', '500');
eq(S.statusOf(0), 'other', 'no status');
eq(S.statusOf('-'), 'other', 'non-numeric status');

console.log('[3] timestamps');
eq(S.parseClfTs('10/Oct/2026:13:55:36 +0000'), Date.UTC(2026, 9, 10, 13, 55, 36), 'UTC offset parsed');
eq(S.parseClfTs('10/Oct/2026:13:55:36 -0700'), Date.UTC(2026, 9, 10, 20, 55, 36), 'negative offset shifts forward');
eq(S.parseClfTs('10/Oct/2026:13:55:36 +0530'), Date.UTC(2026, 9, 10, 8, 25, 36), 'half-hour offset applied');
eq(S.parseClfTs('not a timestamp'), 0, 'junk timestamp is 0, not NaN');

console.log('[4] format detection');
eq(S.detectFormat(['#Software: Microsoft IIS', '#Version: 1.0', '#Date: 2026-10-10 00:00', '#Fields: date time cs-uri-stem', '2026-10-10 02:00 200']), 'w3c', 'IIS Fields header -> w3c');
eq(S.detectFormat(['#Software: Microsoft IIS', '#Version: 1.0', '1.2.3.4 - - [10/Oct/2026:02:00:00 +0000] "GET / HTTP/1.1" 200 1']), 'clf', 'comment lines without a Fields header do not force w3c');
eq(S.detectFormat(['{"ClientIP":"1.2.3.4"}']), 'ndjson', 'a JSON first line -> ndjson');
eq(S.detectFormat(['', '   ', '1.2.3.4 - - [10/Oct/2026:02:00:00 +0000] "GET / HTTP/1.1" 200 1']), 'clf', 'blank lines skipped');
eq(S.detectFormat([]), 'clf', 'nothing to detect falls back to clf');

console.log('[5] apache / nginx combined');
const cp = S.parseLog(combined);
eq(cp.format, 'clf', 'combined log detected as clf');
eq(cp.lines.length, 15, 'all 15 request lines parsed');
eq(cp.unparsed.length, 0, 'no line left unparsed');
eq(cp.noUa, 1, 'exactly one line (common format) carries no user agent');
eq(cp.lines[0].ip, '20.171.206.72', 'client address read');
eq(cp.lines[0].uri, '/', 'request target read');
eq(cp.lines[0].status, 200, 'status read');
eq(cp.lines[0].bytes, 5120, 'byte count read');
eq(cp.lines[0].ua, UAS.gptbot, 'user agent read from group 9, not the referer');
eq(cp.lines[0].ts, Date.UTC(2026, 9, 10, 2, 0, 1), 'timestamp read');
eq(S.parseLog(clf('1.2.3.4', 10, '02:00:00', '/x', 200, 1, UAS.gptbot, 'https://example.com/')).lines[0].uri, '/x', 'a referer containing no spaces does not disturb the user agent');
eq(S.parseLog('1.2.3.4 - - [10/Oct/2026:02:00:00 +0000] "-" 400 0 "-" "bad agent"').lines[0].status, 400, 'a malformed request line still yields a status');

console.log('[6] apache / nginx aggregate');
const ca = S.aggregate(cp);
eq(ca.parsedCount, 15, 'aggregated 15 requests');
eq(ca.aiHits, 8, '8 requests came from AI crawlers; Googlebot, bingbot, facebook, Ahrefs and the two browsers did not');
eq(ca.searchHits + ca.trainHits, 8, 'every AI request is classified retrieval or training');
eq(ca.searchHits, 4, 'retrieval = OAI-SearchBot + Claude-SearchBot + PerplexityBot + Perplexity-User');
eq(ca.trainHits, 4, 'training = GPTBot x2 + ClaudeBot + CCBot');
eq(byToken(ca, 'gptbot').hits, 2, 'GPTBot 2 hits');
eq(byToken(ca, 'gptbot').uniqueUrls, 2, 'GPTBot saw 2 URLs');
eq(byToken(ca, 'gptbot').s['2xx'], 2, 'GPTBot got 200 on both');
eq(byToken(ca, 'gptbot').first, Date.UTC(2026, 9, 10, 2, 0, 1), 'per-bot first seen');
eq(byToken(ca, 'gptbot').last, Date.UTC(2026, 9, 10, 2, 10, 1), 'per-bot last seen');
eq(byToken(ca, 'gptbot').ipCount, 1, 'GPTBot came from one address');
eq(byToken(ca, 'gptbot').topPath, '/', 'GPTBot top path is / (tie with /pricing, first wins)');
eq(byToken(ca, 'claudebot').s['4xx'], 1, 'ClaudeBot 403 counted in 4xx');
eq(byToken(ca, 'bingbot').s['3xx'], 1, 'bingbot 301 counted in 3xx');
eq(byToken(ca, 'googlebot').kind, 'search', 'Googlebot stayed out of the AI buckets');
eq(ca.aiBytes, 5120 + 4096 + 5120 + 300 + 300 + 8000 + 8000 + 400, 'bytes to AI excludes Googlebot, bingbot, facebook, Ahrefs and the browsers');
eq(ca.totalBytes - ca.aiBytes, 5120 + 0 + 400 + 400 + 1200 + 200 + 100, 'bytes to everything else accounted for');
eq(ca.firstTs, Date.UTC(2026, 9, 10, 2, 0, 1), 'earliest timestamp across the log');
eq(ca.lastTs, Date.UTC(2026, 9, 11, 5, 0, 1), 'latest timestamp across the log');
eq(Object.keys(ca.ips).length, 6, '6 distinct AI addresses; PerplexityBot and Perplexity-User share 5.45.207.1');
eq(Object.keys(ca.days).length, 2, 'two distinct days');
eq(ca.days['2026-10-10'].all, 14, '14 requests on the 10th');
eq(ca.days['2026-10-10'].ai, 7, '7 of them from AI crawlers');
eq(ca.days['2026-10-11'].all, 1, '1 request on the 11th');
eq(ca.days['2026-10-11'].ai, 1, 'and it was an AI crawler');
eq(pathOf(ca, '/docs').ai, 2, 'both /docs requests were AI');
eq(pathOf(ca, '/').hits, 8, 'eight requests to /');
eq(pathOf(ca, '/').ai, 3, 'three of them AI: GPTBot, OAI-SearchBot, CCBot');
eq(ca.statuses[200], 10, 'ten 200s');
eq(ca.statuses[403], 2, 'two 403s');
eq(ca.statuses[500], 1, 'one 500');
eq(ca.statuses[301], 1, 'one 301');
eq(ca.statuses[404], 1, 'one 404');
eq(ca.bots.filter(b => b.kind === 'human').reduce((n, b) => n + b.hits, 0), 3, 'three non-bot lines: two browsers and one with no user agent');

console.log('[7] apache common (no user agent column)');
const cm = aggFor(common('1.2.3.4', 10, '02:00:00', '/x', 200, 100));
eq(cm.parsedCount, 1, 'the line is parsed');
eq(cm.noUa, 1, 'and flagged as carrying no user agent');
eq(cm.aiHits, 0, 'nothing can be identified without a user agent');
eq(cm.unparsed.length, 0, 'a common-format line is not discarded as junk');

console.log('[8] IIS W3C');
const W3C_HEADER = '#Fields: date time s-sitename s-computername cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) sc-status sc-substatus sc-win32-status time-taken';
const wp = S.parseLog([
  '#Software: Microsoft Internet Information Services 10.0',
  '#Version: 1.0',
  W3C_HEADER,
  '2026-10-10 02:00:01 W3SVC1 SRV GET /pricing - 80 - 20.171.206.72 ' + UAS.gptbot + ' 200 0 0 412',
  '2026-10-10 02:00:02 W3SVC1 SRV GET / - - 80 - 66.249.66.1 ' + UAS.googlebot + ' 304 0 0 88'
].join('\n'));
eq(wp.format, 'w3c', 'W3C detected');
eq(wp.lines.length, 2, 'both W3C rows parsed');
eq(wp.lines[0].ua, UAS.gptbot, 'cs(User-Agent) column read despite the spaces inside it');
eq(wp.lines[0].uri, '/pricing', 'cs-uri-stem read');
eq(wp.lines[0].status, 200, 'sc-status read');
eq(wp.lines[0].ip, '20.171.206.72', 'c-ip read');
ok(wp.lines[0].ts > 0, 'W3C date and time combined into a timestamp');
eq(S.aggregate(wp).aiHits, 1, 'GPTBot counted as AI, Googlebot not');
const w3cShort = ['#Fields: date time cs-method cs-uri-stem c-ip cs(User-Agent) sc-status sc-substatus sc-win32-status time-taken',
  '2026-10-10 02:00:03 GET /blog 20.171.206.72 Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126.0 200 0 0 88'].join('\n');
eq(S.parseLog(w3cShort).lines[0].ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126.0', 'unquoted W3C user agent reassembled from the middle');
eq(S.parseLog(w3cShort).lines[0].status, 200, 'unquoted W3C status read from the tail');
eq(S.parseLog(w3cShort).lines[0].ip, '20.171.206.72', 'unquoted W3C client address read from the head');
const w3cQuoted = ['#Fields: date time cs-method cs-uri-stem c-ip cs(User-Agent) sc-status',
  '2026-10-10 02:00:04 GET /x 20.171.206.72 "Mozilla/5.0 Chrome/126.0" 404'].join('\n');
eq(S.parseLog(w3cQuoted).lines[0].ua, 'Mozilla/5.0 Chrome/126.0', 'quoted W3C user agent read');
eq(S.parseLog(w3cQuoted).lines[0].status, 404, 'quoted W3C status read');

console.log('[9] Cloudflare Logpush NDJSON');
const np = S.parseLog([
  JSON.stringify({ ClientIP: '20.171.206.72', ClientRequestURI: '/', EdgeResponseStatus: 200, EdgeResponseBytes: 5120, UserAgent: UAS.gptbot, ClientRequestDateTime: '2026-10-10T02:00:01.000000Z' }),
  JSON.stringify({ ClientIP: '52.230.152.32', ClientRequestURI: '/pricing', EdgeResponseStatus: 404, EdgeResponseBytes: 120, UserAgent: UAS.oai, ClientRequestDateTime: '2026-10-10T02:00:02.000000Z' }),
  JSON.stringify({ client_ip: '66.249.66.1', uri: '/', status: 200, bytes: 5120, user_agent: UAS.googlebot, timestamp: 1791597603 })
].join('\n'));
eq(np.format, 'ndjson', 'NDJSON detected');
eq(np.lines.length, 3, 'three JSON rows parsed');
eq(np.lines[0].ua, UAS.gptbot, 'CamelCase UserAgent field read');
eq(np.lines[0].uri, '/', 'ClientRequestURI read');
eq(np.lines[1].status, 404, 'EdgeResponseStatus read');
eq(np.lines[0].ts, Date.parse('2026-10-10T02:00:01Z'), 'ISO timestamp read');
eq(np.lines[2].ts, 1791597603000, 'epoch seconds read as seconds, not milliseconds');
eq(np.lines[2].ua, UAS.googlebot, 'snake_case keys work too');
const na = S.aggregate(np);
eq(na.aiHits, 2, 'GPTBot and OAI-SearchBot are AI, Googlebot is not');
eq(byToken(na, 'oai-searchbot').s['4xx'], 1, '404 bucketed as 4xx');

console.log('[10] junk and empty input');
eq(S.parseLog('').lines.length, 0, 'empty input parses to nothing');
eq(S.parseLog('hello\nworld').unparsed.length, 2, 'prose lines counted as unparsed, not crashed on');
eq(S.parseLog('{"broken":').unparsed.length, 1, 'malformed JSON is unparsed, not a thrown error');
eq(S.parseLog('# comment only\n').lines.length, 0, 'a comment line is skipped');
eq(S.parseLog('1.2.3.4 garbage without a timestamp').unparsed.length, 1, 'a truncated request line is unparsed');
eq(S.parseLog('#Fields: date time\n1.2.3.4').lines.length, 1, 'a W3C file with no Fields header still keeps its rows as unparsed-or-parsed without throwing');

console.log('[11] reverse DNS query builder');
eq(S.reverseName('20.171.206.72'), 'https://dns.google/resolve?name=72.206.171.20.in-addr.arpa&type=PTR', 'IPv4 reversed');
ok(S.reverseName('2a01:4f9:c012:abcd::1').startsWith('https://dns.google/resolve?name='), 'IPv6 produces a query');
ok(!S.reverseName('20.171.206.72').includes('20.171.206.72'), 'the query does not leak the address forward-order into the hostname label');

console.log('[12] formatting and guards');
eq(S.bytes(0), '0 B', 'zero bytes');
eq(S.bytes(512), '512 B', 'bytes');
eq(S.bytes(1024), '1.0 KB', 'one kilobyte');
eq(S.bytes(1536 * 1024), '1.5 MB', 'one and a half megabytes');
eq(aggFor(Array.from({ length: 5 }, () => combined).join('\n')).parsedCount, 75, 'repeated fixtures all parse');
ok(typeof S.MAX_LINES === 'number' && S.MAX_LINES > 1000, 'a line cap is declared');

console.log('[13] anti-vacuity — defects re-injected into a copy of the page');
const broken = html
  .replace('if (l.indexOf(BOTS[i].token) >= 0 && (!best || BOTS[i].token.length > best.token.length)) best = BOTS[i];',
    'if (l.indexOf(BOTS[i].token) >= 0) best = BOTS[i];')
  .replace("return Math.floor(s / 100) + 'xx';", "return s >= 400 ? '5xx' : '2xx';")
  .replace('var ms = Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]);', 'var ms = 0;');
ok(broken !== html, 'all three defects were actually injected');
let S2;
try { S2 = loadFrom(broken); } catch (e) { console.log('  FAIL: the broken page did not even load — ' + e.message); process.exit(1); }
eq(S2.matchBot(BOTH)?.token, 'claudebot', 'DEFECT 1 visible: the longest-match rule is gone');
eq(S2.statusOf(403), '5xx', 'DEFECT 2 visible: 403 bucketed as 5xx');
eq(S2.parseClfTs('10/Oct/2026:13:55:36 +0000'), 0, 'DEFECT 3 visible: timestamps lost');

console.log('[14] the CSP must let the spoof check reach the resolver');
// BUG-331 family: _headers listed a CDN the middleware copy did not, and reading _headers said
// the site was fine when it was not. Both files are checked, and an unparseable connect-src is
// itself a failure — an empty parse is a silent green.
const HUB = path.join(import.meta.dirname, '..');
// Parse the connect-src directive out of a CSP *policy string*. Comment lines that happen to
// mention "connect-src" are prose about the policy, not the policy — reading them as policy is
// how a real rule got reported as missing (and how a real rule could get dropped unnoticed).
const connectSrc = (policy) => {
  const m = /(?:^|;)\s*connect-src\s+([^;]+)/.exec(policy);
  return m ? m[1].trim().split(/\s+/) : null;
};

// _headers: only real header lines carry a policy; '#' lines are comments.
const hdrTxt = fs.readFileSync(HUB + '/_headers', 'utf8');
const hdrPolicies = hdrTxt.split('\n')
  .filter(l => /^\s*Content-Security-Policy\s*:/.test(l))
  .map(l => l.replace(/^\s*Content-Security-Policy\s*:\s*/, '').trim());
ok(hdrPolicies.length > 0, '_headers declares at least one Content-Security-Policy');
for (const p of hdrPolicies) {
  const cs = connectSrc(p);
  ok(!!cs, '_headers: a declared Content-Security-Policy has a connect-src directive');
  ok(!!cs && cs.includes('https://dns.google'), '_headers: every declared connect-src allows https://dns.google');
}

// functions/_middleware.js: the policy lives in two string constants. The comment lines in that
// file explain the policy and even quote connect-src — they are not policy.
const mw = fs.readFileSync(HUB + '/functions/_middleware.js', 'utf8');
const mwPolicies = [...mw.matchAll(/const CSP_(?:DEFAULT|UNSAFE_EVAL)\s*=\s*"([^"]+)"/g)].map(x => x[1]);
ok(mwPolicies.length >= 2, 'functions/_middleware.js declares both CSP_DEFAULT and CSP_UNSAFE_EVAL');
for (const p of mwPolicies) {
  const cs = connectSrc(p);
  ok(!!cs, 'functions/_middleware.js: a shipped CSP constant has a connect-src directive');
  ok(!!cs && cs.includes('https://dns.google'), 'functions/_middleware.js: every shipped connect-src allows https://dns.google');
}
const m = /const CSP_DEFAULT = "([^"]+)"/.exec(mw);
ok(!!m, 'functions/_middleware.js has a parseable CSP_DEFAULT string');
if (m) {
  const cs = connectSrc(m[1]);
  ok(!!cs && cs.includes('https://dns.google'), 'the shipped CSP_DEFAULT connect-src allows https://dns.google');
}
ok(!/Google-Extended/.test(html.split('var BOTS = [')[1].split('];')[0]), 'Google-Extended is not in the bot registry, matching the note the page prints about it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);