/**
 * Self-check for the LLM cost engine shipped in tools/llm-cost-calculator/index.html.
 * Extracts the real tierFor()/costOf() from the page and asserts hand-computed totals,
 * so a regression in the page fails here instead of shipping a wrong number to users.
 *
 * Run: node test-scripts/llm-cost-calculator-test.js
 */
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'tools', 'llm-cost-calculator', 'index.html');
const html = fs.readFileSync(PAGE, 'utf8');

function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name + ' in the page');
  let depth = 0, i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const BATCH_DISCOUNT = 0.5;
const { tierFor, costOf } = new Function(
  'BATCH_DISCOUNT', extract('tierFor') + '\n' + extract('costOf') + '\nreturn {tierFor:tierFor,costOf:costOf};'
)(BATCH_DISCOUNT);

const W = (o) => Object.assign({ in: 0, out: 0, reason: 0, calls: 1, hit: 0, budget: 0, batch: 1 }, o);

const base = { id: 'x/base', in: 2e-6, out: 1e-5, cacheRead: 0, reason: 0, request: 0, tiers: [] };
const cached = Object.assign({}, base, { cacheRead: 2e-7 });
const tiered = Object.assign({}, base, {
  tiers: [{ min: 200000, in: 4e-6, out: 1.5e-5, cacheRead: 0 }]
});
const reasoning = Object.assign({}, base, { reason: 2e-5 });
const perReq = Object.assign({}, base, { request: 0.001 });

const near = (a, b, msg) => {
  if (Math.abs(a - b) > 1e-12) throw new Error(msg + ': got ' + a + ', want ' + b);
  console.log('  ok  ' + msg + ' = ' + a);
};

console.log('1. list price, no cache, no batch');
near(costOf(base, W({ in: 2000, out: 500 })).perCall, 0.009, 'per call');
near(costOf(base, W({ in: 2000, out: 500, calls: 100000 })).perCall * 100000, 900, 'monthly');
near(costOf(base, W({ in: 2000, out: 500 })).listPerCall, 0.009, 'list equals effective');

console.log('2. prompt cache read is cheaper than fresh input');
near(costOf(cached, W({ in: 2000, out: 500, hit: 0.5 })).perCall, 0.0072, '50% hit');
near(costOf(cached, W({ in: 2000, out: 500, hit: 1 })).perCall, 0.0054, '100% hit');

console.log('3. an unpublished cache rate falls back to the full input rate');
near(costOf(base, W({ in: 2000, out: 500, hit: 1 })).perCall, 0.009, 'no cache rate published');
near(costOf(cached, W({ in: 2000, out: 500, hit: 1 })).perCall < costOf(base, W({ in: 2000, out: 500, hit: 1 })).perCall, true, 'published rate is cheaper');

console.log('4. batch discount halves the effective cost but not the list price');
near(costOf(base, W({ in: 2000, out: 500, batch: 0.5 })).perCall, 0.0045, 'per call');
near(costOf(base, W({ in: 2000, out: 500, batch: 0.5 })).listPerCall, 0.009, 'list unchanged');

console.log('5. long-context tier applies to the whole request, not just the overflow');
near(costOf(tiered, W({ in: 250000, out: 500 })).perCall, 1.0075, '250k input clears the 200k tier');
near(costOf(tiered, W({ in: 199999, out: 500 })).perCall, 0.404998, 'just under the tier stays on base rate');
near(tierFor(tiered, 200000).min, 200000, 'threshold is inclusive at exactly 200k');
near(tierFor(tiered, 250000).min, 200000, 'tierFor picks the long-context tier');
near(tierFor(tiered, 1000).min, 0, 'tierFor stays on base for a small request');

console.log('6. reasoning tokens bill at the explicit reasoning rate when published');
near(costOf(reasoning, W({ in: 1000, out: 100, reason: 1000 })).perCall, 0.023, 'explicit reason rate');
near(costOf(base, W({ in: 1000, out: 100, reason: 1000 })).perCall, 0.013, 'falls back to the output rate');

console.log('7. a per-request fee is a published rate, so it sits in both totals');
near(costOf(perReq, W({ in: 2000, out: 500 })).perCall, 0.01, 'fee included in effective');
near(costOf(perReq, W({ in: 2000, out: 500 })).listPerCall, 0.01, 'fee included in list');
near(costOf(perReq, W({ in: 2000, out: 500 })).perCall, costOf(perReq, W({ in: 2000, out: 500 })).listPerCall, 'fee alone creates no list gap');
near(costOf(perReq, W({ in: 2000, out: 500, batch: 0.5 })).perCall, 0.005, 'batch still halves the total');

console.log('8. zero-token workloads cost nothing rather than NaN');
near(costOf(base, W({})).perCall, 0, 'empty workload');
near(costOf(base, W({ in: 0, out: 0, calls: 1e6 })).perCall, 0, 'zero tokens at high volume');

console.log('\nall cost engine assertions passed');
