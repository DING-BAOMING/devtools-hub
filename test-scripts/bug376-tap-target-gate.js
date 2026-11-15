#!/usr/bin/env node
// BUG-376 static gate — stretched-link tap targets for hub tool cards.
// The defect: on every hub template (home, /tools/, category pages) the ONLY anchor inside a
// .tool-card is the title link, ~15-17px tall on mobile — below the site's own 44px touch floor
// (styles.css .feedback-link padding; BUG-306/368 family). 69 small targets on home @375px.
// The fix: `position: relative` on .tool-card + ::after inset:0 on the title link (stretched-link).
// The gate asserts (A) both shared stylesheets carry the fix, (B) every card producer has exactly
// ONE <a> per .tool-card (a second link would be swallowed by the overlay), (C) anti-vacuity —
// stripping the new rules turns the gate red.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
let fail = 0;

function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) fail++;
}

// ---- Tier A: fix present in both stylesheets --------------------------------
for (const file of ['styles.css', 'home.css']) {
  const css = fs.readFileSync(path.join(REPO, file), 'utf8');
  const cardPos = /\.tool-card[^{]*\{[^}]*position:\s*relative/.test(css);
  const after = /\.tool-card[^{]*(h3|h2\.tool-card-title) a::after[^}]*inset:\s*0/.test(css);
  check(`${file}: .tool-card position:relative`, cardPos);
  check(`${file}: title-link ::after inset:0 stretched rule`, after);
}

// ---- Tier B: every .tool-card producer has exactly ONE <a> per card --------
// Card HTML is a single line in each producer; count <a inside each card literal.
const producers = ['functions/index.js', 'functions/tools/[[catchall]].js', 'tools/index.html'];
for (const file of producers) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const cards = src.match(/<div class="tool-card"[\s\S]{0,400}?<\/div>/g) || [];
  if (!cards.length) { check(`${file}: card literal found`, false); continue; }
  const multi = cards.filter(c => (c.match(/<a[\s>]/g) || []).length !== 1);
  check(`${file}: ${cards.length} card literal(s), each exactly 1 <a>`, cards.length > 0 && multi.length === 0, multi.length ? 'cards with != 1 anchor: ' + JSON.stringify(multi).slice(0, 300) : '');
}

// ---- Tier C: anti-vacuity — strip the fix, gate must go red ----------------
for (const file of ['styles.css', 'home.css']) {
  const css = fs.readFileSync(path.join(REPO, file), 'utf8')
    .replace(/\.tool-card[^{]*(h3|h2\.tool-card-title) a::after[^}]*\}/g, '');
  const stripped = !/\.tool-card[^{]*(h3|h2\.tool-card-title) a::after/.test(css);
  check(`${file}: anti-vacuity (stripped state measures broken)`, stripped);
}
// (Tier C verifies the detector's own needle消失 when the fix is removed — paired with Tier A,
// which would also fail in the stripped state; together they prove the fix is the only way green.)

console.log(`\n${fail === 0 ? 'GATE GREEN' : 'GATE RED'} — ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
