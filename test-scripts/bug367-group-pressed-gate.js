#!/usr/bin/env node
// BUG-367 / BUG-399 static gate: a one-of-N selector must announce AND paint its selected member.
//
// REWRITE 2026-10-27 (BUG-399). The previous version bucketed a strip by what its MARKUP
// declared:
//   classSel===1                          -> selector (paints via a selected-state class)
//   classSel===0 && pressedTrue===1       -> selector (paints via aria-pressed alone)
//   classSel===0 && pressed===0           -> "one-shot action row"  (excluded; count pinned to 15)
//
// A selector whose selection is painted by a CSS `[aria-pressed="true"]` hook but whose MARKUP
// omits the attribute therefore fell into the ACTION bucket — the gate filed the defect as
// benign, then reported only a rot count. That is how /tools/baby-percentile-calculator/ and
// /tools/seating-chart-maker/ shipped a one-of-N control that announces no selection AND paints
// no selection on load: the "selected" CSS never matched because the attribute was never there.
//
// The class is now decidable from the tree, with no slug list to rot:
//   SELECTOR   = the strip's own class (or one of its buttons' classes) appears in a CSS rule
//                that also keys on [aria-pressed="true"]  ->  the page PAINTS a selected member,
//                so a member IS selected and must say so.
//   ACTION ROW = no such hook  ->  no member is selected, so aria-pressed would be a lie.
// The two pinned counts (3 selector strips / 15 action rows) are gone: both were lists that could
// rot, and the ledger that predicted them was correct while the gate that read it was blind.
//
// Anti-vacuity — the fix removed, must FAIL:
//   node bug367-group-pressed-gate.js /tmp/bug367-prefix
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const TOOLS = path.join(ROOT, 'tools');
const BLANK = /<(script|style|noscript|template|textarea)\b[\s\S]*?<\/\1\s*>/gi;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// The selected-state class is not spelled the same on every page: `active` on most, `on` on
// p-value-calculator. A predicate that only knew `active` would file p-value-calculator's
// pv-tabs as a row of one-shot actions and quietly stop watching it.
const SELECTED = /\bclass="[^"]*\b(?:active|on|is-active|selected|is-selected|current|checked)\b/;
const PRESSED_HOOK = /aria-pressed\s*=\s*["']?true/i;

const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const classTokens = (s) => (s || '').split(/\s+/).filter(Boolean);

// A tag-by-tag walk with a stack, so a container is paired with its OWN closing tag (a regex
// `<(\w+)…</\1>` breaks on nested containers). Void elements never open a scope.
function stripsOf(html) {
  const src = html.replace(BLANK, ' ');
  const out = [];
  const stack = [];
  for (const m of src.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*?)(\/?)>/gi)) {
    const [, close, tag, attrs, self] = m;
    if (close) {
      const top = stack.pop();
      // Population: role="group" only. A row of independent buttons that merely happens to sit
      // in a div is not a one-of-N selector — extending the population to every button row
      // pulled in 155 false positives (mode rows painted with `.active`, tab strips, toolbars).
      if (top && top.group && top.buttons.length >= 2) out.push(top);
      continue;
    }
    if (VOID.has(tag) || self === '/') continue;
    const entry = {
      group: /\brole\s*=\s*["']group["']/.test(attrs),
      cls: (attrs.match(/class="([^"]*)"/) || [])[1] || '',
      label: (attrs.match(/aria-label="([^"]*)"/) || [])[1] || '',
      buttons: [],
    };
    stack.push(entry);
    if (tag === 'button' && stack.length > 1) stack[stack.length - 2].buttons.push(attrs);
  }
  return out;
}

const slugs = fs.readdirSync(TOOLS).filter((s) => fs.existsSync(path.join(TOOLS, s, 'index.html')));
const missing = [];       // a selector member with no aria-pressed
const multiTrue = [];     // a selector with != 1 member pressed=true
const frozen = [];        // declares aria-pressed but never updates it in JS
const liars = [];         // an action row that claims to be pressed
const selectorStrips = [];
const actionStrips = [];
let selectorToggles = 0, actionToggles = 0;

for (const slug of slugs) {
  const raw = fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8');
  const css = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => m[1].trim());
  const hookRules = rules.filter((r) => PRESSED_HOOK.test(r));
  const jsUpdates = /setAttribute\(\s*['"]aria-pressed/.test(raw);

  for (const g of stripsOf(raw)) {
    const n = g.buttons.length;
    const pressed = g.buttons.filter((b) => /\baria-pressed\s*=/.test(b)).length;
    const pressedTrue = g.buttons.filter((b) => /aria-pressed\s*=\s*["']?true["']?/.test(b)).length;
    const classSel = g.buttons.filter((b) => SELECTED.test(b)).length;

    // The structural discriminator: does the page paint a selected member of THIS strip?
    const tokens = [...classTokens(g.cls), ...g.buttons.flatMap((b) => classTokens((b.match(/class="([^"]*)"/) || [])[1]))];
    const hook = hookRules.find((r) => tokens.some((t) => new RegExp('\\.' + escRe(t) + '(?![\\w-])').test(r)));

    if (hook || classSel === 1) {
      selectorStrips.push(`${slug} "${g.cls || g.label}" n=${n}`);
      selectorToggles += n;
      if (pressed < n) missing.push(`${slug} "${g.cls || g.label}" ${pressed}/${n}`);
      if (pressedTrue !== 1) multiTrue.push(`${slug} "${g.cls || g.label}" true=${pressedTrue}`);
      // The trap BUG-366 shipped on its first pass: `aria-pressed` added to the markup and never
      // touched in JS is worse than nothing — the attribute freezes on the initial value and the
      // button lies about the mode you are in after the first click. Markup is not a state machine.
      if (pressed >= 1 && !jsUpdates) frozen.push(slug);
    } else {
      actionStrips.push(`${slug} "${g.cls || g.label}"`);
      actionToggles += n;
      if (pressed > 0) liars.push(`${slug} "${g.cls || g.label}" ${pressed}/${n}`);
    }
  }
}

ok(missing.length === 0, `${missing.length} selector strip(s) have a member with no aria-pressed — ${missing.slice(0, 10).join(' | ')}`);
ok(multiTrue.length === 0, `${multiTrue.length} selector strip(s) do not have exactly one member pressed=true — ${multiTrue.slice(0, 10).join(' | ')}`);
ok(frozen.length === 0, `${frozen.length} page(s) declare aria-pressed but never update it in JS — the state freezes after the first click: ${[...new Set(frozen)].join(', ')}`);
ok(liars.length === 0, `${liars.length} one-shot action row(s) claim to be pressed — aria-pressed on an action row is a lie: ${liars.slice(0, 6).join(' | ')}`);
ok(selectorStrips.length >= 50, `only ${selectorStrips.length} selector role="group" strips found — expected >= 50 (the fix must not delete the strips)`);
ok(selectorToggles >= 200, `only ${selectorToggles} selector toggle buttons found — expected >= 200`);
ok(actionStrips.length >= 10, `only ${actionStrips.length} one-shot action rows found — expected >= 10 (the fix must not delete them)`);

console.log(`[gate] scanned ${slugs.length} tool pages`);
console.log(`[gate] selector strips: ${selectorStrips.length} / ${selectorToggles} toggles · action rows: ${actionStrips.length} / ${actionToggles} buttons · missing aria-pressed: ${missing.length} · multi-true: ${multiTrue.length} · frozen: ${frozen.length} · liars: ${liars.length}`);

if (failures.length) {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`[gate] ${checks - failures.length}/${checks} checks passed FAIL`);
  process.exit(1);
}
console.log(`[gate] ${checks}/${checks} checks passed PASS`);
