/**
 * BUG-522 gate: the per-tool OG card must be the TOOL's card, not the generic one.
 *
 * WHY
 * functions/api/og/<slug>.svg used to strip the suffix from the route param in the
 * wrong order, so the manifest lookup missed every tool and every request took the
 * fallback branch — the card said "Json Formattersvg", the category was the generic
 * "Developer Tools", and the URL on the card pointed at a page that 404s. No gate
 * looked at the card itself (bug393 only checks the meta tag on the page).
 *
 * WHAT IT CHECKS
 * For a sample of tool pages: the og:image URL on the page, the card it returns,
 * and that the card is valid XML whose title matches the tool and whose URL is the
 * tool's real URL.
 *
 * Usage: node test-scripts/bug522-og-card-prod-test.js [slug ...]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'https://tools.scoreroute.com';
const ROOT = path.join(__dirname, '..');

const DEFAULT_SAMPLE = [
  'json-formatter', 'world-clock', 'html-entity-encoder', 'age-calculator',
  'pdf-editor', 'text-summarizer', 'json-formatter', 'size-converter'
];
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLE;

// The manifest name, to know what the card should say.
const manifestNames = new Map();
execSync("grep '^[a-z0-9]' manifest.txt", { cwd: ROOT, maxBuffer: 1e8 })
  .toString().split('\n').forEach((line) => {
    const p = line.split('|');
    if (p.length >= 5) manifestNames.set(p[0].trim(), p[4].trim());
  });

let fail = 0;
function ok(cond, label, detail) {
  if (cond) { console.log('  ✓ ' + label); return; }
  fail++;
  console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
}

(async () => {
  for (const slug of slugs) {
    console.log('[' + slug + ']');
    const page = await (await fetch(`${BASE}/tools/${slug}/`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAudit/1.0)' } })).text();
    const img = (page.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
    ok(!!img && img.includes(`/api/og/${slug}.svg`), 'the page points at its own OG card', 'og:image = ' + img);
    if (!img) continue;

    // Cache-bust the card URL: the CDN holds the edge copy for 7 days
    // (Cache-Control: max-age=604800), so a plain fetch would keep returning the
    // pre-fix card even after the function is fixed. The gate tests the function.
    const busted = img.split('?')[0] + '?cb=og' + Date.now();
    const res = await fetch(busted, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAudit/1.0)' } });
    ok(res.status === 200, 'the card answers 200', 'status ' + res.status);
    const svg = await res.text();

    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    const title = texts.find((t) => t && !['DEVTOOLS HUB', '⚡'].includes(t) && !t.startsWith('tools.scoreroute.com') && !t.includes('· Free online'));
    const url = texts.find((t) => t.startsWith('tools.scoreroute.com/tools/'));

    ok(!/svg$/.test(title || ''), 'the title has no ".svg" glued to it', 'title = ' + title);
    const want = (manifestNames.get(slug) || '').split(/\s+-\s+/)[0].toLowerCase();
    ok(!!title && title.toLowerCase() === want, 'the title is the tool name', `got "${title}", want "${want}"`);
    ok(url === `tools.scoreroute.com/tools/${slug}/`, 'the card URL is the tool URL', 'got ' + url);
    ok(!texts.some((t) => t.includes('Developer Tools · Free online developer tool')), 'the card is not the generic fallback');

    // Valid XML? A raw & in a description breaks the card.
    const tmp = path.join(require('os').tmpdir(), 'og-card-' + slug + '.svg');
    fs.writeFileSync(tmp, svg);
    let xmlOk = true;
    try { execSync(`python3 -c "import xml.etree.ElementTree as ET;ET.parse('${tmp}')"`); }
    catch (e) { xmlOk = false; }
    ok(xmlOk, 'the card is valid XML');
  }
  console.log(fail === 0 ? 'PASS' : 'FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
