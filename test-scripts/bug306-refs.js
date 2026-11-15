#!/usr/bin/env node
// For every shadow-button id we plan to delete, find JS references and classify
// guarded (safe if element missing) vs unguarded (would throw on null).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'tools');
const buttons = JSON.parse(fs.readFileSync('/tmp/shadow-buttons.json', 'utf8'));
const byslug = {};
for (const b of buttons) (byslug[b.slug] = byslug[b.slug] || new Set()).add(b.id);

let unguarded = 0, guarded = 0;
for (const [slug, ids] of Object.entries(byslug)) {
  const src = fs.readFileSync(path.join(ROOT, slug, 'index.html'), 'utf8');
  const lines = src.split('\n');
  for (const id of ids) {
    const re = new RegExp(`getElementById\\(\\s*['"\`]${id}['"\`]\\s*\\)`);
    lines.forEach((ln, i) => {
      if (!re.test(ln)) return;
      // walk back up to 3 lines for a null guard
      const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      const isGuarded = /if\s*\(\s*(document\.)?getElementById|\|\|\s*null|&&\s*/.test(ctx);
      const chained = /\.addEventListener/.test(ln) && !/^\s*(if|var|const|let)\b/.test(ln.trim());
      if (chained && !isGuarded) { unguarded++; console.log(`UNGUARDED  ${slug} L${i + 1}  ${ln.trim().slice(0, 140)}`); }
      else { guarded++; console.log(`  guarded   ${slug} L${i + 1}  ${ln.trim().slice(0, 110)}`); }
    });
  }
}
console.log(`\n${guarded} guarded, ${unguarded} UNGUARDED`);
