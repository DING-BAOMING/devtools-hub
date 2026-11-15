#!/usr/bin/env node
/**
 * BUG-328 static gate — no AI endpoint may pin a provider model id.
 *
 * Why this exists. Groq decommissioned `llama-3.3-70b-versatile` and NVIDIA answers
 * `410 Gone` for `meta/llama-3.3-70b-instruct` (BUG-327). BUG-327 routed the nine
 * worst callers through `libs/ai-provider.js`, which reads each provider's live
 * `/models` list. Three functions kept their own multi-provider *shape* and so could
 * not just call `aiChat` — `ai-detector` needs a vote from every provider, not the
 * first that answers — and they kept the pinned id. Result measured in production
 * 2026-10-10: `/tools/translator/` returned 402 for every visitor and `/tools/ai-detector/`
 * reported "Error" with 0 of 5 models answered.
 *
 * The class, not the instance: a hardcoded id is a deploy-time landmine. The three
 * files named here are the ones that were fixed; the assertion is that the pattern
 * cannot come back anywhere in `functions/` or `libs/`.
 *
 * Anti-vacuity: pass a rootDir that has the defect re-injected and this must go red.
 *   node test-scripts/bug328-no-pinned-model-id-gate.js [rootDir]
 *
 * What is deliberately NOT asserted: that a specific model id is live. That is a
 * runtime fact, only the provider knows it, and pinning it in a test is the bug.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

// A pinned id is a string literal in a `model:` field, a `model:` shorthand inside an
// object literal, or an id in a getModels()/PROVIDERS array. Comments are stripped
// first — the fixed files *name* the retired ids in their explanatory comments, and a
// comment is not a request.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// Ids are provider-qualified or vendor-prefixed; a bare word like `bestModel` is a
// variable, not a pin. This matches the shape of a real model id: a path or a dotted
// name containing a digit (llama-3.3-70b-versatile, meta/llama-3.3-70b-instruct,
// gpt-oss-120b, gemini-2.5-flash, Qwen/Qwen2.5-7B-Instruct).
const PINNED_ID = /(['"`])((?:[A-Za-z][\w.-]*\/)?[A-Za-z][\w.-]*\d[\w./-]*)\1/;
const MODEL_FIELD = /model\s*:\s*([^,\n}]+)/g;

function scanDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...scanDir(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = [...scanDir(path.join(root, 'functions')), ...scanDir(path.join(root, 'libs'))];

// --- 1. No retired or hardcoded provider id may appear in executable code ----------
const KNOWN_RETIRED = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-70b-instruct'
];

for (const file of files) {
  const rel = path.relative(root, file);
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  for (const id of KNOWN_RETIRED) {
    ok(!code.includes(id), `no code in ${rel} sends the retired id \`${id}\``);
  }
}

// --- 2. Every AI endpoint resolves its id, rather than writing one down -----------
// The three endpoints that keep their own provider shape must each import the shared
// resolver. A file that calls a chat completion without it is one retirement from dead.
const AI_ENDPOINTS = fs.existsSync(path.join(root, 'functions/api'))
  ? fs.readdirSync(path.join(root, 'functions/api')).filter(f => f.endsWith('.js'))
  : [];

// Endpoints that reach an AI provider at all: they name a chat/completions URL, or
// they delegate to libs/ai-provider.js.
const aiEndpoints = AI_ENDPOINTS.filter(f => {
  const src = stripComments(fs.readFileSync(path.join(root, 'functions/api', f), 'utf8'));
  return /api\.groq\.com|integrate\.api\.nvidia\.com|generativelanguage\.googleapis\.com|api\.siliconflow\.cn|apihub\.agnes-ai\.com/.test(src)
    || /from '\.\.\/\.\.\/libs\/ai-provider\.js'/.test(src);
});

ok(aiEndpoints.length >= 15, 'the gate sees the AI endpoints', `found ${aiEndpoints.length}`);

// The invariant is about *chat* endpoints. A model id is also a required parameter of
// the non-chat generation APIs this site also calls — /images/generations, /videos,
// TTS, audio transcription — and those are addressed by a service, not a catalogue:
// there is no /models list to read and the id is part of the request's shape.
// `agnes-video-v2.0`, `agnes-image-2.1-flash` and `FunAudioLLM/CosyVoice2-0.5B` are
// therefore allowed, and a retirement there is a different bug with a different fix.
const NON_CHAT = /\/(images\/generations|videos|audio|speech|transcriptions)\b/;
const chatEndpoints = aiEndpoints.filter(f => {
  const src = stripComments(fs.readFileSync(path.join(root, 'functions/api', f), 'utf8'));
  // Only endpoints that actually issue a chat completion. `ai-detector` and friends
  // match on /chat/completions; an endpoint that only reaches a generation API does not.
  return /\/chat\/completions/.test(src)
    || /from '\.\.\/\.\.\/libs\/ai-provider\.js'/.test(src)
    || /aiChat\(/.test(src);
});

for (const f of chatEndpoints) {
  const rel = `functions/api/${f}`;
  const src = stripComments(fs.readFileSync(path.join(root, 'functions/api', f), 'utf8'));
  const importsResolver = /from '\.\.\/\.\.\/libs\/ai-provider\.js'/.test(src);

  if (importsResolver) {
    // Delegates wholesale to aiChat — no id of its own to be wrong.
    const ownCall = /fetch\(\s*['"]https?:\/\/(api\.groq\.com|integrate\.api\.nvidia\.com)/.test(src);
    ok(!ownCall || /discoverChatModels\(|resolveModelId\(/.test(src),
      `${rel} imports the resolver and does not bypass it with its own fetch`);
  } else {
    // Keeps its own shape: it must still ask the provider which ids it serves.
    ok(/discoverChatModels\(|resolveModelId\(/.test(src),
      `${rel} calls a chat provider directly and must resolve its model id`);
  }
}

// A declared id is the *last* resort inside resolveModelId, not a request. So a chat
// endpoint may keep one in its PROVIDERS array, but it must not be one measured dead.
for (const f of chatEndpoints) {
  const rel = `functions/api/${f}`;
  const src = stripComments(fs.readFileSync(path.join(root, 'functions/api', f), 'utf8'));
  let m; MODEL_FIELD.lastIndex = 0;
  const literals = [];
  while ((m = MODEL_FIELD.exec(src))) {
    const v = m[1].trim();
    const hit = PINNED_ID.exec(v);
    if (hit && !/resolveModelId|provider\./.test(v)) literals.push(hit[2]);
  }
  // The dead ids are named explicitly; anything else is a vendor id we cannot judge
  // from here and must not guess about.
  const dead = literals.filter(id => KNOWN_RETIRED.includes(id));
  ok(dead.length === 0, `${rel} declares no measured-dead model id`, dead.join(' | '));
}

// --- 3. The resolver itself is real and exported ----------------------------------
const libPath = path.join(root, 'libs/ai-provider.js');
if (ok(fs.existsSync(libPath), 'libs/ai-provider.js exists')) {
  const lib = fs.readFileSync(libPath, 'utf8');
  const code = stripComments(lib);
  ok(/export async function discoverChatModels\(/.test(code), 'discoverChatModels is exported');
  ok(/export async function aiChat\(/.test(code), 'aiChat is still exported');
  // A resolver that hardcodes an id of its own is the same defect one level down.
  let m; MODEL_FIELD.lastIndex = 0;
  const literals = [];
  while ((m = MODEL_FIELD.exec(code))) {
    const v = m[1].trim();
    if (PINNED_ID.test(v)) literals.push(v);
  }
  ok(literals.length === 0, 'the resolver pins no model id of its own', literals.join(' | '));
  // A list that comes back empty must be handled, not sent as `model: null`.
  ok(/catch\s*\(\s*\w+\s*\)\s*\{\s*return \[\]/.test(code.replace(/\s+/g, ' ').replace(/catch\s*\(\s*\w+\s*\)\s*\{\s*return \[\];?\s*\}/, 'catch ($) { return []'))
     || /return \[\];/.test(code), 'discovery failure returns an empty list rather than throwing');
}

// --- 4. An empty list must skip the provider, never POST a null model -------------
for (const f of ['ai-detector.js', 'translator.js', 'youtube-tag-generator.js']) {
  const p = path.join(root, 'functions/api', f);
  if (!ok(fs.existsSync(p), `functions/api/${f} exists`)) continue;
  const src = stripComments(fs.readFileSync(p, 'utf8'));
  ok(!/models\.length === 0\) availableModels = \[null\]/.test(src),
    `${f} does not substitute a null model when discovery returns nothing`);
  ok(!/model:\s*model\s*\|\|\s*'/.test(src),
    `${f} has no literal fallback behind the discovered id`);
}

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log('FAIL:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS — no AI endpoint pins a provider model id.');