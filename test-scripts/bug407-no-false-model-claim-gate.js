#!/usr/bin/env node
/**
 * BUG-407 static gate — no published page may name a model the site cannot actually serve.
 *
 * WHY THIS EXISTS (measured live 2026-11-03)
 *   Groq's live `GET /models` list (85 ids checked) contains NO Llama chat model at all:
 *   allam-2-7b, openai/gpt-oss-120b, openai/gpt-oss-20b, openai/gpt-oss-safeguard-20b,
 *   qwen/qwen3.8-27b, whisper-large-v3(+turbo), canopylabs/orpheus-*, and two
 *   meta-llama/llama-prompt-guard-* guard models (not chat models).
 *   NVIDIA's live list (85 ids) has NO llama-3.3-70b and NO Llama 4 Scout — its Llama
 *   ids are meta/codellama-70b, meta/llama2-70b, nvidia/llama-3.1-nemotron-70b-instruct,
 *   meta/llama3-chatqa-1.5-70b and the 3.1/3.2 vision + nemotron + nemoguard families.
 *   Production answered `/api/ai-chat` with `{"model":"allam-2-7b","label":"allam-2-7b (Groq)"}`.
 *
 *   Yet twelve published pages, `manifest.txt`, and the injected category FAQ on
 *   `functions/tools/[[catchall]].js` all asserted "Llama 3.3 70B" / "Llama 4 Scout 17B"
 *   / "NVIDIA Llama 3.1 70B" as the model behind the button. `manifest.txt` is the single
 *   source for the description that reaches `<meta description>`, the JSON-LD, `/tools/<slug>/.md`,
 *   `llms.txt`, `llms-full.txt` and `.well-known/agent-skills/*` — so one false sentence
 *   propagated to every AI-readable surface on the site.
 *
 * THE CLASS, NOT THE INSTANCE
 *   "Bump the version number in the marketing copy" is the same defect every time a
 *   provider retires a model. The codebase already learned the code half of this lesson
 *   (BUG-327/328: never pin a provider model id, read `/models` at runtime). This gate is
 *   the copy half: published text may not pin a model either.
 *
 * TWO RULES
 *   R1 — no versioned, size-suffixed model claim anywhere in published copy
 *        ("Llama 3.3 70B", "Qwen2.5-72B-Instruct", "Llama 4 Scout 17B" …). A model that
 *        can be retired overnight may not be named in a sentence the visitor reads.
 *   R2 — no known-false literal survives (the exact strings this bug shipped, plus the
 *        retired provider ids themselves).
 *
 * ANTI-VACUITY
 *   The gate takes a rootDir, so a copy of the tree with the defect re-injected must go
 *   red. A rule that has never been seen red measures nothing:
 *     node test-scripts/bug407-no-false-model-claim-gate.js [rootDir]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.argv[2]
  ? new URL('file://' + (process.argv[2].startsWith('/') ? process.argv[2] : process.cwd() + '/' + process.argv[2])).pathname
  : new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// ── the surfaces a visitor or an AI crawler actually reads ──────────────────────────
// Static tool pages (served by the tool-page Function after it patches title/desc),
// the manifest (source of every description), and the two FAQ string tables the
// tool-page Function injects into category pages.
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const rel = (f) => relative(ROOT, f);

const toolPages = files.filter(f => /tools\/[^/]+\/index\.html$/.test(rel(f)));
// The site-level pages a visitor reads before trusting the site: the privacy
// policy, about, contact, subprocessors and the homepage. A false model claim
// on /privacy/ is exactly as false as one on a tool page — the first version of
// this gate scanned tool pages only and let "Groq Llama" survive on /privacy/.
// (Groq serves no Llama chat model; see the header comment.)
const sitePages = files.filter(f => {
  const r = rel(f);
  return (r === 'index.html' || r === '404.html' || /^[a-z0-9-]+\/index\.html$/.test(r)) && !r.startsWith('tools/');
});
const catchall = files.find(f => rel(f) === 'functions/tools/[[catchall]].js');
const manifestPath = join(ROOT, 'manifest.txt');

const SURFACES = [
  ...toolPages.map(f => ({ name: rel(f), text: readFileSync(f, 'utf8') })),
  ...sitePages.map(f => ({ name: rel(f), text: readFileSync(f, 'utf8') })),
  { name: 'manifest.txt', text: readFileSync(manifestPath, 'utf8') }
];
if (catchall) SURFACES.push({ name: rel(catchall), text: readFileSync(catchall, 'utf8') });

// ── R1: versioned + size-suffixed model claims ──────────────────────────────────────
// "Llama 3.3 70B", "Llama 4 Scout 17B", "Qwen 2.5 72B", "Llama3.3-70B-versatile",
// "GPT-4 32B". Requires a dotted version AND a parameter count, which is what a
// marketing sentence uses to name a specific model.
const VERSIONED_MODEL = /\b[A-Za-z][A-Za-z0-9]*(?:[\s-][A-Za-z0-9]+)*[\s-]v?\d+\.\d+[\w.-]*\s*[-]?\s*\d{1,3}\s?B\b/g;
// The dash form: "llama-3.3-70b-versatile", "meta/llama-3.1-70b-instruct".
const DASHED_MODEL = /\b[a-z][a-z0-9-]*\/[a-z0-9.-]*\d+\.\d+-\d+b\b/gi;

console.log('\nR1 — no versioned, size-suffixed model claim in published copy');
let r1hits = 0;
for (const s of SURFACES) {
  const a = s.text.match(VERSIONED_MODEL) || [];
  const b = s.text.match(DASHED_MODEL) || [];
  const all = [...new Set([...a, ...b])];
  if (all.length) { r1hits += all.length; console.log('        ' + s.name + ': ' + all.map(x => x.trim()).join(', ')); }
}
ok(r1hits === 0, `published copy names no versioned model (${r1hits} hit${r1hits === 1 ? '' : 's'})`);

// ── R2: the known-false literals from this bug ───────────────────────────────────────
const FALSE_CLAIMS = [
  'Llama 3.3 70B',
  'Llama 3.3',
  'Llama 4 Scout',
  'NVIDIA Llama 3.1 70B',
  'Groq Llama 70B',
  'NVIDIA Llama 70B',
  'Groq Llama',
  'llama-3.3-70b-versatile',
  'llama-3.3-70b',
  'meta/llama-3.3-70b-instruct'
];
console.log('\nR2 — the exact strings this bug shipped are gone');
for (const c of FALSE_CLAIMS) {
  const hits = SURFACES.filter(s => s.text.includes(c)).map(s => s.name);
  ok(hits.length === 0, `no published surface contains "${c}"`, hits.join(', '));
}

// ── R3: the FIXED copy must actually say something true ─────────────────────────────
// A gate that only forbids is satisfied by deleting the sentence. The repaired pages must
// still name a real provider, and the manifest description (the source of every other
// surface) must still name Groq — the provider that answers first.
console.log('\nR3 — the repaired text still names a real provider');
const aiChatDesc = SURFACES.find(s => s.name === 'manifest.txt').text
  .split('\n').find(l => l.startsWith('ai-chat|')) || '';
ok(/\|[^|]*Groq[^|]*\|/.test(aiChatDesc), 'manifest ai-chat description names Groq', aiChatDesc.slice(0, 120));
for (const slug of ['ai-chat', 'ai-ppt-maker', 'ai-prompt-engineer', 'ats-resume-checker']) {
  const page = SURFACES.find(s => s.name === 'tools/' + slug + '/index.html');
  if (!page) { ok(false, `tools/${slug}/index.html is present`); continue; }
  ok(/Groq/.test(page.text), `tools/${slug}/index.html names Groq`);
}

// ── TIER B: anti-vacuity ─────────────────────────────────────────────────────────────
// Re-inject the defect into a copy of the tree and require the same rules to go red.
console.log('\nTIER B — anti-vacuity (the rules must go red on a tree with the defect back)');
const INJECT = [
  { name: 'ai-chat page says "Llama 3.3 70B"', s: 'tools/ai-chat/index.html',
    from: 'powered by Groq and NVIDIA models', to: 'powered by Llama 3.3 70B', red: 'R1' },
  { name: 'manifest ai-chat desc says "Llama 3.3 70B"', s: 'manifest.txt',
    from: 'powered by Groq and NVIDIA models', to: 'powered by Llama 3.3 70B', red: 'R1' },
  { name: 'catchall FAQ says "Llama 4 Scout 17B"', s: 'functions/tools/[[catchall]].js',
    from: 'AI tools run on fast models served by Groq, NVIDIA and Gemini',
    to: 'AI tools use Llama 3.3 70B via Groq and Llama 4 Scout 17B via NVIDIA', red: 'R1' },
  // The site-level page case: no version, no size — only a provider/model pairing
  // that the provider does not serve. R1 cannot see it; R2 must.
  { name: 'privacy policy says "Groq Llama"', s: 'privacy/index.html',
    from: 'third-party AI providers (Groq, Google Gemini',
    to: 'third-party AI providers (Groq Llama, Google Gemini', red: 'R2' }
];
for (const inj of INJECT) {
  const target = SURFACES.find(s => s.name === inj.s);
  if (!target) { ok(false, `anti-vacuity fixture ${inj.s} exists`); continue; }
  const mutated = target.text.replace(inj.from, inj.to);
  ok(mutated !== target.text, `anti-vacuity: ${inj.name} is inject-able`,
    'fixture text "' + inj.from.slice(0, 40) + '" not found in ' + inj.s);
  const a = mutated.match(VERSIONED_MODEL) || [];
  const b = mutated.match(DASHED_MODEL) || [];
  const hit = FALSE_CLAIMS.filter(c => mutated.includes(c));
  if (inj.red === 'R1') {
    ok(a.length + b.length > 0, `anti-vacuity: R1 goes red for ${inj.name}`);
    ok(hit.length > 0, `anti-vacuity: R2 goes red for ${inj.name}`, 'no known-false literal matched: ' + mutated.slice(0, 60));
  } else {
    ok(hit.length > 0, `anti-vacuity: R2 goes red for ${inj.name}`, 'no known-false literal matched: ' + mutated.slice(0, 60));
  }
}

// ── TIER C: the scan is not degenerate ───────────────────────────────────────────────
console.log('\nTIER C — the scan itself saw the site');
ok(toolPages.length >= 300, `scanned ${toolPages.length} tool pages (expected >= 300)`);
ok(sitePages.length >= 4, `scanned ${sitePages.length} site-level pages (expected >= 4): ` +
  sitePages.map(f => rel(f)).join(', '));
ok(SURFACES.length >= 300, `scanned ${SURFACES.length} published surfaces`);
ok(existsSync(manifestPath), 'manifest.txt exists');

console.log(fail ? `\n${fail} FAIL` : '\nALL PASS');
process.exit(fail ? 1 : 0);
