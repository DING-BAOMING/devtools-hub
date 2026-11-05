// Single-page technical SEO audit. Pure functions, no I/O — imported by
// functions/api/seo-check.js and by devtools-hub-docs/test-scripts/seo-audit-logic-test.mjs
// so every rule is testable in Node without a Worker runtime.
//
// Two deliberate choices, both from what the market does NOT do (verified 2026-10-11 against
// Ahrefs, Semrush, SmallSEOTools, PrePostSEO, SEO Site Checkup, Neil Patel, WooRank, WordStream,
// SEOptimer): every finding carries a paste-ready snippet, and robots.txt is checked against
// the AI crawlers as well as Googlebot. Not one of those tools ships a fix snippet; not one of
// them checks GPTBot/ClaudeBot/PerplexityBot against a wildcard group. Those two are the tool.
//
// Indexability decisions reuse headFacts() from sitemap-audit.js and RFC 9309 precedence from
// ai-crawl-audit.js, so this page cannot report a URL as indexable that the sitemap audit calls
// blocked.

import { AI_CRAWLERS, checkAccess, condenseIssues, parseRobots } from './ai-crawl-audit.js';
import { gradeOf, headFacts } from './sitemap-audit.js';

const MAX_HTML_BYTES = 500000;

// Google publishes NO character or pixel limit for a title or a description as of 2026-10:
// developers.google.com/search/docs/appearance/title-link says a title is "truncated in
// Google Search results as needed, typically to fit the device width." So every length
// constant below is a practical target, never a rule, and each finding says which it is.
const TITLE_MIN = 30, TITLE_MAX = 60, DESC_MIN = 70, DESC_MAX = 160;

function attr(tag, name) {
  const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function textOf(s) {
  return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
}

// ---------- head parsing ----------

export function parseHead(html) {
  const src = String(html || '');
  const headEnd = src.search(/<\/head\s*>/i);
  const head = (headEnd > 0 ? src.slice(0, headEnd) : src).slice(0, 60000);

  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const byName = {};
  const og = {};
  const twitter = {};
  for (const tag of metas) {
    const name = (attr(tag, 'name') || attr(tag, 'property') || attr(tag, 'http-equiv') || '').toLowerCase();
    // Decoded here, not at read time: a description written "&amp;" is one character to a
    // browser and five to us, and every length rule below is counting characters.
    const content = decodeEntities(attr(tag, 'content') || '');
    if (!name) continue;
    if (name.indexOf('og:') === 0) { if (!og[name]) og[name] = content; }
    else if (name.indexOf('twitter:') === 0) { if (!twitter[name]) twitter[name] = content; }
    else if (!byName[name]) byName[name] = content;
  }

  const links = head.match(/<link\b[^>]*>/gi) || [];
  let canonical = null, favicon = false;
  for (const tag of links) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    // Keyed by the full attribute name ("og:title", "twitter:card"), so a consumer must index
    // twitter['twitter:card'] and not twitter.card — the prefix is part of the name.
    if (!canonical && /\bcanonical\b/.test(rel)) canonical = decodeEntities(attr(tag, 'href') || '').trim();
    if (/icon/.test(rel)) favicon = true;
  }
  for (const tag of metas) {
    const name = (attr(tag, 'name') || '').toLowerCase();
    if (name === 'msapplication-tileimage') favicon = true;
  }

  const titleM = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const htmlTag = src.match(/<html\b[^>]*>/i);
  const lang = htmlTag ? (attr(htmlTag[0], 'lang') || '').trim() : '';
  const hasCharset = /<meta\b[^>]*charset\s*=/i.test(head);

  return {
    title: titleM ? textOf(titleM[1]) : null,
    description: byName.description || null,
    robots: byName.robots || null,
    googlebot: byName.googlebot || null,
    viewport: byName.viewport || null,
    generator: byName.generator || null,
    og, twitter, canonical, favicon, lang,
    hasCharset,
    metaCount: metas.length,
  };
}

// ---------- body parsing ----------

export function parseBody(html) {
  const src = String(html || '');
  const start = src.search(/<body\b/i);
  const body = start >= 0 ? src.slice(start) : src;

  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(body)) !== null) headings.push({ level: Number(m[1]), text: textOf(m[2]).slice(0, 120) });

  const images = [];
  const imgRe = /<img\b[^>]*>/gi;
  while ((m = imgRe.exec(body)) !== null) {
    images.push({ src: (attr(m[0], 'src') || '').slice(0, 200), alt: attr(m[0], 'alt'), loading: (attr(m[0], 'loading') || '').toLowerCase() });
  }

  let internal = 0, external = 0, emptyAnchor = 0, total = 0;
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  while ((m = aRe.exec(body)) !== null) {
    const href = (attr(m[0], 'href') || '').trim();
    total++;
    if (!href || href === '#') { emptyAnchor++; continue; }
    if (/^(https?:)?\/\//i.test(href)) external++;
    else if (href[0] === '/') internal++;
    else if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    else internal++;
    if (!textOf(m[2]) && !/aria-label|title=/i.test(m[1])) emptyAnchor++;
  }

  const words = (textOf(body.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).match(/[A-Za-z0-9'’-]+/g) || []).length;

  return { headings, images, internal, external, emptyAnchor, links: total, words };
}

// ---------- structured data ----------

// One @id must mean one thing on one site (this project's own BUG-299). Two nodes declaring the
// same @id with different values is reported by name, because it splits the entity the markup is
// supposed to be describing.
function canon(node) {
  const out = {};
  Object.keys(node).sort().forEach((k) => { out[k] = node[k]; });
  return JSON.stringify(out);
}

export function parseSchema(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (!/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) continue;
    const raw = m[2].trim();
    const block = { index: blocks.length, bytes: raw.length, valid: true, error: null, types: [], nodes: [] };
    if (!raw) { block.valid = false; block.error = 'the block is empty'; blocks.push(block); continue; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      block.valid = false;
      block.error = String((e && e.message) || 'invalid JSON');
      blocks.push(block);
      continue;
    }
    // @graph-aware: BUG-298 patched only the top level, so graph-wrapped entities were skipped.
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);
    list.forEach((node) => {
      if (!node || typeof node !== 'object') return;
      const t = node['@type'];
      const types = Array.isArray(t) ? t : (t ? [t] : []);
      types.forEach((x) => { if (x && block.types.indexOf(x) < 0) block.types.push(x); });
      if (node['@id']) block.nodes.push(node);
    });
    blocks.push(block);
  }

  const allTypes = [];
  const byId = new Map();
  const conflicts = [];
  blocks.forEach((b) => {
    b.types.forEach((t) => { if (allTypes.indexOf(t) < 0) allTypes.push(t); });
    b.nodes.forEach((n) => {
      const prev = byId.get(n['@id']);
      if (prev && canon(prev) !== canon(n)) conflicts.push({ id: n['@id'], a: prev, b: n });
      else if (!prev) byId.set(n['@id'], n);
    });
  });

  return { blocks, blockCount: blocks.length, invalid: blocks.filter((b) => !b.valid), types: allTypes, conflicts };
}

// ---------- the audit ----------

function snippet(code, label) {
  return { code, label };
}

export function auditPage(input) {
  const { url, finalUrl, domain, status, redirectStatus, contentType, xRobotsTag, html, bytes, elapsedMs, robotsTxt, robotsStatus } = input;
  const findings = [];
  const add = (section, level, id, title, detail, fix, snip) => findings.push({ section, level, id, title, detail, fix: fix || '', snippet: snip || null });

  const head = parseHead(html);
  const body = parseBody(html);
  const facts = headFacts(html);
  const robots = robotsStatus === 200 ? parseRobots(robotsTxt) : null;
  const path = (() => { try { return new URL(finalUrl || url).pathname || '/'; } catch (e) { return '/'; } })();
  const base = finalUrl || url;

  // --- reachability ---
  if (status === 0) {
    // Nothing came back, so there is no page to judge. Reporting a missing title and a missing
    // canonical here would describe an empty string, and any score above zero would imply a
    // half-healthy page that nobody can see. ai-crawl-audit.js takes the same position for the
    // same reason: a host that does not answer cannot score.
    add('reach', 'error', 'unreachable', 'The page did not answer',
      'The request failed' + (input.fetchError ? ': ' + input.fetchError + '.' : '. A crawler and a visitor would both see this.') + ' Nothing below that could be measured, because there was no page to measure.',
      'Check the URL in a browser. If it loads there and not here, the host is probably refusing this user agent or is unreachable from outside its network.');
    return {
      url, finalUrl: base, domain, status: 0, redirectStatus: redirectStatus || null,
      contentType: contentType || '', bytes: 0, truncated: false, elapsedMs: elapsedMs || 0,
      reachable: false,
      serp: null,
      facts: null,
      schema: { blockCount: 0, types: [], invalid: [], conflicts: [] },
      images: { total: 0, missingAlt: 0, examples: [] },
      links: { internal: 0, external: 0, total: 0, emptyAnchor: 0 },
      crawlers: {
        robotsFound: robotsStatus === 200, robotsStatus, sitemaps: [],
        total: 0, allowed: 0, blocked: [], list: [],
      },
      findings,
      errors: 1, warns: 0, passes: 0, score: 0, grade: 'F',
      checkedAt: new Date().toISOString(),
    };
  }
  add('reach', 'pass', 'reached', 'The page answered with ' + status, 'Fetched in ' + (elapsedMs || 0) + 'ms, ' + (bytes || 0).toLocaleString() + ' bytes of HTML.', '', null);
  if (status >= 500) {
    add('reach', 'error', 'server-error', 'The server returned ' + status,
      'A 5xx means the page is down for everyone, crawlers included. Nothing on the page can be indexed while it does this.',
      'Fix the server error. Search engines retry a 5xx for days and a persistently failing URL gets crawled less and less.');
  } else if (status >= 400) {
    add('reach', 'error', 'client-error', 'The page returned ' + status,
      status === 404 ? 'There is no page at this address. A 404 that returns a "page not found" body with a 200 status is worse, because it is a soft 404 and it does get indexed.' : 'The server refuses to serve this address with ' + status + '.',
      status === 404 ? 'Check the address, or return a real 404 instead of a 200.' : 'Fix the response, or check whether a WAF is blocking crawlers.',
      // A soft 404 is the actionable case here and it is the one that gets missed: the template
      // returns 200, so nothing flags it, and the page quietly enters the index.
      status === 404 ? snippet('<meta name="robots" content="noindex, follow">\n<!-- in the 404/error template only -->', 'If this template also answers with a 200 on a missing page, that is a soft 404 — this line is the fix') : null);
  } else if (status >= 300) {
    add('reach', 'warn', 'redirect', 'The address redirects (' + status + ')',
      'The page is not served at the address you gave; it is served somewhere else' + (redirectStatus === 301 || redirectStatus === 308 ? ' permanently' : ' temporarily') + '. A redirect costs a crawl step and splits any signals on the original URL.',
      'Point links at the destination, or make this URL serve the page directly.', snippet('<meta http-equiv="refresh" content="0; url=' + base + '">', 'Or let the destination be the only address that exists'));
  } else if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    add('reach', 'warn', 'content-type', 'Served as ' + contentType.split(';')[0].trim() + ', not HTML',
      'A search engine expects a web page here and gets something else. It may still index it, but nothing on the page can be read as markup.',
      'Return text/html for a page.');
  }
  if (base.indexOf('https://') !== 0) {
    add('reach', 'error', 'not-https', 'Not served over HTTPS',
      'The page is fetched over plain HTTP. Browsers mark it "Not secure", browsers will not show a padlock, and Google has treated an insecure site as a negative signal for years.',
      'Put the site behind TLS, redirect every http:// request, then send HSTS so the browser stops trying http at all.',
      snippet('# Redirect, in your server config or .htaccess\nRewriteEngine On\nRewriteCond %{HTTPS} !=on\nRewriteRule ^ https://' + domain + '%{REQUEST_URI} [L,R=301]\n\n# Then, as a response header:\nStrict-Transport-Security: max-age=31536000; includeSubDomains', 'The redirect and the header that stops it recurring'));
  }
  if (redirectStatus) {
    add('reach', 'info', 'hop', 'One redirect was followed',
      'The address given redirects ' + redirectStatus + ' to ' + base + '. Both were requested; the findings below describe the page that actually loads.');
  }

  // --- indexability: the layer everything else sits on ---
  if (facts.noindex) {
    add('index', 'error', 'meta-noindex', 'The page asks search engines not to index it',
      'The head carries <meta name="robots" content="' + String(facts.metaRobots).replace(/^,/, '').trim() + '">. No other fix on this page matters while that is there.',
      'Remove the noindex unless the page is genuinely private.', snippet('<meta name="robots" content="index, follow">', 'Say it positively instead of deleting the line'));
  }
  if (xRobotsTag && /noindex/i.test(xRobotsTag)) {
    add('index', 'error', 'header-noindex', 'The server sends X-Robots-Tag: ' + xRobotsTag,
      'This header is set by the web server, not the page, so editing the HTML changes nothing. It is applied before a single byte of markup is read.',
      'Remove the X-Robots-Tag header for this path in the server or CDN config.');
  }
  if (robots) {
    const acc = checkAccess(robots, 'Googlebot', path);
    if (!acc.allowed) {
      add('index', 'error', 'robots-block', 'robots.txt blocks Googlebot from ' + path,
        'The ' + (acc.source === 'agent' ? 'Googlebot' : 'wildcard "*"') + ' group has "' + acc.rule + '", which matches this address. Google will not crawl a page its own robots file forbids, and a noindex in the head is never even read.',
        'Narrow the Disallow rule, or delete it for this path.', snippet('User-agent: Googlebot\nAllow: ' + path, 'A named group beats the wildcard, so this is enough'));
    }
  } else if (robotsStatus === 404) {
    add('index', 'info', 'robots-missing', 'No robots.txt, so nothing is blocked',
      'A missing robots.txt means every crawler is allowed everywhere. That is safe, but it also means you have nowhere to point crawlers at a sitemap.');
  }

  const canonNorm = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + (x.pathname.replace(/\/+$/, '') || '/') + x.search).toLowerCase(); } catch (e) { return String(u || '').toLowerCase(); } };
  if (!head.canonical) {
    add('index', 'error', 'canonical-missing', 'No canonical URL',
      'Without <link rel="canonical"> you are telling no one which address is the real one. Any duplicate — http vs https, with and without www, with and without a trailing slash — becomes a separate URL competing with the others.',
      'Declare the one address that should be in the index.', snippet('<link rel="canonical" href="' + base + '">', 'One line, absolute URL, on every page'));
  } else if (canonNorm(head.canonical) !== canonNorm(base)) {
    add('index', 'error', 'canonical-elsewhere', 'The canonical points at a different page',
      'The page declares <link rel="canonical" href="' + head.canonical + '">. Google treats this page as an alternate of that one and keeps the other in the index instead. This is the single most common reason a page that looks perfect never appears.',
      'Either this URL should be indexed, in which case fix the canonical; or it genuinely duplicates the other, in which case this behaviour is correct and the page should not be in your sitemap either.',
      snippet('<link rel="canonical" href="' + base + '">', 'Change the value to this page\'s own address'));
  } else {
    add('index', 'pass', 'canonical-ok', 'The canonical points at this page',
      '<link rel="canonical" href="' + head.canonical + '"> matches the address that was fetched.', '', null);
  }

  // --- title ---
  const title = head.title;
  if (!title) {
    add('title', 'error', 'title-missing', 'No title tag',
      'The title is the single strongest on-page ranking signal and the clickable headline in the result. Without one Google invents one from the markup, usually badly.',
      'Add a title. 50 to 60 characters is the range that survives truncation on both desktop and mobile.',
      snippet('<title>' + (head.description ? textOf(head.description).slice(0, 55) : 'Page title') + '</title>', 'Inside <head>'));
  } else if (title.length > TITLE_MAX) {
    add('title', 'warn', 'title-long', 'The title is ' + title.length + ' characters',
      'Google publishes no character or pixel limit for a title. Its documentation says a title is “truncated in Google Search results as needed, typically to fit the device width.” The widely quoted 580-pixel and 60-character numbers are a practical target, not a rule. Past that, a title loses its tail in the result, and the part being cut is usually the part you wrote to be the hook.',
      'Shorten it. Leading words survive truncation; trailing words do not.',
      snippet('<title>' + title.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '') + '…</title>', 'Trimmed to ' + TITLE_MAX + ' characters — edit it to read naturally'));
  } else if (title.length < TITLE_MIN) {
    add('title', 'warn', 'title-short', 'The title is only ' + title.length + ' characters',
      'A short title is not an error, but it leaves result space unused and usually means the page is competing on a term it never states.',
      'Use the space. Say what the page is and what it is for.', snippet('<title>' + title + '</title>', 'Current title, worth expanding to ' + TITLE_MIN + '-' + TITLE_MAX + ' characters'));
  } else {
    add('title', 'pass', 'title-ok', 'The title is ' + title.length + ' characters', 'Inside the range that displays in full on desktop and mobile results.', '', null);
  }

  // --- description ---
  const desc = head.description;
  if (!desc) {
    add('description', 'warn', 'desc-missing', 'No meta description',
      'The description is not a ranking factor, but it is the snippet text under your result when nothing else on the page makes a better snippet. Without it Google picks a fragment of body copy, often from the footer.',
      'Write one. 70 to 160 characters.', snippet('<meta name="description" content="' + ((title || 'What this page is about').slice(0, 60)).replace(/"/g, '&quot;') + ' …">', 'A sentence, not a keyword list'));
  } else if (desc.length > DESC_MAX) {
    add('description', 'warn', 'desc-long', 'The description is ' + desc.length + ' characters',
      'Google publishes no character limit for a meta description either, and says it is truncated "as needed, typically to fit the device width." Around 155 to 160 characters is where a description still reads in full on a desktop result. Past that it truncates mid-word.',
      'Trim it to the first sentence that completes the thought.', snippet('<meta name="description" content="' + desc.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, '').replace(/"/g, '&quot;') + '…">', 'Trimmed to ' + DESC_MAX + ' characters'));
  } else if (desc.length < DESC_MIN) {
    add('description', 'warn', 'desc-short', 'The description is only ' + desc.length + ' characters',
      'Short descriptions leave the rest of the result line empty and lose the chance to say what the visitor gets.',
      'Expand it to 70-160 characters.', snippet('<meta name="description" content="' + desc.replace(/"/g, '&quot;') + '">', 'Current text, worth expanding'));
  } else {
    add('description', 'pass', 'desc-ok', 'The description is ' + desc.length + ' characters', 'Inside the range that displays without truncation.', '', null);
  }
  if (desc && title && desc.trim().toLowerCase() === title.trim().toLowerCase()) {
    add('description', 'warn', 'desc-dupe-title', 'The description is identical to the title',
      'They render in two different places and do two different jobs. The title earns the click; the description has to justify it.', '', null);
  }

  // --- headings ---
  const h1s = body.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    add('headings', 'error', 'h1-missing', 'No H1',
      'The H1 is the page\'s main heading and the anchor text for the page\'s primary topic. A page with no H1 asks the crawler to infer one from a logo, a div or a navigation label.',
      'Add exactly one H1, matching what the page is actually about.',
      snippet('<h1>' + (title || 'Main heading') + '</h1>', 'One per page'));
  } else if (h1s.length > 1) {
    add('headings', 'warn', 'h1-multiple', h1s.length + ' H1 headings',
      'Multiple H1s are valid HTML and Google handles them, but every one of them competes to describe the page. In practice they dilute the signal: ' + h1s.slice(0, 3).map((h) => '"' + h.text + '"').join(', ') + '.',
      'Keep the one that describes the page, demote the rest to H2.', snippet('<h2>' + (h1s[1] ? h1s[1].text : 'Section heading') + '</h2>', 'Demote the others'));
  } else {
    add('headings', 'pass', 'h1-ok', 'One H1: "' + h1s[0].text + '"', 'The main heading is unambiguous.', '', null);
  }
  let prevLevel = 0, skipped = null;
  for (const h of body.headings) {
    if (prevLevel && h.level > prevLevel + 1 && !skipped) skipped = 'H' + prevLevel + ' to H' + h.level;
    prevLevel = h.level;
  }
  if (skipped) add('headings', 'info', 'heading-skip', 'Heading levels skip (' + skipped + ')',
    'A jump means a level is skipped. This is not an error and does not affect ranking, but screen-reader users navigate by heading level, so a skipped level reads as missing structure.', '', null);

  // --- technical head ---
  if (!head.viewport) {
    add('technical', 'error', 'viewport-missing', 'No viewport meta tag',
      'Without it a phone renders your page at desktop width and zooms out. Google evaluates the mobile version of a page, and Google states mobile-friendly is a ranking signal.',
      'Add the standard declaration.', snippet('<meta name="viewport" content="width=device-width, initial-scale=1">', 'The tag every responsive page has'));
  } else if (!/width\s*=\s*device-width/i.test(head.viewport)) {
    add('technical', 'warn', 'viewport-width', 'The viewport does not set device width',
      'It reads content="' + head.viewport + '". Without width=device-width the layout does not respond to the screen.', 'Set width=device-width.', snippet('<meta name="viewport" content="width=device-width, initial-scale=1">', 'Standard value'));
  } else {
    add('technical', 'pass', 'viewport-ok', 'The viewport meta tag is set', 'content="' + head.viewport + '"', '', null);
  }
  if (!head.lang) {
    add('technical', 'warn', 'lang-missing', 'The <html> element has no lang attribute',
      'lang tells screen readers which pronunciation rules to use and tells search engines which language the page is in. It is also a WCAG 3.1.1 failure when missing.',
      'Set it on the html element.', snippet('<html lang="en">', 'The language of the page content'));
  }
  if (!head.hasCharset) {
    add('technical', 'warn', 'charset-missing', 'No character set declared',
      'Without a charset declaration the browser guesses, and a guess that is wrong mangles every non-ASCII character on the page.', 'Declare UTF-8.', snippet('<meta charset="utf-8">', 'First thing inside <head>'));
  }
  if (!head.favicon) {
    add('technical', 'info', 'favicon-missing', 'No favicon link',
      'A missing icon means the browser falls back to a default, or to the first image on the page. It is not a ranking factor and it does not affect indexing.', 'Add one.', snippet('<link rel="icon" href="/favicon.ico" sizes="any">', 'Plus a 180x180 apple-touch-icon for iOS'));
  }

  // --- social cards ---
  const ogNeeded = [['og:title', 'title'], ['og:description', 'description'], ['og:image', 'an image'], ['og:url', 'the page address'], ['og:type', '"website"']];
  const ogMissing = ogNeeded.filter((p) => !head.og[p[0]]).map((p) => p[0]);
  if (ogMissing.length) {
    add('social', ogMissing.length >= 4 ? 'warn' : 'info', 'og-missing', ogMissing.length + ' of 5 Open Graph tags missing',
      'Open Graph is what renders the card when someone pastes your URL into Slack, Discord, WhatsApp, LinkedIn or iMessage. Missing: ' + ogMissing.join(', ') + '. With no tags at all, those platforms show the bare URL.',
      'Add the tags inside <head>.',
      snippet(ogNeeded.map((p) => '<meta property="' + p[0] + '" content="' + (head.og[p[0]] || (p[0] === 'og:image' ? 'https://' + domain + '/og-image.png' : p[0] === 'og:url' ? base : p[0] === 'og:type' ? 'website' : (title || 'Page title'))) + '">').join('\n'), 'The five tags, filled in from this page'));
  } else {
    add('social', 'pass', 'og-ok', 'All five Open Graph tags are present', 'Shares of this URL render a card.', '', null);
  }
  if (!head.twitter['twitter:card']) {
    add('social', 'info', 'twitter-card-missing', 'No Twitter card tag',
      'X and Slack fall back to Open Graph when this is absent, so it matters far less than it used to. Twitter:image and Twitter:title are still read first on X itself.',
      'Optional, one line.', snippet('<meta name="twitter:card" content="summary_large_image">', 'Use summary for a small square card, summary_large_image for a 1200x630 image'));
  }

  // --- structured data ---
  const schema = parseSchema(html);
  if (schema.blockCount === 0) {
    add('schema', 'warn', 'schema-missing', 'No structured data',
      'JSON-LD lets you state what a page is to a machine rather than leaving it to infer from markup. It is what produces star ratings, FAQ accordions, breadcrumbs and the author byline in results.',
      'Start with WebApplication for a tool, FAQPage for a page with real questions, BreadcrumbList for a nested page, Organization for the home page.',
      snippet('{\n  "@context": "https://schema.org",\n  "@type": "WebApplication",\n  "name": "' + (title || 'Tool name') + '",\n  "description": "' + (desc || 'What the page does').replace(/"/g, '\\"').slice(0, 150) + '",\n  "url": "' + base + '"\n}', 'JSON-LD goes in a script tag inside <head>'));
  } else {
    if (schema.invalid.length) {
      add('schema', 'error', 'schema-invalid', schema.invalid.length + ' JSON-LD block' + (schema.invalid.length > 1 ? 's do' : ' does') + ' not parse',
        'An unparseable block is discarded silently: the page looks instrumented and carries nothing. Block' + (schema.invalid.length > 1 ? 's' : '') + ' ' + schema.invalid.map((b) => '#' + b.index).join(', ') + ' reported: ' + schema.invalid.map((b) => b.error).join('; ') + '.',
        'Validate the block. The usual causes are a missing "@type" key, an unescaped < or > inside an answer string, and an invalid backslash escape in a regular expression literal.');
    }
    if (schema.types.length === 0 && schema.invalid.length === 0) {
      add('schema', 'warn', 'schema-untyped', 'Structured data is present but no @type is declared',
        'A block without @type is valid JSON and useless to a consumer: there is no type to file it under.', 'Add @type.', snippet('"@type": "WebApplication",', 'One of the schema.org types'));
    }
    if (schema.conflicts.length) {
      add('schema', 'error', 'schema-id-conflict', schema.conflicts.length + ' @id' + (schema.conflicts.length > 1 ? 's are' : ' is') + ' declared twice with different values',
        'The @id ' + schema.conflicts[0].id + ' describes one entity with two different sets of properties across the page\'s blocks. A consumer has to pick one, and the other is discarded. It splits the attribution or organisation signal the entity was there to carry.',
        'Give each entity one definition and reference it by @id everywhere else.',
        snippet('{"@id": "' + base + '#organization", "@type": "Organization", "name": "…", "url": "' + base + '", "sameAs": ["…"]}\n\n// elsewhere, not redefined:\n{"@type": "WebApplication", "author": {"@id": "' + base + '#organization"}}', 'Define once, reference by @id'));
    }
    const named = schema.types.filter((t) => t !== 'WebSite');
    add('schema', schema.invalid.length || schema.conflicts.length ? 'error' : 'pass', 'schema-ok',
      (schema.invalid.length ? 'Partially working structured data' : 'Structured data found') + ': ' + (schema.types.join(', ') || 'no types'),
      schema.blockCount + ' JSON-LD block' + (schema.blockCount > 1 ? 's' : '') + ', ' + (named.length || schema.types.length) + ' type' + ((named.length || schema.types.length) === 1 ? '' : 's') + ' declared.',
      '', null);
  }

  // --- images and links ---
  // alt="" is a deliberate "decorative, skip it" marker and a WCAG-correct one. Only an absent
  // alt attribute is a defect, so the test is `=== null` and never a truthiness check — counting
  // alt="" as missing would tell every good author to delete a correct attribute.
  const missingAlt = body.images.filter((i) => i.alt === null);
  if (body.images.length === 0) {
    add('images', 'pass', 'no-images', 'No images on the page', 'Nothing to check for alt text.', '', null);
  } else if (missingAlt.length) {
    const ratio = Math.round((missingAlt.length / body.images.length) * 100);
    add('images', ratio > 20 ? 'warn' : 'info', 'img-alt', missingAlt.length + ' of ' + body.images.length + ' images have no alt text',
      'Alt text is a WCAG 1.1.1 requirement for meaningful images, and it is how a text-only crawler understands what a diagram shows. Decorative images should carry alt="" rather than nothing, because an empty alt is a deliberate signal and a missing one is not.',
      'Give each meaningful image a description; mark decorative ones alt="".',
      snippet('<img src="' + (missingAlt[0].src || '/image.jpg') + '" alt="' + (title || 'What the image shows') + '" width="800" height="450" loading="lazy">', 'The first image that is missing it'));
  } else {
    add('images', 'pass', 'img-alt-ok', 'All ' + body.images.length + ' images have an alt attribute', '', '', null);
  }
  if (body.emptyAnchor > 0) {
    add('images', 'info', 'empty-anchor', body.emptyAnchor + ' link' + (body.emptyAnchor > 1 ? 's have' : ' has') + ' no destination or no visible text',
      'A link with no anchor text tells a crawler nothing about what it points at, and a link to "#" goes nowhere.',
      'Give each link a real href and real text.', snippet('<a href="' + base + '/about/">About this site</a>', 'Destination and text, both meaningful'));
  }

  // --- robots.txt and AI crawler access ---
  const aiCrawlers = [];
  if (robots) {
    for (const c of AI_CRAWLERS) {
      aiCrawlers.push({ token: c.token, vendor: c.vendor, use: c.use, note: c.note, allowed: checkAccess(robots, c.token, path).allowed });
    }
  }
  const blocked = aiCrawlers.filter((c) => !c.allowed);
  const searchBots = aiCrawlers.filter((c) => c.use === 'search');
  const blockedSearch = searchBots.filter((c) => !c.allowed);

  if (!robots) {
    add('crawlers', robotsStatus === 0 ? 'warn' : 'info', 'robots-unreachable', robotsStatus === 0 ? 'robots.txt could not be fetched' : 'No robots.txt',
      robotsStatus === 0 ? 'The request did not complete, so nothing could be verified. A crawler hitting the same timeout treats the site as unreachable, not as open.' : 'A missing robots.txt means every crawler, Google and AI alike, is allowed everywhere.',
      '', null);
  } else {
    if (robots.sitemaps.length === 0) {
      add('crawlers', 'warn', 'no-sitemap-line', 'robots.txt has no Sitemap: line',
        'A Sitemap: line is the one instruction in robots.txt every engine reads, and it is how AI agents learn which pages exist without guessing.',
        'Add one line.', snippet('Sitemap: https://' + domain + '/sitemap.xml', 'Absolute URL, at the end of the file'));
    }
    if (blockedSearch.length === 0 && searchBots.length) {
      add('crawlers', 'pass', 'ai-search-open', 'All ' + searchBots.length + ' AI search crawlers can read this page',
        'ChatGPT, Claude, Perplexity, Copilot and AI Overviews can all fetch ' + path + '. For a page that wants to be cited in an AI answer, this is the first thing to get right.', '', null);
    } else if (blockedSearch.length) {
      add('crawlers', 'error', 'ai-search-blocked', blockedSearch.length + ' of ' + searchBots.length + ' AI search crawlers are blocked from this page',
        'Blocked: ' + blockedSearch.map((c) => c.token).join(', ') + '. These are the crawlers behind AI answers. Blocking them does not hide the page from a person, it only removes it from the sources a chatbot can cite, which is usually the opposite of the intent behind the rule.',
        'Allow the search crawlers. Blocking the training crawler is a separate decision and does not block search.',
        snippet('User-agent: ' + blockedSearch.slice(0, 3).map((c) => c.token).join('\nUser-agent: ') + '\nAllow: /\n\n# Training on your content is a separate choice:\nUser-agent: GPTBot\nDisallow: /\n', 'A named group beats the wildcard, so this overrides any Disallow: / above'));
    }
    if (blocked.length) {
      add('crawlers', 'info', 'ai-blocked-all', blocked.length + ' of ' + aiCrawlers.length + ' AI crawlers are blocked from this page',
        'Blocked: ' + blocked.map((c) => c.token + ' (' + c.vendor + ')').join(', ') + '.', '', null);
    }
    const gbot = aiCrawlers.filter((c) => c.token === 'Googlebot')[0];
    if (gbot && !gbot.allowed) {
      add('crawlers', 'error', 'googlebot-blocked', 'Googlebot is blocked from this page', 'Google-Extended only controls Gemini training. It has no effect on Google Search.', 'Allow Googlebot.', snippet('User-agent: Googlebot\nAllow: /', 'Google Search and AI Overviews both depend on it'));
    }
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const { score, grade } = gradeOf(errors, warns, 0, 0);

  const ordered = condenseIssues(findings, 99);
  const rank = { error: 0, warn: 1, info: 2, pass: 3 };
  ordered.sort((a, b) => (rank[a.level] - rank[b.level]) || (a.section < b.section ? -1 : 1));

  return {
    url,
    finalUrl: base,
    domain,
    status,
    redirectStatus: redirectStatus || null,
    contentType: contentType || '',
    bytes: Math.min(bytes || 0, MAX_HTML_BYTES),
    truncated: (bytes || 0) > MAX_HTML_BYTES,
    elapsedMs: elapsedMs || 0,
    reachable: true,
    serp: { title: title, description: desc, url: base },
    facts: {
      title: title,
      titleLength: title ? title.length : 0,
      description: desc,
      descriptionLength: desc ? desc.length : 0,
      canonical: head.canonical,
      lang: head.lang,
      viewport: head.viewport,
      headings: body.headings.length,
      h1s: h1s.map((h) => h.text),
      words: body.words,
    },
    schema: { blockCount: schema.blockCount, types: schema.types, invalid: schema.invalid.map((b) => ({ index: b.index, error: b.error })), conflicts: schema.conflicts.map((c) => c.id) },
    images: { total: body.images.length, missingAlt: missingAlt.length, examples: missingAlt.slice(0, 3).map((i) => i.src) },
    links: { internal: body.internal, external: body.external, total: body.links, emptyAnchor: body.emptyAnchor },
    crawlers: {
      robotsFound: robotsStatus === 200,
      robotsStatus: robotsStatus,
      sitemaps: robots ? robots.sitemaps : [],
      total: aiCrawlers.length,
      allowed: aiCrawlers.filter((c) => c.allowed).length,
      blocked: blocked.map((c) => ({ token: c.token, vendor: c.vendor, use: c.use })),
      list: aiCrawlers,
    },
    findings: ordered,
    errors,
    warns,
    passes: findings.filter((f) => f.level === 'pass').length,
    score,
    grade,
    checkedAt: new Date().toISOString(),
  };
}
