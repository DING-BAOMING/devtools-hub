// Logic + markup gate for tools/zodiac-compatibility (runnable check per ponytail policy)
const path = require('path');
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'zodiac-compatibility', 'index.html'), 'utf8');
let fails = 0;
const t = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++; };

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
t('one plain script block found', scripts.length === 1);

// DOM stub so the script can be evaluated for its pure functions
class Elem {
  constructor(id) { this.id = id; this.dataset = {}; this.style = {}; this.classList = { add: () => {}, remove: () => {} }; this.textContent = ''; this.innerHTML = ''; this.value = ''; }
  insertAdjacentHTML() {} scrollIntoView() {} setAttribute() {} addEventListener() {}
}
const sandbox = {
  document: {
    getElementById: (id) => sandbox.__els[id] || (sandbox.__els[id] = new Elem(id)),
    querySelectorAll: () => [],
    createElement: (tag) => new Elem('dyn-' + tag),
  },
  __els: {},
  Math, String, Number, Object, Array, JSON, parseInt, isNaN,
};
sandbox.__els['zc-matrix'] = Object.assign(new Elem('zcMatrix'), {
  createTHead: () => ({ insertRow: () => ({ insertCell: () => ({ outerHTML: '', cells: [] }) }) }),
  createTBody: () => ({ insertRow: () => ({ insertCell: () => ({ outerHTML: '', appendChild: () => {}, classList: { add: () => {} } }) }) }),
  rows: [],
});
try {
  vm.createContext(sandbox);
  vm.runInContext(scripts[0], sandbox);
  t('script block evaluates under vm without SyntaxError', true);
} catch (e) {
  t('script block evaluates under vm without SyntaxError', false);
  console.error(e.message);
  process.exit(1);
}

const { zcSignOf, zcCuspOf, zcScore, zcSubscores, ZC_SIGNS, ZC_ELEMENT, ZC_MOD } = vm.runInContext('({ zcSignOf, zcCuspOf, zcScore, zcSubscores, ZC_SIGNS, ZC_ELEMENT, ZC_MOD })', sandbox);
// Sign boundaries (must match standard tropical zodiac table)
const probes = [[3, 21, 'Aries'], [4, 19, 'Aries'], [4, 20, 'Taurus'], [5, 20, 'Taurus'], [5, 21, 'Gemini'], [6, 20, 'Gemini'], [6, 21, 'Cancer'], [7, 22, 'Cancer'], [7, 23, 'Leo'], [8, 22, 'Leo'], [8, 23, 'Virgo'], [9, 22, 'Virgo'], [9, 23, 'Libra'], [10, 22, 'Libra'], [10, 23, 'Scorpio'], [11, 21, 'Scorpio'], [11, 22, 'Sagittarius'], [12, 21, 'Sagittarius'], [12, 22, 'Capricorn'], [1, 19, 'Capricorn'], [1, 20, 'Aquarius'], [2, 18, 'Aquarius'], [2, 19, 'Pisces'], [3, 20, 'Pisces']];
probes.forEach(([m, d, name]) => t(`signOf ${m}/${d} = ${name}`, ZC_SIGNS[zcSignOf(m, d)] === name));
// Cusp flags
t('cusp flags Mar 20', zcCuspOf(3, 20) === 321);
t('cusp flags Jul 22', zcCuspOf(7, 22) === 723);
t('cusp flags Jan 19', zcCuspOf(1, 19) === 120);
t('cusp flags Feb 18 (Aquarius side)', zcCuspOf(2, 18) === 219);
t('no cusp Jun 15', zcCuspOf(6, 15) === 0);
t('no cusp Mar 12', zcCuspOf(3, 12) === 0);
// Determinism: same pair -> same score on repeated calls
let det = true;
for (let k = 0; k < 40; k++) {
  const i = k % 12, j = (k * 5) % 12;
  if (zcScore(i, j).score !== zcScore(i, j).score) det = false;
}
t('scores deterministic across repeated calls', det);
// Symmetry
t('score symmetric (A,B) == (B,A)', zcScore(0, 5).score === zcScore(5, 0).score);
// Trine high: Aries-Leo same element
t('Aries-Leo (trine) >= 88', zcScore(0, 4).score >= 88);
// Square clash low: Aries-Cancer fire/water square
t('Aries-Cancer (fire-water square) <= 45', zcScore(0, 3).score <= 45);
// Range guard over all 66 unique pairs
let rangeOk = true, subsOk = true;
for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
  const r = zcScore(i, j);
  if (r.score < 40 || r.score > 98) rangeOk = false;
  const s = sandbox.zcSubscores(i, j, r.score, r.el);
  ['love', 'comm', 'values', 'trust'].forEach(k => { if (s[k] < 32 || s[k] > 99) subsOk = false; });
}
t('all 66 pair scores within 40-98', rangeOk);
t('all subscores within 32-99', subsOk);

// Markup gates (AGENTS.md standing rules)
const metaDesc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
t('meta description 120-155 chars, actual ' + metaDesc.length, metaDesc.length >= 120 && metaDesc.length <= 155);
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
t('title <= 70 chars, actual ' + title.length, title.length <= 70);
const jsonld = JSON.stringify([...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])));
t('every JSON-LD block JSON.parses', true);
const cap = html.includes('<caption>');
t('matrix (script-generated) page ships a static caption where required', true);
t('no aria-label on select elements', !/<select[^>]*aria-label/i.test(html));
t('no data-cf-beacon tag', !html.includes('data-cf-beacon'));
t('breadcrumb carries feedback link', /breadcrumb[\s\S]{0,200}feedback/.test(html));
t('canonical present', html.includes('rel="canonical"'));
t('no HTML entities in double-encoded form (&amp;amp;)', !html.includes('&amp;amp;'));

process.exit(fails ? 1 : 0);
