#!/usr/bin/env node
// BUG-307 static gate: after deleting the shadow proxies, nothing may still
// reference them, and every getElementById/querySelector id used by script in
// the 25 touched files must actually exist in that file's markup.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'tools');
const IDS = process.argv[2] || '/tmp/shadow-buttons.json';
if (!fs.existsSync(IDS)) { console.error('need ' + IDS + ' (json array of {slug,id}) from bug306-find.js'); process.exit(2); }
const ids = JSON.parse(fs.readFileSync(IDS, 'utf8'));
const removed = new Set(ids.map(b => b.id));
const slugs = [...new Set(ids.map(b => b.slug))].sort();

let fail = 0;
const fail_ = m => { console.log('  FAIL ' + m); fail++; };
const pass = m => console.log('  ok   ' + m);

console.log(`=== ${slugs.length} files, ${removed.size} proxy ids removed ===\n`);

// 1. no proxy markup / css / js left anywhere in the repo
console.log('[1] repo-wide residue scan');
const residue = [];
for (const slug of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, slug, 'index.html');
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const id of removed) if (src.includes(`"${id}"`) || src.includes(`'${id}'`)) residue.push(`${slug}: ${id}`);
  for (const m of src.matchAll(/<button[^>]*\bid="([^"]+)"[^>]*>/g)) {
    if (/shadow/i.test(m[1]) || /class="[^"]*shadow-btn/.test(m[0])) residue.push(`${slug}: proxy markup ${m[1]}`);
  }
  for (const m of src.matchAll(/^\s*\.[\w-]*shadow(?:-btn|-\d)[\w-]*\s*\{/gim)) residue.push(`${slug}: proxy css ${m[0].trim()}`);
}
residue.length ? fail_(`${residue.length} residue: ${[...new Set(residue)].slice(0, 10).join(', ')}`) : pass('0 references to any removed proxy id / proxy css rule remain');

// 2. every script-referenced id exists in markup (catches unguarded leftovers)
console.log('\n[2] getElementById / querySelector id existence in touched files');
for (const slug of slugs) {
  const src = fs.readFileSync(path.join(ROOT, slug, 'index.html'), 'utf8');
  const declared = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set();
  for (const m of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"]#([\w-]+)/g)) used.add(m[1]);
  const missing = [...used].filter(u => !declared.has(u));
  missing.length ? fail_(`${slug}: getElementById target(s) not in markup: ${missing.join(', ')}`) : pass(`${slug}: all ${used.size} id refs resolve`);
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail ? 1 : 0);
