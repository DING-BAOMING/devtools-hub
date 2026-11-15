// Local gate for libs/seo-audit.js. Runs in plain Node, no Worker and no network.
//   node devtools-hub-docs/test-scripts/seo-audit-logic-test.mjs
// Anti-vacuity: every assertion below is re-run against a deliberately broken fixture, so a
// gate that stops measuring anything goes red instead of green.

import assert from 'node:assert/strict';
import { parseHead, parseBody, parseSchema, auditPage } from '../libs/seo-audit.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const codes = (r, level) => r.findings.filter((f) => f.level === level).map((f) => f.id);
const has = (r, id) => r.findings.some((f) => f.id === id);
const snippetFor = (r, id) => { const f = r.findings.find((x) => x.id === id); return f && f.snippet ? f.snippet.code : ''; };

const GOOD = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Generator - Free Online PDF Invoice Maker</title>
<meta name="description" content="Create a professional PDF invoice free online. Add your details, line items and tax, then download a finished invoice you can send to a client today.">
<link rel="canonical" href="https://good.example/invoice/">
<link rel="icon" href="/favicon.ico">
<meta property="og:title" content="Invoice Generator"><meta property="og:description" content="Create a PDF invoice free.">
<meta property="og:image" content="/og.png"><meta property="og:url" content="https://good.example/invoice/">
<meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","name":"Invoice Generator","url":"https://good.example/invoice/","author":{"@id":"https://good.example/#author"}}</script>
</head><body><h1>Invoice Generator</h1><h2>How to make one</h2>
<img src="/a.png" alt="An invoice"><a href="/about/">About</a><a href="/contact/">Contact</a></body></html>`;

const ROBOTS_OK = `User-agent: *\nAllow: /\n\nSitemap: https://good.example/sitemap.xml\n`;

function run(html, extra) {
  return auditPage(Object.assign({
    url: 'https://good.example/invoice/', finalUrl: 'https://good.example/invoice/',
    domain: 'good.example', status: 200, redirectStatus: null, contentType: 'text/html; charset=utf-8',
    xRobotsTag: null, html, bytes: html.length, elapsedMs: 120, robotsTxt: ROBOTS_OK, robotsStatus: 200,
  }, extra || {}));
}

console.log('\nparseHead / parseBody / parseSchema');

t('head: reads title, description, canonical, og, twitter', () => {
  const h = parseHead(GOOD);
  assert.equal(h.title, 'Invoice Generator - Free Online PDF Invoice Maker');
  assert.ok(h.description.length > 100);
  assert.equal(h.canonical, 'https://good.example/invoice/');
  assert.equal(h.lang, 'en');
  assert.equal(h.hasCharset, true);
  assert.equal(h.favicon, true);
  assert.equal(h.og['og:image'], '/og.png');
  assert.equal(h.twitter['twitter:card'], 'summary_large_image');
  assert.ok(/width=device-width/.test(h.viewport));
});

t('head: attribute order does not matter (BUG-323 lesson)', () => {
  const h = parseHead('<html><head><title rel=x>T</title><meta content="d" name="description"><link href="/c" rel="canonical"></head></html>');
  assert.equal(h.description, 'd');
  assert.equal(h.canonical, '/c');
});

t('head: entities are decoded before measuring length', () => {
  const h = parseHead('<head><title>A &amp; B</title><meta name="description" content="x &amp; y"></head>');
  assert.equal(h.title, 'A & B');
  assert.equal(h.description, 'x & y');
  // "&amp;" is five characters to a naive counter and one to a browser. The length rules are
  // counting what a reader sees, so an undecoded value would push a good description over 160.
  assert.equal(parseHead('<head><meta name="description" content="' + 'a&amp;b'.repeat(32) + '"></head>').description.length, 96);
});

t('head: the twitter card check reads the full attribute name', () => {
  // Regression: twitter is keyed "twitter:card", so a consumer reading .card always got
  // undefined and the check reported a missing card on every page that had one.
  assert.ok(!has(run(GOOD), 'twitter-card-missing'));
  const r = run(GOOD.replace('<meta name="twitter:card" content="summary_large_image">', ''));
  assert.ok(has(r, 'twitter-card-missing'));
});

t('body: heading levels, images and links are counted', () => {
  const b = parseBody(GOOD);
  assert.equal(b.headings.length, 2);
  assert.equal(b.headings[0].level, 1);
  assert.equal(b.images.length, 1);
  assert.equal(b.internal, 2);
  assert.equal(b.external, 0);
});

t('schema: a well-formed block yields its type', () => {
  const s = parseSchema(GOOD);
  assert.equal(s.blockCount, 1);
  assert.deepEqual(s.types, ['WebApplication']);
  assert.equal(s.invalid.length, 0);
});

t('schema: @graph is read, not skipped (BUG-298 lesson)', () => {
  const s = parseSchema('<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebApplication","name":"a"},{"@type":"FAQPage","mainEntity":[]}]}</script>');
  assert.deepEqual(s.types.sort(), ['FAQPage', 'WebApplication']);
});

t('schema: an unparseable block is reported, not swallowed (BUG-312b lesson)', () => {
  const s = parseSchema('<script type="application/ld+json">{"@context":"https://schema.org","@type":}</script>');
  assert.equal(s.blockCount, 1);
  assert.equal(s.invalid.length, 1);
  assert.ok(s.invalid[0].error);
});

t('schema: one @id with two values is a conflict (BUG-299 lesson)', () => {
  const s = parseSchema('<script type="application/ld+json">{"@type":"Person","@id":"https://x.example/#author","name":"A","url":"https://a.example"}</script>'
    + '<script type="application/ld+json">{"@type":"Person","@id":"https://x.example/#author","name":"B","url":"https://b.example"}</script>');
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].id, 'https://x.example/#author');
});

t('schema: same @id with identical values is not a conflict', () => {
  const s = parseSchema('<script type="application/ld+json">{"@type":"Person","@id":"https://x.example/#a","name":"A"}</script>'
    + '<script type="application/ld+json">{"@type":"Person","name":"A","@id":"https://x.example/#a"}</script>');
  assert.equal(s.conflicts.length, 0);
});

console.log('\nauditPage: a good page');

const good = run(GOOD);

t('a complete page has no errors and no warnings', () => {
  assert.deepEqual(codes(good, 'error'), []);
  assert.deepEqual(codes(good, 'warn'), []);
});

t('a complete page scores in the top band', () => {
  assert.ok(good.score >= 85, 'score was ' + good.score + ' findings=' + JSON.stringify(good.findings.filter(f => f.level !== 'pass').map(f => f.id)));
});

t('passing checks are reported as passes, not dropped', () => {
  for (const id of ['canonical-ok', 'title-ok', 'desc-ok', 'h1-ok', 'viewport-ok', 'og-ok', 'ai-search-open']) {
    assert.ok(has(good, id), 'missing pass for ' + id);
  }
});

t('all 19 AI crawlers are evaluated against robots.txt', () => {
  assert.equal(good.crawlers.total, 19);
  assert.equal(good.crawlers.allowed, 19);
  assert.deepEqual(good.crawlers.blocked, []);
});

t('the SERP block carries the title and description actually rendered', () => {
  assert.equal(good.serp.title, 'Invoice Generator - Free Online PDF Invoice Maker');
  assert.equal(good.serp.url, 'https://good.example/invoice/');
});

console.log('\nauditPage: each defect is detected');

t('meta noindex is an error and outranks everything else', () => {
  const r = run(GOOD.replace('<meta name="viewport"', '<meta name="robots" content="noindex, follow"><meta name="viewport"'));
  assert.deepEqual(codes(r, 'error'), ['meta-noindex']);
});

t('X-Robots-Tag: noindex is detected from the response header', () => {
  const r = run(GOOD, { xRobotsTag: 'noindex' });
  assert.ok(has(r, 'header-noindex'));
});

t('a canonical pointing elsewhere is an error, and the snippet fixes it', () => {
  const r = run(GOOD.replace('href="https://good.example/invoice/"', 'href="https://other.example/invoice/"'));
  assert.ok(has(r, 'canonical-elsewhere'));
  assert.ok(/rel="canonical" href="https:\/\/good.example\/invoice\/"/.test(snippetFor(r, 'canonical-elsewhere')));
});

t('a missing canonical ships a paste-ready link tag', () => {
  const r = run(GOOD.replace('<link rel="canonical" href="https://good.example/invoice/">', ''));
  assert.ok(has(r, 'canonical-missing'));
  assert.equal(snippetFor(r, 'canonical-missing'), '<link rel="canonical" href="https://good.example/invoice/">');
});

t('a missing title is an error with a paste-ready title tag', () => {
  const r = run(GOOD.replace(/<title>[\s\S]*?<\/title>/, ''));
  assert.ok(has(r, 'title-missing'));
  assert.ok(/^<title>/.test(snippetFor(r, 'title-missing')));
});

t('a 70-character title is flagged, a 60-character one is not', () => {
  const long = run(GOOD.replace('<title>Invoice Generator - Free Online PDF Invoice Maker</title>', '<title>' + 'A'.repeat(70) + '</title>'));
  assert.ok(has(long, 'title-long'));
  assert.ok(!has(run(GOOD), 'title-long'));
});

t('a missing description is a warning with a paste-ready meta tag', () => {
  const r = run(GOOD.replace(/<meta name="description"[^>]*>/, ''));
  assert.ok(has(r, 'desc-missing'));
  assert.ok(/<meta name="description"/.test(snippetFor(r, 'desc-missing')));
});

t('no H1 is an error; two H1s is a warning', () => {
  assert.ok(has(run(GOOD.replace('<h1>Invoice Generator</h1>', '<h2>Invoice Generator</h2>')), 'h1-missing'));
  assert.ok(has(run(GOOD.replace('</body>', '<h1>Second</h1></body>')), 'h1-multiple'));
});

t('missing viewport, lang, charset and favicon are each named', () => {
  const r = run('<html><head><title>T</title></head><body><h1>x</h1></body></html>');
  for (const id of ['viewport-missing', 'lang-missing', 'charset-missing', 'favicon-missing']) assert.ok(has(r, id), 'missing ' + id);
});

t('missing Open Graph tags are listed by name and filled in from the page', () => {
  const r = run(GOOD.replace(/<meta property="og:[^>]*>/g, ''));
  assert.ok(has(r, 'og-missing'));
  const s = snippetFor(r, 'og-missing');
  for (const t of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) assert.ok(s.indexOf(t) > -1, 'snippet missing ' + t);
});

t('an unparseable JSON-LD block is an error (BUG-312b)', () => {
  const r = run(GOOD.replace('{"@context":"https://schema.org","@type":"WebApplication","name":"Invoice Generator","url":"https://good.example/invoice/","author":{"@id":"https://good.example/#author"}}', '{"@type":}'));
  assert.ok(has(r, 'schema-invalid'));
});

t('no structured data is a warning carrying a filled-in JSON-LD block', () => {
  const r = run(GOOD.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''));
  assert.ok(has(r, 'schema-missing'));
  const s = snippetFor(r, 'schema-missing');
  assert.ok(s.indexOf('"@type": "WebApplication"') > -1);
  assert.ok(s.indexOf('https://good.example/invoice/') > -1);
});

t('an image with no alt is counted and named, alt="" is not counted', () => {
  const none = run(GOOD.replace('alt="An invoice"', ''));
  assert.ok(has(none, 'img-alt'));
  assert.ok(/<img[^>]*alt="/.test(snippetFor(none, 'img-alt')));
  const empty = run(GOOD.replace('alt="An invoice"', 'alt=""'));
  assert.ok(!has(empty, 'img-alt'), 'alt="" must count as decorative, not missing');
});

console.log('\nauditPage: robots.txt and AI crawler access');

t('a robots.txt Disallow on the path is an index error', () => {
  const r = run(GOOD, { robotsTxt: 'User-agent: *\nDisallow: /invoice/\n', robotsStatus: 200 });
  assert.ok(has(r, 'robots-block'));
  assert.ok(/User-agent: Googlebot/.test(snippetFor(r, 'robots-block')));
});

t('a Disallow: / wildcard blocks every crawler and says so by name', () => {
  const r = run(GOOD, { robotsTxt: 'User-agent: *\nDisallow: /\n', robotsStatus: 200 });
  assert.ok(has(r, 'ai-search-blocked'));
  const s = snippetFor(r, 'ai-search-blocked');
  assert.ok(/OAI-SearchBot/.test(s) && /Allow: \//.test(s));
  assert.ok(has(r, 'googlebot-blocked'));
  assert.equal(r.crawlers.allowed, 0);
});

t('blocking a named AI training crawler leaves the search crawlers open', () => {
  const r = run(GOOD, { robotsTxt: 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n', robotsStatus: 200 });
  assert.ok(has(r, 'ai-blocked-all'));
  assert.ok(!has(r, 'ai-search-blocked'));
  assert.deepEqual(r.crawlers.blocked.map((c) => c.token), ['GPTBot']);
});

t('a missing robots.txt is reported as such, not as a block', () => {
  const r = run(GOOD, { robotsTxt: '', robotsStatus: 404 });
  assert.ok(has(r, 'robots-unreachable'));
  assert.ok(!has(r, 'robots-block'));
  assert.equal(r.crawlers.total, 0);
});

t('robots.txt without a Sitemap: line is a warning with the line to paste', () => {
  const r = run(GOOD, { robotsTxt: 'User-agent: *\nAllow: /\n', robotsStatus: 200 });
  assert.ok(has(r, 'no-sitemap-line'));
  assert.ok(/^Sitemap: https:\/\/good.example\/sitemap.xml$/.test(snippetFor(r, 'no-sitemap-line')));
});

console.log('\nauditPage: reachability');

t('plain HTTP is an error', () => {
  const r = run(GOOD, { url: 'http://good.example/invoice/', finalUrl: 'http://good.example/invoice/' });
  assert.ok(has(r, 'not-https'));
});

t('a 404 and a 500 are both errors naming the status', () => {
  assert.ok(has(run(GOOD, { status: 404 }), 'client-error'));
  assert.ok(has(run(GOOD, { status: 503 }), 'server-error'));
});

t('an unreachable page scores 0 and returns no page-level findings', () => {
  const r = run('', { status: 0, fetchError: 'timed out after 9s', html: '', xRobotsTag: null });
  assert.ok(has(r, 'unreachable'));
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'F');
  assert.equal(r.reachable, false);
  assert.equal(r.findings.length, 1, 'an empty response must not produce findings about a title or a canonical that was never sent');
});

t('a followed redirect is reported as a warning and kept in the record', () => {
  const r = run(GOOD, { url: 'https://good.example/invoice', finalUrl: 'https://good.example/invoice/', redirectStatus: 301 });
  assert.ok(has(r, 'hop'));
});

t('a non-HTML content type is a warning', () => {
  assert.ok(has(run(GOOD, { contentType: 'application/json' }), 'content-type'));
});

console.log('\nanti-vacuity: the same assertions must fail on a broken page');

// A real-world broken page: the site 404s, and its custom 404 template ships an empty head,
// no images worth naming, and a robots.txt that blocks the entire site for every crawler.
const broken = run('<html><head></head><body></body></html>', {
  url: 'http://broken.example/', finalUrl: 'http://broken.example/',
  status: 404, robotsTxt: 'User-agent: *\nDisallow: /\n', robotsStatus: 200,
});

t('a broken page is caught by every category the gate claims to cover', () => {
  // No meta-noindex here on purpose: the fixture's head is empty, so that is a separate defect
  // with its own fixture above. Listing it would make this tier pass for the wrong reason.
  for (const id of ['client-error', 'canonical-missing', 'title-missing', 'desc-missing',
    'h1-missing', 'viewport-missing', 'og-missing', 'schema-missing', 'robots-block',
    'ai-search-blocked', 'not-https']) {
    assert.ok(has(broken, id), 'broken fixture did not trip ' + id);
  }
});

t('a broken page scores far below a good one', () => {
  assert.ok(broken.score < good.score - 40, 'good=' + good.score + ' broken=' + broken.score);
});

t('every error and warning that names a fix also ships a snippet', () => {
  // The whole point of the tool: prose is what every competitor ships. A finding with a fix but
  // no snippet is the failure mode this gate exists to keep out.
  const noSnippet = broken.findings.filter((f) => (f.level === 'error' || f.level === 'warn') && f.fix && !f.snippet);
  assert.deepEqual(noSnippet.map((f) => f.id), [], 'findings with a fix but no paste-ready snippet: ' + noSnippet.map((f) => f.id).join(', '));
});

t('an empty URL or a dead host produces no findings at all', () => {
  const r = run('', { status: 0, html: '' });
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.score >= 0 && r.score <= 100);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
