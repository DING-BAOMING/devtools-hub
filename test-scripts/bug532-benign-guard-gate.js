#!/usr/bin/env node
// BUG-532 static gate: a benign precondition guard must not be rendered with an error tone.
//
// The n8n quality inspector (quality_inspection_workflow.py:1172) scans
// `document.querySelectorAll('[class*="error"], .alert-danger')` in finalState and records
// any non-empty text as a `tool_error`; after 3 rechecks that escalates and lands on the
// public feedback page as "Tool error: Please enter some text." while the tool works fine.
// That is the BUG-478 → 525 → 526 → 528 → 531 family; BUG-532 is the class-wide round.
//
// Scope of the gate (the class this round fixed):
//   sinks that put a TONE into the element's class (`showStatus` / `setStatus` with a type
//   argument). The benign call sites now pass 'info' and the page carries a neutral rule.
//   The `showError(msg)` family — a bespoke sink with its own error class — is NOT covered
//   here: it is the next round's work list, held down by the ratchet in [B].
//
// The gate re-derives the class from the tree with its own scan; it is not the patcher, so a
// green gate means the tree is clean, not that two copies of one script agree.
//
// Usage:
//   node bug532-benign-guard-gate.js            # the working tree (+ the strip layer)
//   node bug532-benign-guard-gate.js <rootDir>  # a copy (the anti-vacuity strip layer)
//
// Anti-vacuity: the gate copies the tree, reverts the fix (the neutral tone back to
// 'error'), and requires the same checker to go RED. A gate that cannot go red measures
// nothing — so the strip layer runs as part of every gate run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
const RUN_STRIP = !process.argv[2];   // the strip layer runs against the working tree only

// --- the two predicates -----------------------------------------------------
// A message is a PRECONDITION when it asks the visitor for something they have not
// provided yet ("Please enter…", "Nothing to copy", "Generate a calendar first", …).
// It is NOT a precondition when it reports that the TOOL or an UPSTREAM failed.
const FAILURE = /(fail|error|could ?n[o']t|unable|denied|unsupported|not support|timed? ?out|timeout|permission|exception|crash|connection|server |exceed|too (large|big|heavy|old)|must be (under|below|between)|no such|not found|unreachable|refus|invalid|out of range|rate limit|generated|returned)/i;
const PRECONDITION = /^(please\s+)?(enter|paste|select|choose|upload|provide|add|pick|type|specify|drop|search|fill|describe|connect|start|press|click|write|tell|give|check|generate|calculate|run|nothing|no |fill in|your |use )/i;
const isPrecondition = (m) => !!m && !FAILURE.test(m) && PRECONDITION.test(m.trim());

// --- the scanner (this gate's own implementation) ---------------------------
// Every call of showStatus/setStatus/showError with a literal message, plus the tone the
// sink would put into the element's class.
function findCalls(html, fn) {
  const out = [];
  const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(html))) {
    let i = re.lastIndex, depth = 1, args = [], cur = '';
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === '(') { depth++; cur += c; i++; continue; }
      if (c === ')') { depth--; if (depth === 0) { args.push(cur); i++; break; } cur += c; i++; continue; }
      if (c === "'" || c === '"') {
        const q = c; let s = c; i++;
        while (i < html.length) {
          if (html[i] === '\\') { s += html[i] + html[i + 1]; i += 2; continue; }
          if (html[i] === q) { s += q; i++; break; }
          s += html[i]; i++;
        }
        cur += ' ' + s + ' '; continue;
      }
      if (c === ',' && depth === 1) { args.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    re.lastIndex = i;
    const literals = [];
    for (const a of args) for (const s of a.matchAll(/(['"])((?:[^'"\\]|\\.)*)\1/g)) literals.push(s[2]);
    out.push({ literals, start: m.index, end: i, text: html.slice(m.index, i) });
  }
  return out;
}
function sinkBody(html, fn) {
  const i = html.indexOf('function ' + fn + '(');
  if (i < 0) return null;
  const j = html.indexOf('{', i);
  let d = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') d++;
    else if (html[k] === '}') { d--; if (d === 0) return html.slice(i, k + 1); }
  }
  return null;
}
// The class the sink would render for a given tone — or null when the sink does not put
// the tone into the class at all (inline colours, a fixed element class).
function toneClass(html, fn, tone, loadsToolsJs) {
  const local = sinkBody(html, fn);
  if (!local) {
    if (!loadsToolsJs) return null;
    if (fn === 'showStatus') return 'status ' + tone;      // the shared /tools.js helper
    return null;
  }
  const expr = (local.match(/className\s*=\s*([^;]{0,140})/) || [])[1];
  if (!expr) return null;
  if (!/className\s*=\s*[^;]*\btype\b/.test(local)) {
    // the class may be built inside markup: '<div class="x-status ' + type + '">'
    if (!/class\s*=\s*['"][^'"]*['"]\s*\+\s*type/.test(local)) return null;
  }
  let out;
  try { out = new Function('type', 'return ' + expr.replace(/'/g, '"').replace(/"/g, "'"))(tone); }
  catch (e) { return null; }
  return typeof out === 'string' ? out.trim() : null;
}

// The REAL failures that keep the error tone. They are pinned by message, not by count:
// the point of the list is that the fix must not swallow them. A benign message that moves
// onto this list, or one of these that leaves it, has to turn the gate red.
const KNOWN_REAL_FAILURES = [
  'image-to-excel :: No valid image files selected.',
  'image-to-excel :: No text detected. Try a clearer image or different language.',
  'pdf-to-excel :: No table data found in this PDF. Try a different PDF with structured tabular content.',
  'pdf-to-excel :: No table data found in editor. Please check the format.',
  'prayer-times :: No valid prayer times for this date at this latitude - polar day/night region. Try a moderate latitude.'
];

// --- the tree scan ----------------------------------------------------------
function scanTree(root) {
  const TOOLS = path.join(root, 'tools');
  const slugs = fs.readdirSync(TOOLS).filter(d => fs.existsSync(path.join(TOOLS, d, 'index.html')));
  let tonePrecondition = 0;        // precondition messages still rendered with an error tone
  let showErrorPrecondition = 0;   // precondition messages still rendered by a bespoke error sink
  let noticeSites = 0;             // precondition messages moved into the neutral notice sink
  let realFailures = 0;            // real failures that still render with an error tone
  let neutralRules = 0;
  const offenders = [];
  const showErrorPages = new Set();
  const showErrorSites = [];       // "slug :: message" for every message left in an error sink
  const noticePages = new Set();   // pages that use the neutral notice sink

  for (const slug of slugs) {
    const html = fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8');
    const loadsToolsJs = /<script[^>]*src=["']\/tools\.js/.test(html);
    for (const fn of ['showStatus', 'setStatus', 'showError', 'showNotice']) {
      for (const call of findCalls(html, fn)) {
        const lits = call.literals;
        if (!lits.length) continue;
        let msg = null;
        if (fn === 'showError' || fn === 'showNotice') msg = lits[0];
        else {
          if (lits[lits.length - 1] !== 'error') continue;
          if (lits.length < 2) continue;
          msg = lits[lits.length - 2];
        }
        if (fn === 'showNotice') {
          if (msg && isPrecondition(msg)) { noticeSites++; noticePages.add(slug); }
          continue;
        }
        if (!msg || !isPrecondition(msg)) {
          // [D] the fix must not over-suppress: a real failure keeps the error tone
          if (fn !== 'showError' && lits[lits.length - 1] === 'error' && msg && FAILURE.test(msg)) {
            const cls = toneClass(html, fn, 'error', loadsToolsJs);
            if (cls && /error/i.test(cls)) realFailures++;
          }
          continue;
        }
        if (fn === 'showError') {
          showErrorPrecondition++; showErrorPages.add(slug);
          showErrorSites.push(slug + ' :: ' + msg);
          continue;
        }
        const cls = toneClass(html, fn, 'error', loadsToolsJs);
        if (cls === null) continue;           // not a class sink — invisible to the inspector
        if (!/error/i.test(cls)) continue;    // already neutral
        tonePrecondition++;
        offenders.push(slug + ' :: ' + msg + '  -> class "' + cls + '"');
      }
    }
    if (html.includes('BUG-532: benign precondition notice')) {
      const rule = (html.match(/\/\* BUG-532: benign precondition notice[\s\S]*?\*\/([\s\S]*?)\}/) || [])[1] || '';
      neutralRules++;
      if (!/background\s*:/.test(rule)) offenders.push(slug + ' :: the BUG-532 neutral rule has no background');
      if (!/color\s*:/.test(rule)) offenders.push(slug + ' :: the BUG-532 neutral rule has no colour');
      if (/#ef4444|#ff4444|#ff6b6b|var\(--danger\)|var\(--error\)|var\(--red\)|#fca5a5|#ff9999/i.test(rule)) {
        offenders.push(slug + ' :: the BUG-532 neutral rule still uses an error colour');
      }
    }
    // [F] a page that shows a benign notice needs a VISIBLE neutral sink. A notice nobody
    // can see is a worse defect than the one it replaced: the visitor loses the message.
    if (noticePages.has(slug)) {
      const defines = /function showNotice\s*\(|showNotice\s*:\s*function\s*\(|showNotice\s*=\s*function/.test(html);
      if (!defines) offenders.push(slug + ' :: showNotice() is called but not defined');
      const shared = /id=["']toolNotice["'][^>]*class=["'][^"']*\btool-notice\b/.test(html);
      const local = /class=["'][^"']*\b[\w-]*notice\b[^"']*["']/.test(html);
      // a page may also tone its own sink at runtime (BUG-528's dh-notice): the class only
      // appears in the script, so read the function body instead of the markup
      const noticeBody = (html.match(/function showNotice\s*\([^)]*\)\s*\{[\s\S]{0,600}?\}/) || [])[0] || '';
      const runtimeTone = /class(?:Name)?\s*=\s*['"][^'"]*notice/i.test(noticeBody);
      if (!shared && !local && !runtimeTone) offenders.push(slug + ' :: showNotice() has no neutral sink element');
      if (shared && !/\/styles\.css/.test(html)) {
        offenders.push(slug + ' :: the shared neutral sink lives in /styles.css but this page does not link it');
      }
      if (!shared && local) {
        const cls = (html.match(/class=["'][^"']*\b([\w-]*notice)\b[^"']*["']/) || [])[1];
        if (cls && !new RegExp('\\.' + cls + '\\b').test(html.split('</style>')[0])) {
          offenders.push(slug + ' :: the local neutral sink class ' + cls + ' has no CSS rule');
        }
      }
    }
    // [H] a status message must never be written into a CONTROL. The shared showStatus()
    // replaces the element's class and clears its text after 3 s, so a <button> sink turned the
    // control into an empty status box — measured on production: the "Summarize" button became
    // class "status error" and then an empty box, and the tool could not be used again.
    for (const fn of ['showStatus', 'setStatus']) {
      for (const call of findCalls(html, fn)) {
        const lits = call.literals;
        if (lits.length < 3) continue;
        const id = lits[lits.length - 3];
        if (!/^[\w-]+$/.test(id)) continue;      // a computed id: not decidable statically
        const m = html.match(new RegExp('<([a-z]+)([^>]*\\bid=["\']' + id + '["\'][^>]*)>'));
        if (!m) continue;
        if (m[1] === 'button' || m[1] === 'input' || m[1] === 'textarea' || m[1] === 'select') {
          offenders.push(slug + ' :: ' + fn + '() writes into the <' + m[1] + ' id="' + id + '"> — the control is destroyed');
        }
      }
    }
  }
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const noticeRule = (styles.match(/\.tool-notice\.show\s*\{([^}]*)\}/) || [])[1] || '';
  if (!/display\s*:\s*block/.test(noticeRule)) offenders.push('styles.css :: .tool-notice.show does not make the notice visible');
  const noticeBase = (styles.match(/\.tool-notice\s*\{([^}]*)\}/) || [])[1] || '';
  if (!/color\s*:/.test(noticeBase)) offenders.push('styles.css :: .tool-notice has no colour');
  if (/#ef4444|#ff4444|#ff6b6b|#fca5a5|#ff9999/i.test(noticeBase + noticeRule)) {
    offenders.push('styles.css :: .tool-notice still uses an error colour');
  }
  return { slugs, tonePrecondition, showErrorPrecondition, realFailures, neutralRules, offenders, showErrorPages, showErrorSites, noticeSites, noticePages };
}

// --- the strip layer (anti-vacuity) -----------------------------------------
// Copy the tree and put the fix back the way it was: every benign precondition that now
// renders in the neutral tone goes back to 'error'. The same scanner must then go red.
function stripTree(root) {
  const TOOLS = path.join(root, 'tools');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug532-strip-'));
  for (const slug of fs.readdirSync(TOOLS)) {
    const src = path.join(TOOLS, slug, 'index.html');
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(tmp, 'tools', slug), { recursive: true });
    let html = fs.readFileSync(src, 'utf8');
    const loadsToolsJs = /<script[^>]*src=["']\/tools\.js/.test(html);
    const edits = [];
    for (const fn of ['showStatus', 'setStatus']) {
      for (const call of findCalls(html, fn)) {
        const lits = call.literals;
        if (lits.length < 2) continue;
        if (lits[lits.length - 1] !== 'info') continue;
        const msg = lits[lits.length - 2];
        if (!isPrecondition(msg)) continue;
        const cls = toneClass(html, fn, 'info', loadsToolsJs);
        if (cls === null || /error/i.test(cls)) continue;   // was never part of the fix
        let idx = -1, lit = null;
        for (const q of ["'", '"']) {
          const i2 = call.text.lastIndexOf(q + 'info' + q);
          if (i2 > idx) { idx = i2; lit = q + 'info' + q; }
        }
        if (idx < 0) continue;
        edits.push({ start: call.start + idx, end: call.start + idx + lit.length, text: lit[0] + 'error' + lit[0] });
      }
    }
    // The second half of the fix: a benign precondition that now goes into the neutral notice
    // sink goes back to the error sink. Only the call site is reverted — the neutral sink
    // itself stays, so the reverted tree is exactly the pre-fix behaviour.
    for (const call of findCalls(html, 'showNotice')) {
      const lits = call.literals;
      if (!lits.length) continue;
      const msg = lits[0];
      if (!isPrecondition(msg)) continue;
      edits.push({ start: call.start, end: call.start + 'showNotice'.length, text: 'showError' });
    }
    for (const e of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, e.start) + e.text + html.slice(e.end);
    fs.writeFileSync(path.join(tmp, 'tools', slug, 'index.html'), html);
  }
  // the shared stylesheet carries the neutral sink rule — the scan reads it
  const styles = path.join(root, 'styles.css');
  if (fs.existsSync(styles)) fs.copyFileSync(styles, path.join(tmp, 'styles.css'));
  return tmp;
}

// --- run --------------------------------------------------------------------
let checks = 0;
const failures = [];
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };

const res = scanTree(ROOT);
ok(res.tonePrecondition === 0,
  `[A] ${res.tonePrecondition} precondition message(s) still reach an error-tone class sink: ` + res.offenders.slice(0, 8).join(' | '));
const left = res.showErrorSites.slice().sort();
const known = KNOWN_REAL_FAILURES.slice().sort();
ok(JSON.stringify(left) === JSON.stringify(known),
  `[B] the messages left in a bespoke error sink are not exactly the pinned REAL failures.\n` +
  `      left: ${JSON.stringify(left, null, 0)}\n      pinned: ${JSON.stringify(known, null, 0)}`);
ok(res.noticeSites > 60,
  `[C] only ${res.noticeSites} benign precondition message(s) go into the neutral notice sink — the fix looks reverted`);
ok(res.neutralRules > 0, '[D] no page carries a BUG-532 neutral rule — the fix looks reverted');
ok(res.realFailures > 100,
  `[E] only ${res.realFailures} real-failure message(s) still render with an error tone — the fix over-suppressed`);
ok(res.offenders.length === 0, `[F] ${res.offenders.length} structural problem(s): ` + res.offenders.slice(0, 8).join(' | '));

console.log(`bug532 benign-guard gate (${ROOT})`);
console.log(`  tool pages scanned       : ${res.slugs.length}`);
console.log(`  precondition → error tone: ${res.tonePrecondition}   (must be 0)`);
console.log(`  real failures still red  : ${res.realFailures}`);
console.log(`  pages with a neutral rule: ${res.neutralRules}`);
console.log(`  neutral notice sink      : ${res.noticeSites} precondition message(s) on ${res.noticePages.size} pages`);
console.log(`  left in an error sink    : ${res.showErrorPrecondition} — the pinned REAL failures, ${res.showErrorPages.size} pages`);
console.log(`    ${[...res.showErrorPages].sort().join(', ')}`);

if (RUN_STRIP) {
  const tmp = stripTree(ROOT);
  try {
    const stripped = scanTree(tmp);
    const red = stripped.tonePrecondition > 0 || stripped.showErrorPrecondition > KNOWN_REAL_FAILURES.length;
    ok(red, `[G] the strip layer did NOT turn the tree red — the gate cannot fail, so it measures nothing ` +
      `(stripped: ${stripped.tonePrecondition} tone sites, ${stripped.showErrorPrecondition} bespoke sites)`);
    console.log(`  strip layer: reverted ${stripped.tonePrecondition} tone call site(s) + ${stripped.showErrorPrecondition - KNOWN_REAL_FAILURES.length} notice call site(s) ` +
      `→ the same scanner reports ${stripped.tonePrecondition} tone + ${stripped.showErrorPrecondition} bespoke (both must be > 0)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`  checks: ${checks}, failures: ${failures.length}`);
if (failures.length) {
  console.log('\nFAIL:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
