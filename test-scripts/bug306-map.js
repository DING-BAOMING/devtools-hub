#!/usr/bin/env node
// For each shadow button, find the real control its forwarding JS targets, so the
// shadow's data-testid can be migrated onto that real control before deletion.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'tools');
const buttons = JSON.parse(fs.readFileSync('/tmp/shadow-buttons.json', 'utf8'));
const byslug = {};
for (const b of buttons) (byslug[b.slug] = byslug[b.slug] || new Set()).add(b.id);

const rows = [];
for (const [slug, ids] of Object.entries(byslug).sort()) {
  const src = fs.readFileSync(path.join(ROOT, slug, 'index.html'), 'utf8');
  const lines = src.split('\n');
  // var NAME = document.getElementById('x')  ->  NAME maps to real element x
  const varMap = {};
  for (const ln of lines) {
    const m = ln.match(/var\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]([\w-]+)['"]\s*\)/);
    if (m) varMap[m[1]] = m[2];
  }
  const testid = {};
  lines.forEach(ln => { const m = ln.match(/<button[^>]*\bid="([\w-]+)"[^>]*data-testid="([\w-]+)"/) || ln.match(/<button[^>]*data-testid="([\w-]+)"[^>]*\bid="([\w-]+)"/); if (m) testid[m[1]] = m[2]; });

  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const re = new RegExp(`(?:var\\s+(\\w+)\\s*=\\s*)?document\\.getElementById\\(\\s*['"\`]${esc}['"\`]\\s*\\)[^\\n]*`);
    // gather the statement (may span lines)
    let stmt = '', start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`'${id}'`) || lines[i].includes(`"${id}"`)) {
        if (re.test(lines[i]) || /getElementById/.test(lines[i])) {
          start = i; let depth = 0;
          for (let k = i; k < lines.length; k++) { stmt += lines[k] + ' '; for (const ch of lines[k]) { if (ch === '(') depth++; else if (ch === ')') depth--; } if (depth <= 0) break; }
          break;
        }
      }
    }
    // resolve target:  X.click() | getElementById('y').click() | fn()
    let target = null, how = '';
    let m = stmt.match(/getElementById\(\s*['"]([\w-]+)['"]\s*\)\s*\.click\(\)/);
    if (m) { target = m[1]; how = 'direct .click()'; }
    if (!target) { m = stmt.match(/(\w+)\.click\(\)/); if (m) { target = varMap[m[1]] || m[1]; how = `var ${m[1]}`; } }
    if (!target) { m = stmt.match(/addEventListener\(\s*['"]click['"]\s*,\s*(\w+)\s*\)/); if (m) { target = m[1] + '()'; how = 'handler fn'; } }
    if (!target) { m = stmt.match(/function\s*\(\)\s*\{\s*(\w+)\s*\(/); if (m) { target = m[1] + '()'; how = 'inner fn'; } }
    if (!target) { m = stmt.match(/(\w+)\s*\(\s*\)/); if (m) { target = m[1] + '()'; how = 'bare fn'; } }
    rows.push({ slug, shadow: id, testid: testid[id] || '(none)', realTarget: target || 'UNRESOLVED', how, stmt: stmt.trim().slice(0, 95) });
  }
}
let un = 0;
for (const r of rows) { if (!r.realTarget || r.realTarget === 'UNRESOLVED') un++; }
for (const r of rows) console.log(`${r.realTarget === 'UNRESOLVED' ? '!!' : '  '} ${r.slug.padEnd(24)} ${r.shadow.padEnd(26)} -> ${String(r.realTarget).padEnd(16)} [${r.how}]  tid=${r.testid}`);
console.log(`\n${rows.length} shadows, ${un} UNRESOLVED targets`);
fs.writeFileSync('/tmp/shadow-map.json', JSON.stringify(rows, null, 1));
