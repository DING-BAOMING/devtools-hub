#!/usr/bin/env node
// Static gate: every JSON-LD block in every shipped HTML file must PARSE.
//
// An invalid block is not a cosmetic defect. A consumer that fails to parse one block discards
// it, so the page silently loses the schema it declared — and the sitewide patcher in
// functions/tools/[[catchall]].js makes it worse: it skips injecting a real FAQPage when the
// markup already contains the string `"@type": "FAQPage"`, which a BROKEN block satisfies.
// That is how tools/ping-test ended up serving a FAQPage with zero questions while the page had
// 8 <details class="faq-item"> entries (BUG-312).
//
// The scan strips every <script> element that is NOT application/ld+json before looking for
// blocks, so a page that *generates* JSON-LD for the user (schema-markup-generator's code sample,
// css-to-tailwind's CSS sample) is not a false positive. A regex alone cannot tell those apart.
//   node bug312-jsonld-parses-static-gate.js [rootDir]
//
// ANTI-VACUITY: pass a rootDir whose JSON-LD defects have been re-injected and the gate MUST
// fail. A gate that passes on a deliberately broken tree measures nothing.
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.html')) files.push(f);
  }
})(ROOT);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const no = (m) => { fail++; console.log('  FAIL ' + m); };

const bad = [];
let blocks = 0, dynamic = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  // drop every script element that is not a JSON-LD block
  const only = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (m) => (/application\/ld\+json/i.test(m) ? m : ''));
  for (const m of only.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const body = m[1].trim();
    // A page that BUILDS JSON-LD in JS (schema-markup-generator hands the user a template) is
    // not a static block and no source scanner can see inside a JS string. Hand-written blocks
    // — the only kind that can carry this defect — always start with { or [.
    if (!/^[[{]/.test(body)) { dynamic++; continue; }
    blocks++;
    try { JSON.parse(m[1]); }
    catch (e) {
      bad.push({ f: path.relative(ROOT, f), err: String(e.message), around: body.slice(0, 120).replace(/\s+/g, ' ') });
    }
  }
}

ok(`scanned ${files.length} HTML files, ${blocks} hand-written JSON-LD blocks (${dynamic} JS-built, browser-tier only)`);
if (bad.length === 0) ok('every hand-written JSON-LD block in the repo parses as JSON');
else bad.forEach(b => no(`${b.f} — ${b.err} — ${b.around}`));

// Second gate: a FAQPage block that declares zero questions is the ping-test signature — the
// page has the <details> entries but the block says nothing. The patcher will not inject a real
// one because the string `"@type": "FAQPage"` is already present.
const empty = [];
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const faqs = (html.match(/class="faq-item"/g) || []).length;
  if (!faqs) continue;
  const only = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (m) => (/application\/ld\+json/i.test(m) ? m : ''));
  for (const m of only.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    if (!/^[[{]/.test(m[1].trim())) continue;
    let j; try { j = JSON.parse(m[1]); } catch (e) { continue; }
    const nodes = Array.isArray(j['@graph']) ? j['@graph'] : [j];
    for (const n of nodes) {
      if (n['@type'] === 'FAQPage' && (!Array.isArray(n.mainEntity) || n.mainEntity.length === 0)) {
        empty.push(path.relative(ROOT, f) + ` (${faqs} faq-item elements on the page)`);
      }
    }
  }
}
empty.length === 0
  ? ok('no page declares a FAQPage with zero questions while having <details class="faq-item">')
  : empty.forEach(e => no('empty FAQPage: ' + e));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
