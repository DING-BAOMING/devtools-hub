#!/usr/bin/env node
// BUG-326 static gate — `a11y/autocomplete-tokens` (WCAG 2.1 SC 1.3.5 Identify Input Purpose).
//
// WHY A KNOWN-BAD LIST AND NOT A DETECTOR RE-IMPLEMENTATION
// The rule identifies a field's purpose from a token-sequence table baked into the
// squirrelscan binary. Re-deriving that table here would be a second, drifting copy
// of a rule we do not own: it would go green the day the binary changes and the site
// does not (same failure as BUG-310's coverage-outlier fix that satisfied the defect
// and left the rule firing). So the list below is the AUTHORITATIVE output of a
// 380-page full-coverage crawl (`squirrel audit -C full --max-pages 400`, v0.0.105,
// 2026-10-09), pinned per element id, and the gate checks exactly two things:
//
//   FIXED      the element carries the exact token the rule expects
//   STILL-BAD  the element is a detector FALSE POSITIVE and must stay untagged
//
// Anti-vacuity: pass a rootDir copy with the fix stripped and the gate must go red.
//   node bug326-autocomplete-tokens-gate.js /tmp/bug326-inject
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const TOOLS = path.join(ROOT, 'tools');

// id -> the exact token `Hs()` demands. A token outside this map's `allowed` list
// makes the rule report "incorrect", which is severity FAIL, not warn.
const FIXED = {
  'email-signature-generator': {
    'es-fname': 'given-name', 'es-lname': 'family-name', 'es-email': 'email',
    'es-phone': 'tel', 'es-address': 'street-address',
  },
  'resume-builder': { 'r-name': 'name', 'r-email': 'email', 'r-phone': 'tel' },
  'signature-maker': { 'typeName': 'name' },
  'ai-ppt-maker': { 'pm-author': 'name' },
  'letter-generator': { 'lg-sender-name': 'name' },
  'qr-code-generator': {
    'email-address': 'email', 'vcard-name': 'name', 'vcard-email': 'email',
    'vcard-phone': 'tel', 'phone-number': 'tel', 'sms-number': 'tel',
  },
  'invoice-generator': {
    'inv-from-email': 'email', 'inv-from-phone': 'tel', 'inv-from-addr': 'street-address',
  },
  'receipt-generator': {
    'rcp-from-email': 'email', 'rcp-from-phone': 'tel', 'rcp-from-addr': 'street-address',
  },
  'email-verifier': { 'email-input': 'email' },
  'air-quality-index': { 'loc': 'address-level2' },  // city you check the air for = your own location context; autofill of a saved city is never wrong data
};

// Elements the rule flags whose expectation is WRONG. Each is a field that does not
// collect the visitor's own identity data, so a token there would make the browser
// autofill the visitor's real name/email into a field that is not about them. They
// must stay untagged; the residual warning is correct and is left standing.
const FALSE_POSITIVE = {
  'ip-address-lookup': ['custom-ip-input'],           // "IP address" != street address
  'subnet-calculator': ['ipv4-input', 'ipv6-input'], // same
  'proxy-checker': ['hostInput'],                    // IP or domain; already off
  'space-keeper': ['space-url'],                     // matched "your-name" in the URL
  'utm-builder': ['ubMedium', 'ubBulkMedium'],       // "email, social" is a medium list
  'qr-code-generator': ['email-subject'],            // a subject line is not an address
  'ai-email-writer': ['aew-compose-type'],           // label "Email type" = Apology/Follow-up
  'ai-detector': ['detector-input'],                 // placeholder prose mentions "email"
  'email-signature-generator': ['es-disclaimer'],    // legal boilerplate textarea
  'email-spam-checker': ['esc-body', 'esc-fixed'],   // email body under analysis
  'email-header-analyzer': ['eha-input'],            // raw headers; correctly off
  'sql-formatter': ['sql-input'],                   // placeholder SQL contains "email"
  'json-diff': ['left-json', 'right-json'],          // placeholder JSON contains "city"
  'invoice-generator': ['inv-to-email', 'inv-to-addr'],   // Bill To = the customer
  'receipt-generator': ['rcp-to-email', 'rcp-to-addr'],   // Bill To = the customer
  'world-clock': ['city-select'],
  'time-zone-converter': ['from-city', 'to-city'],
  'sunrise-sunset': ['city-input'],
  'weather-forecast': ['city-input'],
  'daily-holiday': ['country-select'],
  'name-generator': ['ng-fake-country'],
  'tax-calculator': ['uk-country'],
  'iban-validator': ['refSearch'],
  'paycheck-calculator': ['pc-state'],               // US state income tax picker
  'poker-odds-calculator': ['street'],               // Flop / Turn — matched on "street"
};

let pass = 0, fail = 0;
const bad = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; bad.push(msg); } }

// Read the tag for a given id out of one tool page.
function tagFor(html, id) {
  const re = new RegExp('<(?:input|textarea|select)\\b[^>]*\\bid="' + id + '"[^>]*>', 'i');
  const m = html.match(re);
  return m ? m[0] : null;
}
function attr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1].trim() : null;
}

const slugs = fs.readFileSync(path.join(ROOT, 'manifest.txt'), 'utf8')
  .split('\n').filter(l => l.trim() && !l.startsWith('#'))
  .map(l => l.split('|')[0].trim());

const VALID = new Set([
  'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name',
  'honorific-suffix', 'nickname', 'username', 'new-password', 'current-password',
  'one-time-code', 'organization-title', 'organization', 'street-address',
  'address-line1', 'address-line2', 'address-level3', 'address-level4',
  'address-level1', 'address-level2', 'postal-code', 'country', 'country-name',
  'cc-name', 'cc-number', 'cc-exp', 'cc-csc', 'cc-exp-month', 'cc-exp-year',
  'cc-type', 'transaction-currency', 'transaction-amount', 'language',
  'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'email',
  'tel', 'tel-national', 'tel-local', 'tel-country-code', 'tel-area-code', 'tel-extension',
]);

const fixedTotal = Object.values(FIXED).reduce((n, m) => n + Object.keys(m).length, 0);
const fpTotal = Object.values(FALSE_POSITIVE).reduce((n, a) => n + a.length, 0);
console.log(`BUG-326 gate — root: ${ROOT}`);
console.log(`manifest tools: ${slugs.length} | pinned real fields: ${fixedTotal} | pinned detector false positives: ${fpTotal}\n`);

for (const slug of slugs) {
  const p = path.join(TOOLS, slug, 'index.html');
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');

  for (const [id, token] of Object.entries(FIXED[slug] || {})) {
    const tag = tagFor(html, id);
    if (!tag) { ok(false, `${slug}#${id}: element is gone — update the pinned list`); continue; }
    const got = attr(tag, 'autocomplete');
    ok(got === token, `${slug}#${id}: autocomplete="${got === null ? '(none)' : got}", expected "${token}"`);
    // An unrecognised token is ignored by the browser outright — worse than nothing.
    ok(got === null || VALID.has(got), `${slug}#${id}: autocomplete="${got}" is a valid WHATWG token`);
  }

  for (const id of FALSE_POSITIVE[slug] || []) {
    const tag = tagFor(html, id);
    if (!tag) { ok(false, `${slug}#${id}: element is gone — update the pinned list`); continue; }
    const got = attr(tag, 'autocomplete');
    ok(got === null || got === 'off',
      `${slug}#${id}: false positive must stay untagged, found autocomplete="${got}"`);
  }
}

// The inverse check: no page may carry a syntactically broken token. A typo here is
// the one defect class that silently disables autofill while looking instrumented.
let scanned = 0, malformed = 0;
for (const slug of slugs) {
  const p = path.join(TOOLS, slug, 'index.html');
  if (!fs.existsSync(p)) continue;
  scanned++;
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/autocomplete\s*=\s*"([^"]*)"/g)) {
    const raw = m[1].trim().toLowerCase();
    if (raw === 'off' || raw === 'on') continue;
    for (const tok of raw.split(/\s+/)) {
      if (!VALID.has(tok)) { ok(false, `${slug}: autocomplete="${raw}" contains invalid token "${tok}"`); malformed++; }
    }
  }
}
console.log(`scanned ${scanned} tool pages for malformed tokens: ${malformed}\n`);

console.log(`${pass} passed, ${fail} failed`);
if (bad.length) { console.log('\nFAILURES:'); bad.forEach(b => console.log('  - ' + b)); }
console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(fail ? 1 : 0);