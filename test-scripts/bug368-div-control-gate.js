#!/usr/bin/env node
// BUG-368 static gate: a one-of-N selector that is only a control because of its `role`.
//
//   `<div role="tab" tabindex="0" onclick="switchTab('x')">` and its siblings — 15 of them on
//   3 pages (date-calculator 3, pomodoro-timer 3, table-of-contents-generator 4+5) — declared an
//   ARIA tab pattern the page cannot honour: `role="tablist"` with ZERO `role="tabpanel"` and zero
//   `aria-controls`. So `getByRole('tab')` found the trigger while nothing on the page ever
//   answered to `tabpanel`, and `getByRole('button')` found nothing at all — the exact
//   "Step N click -> Timeout 5000ms" surface BUG-363 and BUG-366 were filed on.
//
//   Two of the three pages were worse than a bad role: pomodoro-timer and
//   table-of-contents-generator's 9 tabs carry NO `tabindex`, so **6 of the 15 were not in the
//   tab order at all** — a keyboard user could not reach them, and date-calculator's 3 had
//   `tabindex="0"` with no keydown handler, so Tab reached them and Enter/Space did nothing.
//
//   BUG-366 left these 3 out of scope on purpose ("the element itself has to change") and left a
//   stale-scope assertion behind so the exclusion could not outlive its reason. That assertion
//   went red, the exclusion was DELETED, and this gate now owns the class structurally and
//   tree-wide — no slug list, so a new `<div role="tab">` anywhere goes red by itself.
//
// What this gate asserts, and why each one:
//   1. No non-<button> element carries `role="tab"` in a document with no `role="tabpanel"`.
//      The defect. 7 pages DO have real tabpanels and a wired tab set — those are the scope cut.
//   2. No `role="tablist"` in a document with no `role="tabpanel"`.            the container side
//   3. Every member of an exclusive one-of-N container is reachable: a `<button>`/`<input>`/
//      `<a href>`, or an explicit non-negative `tabindex`.  The user harm, generalised.
//      First version of this assertion counted only `role="group"` containers and was therefore
//      **green on the pre-fix tree** — the 3 pages called theirs a `tablist`, so the defect's
//      members were never enumerated. It now walks `group` and `tablist` alike; pre-fix it
//      reports 6 unreachable tabs (pomodoro-timer 3 + table-of-contents-generator 9, minus the
//      6 that... precisely: pomodoro 3 and tocg 9 have no tabindex at all; date-calculator's 3
//      do, so it is reachable-but-not-operable, which assertion 1 covers).
//   4. The 3 migrated pages still ship >= 4 strips / >= 15 members.    anti-vacuity: the fix must
//      not be "delete the strip". 4 = 1 + 1 + 2 strips; 15 = the 3+3+9 tabs measured pre-fix.
//
// Anti-vacuity — the fix removed, must FAIL:
//   node bug368-div-control-gate.js /tmp/bug368-prefix
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const TOOLS = path.join(ROOT, 'tools');
const BLANK = /<(script|style|noscript|template|textarea)\b[\s\S]*?<\/\1\s*>/gi;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Same two spellings BUG-367 had to learn: `active` nearly everywhere, `on` on p-value-calculator.
const SELECTED = /\bclass="[^"]*\b(?:active|on|is-active|selected|is-selected|current|checked)\b/;
const MIGRATED = ['date-calculator', 'pomodoro-timer', 'table-of-contents-generator'];

const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

// Tag-by-tag walk with a stack, so a container is paired with its OWN closing tag. Regex
// `<(\w+)…role="group"[\s\S]*?</\1>` breaks on nested groups (tdee-calculator nests
// `tc-mode-toggle` inside `tc-tabs`); BUG-367 shipped that bug once already.
function scan(html) {
  const src = html.replace(BLANK, ' ');
  const out = { divTabs: [], tablists: [], groups: [] };
  for (const m of src.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\brole\s*=\s*["'](tab|tablist|group|button)["'][^>]*)>/gi)) {
    if (!/role\s*=\s*["']tabpanel["']/.test(src) && m[3] === 'tab' && m[1] !== 'button') {
      out.divTabs.push(`<${m[1]}${m[2].replace(/\s+/g, ' ').trim().slice(0, 60)}>`);
    }
  }
  if (!/role\s*=\s*["']tabpanel["']/.test(src) && /\brole\s*=\s*["']tablist["']/.test(src)) out.tablists.push(1);

  const stack = [];
  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*?)(\/?)>/gi)) {
    const [, close, tag, attrs, self] = m;
    if (close) { const top = stack.pop(); if (top && top.group) out.groups.push(top); continue; }
    if (VOID.has(tag) || self === '/') continue;
    const entry = {
      group: /\brole\s*=\s*["'](?:group|tablist)["']/.test(attrs),
      cls: (attrs.match(/class="([^"]*)"/) || [])[1] || '',
      members: [],
    };
    stack.push(entry);
    // `role="tab"` counts as a member too: pre-fix, pomodoro/tocg built the strip out of
    // `role="tab"` divs, which a button-only collector would have skipped entirely — and then
    // assertion 3 would have passed on exactly the tree that assertion 1 rejects.
    if ((tag === 'button' || tag === 'input'
         || /\brole\s*=\s*["'](?:button|tab)["']/.test(attrs)) && stack.length > 1) {
      stack[stack.length - 2].members.push({ tag, attrs });
    }
  }
  return out;
}

const slugs = fs.readdirSync(TOOLS).filter((s) => fs.existsSync(path.join(TOOLS, s, 'index.html')));
const divTabs = [], tablists = [], unreachable = [];
let migratedStrips = 0, migratedMembers = 0;

for (const slug of slugs) {
  const { divTabs: d, tablists: l, groups } = scan(fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8'));
  for (const t of d) divTabs.push(`${slug}: ${t}`);
  if (l.length) tablists.push(slug);
  for (const g of groups) {
    if (g.members.length < 2) continue;
    if (g.members.filter((m) => SELECTED.test(m.attrs)).length !== 1) continue;  // not one-of-N
    if (MIGRATED.includes(slug)) { migratedStrips++; migratedMembers += g.members.length; }
    for (const m of g.members) {
      const reachable = m.tag === 'button' || m.tag === 'input'
        || (m.tag === 'a' && /\bhref\s*=/.test(m.attrs))
        || /\btabindex\s*=\s*["'](?!-\s*["'])/.test(m.attrs);
      if (!reachable) unreachable.push(`${slug} "${g.cls}" <${m.tag}${/role="tab"/.test(m.attrs) ? ' role="tab"' : ''}>`);
    }
  }
}

ok(divTabs.length === 0, `${divTabs.length} non-<button> element(s) declare role="tab" with no role="tabpanel" in the document: ${divTabs.slice(0, 6).join(' | ')}`);
ok(tablists.length === 0, `${tablists.length} page(s) declare role="tablist" with no role="tabpanel": ${tablists.join(', ')}`);
ok(unreachable.length === 0, `${unreachable.length} member(s) of an exclusive one-of-N container cannot be reached by keyboard: ${unreachable.slice(0, 8).join(' | ')}`);
ok(migratedStrips >= 4, `only ${migratedStrips} strip(s) left on the 3 migrated pages — expected >= 4 (the fix must not delete the strips)`);
ok(migratedMembers >= 15, `only ${migratedMembers} tab button(s) left on the 3 migrated pages — expected >= 15`);

console.log(`[gate] scanned ${slugs.length} tool pages`);
console.log(`[gate] div role="tab": ${divTabs.length} · orphan role="tablist": ${tablists.length} · unreachable strip members: ${unreachable.length} · migrated strips: ${migratedStrips}/${migratedMembers}`);

if (failures.length) {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`[gate] ${checks - failures.length}/${checks} checks passed FAIL`);
  process.exit(1);
}
console.log(`[gate] ${checks}/${checks} checks passed PASS`);
