#!/usr/bin/env node
// If a shadow button was the ONLY element carrying a data-testid, deleting it
// removes a locator the auto-audit may depend on. Report those so the testid can
// be moved onto the real button instead of lost.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'tools');
const buttons = JSON.parse(fs.readFileSync('/tmp/shadow-buttons.json', 'utf8'));
const byslug = {};
for (const b of buttons) (byslug[b.slug] = byslug[b.slug] || new Set()).add(b.id);

let orphans = 0;
for (const [slug, ids] of Object.entries(byslug).sort()) {
  const src = fs.readFileSync(path.join(ROOT, slug, 'index.html'), 'utf8');
  const lines = src.split('\n');
  for (const id of ids) {
    const btnLine = lines.find(l => l.includes('<button') && l.includes(`id="${id}"`));
    if (!btnLine) continue;
    const tid = (btnLine.match(/data-testid="([^"]+)"/) || [])[1];
    if (!tid) continue;
    const holders = lines.filter(l => l.includes(`data-testid="${tid}"`));
    if (holders.length === 1) {
      orphans++;
      // what does the shadow forward to? look for the real button by testid similarity
      const base = tid.replace(/-shadow$/, '');
      const guess = lines.filter(l => /<button/.test(l) && l.includes(`data-testid="${base}"`)).map(l => (l.match(/id="([^"]+)"/) || [])[1]);
      console.log(`ORPHAN  ${slug}  testid="${tid}"  (shadow ${id})  -> real button with same testid: ${guess.length ? guess.join(',') : 'NONE FOUND'}`);
    }
  }
}
console.log(`\n${orphans} data-testid values would become orphaned`);
