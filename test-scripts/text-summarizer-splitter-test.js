#!/usr/bin/env node
/**
 * text-summarizer splitSentences — one runnable check (BUG-464).
 *
 * Feedback mw798vmiskpun882n (2026-11-08 03:10): the tool showed
 *   "[tool_error] Not enough sentences to summarize. Please enter at least 3 sentences."
 * on text that plainly had three or more sentences.
 *
 * Root cause: the shipped splitter only counted a sentence when the .!? was
 * followed by a SPACE / NEWLINE / end-of-string, and it ignored newlines as
 * boundaries entirely. Newline-separated lines with no terminal punctuation
 * ("Line one\nLine two\nLine three") counted as ONE sentence -> false error.
 *
 * This file has two tiers:
 *   [A] OLD (verbatim copy of the deployed function) must still mis-count the
 *       reported shape -> proves the bug is real and this test is not vacuous.
 *   [B] NEW (read out of the page's own <script>) must count them, must not
 *       break decimals ("3.14" is one number, not two sentences), and must not
 *       emit empty / digit-only fragments.
 *
 * Run: node text-summarizer-splitter-test.js   (from anywhere; root is __dirname)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'tools', 'text-summarizer', 'index.html');

/* ---------- the shipped (pre-fix) implementation, verbatim ---------- */
function splitSentencesOLD(text) {
  var result = [];
  var current = '';
  var chars = text.split('');
  for (var i = 0; i < chars.length; i++) {
    current += chars[i];
    if (chars[i] === '.' || chars[i] === '!' || chars[i] === '?') {
      if (i + 1 >= chars.length || chars[i + 1] === ' ' || chars[i + 1] === '\n' || chars[i + 1] === '\r') {
        var trimmed = current.trim();
        if (trimmed.length > 0) { result.push(trimmed); }
        current = '';
      }
    }
  }
  var trimmed2 = current.trim();
  if (trimmed2.length > 0) { result.push(trimmed2); }
  return result;
}

/* ---------- the fixed implementation, read from the page source ---------- */
function loadSplitterFromPage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/function splitSentences\(text\) \{[\s\S]*?\n {4}\}/);
  if (!m) throw new Error('splitSentences not found in ' + PAGE);
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn splitSentences;')();
}

const CASES = [
  { name: 'prose, space after punctuation', text: 'Artificial intelligence changed how we work. Machine learning now handles tasks that once needed humans. It still makes mistakes. Hallucination remains a problem. Efficiency keeps improving.', expect: 5 },
  { name: 'no space after the period (reported shape 1)', text: 'First sentence here.Second sentence here.Third sentence here.', expect: 3 },
  { name: 'newline separated, no terminal punctuation (reported shape 2)', text: 'AI is changing the world\nModels are getting cheaper\nThey still make mistakes\nHumans stay in charge', expect: 4 },
  { name: 'blank-line separated paragraphs', text: 'Para one is here.\n\nPara two is here.\n\nPara three is here.', expect: 3 },
  { name: 'single sentence stays single', text: 'One lone sentence with no second half.', expect: 1 },
  { name: 'question then answer, no space', text: 'What is it?A tool.', expect: 2 },
  { name: 'mixed punctuation run', text: 'Really?! Yes. Absolutely!', expect: 3 }, // Really?! / Yes. / Absolutely!
  { name: 'initialisms are not boundaries', text: 'The U.S.Government published new rules today. Agencies must comply. Enforcement starts next year.', expect: 3 },
  { name: 'initialism before a space splits like the old splitter (pre-existing, not a regression)', text: 'The U.S. Government published new rules today. Agencies must comply. Enforcement starts next year.', expect: 4 },
  { name: 'closing quote stays with its sentence', text: 'He said "stop." Then he left. Nobody argued.', expect: 3 },
];

let fail = 0;
const NEW = loadSplitterFromPage();

console.log('[B] fixed splitter (read from tools/text-summarizer/index.html)');
for (const c of CASES) {
  const got = NEW(c.text);
  const ok = got.length === c.expect;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + c.name +
    '  -> expected ' + c.expect + ' sentences, got ' + got.length);
  if (!ok) console.log('        ' + JSON.stringify(got));
}

console.log('[B2] decimals and abbreviations survive');
const dec = NEW('Pi is 3.14 and e is 2.71 in this text. Prices rose 19.99 percent last year. Version 2.5 shipped.');
const decErr = [];
if (dec.some(s => /^\d+$/.test(s))) decErr.push('a bare number became its own sentence: ' + JSON.stringify(dec));
if (dec.length !== 3) decErr.push('expected 3 sentences, got ' + dec.length + ' ' + JSON.stringify(dec));
if (!dec[0].includes('3.14') || !dec[1].includes('19.99') || !dec[2].includes('2.5')) decErr.push('a decimal was split out of its sentence: ' + JSON.stringify(dec));
if (dec.some(s => s.trim() === '')) decErr.push('empty fragment emitted');
if (decErr.length) { fail++; console.log('  FAIL  ' + decErr.join('; ')); } else console.log('  PASS  3.14 / 19.99 / 2.5 kept inside their 3 sentences');

console.log('[B4] no single-letter initialism fragments (the first fix attempt split them)');
const acro = NEW('The U.S.Government published new rules today. Agencies must comply with them.');
const acroErr = [];
if (acro.some(s => /^[A-Z]\.?$/.test(s))) acroErr.push('an initialism became its own fragment: ' + JSON.stringify(acro));
if (acro.length !== 2) acroErr.push('expected 2 sentences, got ' + acro.length + ' ' + JSON.stringify(acro));
if (acroErr.length) { fail++; console.log('  FAIL  ' + acroErr.join('; ')); } else console.log('  PASS  "U.S." stays inside its sentence (2 sentences)');

const quote = NEW('He said "stop." Then he left.');
const quoteErr = [];
if (quote.some(s => /^["\u2019\u201d]/.test(s))) quoteErr.push('a closing quote started the next fragment: ' + JSON.stringify(quote));
if (quote.length !== 2) quoteErr.push('expected 2 sentences, got ' + quote.length + ' ' + JSON.stringify(quote));
if (quoteErr.length) { fail++; console.log('  FAIL  ' + quoteErr.join('; ')); } else console.log('  PASS  closing quote stays inside its sentence (2 sentences)');

console.log('[B3] every output fragment is non-empty and whitespace-clean');
let b3 = true;
for (const c of CASES) {
  for (const s of NEW(c.text)) {
    if (!s.trim() || /\n/.test(s)) { b3 = false; console.log('  FAIL  ' + c.name + ' fragment ' + JSON.stringify(s)); }
  }
}
if (b3) console.log('  PASS  no empty or multi-line fragments');

console.log('[A] anti-vacuity: the deployed (pre-fix) splitter on the reported shapes');
const reported = CASES[2].text; // newline separated, no terminal punctuation
const oldCount = splitSentencesOLD(reported).length;
const oldNoSpace = splitSentencesOLD(CASES[1].text).length;
const oldOk = oldCount < 3 && oldNoSpace < 3;
if (!oldOk) fail++;
console.log('  ' + (oldOk ? 'PASS' : 'FAIL') +
  '  OLD counted ' + oldCount + ' and ' + oldNoSpace +
  ' sentences where 4 and 3 exist -> the "Not enough sentences" error was real');

console.log(fail === 0 ? '\nALL PASS (' + (CASES.length + 3) + ' assertions)' : '\n' + fail + ' FAILURE(S)');
process.exit(fail === 0 ? 0 : 1);
