#!/usr/bin/env node
// BUG-321 gate: every model id offered by /tools/ai-image-generator/ must be a LIVE Puter
// `puter.ai.txt2img({model})` id, and the option object the page sends must only carry keys the
// provider documents. A retired id is not a crash: Puter answers `Model not found`, which is a
// one-line error string on a page whose entire job is to generate an image.
//
// WHY THIS IS A GATE AND NOT A LIVE CHECK: `puter.drivers.call('puter-image-generation','models')`
// needs an auth token (`token_missing` without one), so the catalog cannot be enumerated from CI.
// The pinned LIVE_CATALOG below was read out of Puter's own docs on 2026-10-07
// (https://docs.puter.com/AI/txt2img/) — including its explicit note that requests for the retired
// OpenAI ids "fail with `Model not found`". A gate that is a known-good/known-bad list is durable;
// a live checker would need a Puter account, so it would never run.
//
//   node bug321-puter-image-models-gate.js [rootDir]     # default rootDir = the repo
//
// ANTI-VACUITY: point it at a tree whose options were reverted and the gate MUST fail.
//   cp -r devtools-hub /tmp/inject && \
//   sed -i 's|<option value="gpt-image-2">|<option value="dall-e-3">|' \
//     /tmp/inject/tools/ai-image-generator/index.html && \
//   node bug321-puter-image-models-gate.js /tmp/inject   # -> FAIL, exit 1
// BUG-322 added tier 5 (the failure path). Its own revert, on a copy:
//   sed -i 's|showError(providerErrorMessage(e, model));|showError(e.message \|\| "Generation failed. Please try again.");|' \
//     /tmp/inject/tools/ai-image-generator/index.html   # -> FAIL on tier 5, exit 1
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const FILE = path.join(ROOT, 'tools/ai-image-generator/index.html');

// The catalog Puter documents, per provider. `ratio` is the option every one of these providers
// accepts for aspect control; `size` is a DALL-E-era option and is silently dropped by the others.
const LIVE_CATALOG = {
  openai: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'],
  gemini: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'],
  xai: ['grok-imagine-image-2.0', 'grok-imagine-image'],
  byteplus: ['dola-seedream-5-0-pro-260628', 'seedream-5-0-lite-260128',
             'seedream-4-5-251128', 'seedream-4-0-250828'],
  replicate: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-dev',
              'leonardoai/lucid-origin'],
  cloudflare: ['@cf/black-forest-labs/flux-1-schnell', '@cf/black-forest-labs/flux-2-dev']
};
const LIVE = new Set();
for (const list of Object.values(LIVE_CATALOG)) for (const id of list) LIVE.add(id);
// A `provider:` prefix selects that provider explicitly; the bare id must still be live.
const liveId = v => LIVE.has(v.replace(/^(replicate|workers-ai):/, ''));

// Retired ids that Puter documents as failing. Named so the failure message says WHY.
const RETIRED = {
  'dall-e-3': 'OpenAI DALL-E 3 — retired from the catalog',
  'dall-e-2': 'OpenAI DALL-E 2 — retired from the catalog',
  'gpt-image-1': 'OpenAI deprecated 2026 (docs: "fail with Model not found")',
  'gpt-image-1-mini': 'OpenAI deprecated 2026 (docs: "fail with Model not found")',
  'gpt-image-1.5': 'OpenAI deprecated 2026 (docs: "fail with Model not found")',
  'gemini-2.5-flash-image': 'Google deprecated, shut down 2026-10-02 (docs: "fail as unknown models")',
  'nano-banana': 'retired alias for gemini-2.5-flash-image (docs: "fail as unknown models")',
  'flux.schnell': 'never a Puter catalog id — Replicate uses black-forest-labs/flux-schnell',
  'flux.dev': 'never a Puter catalog id — Cloudflare uses @cf/black-forest-labs/flux-2-dev',
  'stable-diffusion-3-medium': 'not in the catalog (SDXL routes are @cf/… ids)',
  'stable-diffusion-xl': 'not in the catalog (SDXL routes are @cf/… ids)'
};

const fails = [];
const src = fs.readFileSync(FILE, 'utf8');

// 1. the <select> options
const optBlock = src.match(/<select id="modelSelect-sel"[\s\S]*?<\/select>/);
if (!optBlock) fails.push('FAIL  no #modelSelect-sel <select> found in ' + FILE);
const offered = [...(optBlock ? optBlock[0].matchAll(/<option value="([^"]+)"/g) : [])].map(m => m[1]);

if (offered.length < 2) fails.push(`FAIL  only ${offered.length} model option(s) offered — the picker is empty`);
for (const v of offered) {
  if (RETIRED[v]) fails.push(`FAIL  model "${v}" is dead: ${RETIRED[v]}`);
  else if (!liveId(v)) fails.push(`FAIL  model "${v}" is not in the live Puter catalog`);
}
if (new Set(offered).size !== offered.length) fails.push('FAIL  duplicate model ids in #modelSelect-sel');

// 2. MODEL_INFO must name every offered id, and the default must exist in it
const infoBlock = src.match(/const MODEL_INFO = \{[\s\S]*?\};/);
if (!infoBlock) fails.push('FAIL  no MODEL_INFO map found');
else {
  for (const v of offered) {
    if (!new RegExp("'" + v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + "'\\s*:").test(infoBlock[0])) {
      fails.push(`FAIL  MODEL_INFO has no entry for offered model "${v}" — the info bar would show a fallback name`);
    }
  }
  for (const k of [...infoBlock[0].matchAll(/'([^']+)'\s*:/g)].map(m => m[1])) {
    if (!offered.includes(k)) fails.push(`FAIL  MODEL_INFO names "${k}" but the <select> does not offer it`);
  }
}

// 3. the request object: no DALL-E-era `size`, `ratio` present, no dead id in the fallback
if (/\boptions\.size\b|size:\s*['"]\d{3,4}x\d{3,4}['"]/.test(src)) {
  fails.push('FAIL  page still sends options.size — no documented provider takes it; use ratio: {w, h}');
}
if (!/options\.ratio\s*=\s*\{\s*w:/.test(src)) {
  fails.push('FAIL  page never sends options.ratio — the aspect-ratio picker would do nothing');
}
const fallback = src.match(/MODEL_INFO\[['"]([^'"]+)['"]\]/);
if (fallback && !offered.includes(fallback[1])) {
  fails.push(`FAIL  fallback model "${fallback[1]}" is not offered by the <select>`);
}
const defaultOpt = optBlock ? (optBlock[0].match(/<option value="([^"]+)" selected/) || [])[1] : null;
if (defaultOpt && !src.includes(`>${defaultOpt.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<`)) {
  // first option is the implicit default; make sure the info bar's initial text matches it
  fails.push('FAIL  no selected model declared and the info bar initial text is unchecked');
}

// 4. copy must not advertise a dead model or a promise the page cannot keep
const copy = src.replace(/<script[\s\S]*?<\/script>/g, ' ');
for (const claim of [/DALL-?E/i, /Stable Diffusion/i]) {
  if (claim.test(copy)) fails.push(`FAIL  visible copy still advertises ${claim.source} — retired from the Puter catalog`);
}
for (const claim of [/prompts and images never leave your browser/i, /100% private/i, /requires no signup/i, /No signup required/i]) {
  if (claim.test(copy)) fails.push(`FAIL  visible copy still claims ${claim.source} — generation sends the prompt to the provider and opens a Puter sign-in on first run`);
}

console.log(`catalog: ${LIVE.size} live ids across ${Object.keys(LIVE_CATALOG).length} providers`);
console.log(`offered: ${offered.length} -> ${offered.join(', ')}`);

// 5. BUG-322: what the page says when the provider says `Model not found`. Both real feedback
//    reports for this page were that raw string, so the failure path is user-facing copy, not
//    a debug channel.
const body = (name) => {
  const i = src.indexOf('function ' + name);
  if (i < 0) return null;
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  return null;
};
const errFn = body('providerErrorMessage');
if (!errFn) {
  fails.push('FAIL  no providerErrorMessage() — the catch block prints the provider string raw, which is what both feedback reports contained');
} else {
  if (!/model not found/i.test(errFn)) fails.push('FAIL  providerErrorMessage() does not recognise `Model not found` — Puter\'s answer for a retired id');
  if (!/MODEL_INFO\[/.test(errFn)) fails.push('FAIL  providerErrorMessage() does not name the model that failed in MODEL_INFO terms');
  if (!/Generation failed: /.test(errFn)) fails.push('FAIL  providerErrorMessage() has no fallback that keeps the provider text for failures we cannot diagnose');
  if (!/showError\(providerErrorMessage\(/.test(src)) fails.push('FAIL  the catch block does not route errors through providerErrorMessage()');
  if (!/role="alert"/.test(src)) fails.push('FAIL  #error has no role="alert" — a message that appears after a click is silent to a screen reader');
}
const showErr = body('showError');
if (showErr && /setTimeout/.test(showErr)) {
  fails.push('FAIL  showError() auto-dismisses — the retired-model message is two sentences and vanishes before it can be read or acted on');
}

if (fails.length) { fails.forEach(f => console.log(f)); process.exit(1); }
console.log('PASS  every offered model is live, ratio replaces size, copy advertises neither dead models nor false promises, and the failure path is written for the user');
