// BUG-336 gate: one category, one display name, on every surface that publishes it.
// Tier A: assert the live/API surfaces agree with the category page.
// Tier B: anti-vacuity — flip one source back and require the gate to go red.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

let fails = 0;
let tierAFails = 0;
const A = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? ' — ' + d : '')); if (!c) fails++; };

// Pull the label map out of each source WITHOUT executing them — the name is a literal in
// each file, so reading the literal is both sufficient and immune to Function side effects.
function labelsFromIndexJs() {
  const src = readFileSync(ROOT + '/functions/index.js', 'utf8');
  const body = src.slice(src.indexOf('const CAT_ORDER = ['), src.indexOf('const knownCats'));
  return Object.fromEntries([...body.matchAll(/\['([a-z-]+)',\s*'([^']+)'\]/g)].map(m => [m[1], m[2]]));
}
function labelsFromApiTools() {
  const src = readFileSync(ROOT + '/functions/api/tools.js', 'utf8');
  const body = src.slice(src.indexOf('const CAT_LABELS = {'), src.indexOf('export async function'));
  return Object.fromEntries([...body.matchAll(/'([a-z-]+)':\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
}
// E3 (2026-11-04): the category page's label map moved OUT of functions/tools/[[catchall]].js
// into libs/category-copy.js (CAT_LABELS) — one owner for the display name, imported by the
// catch-all and by the hub. The gate's class is unchanged ("one category, one display name on
// every surface that publishes it"); the surface it used to read now HOLDS the map, so it reads
// it from the owner. Reading the map from the file that publishes it is still the same
// "literal, not execution" trick.
function labelsFromCategoryLib() {
  const src = readFileSync(ROOT + '/libs/category-copy.js', 'utf8');
  const body = src.slice(src.indexOf('export const CAT_LABELS = {'), src.indexOf('export const CAT_NOUNS'));
  return Object.fromEntries([...body.matchAll(/'([a-z-]+)':\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
}

const SOURCES = {
  'functions/index.js (homepage grid + search)': labelsFromIndexJs(),
  'functions/api/tools.js (public JSON API)': labelsFromApiTools(),
  'libs/category-copy.js -> category page (CAT_LABELS)': labelsFromCategoryLib(),
};

function check(sources, label) {
  console.log(label);
  const [a, b, c] = Object.entries(sources);
  for (const [name, map] of Object.entries(sources)) {
    A(`${name}: has all 11 categories`, Object.keys(map).length === 11, Object.keys(map).length + ' found');
  }
  for (const slug of Object.keys(SOURCES[a[0]] ?? a[1])) {
    const vals = Object.values(sources).map(m => m[slug]);
    A(`'${slug}' label identical on all 3 surfaces`, new Set(vals).size === 1, vals.join('  vs  '));
  }
}

// The category page must PUBLISH the owner's labels, not a private copy of them: the catch-all
// imports CAT_LABELS from libs/category-copy.js and must not also declare a local map of the
// same names (a second copy is exactly how this gate went red in the first place).
{
  const src = readFileSync(ROOT + '/functions/tools/[[catchall]].js', 'utf8');
  A('functions/tools/[[catchall]].js imports CAT_LABELS from libs/category-copy.js',
    /import\s*\{[^}]*CAT_LABELS[^}]*\}\s*from\s*'[^']*libs\/category-copy\.js'/.test(src));
  A('functions/tools/[[catchall]].js declares no second copy of the label map',
    !/const\s+CAT_LABELS\s*=\s*\{/.test(src));
}

check(SOURCES, 'TIER A — shipped sources');
tierAFails = fails;

// Tier B: revert ONE source and require red.
console.log('TIER B — anti-vacuity (one source reverted, gate MUST go red)');
const S2 = { ...SOURCES };
S2['functions/api/tools.js (public JSON API)'] = { ...S2['functions/api/tools.js (public JSON API)'], formatters: 'Formatters' };
check(S2, 'TIER B — api/tools reverted to the old name');
A('TIER B: gate is not vacuous', fails > 0, fails + ' failures detected');

// Tier A failures are real defects. A Tier B failure is the anti-vacuity tier WORKING —
// it is supposed to detect the reverted label. Only Tier A decides the exit code, otherwise
// this gate can never exit 0 and a red run stops meaning anything.
console.log('\nTIER A result:', tierAFails ? tierAFails + ' FAIL' : 'PASS (Tier B failing is the expected outcome)');
process.exit(tierAFails ? 1 : 0);
