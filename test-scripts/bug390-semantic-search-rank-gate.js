#!/usr/bin/env node
/**
 * BUG-390 regression gate — the LOCAL RANK must put the right tool first.
 *
 * Why this exists. The semantic-search endpoint used to hand the LLM
 * `tools.slice(0, 20)` — the first 20 rows of manifest.txt — so for 351 of the 371
 * tools the model could not see the right answer even in principle. It is a 7B model
 * that answers in prose, so it filled the gap with whatever it saw, and the slug
 * parser mined that prose. Measured on production before the fix:
 *
 *   "make a logo"                -> audio-to-text, text-to-speech, logo-maker
 *   "calculate area of a circle" -> audio-to-text, blood-type-calculator, ...
 *   "write a resume"             -> audio-to-text, blood-type-calculator, ...
 *   "pdf to jpg"                 -> audio-to-text, pdf-to-image, pdf-to-text
 *
 * The endpoint now ranks every tool against the query locally, shows the LLM that
 * shortlist, and accepts back only slugs that are on it. This gate asserts the local
 * rank itself, with no network and no provider, so the ranking cannot silently rot
 * when the manifest changes.
 *
 * Anti-vacuity: the gate fails if the rank is replaced by the old head-of-manifest
 * slice, because for most of these queries the right tool is not in the first 20 rows.
 *
 *   node test-scripts/bug390-semantic-search-rank-gate.js [rootDir]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;

// [query, the slug that must come first]
const CASES = [
  ['make a logo', 'logo-maker'],
  ['calculate area of a circle', 'area-calculator'],
  ['write a resume', 'resume-builder'],
  ['convert video to mp3', 'video-to-audio'],
  ['pdf to jpg', 'pdf-to-image'],
  ['convert jpg to png', 'image-format-converter'],
  ['compress pdf', 'pdf-compressor'],
  ['merge pdf files', 'pdf-merger'],
  ['make a qr code', 'qr-code-generator'],
  ['check website speed', 'website-down-checker'],
  ['generate a password', 'password-generator'],
  ['count words', 'word-counter'],
  ['youtube transcript', 'youtube-transcript-extractor'],
  ['create a favicon', 'favicon-generator'],
  ['remove background from image', 'background-remover'],
  ['unit conversion', 'unit-converter'],
  ['json to yaml', 'json-yaml-converter'],
  ['whats the weather', 'weather-forecast'],
  ['bmi calculator', 'bmi-calculator'],
  ['resize image', 'image-resizer'],
  ['split pdf pages', 'pdf-splitter'],
  ['screen recorder', 'screen-recorder'],
  ['qr code reader', 'qr-code-reader'],
  ['invoice generator', 'invoice-generator'],
  ['hash a string', 'hash-generator'],
  ['how to reduce pdf size', 'pdf-compressor'],
  ['calculate percentage', 'percentage-calculator']
];

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

(async () => {
  const manifestPath = path.join(root, 'manifest.txt');
  const endpointPath = path.join(root, 'functions/api/semantic-search.js');
  if (!fs.existsSync(manifestPath)) {
    console.log('FAIL — manifest.txt not found at ' + manifestPath);
    process.exit(1);
  }
  if (!fs.existsSync(endpointPath)) {
    console.log('FAIL — functions/api/semantic-search.js not found');
    process.exit(1);
  }

  // The endpoint is an ES module; the gate is CommonJS. Copy the two modules into a
  // temp directory as .mjs and import them from there.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semrank-'));
  fs.writeFileSync(
    path.join(tmp, 'ai-provider.mjs'),
    fs.readFileSync(path.join(root, 'libs/ai-provider.js'), 'utf8')
  );
  const src = fs.readFileSync(endpointPath, 'utf8');
  fs.writeFileSync(
    path.join(tmp, 'semantic-search.mjs'),
    src.replace("from '../../libs/ai-provider.js'", "from './ai-provider.mjs'")
  );

  let mod;
  try {
    mod = await import(pathToFileURL(path.join(tmp, 'semantic-search.mjs')).href);
  } catch (e) {
    console.log('FAIL — could not load the endpoint module: ' + e.message);
    process.exit(1);
  }
  ok(typeof mod.rankTools === 'function', 'the endpoint exports rankTools');
  ok(typeof mod.parseManifest === 'function', 'the endpoint exports parseManifest');

  const tools = mod.parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  ok(tools.length > 300, 'the manifest parsed into the tool list', `got ${tools.length}`);
  const slugs = new Set(tools.map(t => t.slug));

  const head = tools.slice(0, 20).map(t => t.slug);
  let notInHead = 0;
  for (const [query, expected] of CASES) {
    const ranked = mod.rankTools(tools, query);
    const first = ranked.length ? ranked[0].slug : '(nothing)';
    ok(first === expected, `"${query}" ranks "${expected}" first`, `got "${first}"`);
    ok(slugs.has(expected), `"${query}" names a tool that exists`, `no slug "${expected}"`);
    if (!head.includes(expected)) notInHead++;
  }

  // The old behaviour handed the LLM the first 20 rows of the manifest. Most of these
  // answers are NOT among them, which is exactly why the old endpoint answered
  // "audio-to-text" — the model had nothing else to pick. If the manifest is ever
  // reordered so that they all are, this assertion stops being about the defect.
  ok(notInHead >= 15,
    'most of these answers were unreachable from the manifest head',
    `only ${notInHead} of ${CASES.length} were outside the first 20 rows`);

  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log('FAIL:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('PASS — the local semantic rank puts the right tool first.');
})();
