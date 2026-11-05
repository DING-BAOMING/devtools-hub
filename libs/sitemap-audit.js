// XML sitemap parsing + indexability auditing. Pure functions, no I/O — imported by
// functions/api/sitemap-audit.js and by devtools-hub-docs/test-scripts/sitemap-audit-logic-test.mjs
// so the rules are testable in Node without a Worker runtime.
//
// Every `gsc` string below is a label Google Search Console actually shows, quoted from
// the Sitemaps report (support.google.com/webmasters/answer/7451001) or the Page indexing
// report (support.google.com/webmasters/answer/7440203). Do not invent new ones.
//
// Documented limits, from developers.google.com/search/docs/crawling-indexing/sitemaps:
// 50MB uncompressed / 50,000 URLs, fully-qualified absolute <loc>, W3C datetime <lastmod>,
// and "Google ignores <priority> and <changefreq> values".

import { checkAccess, condenseIssues, parseRobots } from './ai-crawl-audit.js';

const MAX_BYTES = 52428800; // 50MB uncompressed
const MAX_URLS = 50000;
const MAX_URL_LENGTH = 2048;
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

// Only the two formats Google documents as acceptable. A bare local date, a
// slash-separated date, or a datetime with no timezone are all rejected by Search Console
// as "Invalid date", so they are rejected here too rather than passed through quietly.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function attr(tag, name) {
  const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '';
}

function unescapeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Everything needed is inside <head>, which is always the first few kilobytes. Reading the
// whole document for a canonical tag would cost 10x the CPU for no extra signal, so the
// caller is expected to hand over a head slice rather than a full page.
export function headFacts(html) {
  const head = String(html || '').slice(0, 30000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  let metaRobots = null;
  for (const tag of metas) {
    const name = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') continue;
    metaRobots = (metaRobots || '') + ',' + (attr(tag, 'content') || '');
  }
  const links = head.match(/<link\b[^>]*>/gi) || [];
  let canonical = null;
  for (const tag of links) {
    if (!/\brel\s*=\s*("[^"]*canonical[^"]*"|'[^']*canonical[^']*'|canonical)/i.test(tag)) continue;
    canonical = attr(tag, 'href');
    break;
  }
  return {
    metaRobots,
    // A robots meta that also allows everything else is still a noindex page: the single
    // most common real cause of a valid sitemap with zero indexed pages.
    noindex: metaRobots ? /(^|[\s,])noindex([\s,]|$)/i.test(metaRobots) : null,
    canonical: canonical ? unescapeXml(canonical).trim() : null,
  };
}

function entriesOf(xml, tagName) {
  const out = [];
  const re = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)</' + tagName + '>', 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const locs = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi) || [];
    out.push({
      locs: locs.map((l) => unescapeXml(l.replace(/<\/?loc[^>]*>/gi, '')).trim()),
      lastmod: (block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i) || [null, null])[1] === null ? null : unescapeXml(block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)[1]).trim(),
      hasChangefreq: /<changefreq>/i.test(block),
      hasPriority: /<priority>/i.test(block),
    });
  }
  return out;
}

export function parseSitemap(text, contentType) {
  const raw = String(text || '');
  const body = raw.replace(/^﻿/, '');
  const type = String(contentType || '').toLowerCase();
  const result = {
    kind: 'unknown',
    rootTag: null,
    namespace: null,
    bytes: Buffer.byteLength(raw, 'utf8'),
    startsWithXmlDecl: /^﻿?\s*<\?xml/i.test(body),
    leadingWhitespace: /^\s+/.test(body),
    entries: [],
    notes: [],
  };

  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(body)) {
    result.kind = 'html';
    result.notes.push('The file loads in a browser and is really an HTML page. A crawler parsing it strictly finds no sitemap at all.');
    return result;
  }
  if (type && !/(xml|text\/plain|application\/(g?zip|x-gzip)|octet-stream)/.test(type)) {
    result.notes.push('Served as ' + type.split(';')[0].trim() + ' rather than XML. Most crawlers still read it, but text/xml or application/xml is what the spec asks for.');
  }

  const urlset = body.match(/<urlset\b[^>]*>/i);
  const index = body.match(/<sitemapindex\b[^>]*>/i);
  if (urlset) {
    result.kind = 'urlset';
    result.rootTag = 'urlset';
    result.namespace = attr(urlset[0], 'xmlns');
    result.entries = entriesOf(body, 'url');
  } else if (index) {
    result.kind = 'sitemapindex';
    result.rootTag = 'sitemapindex';
    result.namespace = attr(index[0], 'xmlns');
    result.entries = entriesOf(body, 'sitemap');
  } else if (!/[<]/.test(body) && /\S+\s+\S*/.test(body)) {
    result.kind = 'text';
    result.entries = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ locs: [l], lastmod: null, hasChangefreq: false, hasPriority: false }));
    result.notes.push('This is a plain text sitemap, which the protocol allows as long as it contains nothing but URLs, one per line.');
  } else {
    result.kind = 'invalid';
    result.notes.push('No <urlset>, <sitemapindex> or URL list was found. The body does not look like a sitemap at all.');
  }
  return result;
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return null; }
}
// Google treats a domain and its www form as the same site, so host comparisons for
// "is this URL on the same site as the sitemap" go through here.
function bareHost(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }
function pathOf(u) {
  try { const p = new URL(u).pathname; return p || '/'; } catch (e) { return null; }
}
// Two URLs that differ only by a trailing slash, a www prefix or a tracking parameter are
// the same page to a crawler. Google calls the result "Duplicate without user-selected
// canonical": it picks one and drops the other from the index.
function nearDupKey(u) {
  try {
    const p = new URL(u);
    let path = p.pathname.replace(/\/+$/, '') || '/';
    const drop = [];
    p.searchParams.forEach((v, k) => { if (/^(utm_|fbclid|gclid|ref|source)/i.test(k)) drop.push(k); });
    drop.forEach((k) => p.searchParams.delete(k));
    const host = p.hostname.toLowerCase().replace(/^www\./, '');
    return host + path + (p.search ? p.search : '');
  } catch (e) { return String(u).toLowerCase(); }
}

function classify(locs, sitemapHost, sitemapDir, nowMs) {
  const issues = [];
  if (locs.length === 0) { issues.push({ level: 'error', code: 'missing-loc', gsc: 'Missing XML tag', title: 'An entry has no <loc>', msg: 'A <url> entry with no <loc> tells a crawler nothing. Google reports this as a missing tag.', fix: 'Give every entry exactly one <loc> containing the full page URL.' }); return issues; }
  if (locs.length > 1) { issues.push({ level: 'error', code: 'dup-tag', gsc: 'Invalid XML: too many tags', title: 'An entry lists the same tag twice', msg: 'One <url> entry has ' + locs.length + ' <loc> tags. Duplicate tags in a single entry are rejected as invalid XML, and the whole entry can be dropped.', fix: 'Split the entry into separate <url> blocks, one URL each.' }); }

  const loc = locs[0];
  if (!loc) { issues.push({ level: 'error', code: 'empty-loc', gsc: 'Missing XML tag', title: 'An entry has an empty <loc>', msg: 'An empty <loc> is a tag with no value. Google skips the entry.', fix: 'Remove the entry or fill in the URL.' }); return issues; }
  if (!/^https?:\/\//i.test(loc)) {
    issues.push({ level: 'error', code: 'relative-loc', gsc: 'Invalid URL', title: 'Not a full URL: ' + loc, msg: 'Google documents that a sitemap must use fully-qualified, absolute URLs. It crawls each entry exactly as written, so a relative path is not resolved against anything.', fix: 'Write the complete URL including scheme and host, for example https://' + (sitemapHost || 'example.com') + '/page.html.' });
    return issues;
  }
  if (loc.length > MAX_URL_LENGTH) {
    issues.push({ level: 'warn', code: 'url-too-long', gsc: 'Invalid URL', title: 'URL is ' + loc.length + ' characters', msg: 'The protocol caps a <loc> value at ' + MAX_URL_LENGTH + ' characters.', fix: 'Shorten the URL. Session ids, tracking parameters and long slugs are the usual cause.' });
  }
  const host = hostOf(loc);
  // bareHost folds away the www prefix, because Google treats example.com and
  // www.example.com as one site: a www split is reported once as a path mismatch by
  // auditStructure, and calling it "not allowed" here would cry wolf on a very common setup.
  if (host && sitemapHost && bareHost(host) !== bareHost(sitemapHost)) {
    issues.push({ level: 'error', code: 'off-host', gsc: 'URL not allowed', title: 'Different site than the sitemap: ' + loc, msg: 'This URL is on ' + host + ' while the sitemap itself is on ' + sitemapHost + '. Google reports cross-domain entries as not allowed, and a URL at a higher level of the same site is reported the same way.', fix: 'Move the URL into its own sitemap for that domain, and submit each sitemap from the robots.txt of the site it belongs to.' });
  } else if (host && sitemapHost && host === sitemapHost && sitemapDir) {
    const p = pathOf(loc);
    if (p && !(p + '/').startsWith(sitemapDir + '/') && p !== sitemapDir) {
      issues.push({ level: 'info', code: 'outside-dir', gsc: null, title: 'Outside the sitemap directory: ' + loc, msg: 'Google documents that a sitemap affects only descendants of the directory it sits in, unless you also submit it through Search Console. This URL sits above ' + sitemapDir + '.', fix: 'Either submit the sitemap in Search Console as well, or host it at the site root.' });
    }
  }
  return issues;
}

export function auditStructure(parsed, opts) {
  const { sitemapUrl, bytes, nowMs } = opts;
  const issues = [];
  const add = (level, code, gsc, title, msg, fix, urls) => issues.push({ level, code, gsc, title, msg, fix, urls: urls || [] });

  if (parsed.kind === 'html') {
    add('error', 'is-html', 'Unsupported format', 'That URL is an HTML page, not a sitemap', 'The response body is markup, so there is nothing for a crawler to parse. This is usually a 404 page returning a 200 status.', 'Publish the XML at that path, or point the Sitemap: line at the real file.');
    return { issues: condenseIssues(issues), total: 0, unique: 0, duplicates: [] };
  }
  if (parsed.kind === 'invalid') {
    add('error', 'unparseable', 'Parsing error', 'This does not parse as a sitemap', parsed.notes.join(' '), 'Check the raw XML in the section below. The first tag has to be <?xml or <urlset>.');
    return { issues: condenseIssues(issues), total: 0, unique: 0, duplicates: [] };
  }
  // A well-formed XML file starts with "<". Anything else at position 0 is the whitespace
  // Search Console reports as "Leading whitespace"; it does not block processing but it is
  // not valid XML and it is free to fix.
  if (parsed.leadingWhitespace && parsed.kind === 'urlset') {
    add('error', 'leading-ws', 'Leading whitespace', 'The file starts with whitespace instead of a declaration', 'Search Console reports this as leading whitespace. It does not block processing, but it is not valid XML and it is free to fix.', 'Start the file with <?xml version="1.0" encoding="UTF-8"?> on the first line.');
  }
  if (parsed.namespace && parsed.namespace !== NS) {
    add('error', 'ns', 'Incorrect namespace', 'Wrong namespace: ' + parsed.namespace, 'The namespace in the header has to be ' + NS + '.', 'Set xmlns="' + NS + '" on the <' + (parsed.rootTag || 'urlset') + '> tag.');
  }
  if (bytes > MAX_BYTES) {
    add('error', 'too-big', 'Sitemap file size error', 'File is ' + (bytes / 1048576).toFixed(1) + 'MB, over the 50MB limit', 'Google caps one sitemap at 50MB uncompressed. A file over the limit may not be read at all.', 'Split the URLs across several sitemaps and list them in a sitemap index file.');
  }

  const total = parsed.entries.length;
  if (total === 0) {
    add('error', 'empty', 'Empty sitemap', 'The sitemap lists no URLs', 'An empty sitemap is reported as an error rather than ignored, and it tells a crawler there is nothing new here.', 'Add your indexable URLs, or remove the sitemap and its Sitemap: line if the site is genuinely empty.');
  }
  if (total > MAX_URLS) {
    add('error', 'too-many', 'Too many URLs', 'Lists ' + total.toLocaleString() + ' URLs, over the 50,000 limit', 'One sitemap may hold at most 50,000 URLs.', 'Split into multiple sitemaps behind a sitemap index file.');
  }

  const sitemapHost = hostOf(sitemapUrl);
  const sitemapDir = (() => { try { return new URL(sitemapUrl).pathname.replace(/\/[^/]*$/, ''); } catch (e) { return null; } })();

  const perEntry = [];
  const seen = new Map();
  const near = new Map();
  const dupes = [];
  const lastmods = [];
  let changefreqCount = 0;
  let priorityCount = 0;
  const wwwInSitemap = /^www\./.test(sitemapHost || '') ? 'www' : sitemapHost ? 'bare' : null;
  const wwwSeen = new Set();

  parsed.entries.forEach((e, i) => {
    const ei = classify(e.locs, sitemapHost, sitemapDir, nowMs);
    const loc = e.locs[0] || null;
    perEntry.push({ index: i, loc, lastmod: e.lastmod, issues: ei });

    if (e.hasChangefreq) changefreqCount++;
    if (e.hasPriority) priorityCount++;
    if (e.lastmod) {
      lastmods.push({ loc, value: e.lastmod });
      if (!DATE_ONLY_RE.test(e.lastmod) && !DATE_TIME_RE.test(e.lastmod)) {
        ei.push({ level: 'error', code: 'bad-date', gsc: 'Invalid date', title: 'Unparseable <lastmod>: ' + e.lastmod, msg: 'Google accepts W3C datetime, with the time optional. Both "2005-02-21" and "2005-02-21T18:00:15+00:00" are valid. A slash-separated date, a day-first date, or a datetime with no timezone is not.', fix: 'Use YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS+00:00 with a timezone.' });
      } else {
        const t = Date.parse(e.lastmod);
        if (Number.isNaN(t)) {
          ei.push({ level: 'error', code: 'bad-date', gsc: 'Invalid date', title: 'Impossible date: ' + e.lastmod, msg: 'The format is right but the date does not exist.', fix: 'Check the month and day. ' + e.lastmod + ' is not a real date.' });
        } else if (t > nowMs + 86400000) {
          ei.push({ level: 'error', code: 'future-date', gsc: 'Invalid date', title: 'Future <lastmod>: ' + e.lastmod, msg: 'The date is in the future, so the page cannot have been modified then. Search engines discard an untrustworthy lastmod.', fix: 'Set the date the page was actually last modified.' });
        }
      }
    }

    if (loc && /^https?:\/\//i.test(loc)) {
      if (seen.has(loc)) {
        dupes.push(loc);
        ei.push({ level: 'error', code: 'dup-exact', gsc: 'Invalid XML: too many tags', title: 'Listed more than once: ' + loc, msg: 'This exact URL appears ' + (seen.get(loc) + 1) + ' times in the same sitemap.', fix: 'Keep one entry. Duplicate entries waste crawl budget and Google reports the file as having duplicate tags.' });
      } else seen.set(loc, 1);
      const k = nearDupKey(loc);
      if (near.has(k) && near.get(k) !== loc) ei.push({ level: 'warn', code: 'dup-near', gsc: null, title: 'Same page as ' + near.get(k), msg: 'These two URLs differ only by a trailing slash, a www prefix or a tracking parameter, so a crawler sees one page submitted twice. Google picks one as canonical and drops the other, which is reported as "Duplicate without user-selected canonical".', fix: 'Keep the URL you want in the index, remove the other, and make sure the page itself declares it with <link rel="canonical">.', urls: [near.get(k)] });
      else near.set(k, loc);
      const h = hostOf(loc);
      if (h) wwwSeen.add(/^www\./.test(h) ? 'www' : 'bare');
    }
  });

  const wwwMismatch = wwwInSitemap && wwwSeen.size === 1 && !wwwSeen.has(wwwInSitemap);
  if (wwwSeen.size === 2 || wwwMismatch) {
    const urlsWww = [...seen.keys()].filter((u) => /^www\./.test(hostOf(u) || ''));
    add('error', 'www-mix', wwwMismatch ? (wwwInSitemap === 'bare' ? 'Path mismatch: Includes www' : 'Path mismatch: Missing www') : 'Path mismatch',
      wwwMismatch ? 'The file is served from ' + sitemapHost + ' but lists URLs on ' + (wwwInSitemap === 'bare' ? 'www.' + bareHost(sitemapHost) : bareHost(sitemapHost)) : 'The sitemap mixes www and non-www URLs',
      'Google treats ' + bareHost(sitemapHost) + ' and www.' + bareHost(sitemapHost) + ' as one site and reports the difference as a path mismatch rather than a cross-domain error. ' + (wwwMismatch ? 'Every URL listed is still reachable, but the file reads as a different path than the one it is served from, and Google is left choosing which form is canonical for every page.' : 'Listing both leaves it choosing which one is canonical for every page.'),
      'Pick one host and make every <loc> use it, matching whichever one the site actually redirects to. Serve the sitemap from that same host.', urlsWww.slice(0, 10));
  }
  if (dupes.length) {
    add('error', 'dups', 'Invalid XML: too many tags', dupes.length + ' URL' + (dupes.length === 1 ? '' : 's') + ' listed twice', 'Duplicate entries waste crawl budget and are reported as an XML error.', 'Deduplicate the generator output. The offending URLs are in the per-URL table.', dupes.slice(0, 10));
  }

  const dated = lastmods.filter((l) => !DATE_ONLY_RE.test(l.value) && !DATE_TIME_RE.test(l.value) || Number.isNaN(Date.parse(l.value)));
  if (lastmods.length === 0 && total > 0) {
    add('info', 'no-lastmod', null, 'No <lastmod> on any URL', 'Optional, so this is not an error. Google uses lastmod when it is consistently accurate, and it is the cheapest freshness signal you can hand a crawler.', 'Add <lastmod> as the date each page last changed meaningfully. Not the date the sitemap was generated.');
  } else if (total >= 10 && new Set(lastmods.map((l) => l.value)).size === 1 && lastmods.length === total) {
    add('warn', 'same-lastmod', 'Invalid date', 'Every URL has the same <lastmod>: ' + lastmods[0].value, 'One identical timestamp across the whole file is the signature of a build time, not a modification date. Google states it uses lastmod only when it is consistently and verifiably accurate, so a constant value teaches it nothing and invites the date to be distrusted.', 'Set lastmod per page from that page own modification time, or drop the tag rather than fill it with the build date.');
  } else if (dated.length) {
    add('error', 'bad-dates', 'Invalid date', dated.length + ' lastmod value' + (dated.length === 1 ? ' is' : 's are') + ' not in W3C datetime format', 'Accepted formats are YYYY-MM-DD and YYYY-MM-DDTHH:MM:SS+00:00. The time is optional; the timezone is not optional when the time is present.', 'Reformat those entries. The exact values are listed against each URL below.', dated.slice(0, 10).map((l) => l.loc));
  }

  if (changefreqCount) add('info', 'changefreq', null, '<changefreq> on ' + changefreqCount + ' URL' + (changefreqCount === 1 ? '' : 's'), 'Google states plainly that it ignores <priority> and <changefreq> values. The tags are valid, they are simply never read, and they make the file larger.', 'Drop both tags. They cost bytes and buy nothing.');
  if (priorityCount) add('info', 'priority', null, '<priority> on ' + priorityCount + ' URL' + (priorityCount === 1 ? '' : 's'), 'Same as <changefreq>: Google ignores it. Ranking is not something a sitemap can request.', 'Drop the tag.');
  if (parsed.kind === 'sitemapindex' && total > 50000) {
    add('error', 'too-many-sitemaps', 'Too many sitemaps', 'Index file lists ' + total.toLocaleString() + ' sitemaps', 'The cap is 50,000 entries per index file, and 500 index files per site.', 'Split the index.');
  }
  if (parsed.kind === 'sitemapindex') {
    parsed.entries.forEach((e, i) => {
      const loc = e.locs[0] || '';
      if (loc && sitemapUrl && nearDupKey(loc) === nearDupKey(sitemapUrl)) {
        perEntry[i].issues.push({ level: 'error', code: 'nested-index', gsc: 'Incorrect sitemap index format: Nested sitemap indexes', title: 'The index lists itself', msg: 'A sitemap index file may only list sitemap files. It cannot list another index file, including its own URL.', fix: 'Point the entry at the child sitemap, not at the index.' });
      }
    });
  }

  return { issues: condenseIssues(issues), perEntry, total, unique: seen.size, duplicates: dupes, changefreqCount, priorityCount, lastmodCount: lastmods.length };
}

// The live half of the audit. robotsTxt is passed in already fetched; robotsParsed comes
// from ai-crawl-audit so the same RFC 9309 precedence decides both halves.
export function classifyLive(loc, probe, robotsTxt) {
  const issues = [];
  const robots = robotsTxt ? parseRobots(robotsTxt) : null;
  const p = pathOf(loc);

  if (robots) {
    const acc = checkAccess(robots, 'Googlebot', p);
    if (!acc.allowed) {
      issues.push({ level: 'error', code: 'robots-block', gsc: 'URL blocked by robots.txt', title: 'Blocked for Googlebot by robots.txt', msg: 'The rule "' + acc.rule + '" in the ' + (acc.source === 'agent' ? 'Googlebot' : 'wildcard') + ' group stops Google from crawling this URL, while the sitemap is asking it to. Google ignores a blocked URL and the sitemap entry does nothing.', fix: 'Remove or narrow the Disallow rule, or take the URL out of the sitemap. You cannot ask for both.' });
    }
  }
  if (probe.status === 0) {
    issues.push({ level: 'warn', code: 'unreachable', gsc: null, title: 'The URL did not answer', msg: 'The request failed: ' + (probe.error || 'no response') + '. A crawler would see the same thing.', fix: 'Check the URL in a browser. If it works there and not here, the host is probably refusing this user agent.' });
    return issues;
  }
  if (probe.xRobotsTag && /noindex/i.test(probe.xRobotsTag)) {
    issues.push({ level: 'error', code: 'xrobots-noindex', gsc: 'URL marked noindex', title: 'X-Robots-Tag: noindex', msg: 'The response header "' + probe.xRobotsTag + '" tells Google not to index this page.', fix: 'Remove the header for this path.' });
  }
  if (probe.status >= 300 && probe.status < 400) {
    issues.push({ level: 'error', code: 'redirect', gsc: 'Page with redirect', title: 'Returns ' + probe.status + ' instead of a page', msg: 'A sitemap should list final destinations, not redirects. Google reports these as URLs not followed and spends crawl budget on the hop.', fix: 'Put the destination URL in the sitemap, or make this URL serve a 200 directly.', gscUrl: probe.location || null });
  } else if (probe.status === 404 || probe.status === 410) {
    issues.push({ level: 'error', code: 'gone', gsc: probe.status === 403 ? 'Blocked due to access forbidden (403)' : 'URL blocked due to other 4xx issue', title: 'Returns ' + probe.status, msg: 'The URL is in the sitemap but does not exist. Google reports 4xx pages as blocked and stops retrying them.', fix: 'Remove the entry, or restore the page.' });
  } else if (probe.status === 403) {
    issues.push({ level: 'error', code: 'forbidden', gsc: 'Blocked due to access forbidden (403)', title: 'Returns 403', msg: 'The server refuses to serve this URL to us. It may be a bot block, a geo restriction, or a missing permission.', fix: 'Check the page in a browser with a logged-out session, then look at your WAF or .htaccess rules.' });
  } else if (probe.status >= 500) {
    issues.push({ level: 'error', code: 'server', gsc: 'HTTP error', title: 'Returns ' + probe.status, msg: 'The server is failing on this URL.', fix: 'Fix the server error first. A 5xx page listed in a sitemap is a crawl error Google will keep retrying.' });
  } else if (probe.status >= 200 && probe.status < 300 && probe.html) {
    const f = headFacts(probe.html);
    if (f.noindex) {
      issues.push({ level: 'error', code: 'meta-noindex', gsc: 'URL marked noindex', title: 'Page has <meta name="robots" content="' + f.metaRobots.replace(/^,/, '').trim() + '">', msg: 'The page tells Google not to index it, and the sitemap tells Google to. The page wins, so this entry is dead weight and is reported as a URL marked noindex.', fix: 'Remove the noindex from the head, or take the URL out of the sitemap.' });
    }
    if (f.canonical && f.canonical !== loc) {
      issues.push({ level: 'error', code: 'canonical-other', gsc: 'Alternate page with proper canonical tag', title: 'Canonical points somewhere else', msg: 'The page declares <link rel="canonical" href="' + f.canonical + '">. Google treats this URL as an alternate and keeps the other one in the index, so listing this one in the sitemap is self-defeating.', fix: 'Either list ' + f.canonical + ' in the sitemap instead, or drop the canonical tag if this page is the one you want indexed.' });
    }
  }
  return issues;
}

const GRADES = [
  [95, 'A'], [85, 'B'], [72, 'C'], [58, 'D'], [40, 'E'],
];

export function gradeOf(errors, warns, deadUrls, totalUrls) {
  // Each dead URL already arrives as an error, so it is counted twice on purpose: once for
  // the finding and once for the ratio, because "one in four pages is broken" is a different
  // kind of problem from "one page is broken". The ratio term is capped so a tiny sample with
  // a bad draw cannot outweigh the rest of the report.
  const deadRatio = totalUrls > 0 ? deadUrls / totalUrls : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - errors * 9 - warns * 3 - Math.min(25, deadRatio * 50))));
  const grade = (GRADES.find((g) => score >= g[0]) || [0, 'F'])[1];
  return { score, grade };
}

export function buildCleanSitemap(locs) {
  const body = locs.map((u) => '  <url>\n    <loc>' + String(u).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</loc>\n  </url>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="' + NS + '">\n' + body + '\n</urlset>\n';
}

export function robotsSitemapLine(url) {
  return 'Sitemap: ' + url;
}
