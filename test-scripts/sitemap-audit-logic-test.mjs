// Self-check for libs/sitemap-audit.js — run: node devtools-hub-docs/test-scripts/sitemap-audit-logic-test.mjs
// No framework, no fixtures on disk: every input is inline so the file is the whole test.
import assert from 'node:assert/strict';
import { auditStructure, buildCleanSitemap, classifyLive, gradeOf, headFacts, parseSitemap } from '../libs/sitemap-audit.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

const NOW = Date.parse('2026-10-04T00:00:00Z');
const SITEMAP = 'https://example.com/sitemap.xml';
const DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const wrap = (entries) => DECL + '\n<urlset xmlns="' + NS + '">' + entries + '</urlset>';
const codes = (issues) => issues.map((i) => i.code);

// ---------- parseSitemap ----------
t('parses a urlset', () => {
  const p = parseSitemap(wrap('<url><loc>https://example.com/a</loc><lastmod>2026-01-02</lastmod></url>'), 'application/xml');
  assert.equal(p.kind, 'urlset');
  assert.equal(p.namespace, NS);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].locs[0], 'https://example.com/a');
  assert.equal(p.entries[0].lastmod, '2026-01-02');
});

t('parses a sitemap index', () => {
  const p = parseSitemap(DECL + '<sitemapindex xmlns="' + NS + '"><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>', 'text/xml');
  assert.equal(p.kind, 'sitemapindex');
  assert.equal(p.entries[0].locs[0], 'https://example.com/s1.xml');
});

t('detects an HTML page served as a sitemap', () => {
  assert.equal(parseSitemap('<!DOCTYPE html><html><body>404</body></html>', 'text/html').kind, 'html');
});

t('parses a plain text sitemap', () => {
  const p = parseSitemap('https://example.com/a\nhttps://example.com/b\n', 'text/plain');
  assert.equal(p.kind, 'text');
  assert.equal(p.entries.length, 2);
});

t('unescapes entities in loc', () => {
  const p = parseSitemap(wrap('<url><loc>https://example.com/a?x=1&amp;y=2</loc></url>'), 'application/xml');
  assert.equal(p.entries[0].locs[0], 'https://example.com/a?x=1&y=2');
});

// ---------- auditStructure ----------
t('flags a relative loc as Invalid URL', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>/about</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('relative-loc'));
  assert.equal(r.perEntry[0].issues.find((i) => i.code === 'relative-loc').gsc, 'Invalid URL');
});

t('flags an exact duplicate', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.equal(r.total, 2);
  assert.equal(r.unique, 1);
  assert.ok(codes(r.issues).includes('dups'));
  assert.equal(r.perEntry[1].issues[0].gsc, 'Invalid XML: too many tags');
});

t('flags a near duplicate that differs only by trailing slash', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a/</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[1].issues).includes('dup-near'));
});

t('flags a near duplicate that differs only by a tracking parameter', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a?utm_source=x</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[1].issues).includes('dup-near'));
});

t('flags a future lastmod', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc><lastmod>2027-01-01</lastmod></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('future-date'));
});

t('flags a non-W3C lastmod', () => {
  for (const bad of ['04/10/2026', '2026-10-04T10:00:00', '10-04-2026', 'Oct 4 2026']) {
    const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc><lastmod>' + bad + '</lastmod></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
    assert.ok(codes(r.perEntry[0].issues).includes('bad-date'), 'should reject ' + bad);
  }
});

t('accepts both documented W3C formats', () => {
  for (const good of ['2026-01-02', '2026-01-02T18:00:15+00:00', '2026-01-02T18:00:15Z', '2026-01-02T18:00:15.500+05:30']) {
    const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc><lastmod>' + good + '</lastmod></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
    assert.ok(!codes(r.perEntry[0].issues).includes('bad-date'), 'should accept ' + good);
  }
});

t('flags one identical lastmod across a large file as a build time', () => {
  const many = Array.from({ length: 12 }, (_, i) => '<url><loc>https://example.com/p' + i + '</loc><lastmod>2026-01-01</lastmod></url>').join('');
  const r = auditStructure(parseSitemap(wrap(many), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('same-lastmod'));
});

t('does not flag same-lastmod on a small file', () => {
  const few = Array.from({ length: 3 }, (_, i) => '<url><loc>https://example.com/p' + i + '</loc><lastmod>2026-01-01</lastmod></url>').join('');
  const r = auditStructure(parseSitemap(wrap(few), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(!codes(r.issues).includes('same-lastmod'));
});

t('flags a cross-domain URL as URL not allowed', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://other.com/a</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('off-host'));
  assert.equal(r.perEntry[0].issues[0].gsc, 'URL not allowed');
});

t('flags mixing www and non-www inside the file', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://www.example.com/a</loc></url><url><loc>https://example.com/b</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('www-mix'));
});

t('flags a file served from the bare host that lists only www URLs, as a path mismatch not a cross-domain error', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://www.sitemaps.org/</loc></url>'), 'application/xml'), { sitemapUrl: 'https://sitemaps.org/sitemap.xml', bytes: 100, nowMs: NOW });
  const i = r.issues.find((x) => x.code === 'www-mix');
  assert.ok(i, 'expected a www finding');
  assert.equal(i.gsc, 'Path mismatch: Includes www');
  // The regression this guards: a www/non-www split reported as "URL not allowed" cries
  // wolf on the single most common host setup on the web.
  assert.equal(codes(r.perEntry[0].issues).includes('off-host'), false);
  assert.equal(r.perEntry[0].issues.length, 0);
});

t('a genuine cross-domain URL is still an error', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://other.com/a</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('off-host'));
});

t('flags leading whitespace without an XML declaration', () => {
  const r = auditStructure(parseSitemap('\n\n  ' + wrap('<url><loc>https://example.com/a</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('leading-ws'));
});

t('flags an empty sitemap', () => {
  const r = auditStructure(parseSitemap(wrap(''), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('empty'));
});

t('flags a wrong namespace', () => {
  const r = auditStructure(parseSitemap(DECL + '<urlset xmlns="http://example.com/sitemap"><url><loc>https://example.com/a</loc></url></urlset>', 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('ns'));
  assert.equal(r.issues.find((i) => i.code === 'ns').gsc, 'Incorrect namespace');
});

t('flags duplicate tags inside one entry', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc><loc>https://example.com/b</loc></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('dup-tag'));
});

t('tells the user Google ignores changefreq and priority', () => {
  const r = auditStructure(parseSitemap(wrap('<url><loc>https://example.com/a</loc><changefreq>daily</changefreq><priority>0.8</priority></url>'), 'application/xml'), { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('changefreq'));
  assert.ok(codes(r.issues).includes('priority'));
});

t('flags a nested sitemap index', () => {
  const p = parseSitemap(DECL + '<sitemapindex xmlns="' + NS + '"><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>', 'application/xml');
  const r = auditStructure(p, { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.perEntry[0].issues).includes('nested-index'));
});

t('flags over 50000 URLs', () => {
  const fake = { kind: 'urlset', entries: Array.from({ length: 50001 }, (_, i) => ({ locs: ['https://example.com/p' + i], lastmod: null, hasChangefreq: false, hasPriority: false })), bytes: 100, leadingWhitespace: false, startsWithXmlDecl: true, namespace: NS, notes: [] };
  const r = auditStructure(fake, { sitemapUrl: SITEMAP, bytes: 100, nowMs: NOW });
  assert.ok(codes(r.issues).includes('too-many'));
});

// ---------- headFacts ----------
t('reads noindex out of a meta robots tag', () => {
  assert.equal(headFacts('<html><head><meta name="robots" content="noindex, follow"></head></html>').noindex, true);
  assert.equal(headFacts('<html><head><meta name="robots" content="index, follow"></head></html>').noindex, false);
  assert.equal(headFacts('<html><head><meta name="ROBOTS" content="NOINDEX"></head></html>').noindex, true);
  assert.equal(headFacts('<html><head></head></html>').noindex, null);
});

t('reads a canonical link in either attribute order', () => {
  assert.equal(headFacts('<link rel="canonical" href="https://example.com/x">').canonical, 'https://example.com/x');
  assert.equal(headFacts('<link href="https://example.com/x" rel=\'canonical\'>').canonical, 'https://example.com/x');
  assert.equal(headFacts('<link rel="stylesheet" href="/a.css">').canonical, null);
});

// ---------- classifyLive ----------
const OK = { status: 200, html: '<html><head><title>t</title></head></html>', xRobotsTag: null };
const ROBOTS_BLOCKING = 'User-agent: *\nDisallow: /private/';
const ROBOTS_OPEN = 'User-agent: *\nDisallow: /admin/';

t('flags a robots-blocked URL using the shared RFC 9309 matcher', () => {
  const i = classifyLive('https://example.com/private/x', OK, ROBOTS_BLOCKING);
  assert.ok(codes(i).includes('robots-block'));
  assert.equal(i[0].gsc, 'URL blocked by robots.txt');
  assert.equal(classifyLive('https://example.com/public/x', OK, ROBOTS_BLOCKING).length, 0);
});

t('a longer Allow overrides a shorter Disallow', () => {
  const i = classifyLive('https://example.com/admin/ok', OK, 'User-agent: *\nDisallow: /admin/\nAllow: /admin/ok');
  assert.equal(codes(i).includes('robots-block'), false);
});

t('flags a 301 as Page with redirect', () => {
  const i = classifyLive('https://example.com/a', { status: 301, location: 'https://example.com/b', html: '', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i[0].code, 'redirect');
  assert.equal(i[0].gsc, 'Page with redirect');
});

t('flags a 404', () => {
  const i = classifyLive('https://example.com/a', { status: 404, html: '', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i[0].code, 'gone');
  assert.equal(i[0].level, 'error');
});

t('flags a meta noindex on a 200 page', () => {
  const i = classifyLive('https://example.com/a', { status: 200, html: '<head><meta name="robots" content="noindex"></head>', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i[0].code, 'meta-noindex');
  assert.equal(i[0].gsc, 'URL marked noindex');
});

t('flags an X-Robots-Tag noindex header', () => {
  const i = classifyLive('https://example.com/a', { status: 200, html: '<head></head>', xRobotsTag: 'noindex' }, ROBOTS_OPEN);
  assert.ok(codes(i).includes('xrobots-noindex'));
});

t('flags a canonical pointing at another URL', () => {
  const i = classifyLive('https://example.com/a', { status: 200, html: '<head><link rel="canonical" href="https://example.com/b"></head>', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i[0].code, 'canonical-other');
  assert.equal(i[0].gsc, 'Alternate page with proper canonical tag');
});

t('a self-referencing canonical is fine', () => {
  const i = classifyLive('https://example.com/a', { status: 200, html: '<head><link rel="canonical" href="https://example.com/a"></head>', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i.length, 0);
});

t('an unreachable URL is a warning, not a crash', () => {
  const i = classifyLive('https://example.com/a', { status: 0, error: 'timed out', html: '', xRobotsTag: null }, ROBOTS_OPEN);
  assert.equal(i[0].code, 'unreachable');
  assert.equal(i[0].level, 'warn');
});

// ---------- gradeOf / buildCleanSitemap ----------
t('a clean sitemap scores an A', () => {
  assert.equal(gradeOf(0, 0, 0, 40).grade, 'A');
});

t('dead URLs drag the grade down, and more of them drag harder', () => {
  // Each dead URL reaches gradeOf as an error too, which is how the Function calls it.
  const few = gradeOf(2, 0, 2, 40);
  const many = gradeOf(20, 0, 20, 40);
  assert.ok(few.score > many.score, '2 dead should score above 20 dead');
  assert.notEqual(few.grade, 'A', 'two dead URLs is not a clean bill of health');
  assert.equal(many.grade, 'F');
  assert.equal(gradeOf(0, 0, 0, 0).score, 100, 'no sample at all must not penalise the score');
});

t('clean sitemap output is escaped and valid', () => {
  const out = buildCleanSitemap(['https://example.com/a?x=1&y=2']);
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(out.includes('x=1&amp;y=2'));
  assert.equal(parseSitemap(out, 'application/xml').entries[0].locs[0], 'https://example.com/a?x=1&y=2');
});

console.log('\n' + n + ' checks passed');
