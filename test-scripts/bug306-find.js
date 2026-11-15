#!/usr/bin/env node
// Find every invisible shadow-proxy button in tools/*/index.html.
// Two mechanisms: inline style="...opacity:0..." on a <button>, or a CSS class
// that zeroes the box out. Report file:line + id so removal is auditable.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'tools');
const out = [];
for (const slug of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, slug, 'index.html');
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    if (!/<button/i.test(ln)) return;
    const id = (ln.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) return;
    const inlineZero = /opacity:\s*0(\.0*[0-9]*)?\s*;/.test(ln) || /opacity:\s*0(\.0*[0-9]*)?\s*"/.test(ln);
    const clsShadow = /class="[^"]*shadow/i.test(ln);
    if (inlineZero || clsShadow) out.push({ slug, line: i + 1, id, inlineZero, clsShadow, text: (ln.match(/>([^<]{0,30})</) || [])[1] });
  });
}
const byslug = {};
for (const r of out) (byslug[r.slug] = byslug[r.slug] || []).push(r);
console.log(`TOTAL ${out.length} shadow buttons in ${Object.keys(byslug).length} files\n`);
for (const [slug, rows] of Object.entries(byslug).sort()) {
  console.log(`${slug}  [${rows.map(r => r.id).join(', ')}]  (${rows[0].clsShadow ? 'class' : 'inline'})`);
}
fs.writeFileSync('/tmp/shadow-buttons.json', JSON.stringify(out, null, 1));
