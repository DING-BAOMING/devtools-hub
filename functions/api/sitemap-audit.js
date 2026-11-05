// XML sitemap auditor. Input: a domain (discover the sitemap first) or a sitemap URL.
// Fetches robots.txt once, the sitemap once, then samples N page URLs and checks whether
// each one is actually indexable — which is the part status-code-only tools skip.
import { checkAccess, normalizeDomain, parseRobots } from '../../libs/ai-crawl-audit.js';
import { auditStructure, buildCleanSitemap, classifyLive, gradeOf, parseSitemap } from '../../libs/sitemap-audit.js';

const UA = 'Mozilla/5.0 (compatible; DevToolsHub-Sitemap-Audit/1.0; +https://tools.scoreroute.com/tools/sitemap-audit/)';
const TIMEOUT_MS = 8000;
const MAX_SITEMAP_BYTES = 6000000;
const MAX_HEAD_BYTES = 30000;
const MAX_URLS = 35; // 2 (robots) + 6 (probes) + 2 (index + child) + 35 = 45 subrequests, under the free-plan cap of 50
const PROBE_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml', '/sitemap0.xml'];

async function fetchRaw(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // redirect: 'manual' on every outbound request. Following a redirect would let a
    // public host bounce us to a private address, and a redirecting sitemap is itself a
    // finding worth reporting rather than a hop worth hiding.
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': accept },
      redirect: 'manual',
      signal: controller.signal,
    });
    return { status: res.status, location: res.headers.get('location'), type: (res.headers.get('content-type') || '').toLowerCase(), res };
  } catch (e) {
    return { status: 0, location: null, type: '', res: null, error: e && e.name === 'AbortError' ? 'timed out after ' + TIMEOUT_MS / 1000 + 's' : (e && e.message) || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Reads at most MAX_HEAD_BYTES and closes the stream. A page's robots meta and canonical
// link live in <head>, so the rest of the document is bytes we would pay CPU to scan and
// throw away — that is the whole reason this cap exists.
async function readCapped(res, max) {
  if (!res || !res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    while (total < max) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
      total += chunk.value.length;
    }
  } catch (e) {
    // A truncated body is fine here: we wanted the head, not the document.
  }
  try { await reader.cancel(); } catch (e) { /* already closed */ }
  return out;
}

async function fetchText(url, accept) {
  const r = await fetchRaw(url, accept);
  if (r.status < 200 || r.status >= 300) return { status: r.status, location: r.location, type: r.type, text: '', error: r.error || null };
  return { status: r.status, location: r.location, type: r.type, text: (await readCapped(r.res, MAX_SITEMAP_BYTES)).slice(0, MAX_SITEMAP_BYTES), error: null };
}

// Most of the web redirects /sitemap.xml to the www host, and Google follows that hop when
// it reads a sitemap. Refusing to follow it would report "no sitemap" on a large share of
// sites, so one hop is followed here and then reported as a note. The hop target goes
// through the same normalizeDomain guard, so a redirect cannot walk us to a private address.
async function fetchSitemapText(url) {
  const first = await fetchText(url, 'application/xml,text/xml,text/plain,*/*;q=0.5');
  if (first.status < 300 || first.status >= 400 || !first.location) return first;
  const target = new URL(first.location, url).toString();
  if (normalizeDomain(new URL(target).hostname) === null) return first;
  const second = await fetchText(target, 'application/xml,text/xml,text/plain,*/*;q=0.5');
  if (second.status !== 200) {
    // The hop landed somewhere real but still not on a sitemap. Recording the chain is more
    // useful than a bare "not found": it shows the path is a redirect dead end, not a
    // guess that the site has no sitemap.
    return Object.assign(first, { hopTo: target, hopStatus: second.status });
  }
  return Object.assign(second, { redirectedFrom: url, redirectStatus: first.status, finalUrl: target });
}

// Evenly spread rather than "the first N", because on a real site the first twenty <loc>
// entries are the homepage and its immediate children. The interesting breakage sits in
// the tail, so a head-of-list sample would report a clean bill of health on a broken site.
function spread(list, n) {
  if (list.length <= n) return list.map((_, i) => i);
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(i * step));
  return out;
}

async function probePage(u) {
  const r = await fetchRaw(u, 'text/html,application/xhtml+xml,*/*;q=0.5');
  if (r.status === 0) return { status: 0, html: '', xRobotsTag: null, location: null, error: r.error };
  const xRobotsTag = r.res ? r.res.headers.get('x-robots-tag') : null;
  const html = r.status >= 200 && r.status < 300 && r.res ? await readCapped(r.res, MAX_HEAD_BYTES) : '';
  return { status: r.status, html, xRobotsTag, location: r.location, error: null };
}

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
  if (context.request.method !== 'GET') return new Response(JSON.stringify({ error: 'Use GET' }), { status: 405, headers });

  try {
    const q = new URL(context.request.url).searchParams;
    const raw = String(q.get('url') || '').trim();
    if (!raw) return new Response(JSON.stringify({ error: 'Enter a domain or a sitemap URL.' }), { status: 400, headers });

    const sample = Math.max(0, Math.min(MAX_URLS, parseInt(q.get('sample') || '20', 10) || 20));
    const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    let parsed;
    try { parsed = new URL(withScheme); } catch (e) { parsed = null; }
    if (!parsed) return new Response(JSON.stringify({ error: 'That does not parse as a URL.' }), { status: 400, headers });

    // SSRF guard: normalizeDomain rejects IP literals, bare hostnames and private suffixes.
    // Everything fetched below is on this one host, so one check covers the whole run.
    const domain = normalizeDomain(parsed.hostname);
    if (!domain) return new Response(JSON.stringify({ error: 'Enter a public domain such as example.com. Private hosts and IP addresses are not accepted.' }), { status: 400, headers });

    const origin = parsed.protocol + '//' + domain;
    const directSitemap = q.get('sitemap') === '1' || (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '');

    // Some hosts only answer on one scheme, so a failed https probe is retried over http
    // before the file is called missing.
    let robotsProbe = await fetchText(origin + '/robots.txt', 'text/plain,*/*;q=0.5');
    if (robotsProbe.status !== 200) {
      const overHttp = await fetchText('http://' + domain + '/robots.txt', 'text/plain,*/*;q=0.5');
      if (overHttp.status === 200) robotsProbe = overHttp;
    }
    const robots = robotsProbe.status === 200 ? robotsProbe.text : '';
    const declared = parseRobots(robots).sitemaps;

    let sitemapUrl = null;
    let source = null;
    let sitemap = null;
    const discovered = [];

    if (directSitemap) {
      sitemapUrl = origin + (parsed.pathname === '/' ? '/sitemap.xml' : parsed.pathname) + (parsed.search || '');
      sitemap = await fetchSitemapText(sitemapUrl);
    } else if (declared.length) {
      source = 'robots.txt';
      for (const candidate of declared.slice(0, 2)) {
        const u = /^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate;
        if (normalizeDomain(new URL(u).hostname) !== domain) continue;
        const s = await fetchSitemapText(u);
        if (s.status === 200) { sitemapUrl = s.finalUrl || u; sitemap = s; break; }
        discovered.push({ url: s.finalUrl || u, status: s.status, via: s.redirectedFrom ? s.redirectStatus : null });
      }
    }

    // Only spend the probe requests when robots.txt did not already name a sitemap.
    if (!sitemap) {
      const probed = await Promise.all(PROBE_PATHS.map(async (p) => {
        const u = origin + p;
        const s = await fetchSitemapText(u);
        return { url: u, status: s.status, text: s.text, type: s.type, location: s.location, hopTo: s.hopTo, hopStatus: s.hopStatus, finalUrl: s.finalUrl };
      }));
      const hits = probed.filter((r) => r.status === 200 && r.text.trim().length > 0);
      // robots.txt is the more trustworthy source, so it wins even when a probe also matched.
      const pick = hits.find((h) => /<(urlset|sitemapindex)\b/i.test(h.text)) || hits[0];
      for (const r of probed) {
        let note;
        if (r.status === 200) note = /<(urlset|sitemapindex)\b/i.test(r.text) ? 'valid' : 'not a sitemap';
        else if (r.hopTo) note = r.status + ' -> ' + r.hopStatus;
        else if (r.status === 0) note = 'unreachable';
        else note = String(r.status);
        discovered.push({ url: r.url, status: r.status, note: note });
      }
      if (pick) { sitemapUrl = pick.finalUrl || pick.url; source = 'common path'; sitemap = { status: 200, type: pick.type, text: pick.text, location: pick.location, error: null }; }
    }

    if (!sitemap || !sitemapUrl) {
      return new Response(JSON.stringify({
        domain,
        robotsFound: robotsProbe.status === 200,
        robotsStatus: robotsProbe.status,
        declaredSitemaps: declared,
        discovered,
        sitemap: { found: false },
        message: 'No sitemap was found at any of the six common paths, and robots.txt does not name one. The path each probe returned is listed below, so a redirect dead end is distinguishable from a missing file.',
        fixes: ['Add a Sitemap: line to robots.txt.', 'Publish /sitemap.xml at the site root.'],
      }), { headers });
    }

    const auditHost = normalizeDomain(new URL(sitemapUrl).hostname) || domain;
    const nowMs = Date.now();
    const parsedSitemap = parseSitemap(sitemap.text, sitemap.type);

    // A sitemap index lists sitemaps, not pages. Audit the first child so the per-URL table
    // has real URLs in it, and say plainly in the UI which child was used.
    let activeSitemapUrl = sitemapUrl;
    let activeParsed = parsedSitemap;
    let indexChild = null;
    if (parsedSitemap.kind === 'sitemapindex' && parsedSitemap.entries.length) {
      const childUrl = parsedSitemap.entries[0].locs[0];
      if (childUrl && /^https?:\/\//i.test(childUrl)) {
        const child = await fetchSitemapText(childUrl);
        if (child.status === 200) {
          const childParsed = parseSitemap(child.text, child.type);
          if (childParsed.kind === 'urlset') { activeSitemapUrl = childUrl; activeParsed = childParsed; indexChild = { url: childUrl, status: 200, total: childParsed.entries.length }; }
          else indexChild = { url: childUrl, status: 200, total: 0, note: 'not a urlset' };
        } else indexChild = { url: childUrl, status: child.status, total: 0 };
      }
    }

    const structure = auditStructure(activeParsed, { sitemapUrl: activeSitemapUrl, bytes: activeParsed.bytes, nowMs });
    const perEntry = structure.perEntry || [];

    const findable = perEntry.filter((e) => e.loc && /^https?:\/\//i.test(e.loc));
    const picks = spread(findable, sample);
    const probes = await Promise.all(picks.map((i) => probePage(findable[i].loc).then((p) => ({ i, p }))));

    const liveByIndex = new Map();
    for (const { i, p } of probes) liveByIndex.set(i, p);

    const urls = perEntry.map((e) => {
      const idx = findable.indexOf(e);
      const p = idx >= 0 && liveByIndex.has(idx) ? liveByIndex.get(idx) : null;
      const issues = e.issues.slice();
      if (p) {
        // checked marks an issue that required a live fetch, so the grade can weight real
        // indexability failures above a static formatting nit.
        for (const li of classifyLive(e.loc, p, robots)) { li.checked = true; issues.push(li); }
      }
      return {
        loc: e.loc,
        lastmod: e.lastmod,
        issues,
        live: p ? { status: p.status, location: p.location, error: p.error || null, checked: true } : { checked: false },
      };
    });

    const structural = structure.issues;
    const urlIssues = urls.flatMap((u) => u.issues);
    const all = structural.concat(urlIssues);
    const errors = all.filter((i) => i.level === 'error').length;
    const warns = all.filter((i) => i.level === 'warn').length;
    const dead = urls.filter((u) => u.issues.some((i) => i.level === 'error' && i.checked)).length;
    const sampled = picks.length;
    const { score, grade } = gradeOf(errors, warns, dead, sampled);

    // The "clean sitemap" is the audited file with every URL that cannot be indexed removed.
    // It is the one output that turns a report into a fix. It is built from what was
    // examined, so `fullCoverage` tells the page whether to present it as a replacement file
    // or as a sample — a sitemap rewritten from a sample is not the same as a fixed one.
    const cleanable = urls.filter((u) => u.loc && /^https?:\/\//i.test(u.loc) && !u.issues.some((i) => i.level === 'error' && i.checked));

    const MAX_ROWS = 300;
    const worthShowing = urls.filter((u) => u.live.checked || u.issues.length > 0);
    const rows = worthShowing.length > MAX_ROWS ? worthShowing.slice(0, MAX_ROWS) : worthShowing;
    const rowsOmitted = worthShowing.length - rows.length;

    const robotsRules = robots ? parseRobots(robots) : null;
    // Same RFC 9309 decision the per-URL check uses, so a path cannot be reported as
    // blocked in one place and allowed in another.
    const sitemapBlocked = robotsRules ? !checkAccess(robotsRules, 'Googlebot', new URL(sitemapUrl).pathname).allowed : false;

    const notes = [];
    if (sitemap.redirectedFrom) notes.push('The path you gave redirects (' + sitemap.redirectStatus + ') to ' + sitemapUrl + '. Google follows that hop, but publishing the file at the final address saves a request on every crawl.');
    if (sitemapBlocked) notes.push('robots.txt blocks Googlebot from the sitemap path itself, so the file is never read. Google reports this as "Sitemap contains urls which are blocked by robots.txt".');
    if (sitemap.type && /text\/html/i.test(sitemap.type) && parsedSitemap.kind !== 'html') notes.push('The file is served as ' + sitemap.type.split(';')[0].trim() + '. XML is the documented type.');
    notes.push.apply(notes, parsedSitemap.notes);

    return new Response(JSON.stringify({
      domain,
      auditHost,
      sitemapUrl,
      activeSitemapUrl,
      source,
      indexChild,
      robots: {
        found: robotsProbe.status === 200,
        status: robotsProbe.status,
        declaredSitemaps: declared,
        blocksSitemap: sitemapBlocked,
      },
      discovered,
      sitemap: {
        found: true,
        status: sitemap.status,
        contentType: sitemap.type,
        kind: parsedSitemap.kind,
        rootTag: parsedSitemap.rootTag,
        namespace: parsedSitemap.namespace,
        bytes: parsedSitemap.bytes,
        isIndex: parsedSitemap.kind === 'sitemapindex',
        indexEntries: parsedSitemap.kind === 'sitemapindex' ? parsedSitemap.entries.length : 0,
      },
      stats: {
        total: structure.total || 0,
        unique: structure.unique || 0,
        duplicates: (structure.duplicates || []).length,
        withLastmod: structure.lastmodCount || 0,
        withChangefreq: structure.changefreqCount || 0,
        withPriority: structure.priorityCount || 0,
      },
      sampled,
      // A 50,000-URL sitemap would otherwise ship a megabyte of unchecked rows. The rows
      // worth showing are the ones that were fetched and the ones carrying a finding, so
      // that union is sent and the rest is counted rather than transmitted.
      urls: rows,
      rowsOmitted: rowsOmitted,
      issues: structural,
      notes,
      score,
      grade,
      clean: {
        xml: buildCleanSitemap(cleanable.map((u) => u.loc)),
        kept: cleanable.length,
        examined: findable.length,
        fullCoverage: sampled >= findable.length,
      },
      generatedAt: new Date().toISOString(),
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e && e.message) || 'Audit failed' }), { headers, status: 500 });
  }
}
