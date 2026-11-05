/**
 * Site-wide health + SEO audit. Checks every tool page listed in manifest.txt
 * plus the derived surfaces, over HTTP, with a concurrency cap.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const BASE = 'https://tools.scoreroute.com';
const CONC = 12;

const slugs = execSync("grep '^[a-z0-9]' manifest.txt | cut -d'|' -f1", { cwd: __dirname + '/..', maxBuffer: 1e8 })
  .toString().trim().split('\n').filter(Boolean);

function pick(html, re) { const m = html.match(re); return m ? m[1] : null; }
function decode(s) {
  return s == null ? null : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

async function check(slug) {
  const r = { slug, bad: [] };
  try {
    const res = await fetch(BASE + '/tools/' + slug + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAudit/1.0)' } });
    r.status = res.status;
    if (res.status !== 200) { r.bad.push('HTTP ' + res.status); return r; }
    const html = await res.text();
    r.bytes = html.length;
    if (html.length < 3000) r.bad.push('thin body ' + html.length);

    r.title = decode(pick(html, /<title>([^<]*)<\/title>/));
    r.desc = decode(pick(html, /<meta name="description" content="([^"]*)"/));
    r.canon = pick(html, /<link rel="canonical" href="([^"]*)"/);
    r.h1 = (html.match(/<h1[\s>]/g) || []).length;
    r.ld = (html.match(/application\/ld\+json/g) || []).length;
    r.faq = (html.match(/class="[^"]*\bfaq-item\b/g) || []).length;
    r.weapp = /"@type":\s*"WebApplication"|"@type":"WebApplication"/.test(html);
    r.robots = pick(html, /<meta name="robots" content="([^"]*)"/);

    if (!r.title) r.bad.push('no title');
    else if (r.title.length > 60) r.bad.push('title ' + r.title.length + ' chars');
    if (!r.desc) r.bad.push('no meta description');
    else if (r.desc.length < 70 || r.desc.length > 160) r.bad.push('desc ' + r.desc.length + ' chars');
    if (r.h1 !== 1) r.bad.push('h1=' + r.h1);
    if (!r.canon) r.bad.push('no canonical');
    else if (r.canon !== BASE + '/tools/' + slug + '/') r.bad.push('canonical ' + r.canon);
    if (!r.weapp) r.bad.push('no WebApplication JSON-LD');
    if (r.robots && !/max-snippet:-1/.test(r.robots)) r.bad.push('robots limits snippet: ' + r.robots);
    if (/&amp;amp;/.test(html)) r.bad.push('double-encoded &amp;amp;');
    if (html.indexOf('| DevTools Hub') === -1 && r.title && r.title.indexOf('DevTools Hub') === -1 && r.title.length < 58) r.bad.push('title missing brand');
  } catch (e) { r.bad.push('FETCH ' + e.message); }
  return r;
}

(async () => {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < slugs.length) { const s = slugs[i++]; results.push(await check(s)); }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const bad = results.filter((r) => r.bad.length);
  console.log('checked ' + results.length + ' tool pages at ' + new Date().toUTCString());
  console.log('healthy: ' + (results.length - bad.length) + '   with issues: ' + bad.length + '\n');
  const byIssue = {};
  bad.forEach((r) => r.bad.forEach((b) => {
    const k = b.replace(/\d+/g, 'N');
    (byIssue[k] = byIssue[k] || []).push(r.slug);
  }));
  Object.keys(byIssue).sort().forEach((k) => console.log('  ' + k + '  x' + byIssue[k].length + '  -> ' + byIssue[k].slice(0, 12).join(', ') + (byIssue[k].length > 12 ? ' …' : '')));

  console.log('\n--- derived surfaces ---');
  const sm = await (await fetch(BASE + '/sitemap.xml')).text();
  const smUrls = (sm.match(/<loc>/g) || []).length;
  const missing = slugs.filter((s) => sm.indexOf('/tools/' + s + '/') === -1);
  console.log('sitemap.xml: ' + smUrls + ' URLs; tool pages missing from sitemap: ' + missing.length + (missing.length ? ' -> ' + missing.slice(0, 10).join(', ') : ''));
  const llms = await (await fetch(BASE + '/llms.txt')).text();
  console.log('llms.txt: ' + llms.length + ' bytes; slugs missing: ' + slugs.filter((s) => llms.indexOf('/tools/' + s + '/') === -1).length);
  const tj = await (await fetch(BASE + '/api/tools')).json();
  console.log('/api/tools: ' + (tj.tools || []).length + ' tools; slugs missing: ' + slugs.filter((s) => !(tj.tools || []).some((t) => t.slug === s)).length);
  const home = await (await fetch(BASE + '/')).text();
  console.log('homepage: ' + home.length + ' bytes');
  for (const c of ['formatters', 'calculators', 'generators', 'converters', 'media', 'network', 'code-testing', 'pdf-tools', 'life', 'finance', 'ai-language']) {
    const res = await fetch(BASE + '/tools/' + c + '/');
    const t = await res.text();
    const expect = slugs.filter((s) => {
      const line = execSync("grep '^" + s + "|' manifest.txt", { cwd: __dirname + '/..' }).toString();
      return line.split('|')[1] === c;
    });
    const missingHere = expect.filter((s) => t.indexOf('/tools/' + s + '/') === -1);
    console.log('  /tools/' + c + '/ HTTP ' + res.status + ', expects ' + expect.length + ' tools, missing ' + missingHere.length + (missingHere.length ? ' -> ' + missingHere.slice(0, 5).join(', ') : ''));
  }
  process.exitCode = bad.length ? 1 : 0;
})();
