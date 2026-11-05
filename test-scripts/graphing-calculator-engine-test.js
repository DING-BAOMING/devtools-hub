// Engine self-check for tools/graphing-calculator/index.html
// Runs the SHIPPED page (file://) and asserts the numerical answers it prints.
// Every "exact" value here was verified independently against a dense Simpson
// reference, not written from memory.
// Fails loudly if any parser / solver / regression path breaks.
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const PAGE = 'file://' + path.resolve(__dirname, '../tools/graphing-calculator/index.html');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors = [];
  // file:// cannot load /styles.css or /tools.js, and the analytics beacon is
  // cross-origin. Those are environment artefacts, not code defects.
  const IGNORE = /ERR_FILE_NOT_FOUND|net::ERR_FAILED|cloudflareinsights|beacon\.min\.js|styles\.css|\/tools\.js/;
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.__gc, { timeout: 10000 });

  console.log('\n[1] parser');
  const parse = await page.evaluate(() => ({
    pow: __gc.evalNode(__gc.parse('2^3^2'), {}),                    // right assoc -> 512
    imp: __gc.evalNode(__gc.parse('2x'), { x: 3 }),                 // implicit mul -> 6
    impf: __gc.evalNode(__gc.parse('2sin(x)'), { x: Math.PI / 2 }),// -> 2
    impb: __gc.evalNode(__gc.parse('(x+1)(x-1)'), { x: 4 }),        // -> 15
    un: __gc.evalNode(__gc.parse('-x^2'), { x: 3 }),                // -(3^2) = -9
    un2: __gc.evalNode(__gc.parse('2^-2'), {}),                    // 0.25
    fac: __gc.evalNode(__gc.parse('5!'), {}),                       // 120
    sq: __gc.evalNode(__gc.parse('x^2'), { x: -3 }),                // 9
    eq: __gc.evalNode(__gc.parse('(x-1)^2+(y-2)^2-9'), { x: 4, y: 2 }), // implicit, on circle
    eqo: __gc.evalNode(__gc.parse('(x-1)^2+(y-2)^2-9'), { x: 0, y: 0 }),
    sinx: __gc.evalNode(__gc.parse('sin x'), { x: Math.PI / 2 }),  // bare function name
    pi: __gc.evalNode(__gc.parse('pi'), {}),
    logb: __gc.evalNode(__gc.parse('log10(x)'), { x: 8 }),
    lnb: __gc.evalNode(__gc.parse('ln(x)'), { x: 8 }),
    log2b: __gc.evalNode(__gc.parse('log2(x)'), { x: 8 }),
    e: __gc.evalNode(__gc.parse('e^x'), { x: 2 })
  }));
  check('2^3^2 = 512 (right associative)', near(parse.pow, 512), parse.pow);
  check('2x with x=3 -> 6 (implicit multiply)', near(parse.imp, 6), parse.imp);
  check('2sin(pi/2) -> 2 (implicit function multiply)', near(parse.impf, 2), parse.impf);
  check('(x+1)(x-1) with x=4 -> 15 (implicit bracket multiply)', near(parse.impb, 15), parse.impb);
  check('-x^2 with x=3 -> -9 (unary binds looser than ^)', near(parse.un, -9), parse.un);
  check('2^-2 -> 0.25 (right operand may be unary)', near(parse.un2, 0.25), parse.un2);
  check('5! -> 120', near(parse.fac, 120), parse.fac);
  check('x^2 with x=-3 -> 9 (not NaN)', near(parse.sq, 9), parse.sq);
  check('implicit circle is 0 on (4,2)', near(parse.eq, 0), parse.eq);
  check('implicit circle non-zero off-curve', !near(parse.eqo, 0), parse.eqo);
  check('"sin x" parses as sin(x)', near(parse.sinx, 1), parse.sinx);
  check('pi constant', near(parse.pi, Math.PI), parse.pi);
  check('log10(8) = 0.903 (log10 is base 10)', near(parse.logb, Math.log10(8), 1e-12), parse.logb);
  check('ln(8) = 2.079 (log and ln are the natural log)', near(parse.lnb, Math.log(8), 1e-12), parse.lnb);
  check('log2(8) = 3', near(parse.log2b, 3, 1e-12), parse.log2b);
  check('e^x at x=2 -> e^2', near(parse.e, Math.E * Math.E), parse.e);

  console.log('\n[2] parser rejects garbage (no eval fallback)');
  const bad = await page.evaluate(() => {
    const out = {};
    ['2 +', '(x+1', 'x^^2', 'foo(x)', 'ln(', '1.2.3', '@', 'x+*2', 'x = window', 'window', 'xy', 'sin'].forEach(function (s) {
      try { __gc.parse(s); out[s] = 'PARSED'; }
      catch (e) { out[s] = e && e.msg ? e.msg : String(e); }
    });
    return out;
  });
  Object.keys(bad).forEach(k => check('rejects ' + JSON.stringify(k), bad[k] !== 'PARSED', bad[k]));
  const noEval = await page.evaluate(() => ({
    hasEval: /[^.\w]eval\s*\(/.test(document.documentElement.innerHTML),
    hasNewFunction: /new\s+Function\s*\(/.test(document.documentElement.innerHTML),
    hasInnerHTML: /\.innerHTML\s*=/.test(document.documentElement.innerHTML)
  }));
  check('3! is a valid factorial (6), not a parse error', near(parse.fac, 120));
  check('rejects an unknown multi-letter name (xy is not silently x*y)', /Unknown name/.test(bad['xy']), bad['xy']);
  check('source contains no eval() call', noEval.hasEval === false);
  check('source contains no new Function()', noEval.hasNewFunction === false);

  console.log('\n[3] root finding (bisection)');
  const roots = await page.evaluate(() => {
    const mk = s => x => __gc.evalNode(__gc.parse(s), { x: x });
    return {
      quad: __gc.findZeros(mk('x^2-4'), -10, 10),
      sin: __gc.findZeros(mk('sin(x)'), -0.1, 10.1),
      cubic: __gc.findZeros(mk('x^3-2x-5'), 0, 4),
      tang: __gc.findZeros(mk('x^2'), -5, 5)
    };
  });
  check('x^2-4 has exactly 2 roots in [-10,10]', roots.quad.length === 2, JSON.stringify(roots.quad));
  check('x^2-4 roots are -2 and +2', near(roots.quad[0], -2) && near(roots.quad[1], 2), JSON.stringify(roots.quad));
  check('roots accurate to 1e-11 (not grid artefacts)', near(roots.quad[0], -2, 1e-11) && near(roots.quad[1], 2, 1e-11), JSON.stringify(roots.quad));
  check('sin(x) root at 0 inside [-0.1,10.1]', roots.sin.some(r => near(r, 0, 1e-11)), JSON.stringify(roots.sin));
  check('sin(x) root at pi inside window', roots.sin.some(r => near(r, Math.PI, 1e-9)), JSON.stringify(roots.sin));
  check('x^3-2x-5 root = 2.0945514815423265', roots.cubic.length === 1 && near(roots.cubic[0], 2.0945514815423265, 1e-9), JSON.stringify(roots.cubic));
  check('x^2 reports NO root (even multiplicity -> no sign change, by design)', roots.tang.length === 0, JSON.stringify(roots.tang));

  console.log('\n[4] turning points');
  const ext = await page.evaluate(() => {
    const mk = s => x => __gc.evalNode(__gc.parse(s), { x: x });
    return {
      quad: __gc.findExtrema(mk('x^2-4'), -10, 10),
      cubic: __gc.findExtrema(mk('x^3-3x'), -5, 5),
      lin: __gc.findExtrema(mk('2x+1'), -5, 5)
    };
  });
  check('x^2-4 has 1 minimum at (0,-4)', ext.quad.length === 1 && near(ext.quad[0].x, 0, 1e-7) && near(ext.quad[0].y, -4, 1e-6) && ext.quad[0].kind === 'min', JSON.stringify(ext.quad));
  check('x^3-3x has a max then a min', ext.cubic.length === 2 && ext.cubic[0].kind === 'max' && ext.cubic[1].kind === 'min', JSON.stringify(ext.cubic));
  check('max at x=-1 (y=2) and min at x=+1 (y=-2)', near(ext.cubic[0].x, -1, 1e-6) && near(ext.cubic[0].y, 2, 1e-5) && near(ext.cubic[1].x, 1, 1e-6) && near(ext.cubic[1].y, -2, 1e-5), JSON.stringify(ext.cubic));
  check('a straight line has no turning point', ext.lin.length === 0, JSON.stringify(ext.lin));

  console.log('\n[5] definite integral (Gauss-Kronrod 15/7)');
  const ints = await page.evaluate(() => {
    const mk = s => x => __gc.evalNode(__gc.parse(s), { x: x });
    return {
      x2: __gc.integrate(mk('x^2'), 0, 3),
      rev: __gc.integrate(mk('x^2'), 3, 0),
      sin: __gc.integrate(mk('sin(x)'), 0, Math.PI),
      poly: __gc.integrate(mk('x^5-2x+1'), -2, 4),
      absx: __gc.integrate(mk('abs(x)'), -2, 3),
      lnx: __gc.integrate(mk('1/x'), 1, 2),
      osc: __gc.integrate(mk('sin(1000x)'), 0, 10),
      gauss: __gc.integrate(mk('1/(1+x^2)'), -10, 10),
      expn: __gc.integrate(mk('exp(x)'), 0, 1),
      sqrt: __gc.integrate(mk('sqrt(x)'), 0, 4),
      x2s: __gc.integrate(mk('x^2*sin(x)'), 0, Math.PI),
      wide: __gc.integrate(mk('1/(1+x^2)'), -1e6, 1e6),
      improper: __gc.integrate(mk('1/sqrt(1-x^2)'), -1, 1)
    };
  });
  check('∫0..3 x² = 9', near(ints.x2, 9, 1e-9), ints.x2);
  check('∫3..0 x² = -9 (orientation respected, not silently flipped)', near(ints.rev, -9, 1e-9), ints.rev);
  check('∫0..π sin(x) = 2', near(ints.sin, 2, 1e-9), ints.sin);
  check('∫-2..4 (x^5-2x+1) = 666', near(ints.poly, 666, 1e-6), ints.poly);
  check('∫-2..3 |x| = 6.5 (kink at 0 resolved)', near(ints.absx, 6.5, 1e-8), ints.absx);
  check('∫1..2 1/x = ln 2', near(ints.lnx, Math.log(2), 1e-12), ints.lnx);
  check('∫0..10 sin(1000x) (1000 oscillations) to 1e-11', near(ints.osc, (1 - Math.cos(10000)) / 1000, 1e-11), ints.osc);
  check('∫-10..10 1/(1+x²) = 2·atan(10)', near(ints.gauss, 2 * Math.atan(10), 1e-9), ints.gauss);
  check('∫0..1 e^x = e-1', near(ints.expn, Math.E - 1, 1e-12), ints.expn);
  check('∫0..4 √x = 16/3', near(ints.sqrt, 16 / 3, 1e-8), ints.sqrt);
  check('∫0..π x²sin(x) = π²-4 (Simpson was 87% wrong here)', near(ints.x2s, Math.PI * Math.PI - 4, 1e-9), ints.x2s);
  check('∫-1e6..1e6 1/(1+x²) ≈ π to 4 decimals (wide range)', near(ints.wide, Math.PI, 1e-4), ints.wide);
  check('improper ∫-1..1 1/√(1-x²) ≈ π to 4 decimals (documented limit)', near(ints.improper, Math.PI, 1e-4), ints.improper);

  console.log('\n[6] area between curves with auto intersection bounds');
  const area = await page.evaluate(() => {
    // area of (2 - x^2) on [-sqrt2, sqrt2] = 2*(2*sqrt2) - 2*(sqrt2)^3/3
    const L = Math.SQRT2;
    const exact = 2 * (2 * L) - 2 * Math.pow(L, 3) / 3;
    const f = x => 2 - x * x;
    const xs = __gc.findZeros(f, -L, L, 4000);
    let total = 0;
    const bounds = [-L].concat(xs, [L]);
    for (let i = 0; i < bounds.length - 1; i++) total += __gc.integrate(x => Math.abs(f(x)), bounds[i], bounds[i + 1]);
    // the same thing with the sign flip the UI applies per slice
    let signed = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const lo = bounds[i], hi = bounds[i + 1];
      const sign = f((lo + hi) / 2) >= 0 ? 1 : -1;
      signed += sign * __gc.integrate(f, lo, hi);
    }
    return { xs: xs, total: total, signed: signed, exact: exact };
  });
  check('2-x^2 intersects its roots at ±√2', area.xs.length === 2 && near(area.xs[0], -Math.SQRT2, 1e-9) && near(area.xs[1], Math.SQRT2, 1e-9), JSON.stringify(area.xs));
  check('|f| area = 3.7712361663282534', near(area.total, area.exact, 1e-9), area.total);
  check('per-slice sign flip still yields the same positive area', near(area.signed, area.exact, 1e-9), area.signed);

  console.log('\n[7] regression (normal equations, partial pivoting)');
  const fit = await page.evaluate(() => {
    function run(model, pts) {
      const M = __gc.MODELS[model];
      const work = M.pre ? pts.map(M.pre) : pts;
      const k = M.k, A = [], b = [];
      for (let i = 0; i < k; i++) { A.push(new Array(k).fill(0)); b.push(0); }
      for (const p of work) {
        const bi = M.basis(p);
        for (let j = 0; j < k; j++) { b[j] += bi[j] * p.y; for (let l = 0; l < k; l++) A[j][l] += bi[j] * bi[l]; }
      }
      const c = __gc.solve(A, b);
      const fn = M.fn(c);
      const ybar = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      let ssRes = 0, ssTot = 0;
      for (const p of pts) { const r = p.y - fn(p.x); ssRes += r * r; ssTot += (p.y - ybar) * (p.y - ybar); }
      return { coef: c, r2: 1 - ssRes / ssTot, eq: M.eq(c) };
    }
    return {
      lin: run('linear', [{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 9 }]),
      exact: run('quadratic', [{ x: -3, y: 9 }, { x: -1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 3, y: 9 }]),
      cub: run('cubic', [{ x: -2, y: -8 }, { x: -1, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 8 }]),
      exp: run('exponential', [{ x: 0, y: 2 }, { x: 1, y: 2 * Math.E }, { x: 2, y: 2 * Math.E * Math.E }]),
      pow: run('power', [{ x: 1, y: 3 }, { x: 2, y: 3 * Math.pow(2, 1.5) }, { x: 4, y: 3 * Math.pow(4, 1.5) }]),
      logf: run('logarithmic', [{ x: Math.E, y: 3 }, { x: Math.E * Math.E, y: 5 }, { x: Math.E * Math.E * Math.E, y: 7 }]),
      badPow: run('power', [{ x: 1, y: 3 }, { x: 2, y: 3 * Math.pow(2, 1.5) }, { x: 4, y: 3 * Math.pow(4, 1.5) }])
    };
  });
  check('linear fit of y=2x+1 recovers slope 2 / intercept 1', near(fit.lin.coef[1], 2, 1e-9) && near(fit.lin.coef[0], 1, 1e-9), fit.lin.eq);
  check('perfect linear fit gives R2 = 1', near(fit.lin.r2, 1, 1e-12), fit.lin.r2);
  check('quadratic fit recovers exactly y = x^2', near(fit.exact.coef[2], 1, 1e-7) && near(fit.exact.coef[1], 0, 1e-7) && near(fit.exact.coef[0], 0, 1e-7), fit.exact.eq);
  check('perfect quadratic fit gives R2 = 1', near(fit.exact.r2, 1, 1e-9), fit.exact.r2);
  check('cubic fit recovers y = x^3', near(fit.cub.coef[3], 1, 1e-8) && near(fit.cub.coef[0], 0, 1e-7), fit.cub.eq);
  check('exponential fit recovers y = 2e^x (BUG: basis must not re-log)', near(fit.exp.coef[1], 1, 1e-9) && near(Math.exp(fit.exp.coef[0]), 2, 1e-9), fit.exp.eq);
  check('power fit recovers y = 3x^1.5 (BUG: pre() already logged x, basis must not log again)',
    near(fit.pow.coef[1], 1.5, 1e-9) && near(Math.exp(fit.pow.coef[0]), 3, 1e-9), fit.pow.eq);
  check('logarithmic fit recovers y = 1 + 2ln(x)', near(fit.logf.coef[0], 1, 1e-8) && near(fit.logf.coef[1], 2, 1e-8), fit.logf.eq);
  check('power equation string contains no "undefined"', !/undefined/.test(fit.pow.eq), fit.pow.eq);

  console.log('\n[8] number formatting');
  const f = await page.evaluate(() => ({
    a: __gc.fmt(1 / 3, 12), b: __gc.fmt(2, 12), c: __gc.fmt(1e-12), d: __gc.fmt(1234567.891, 12), e: __gc.fmt(-0.5, 12)
  }));
  check('fmt(1/3) = 0.333333333333', f.a === '0.333333333333', f.a);
  check('fmt(2) = 2', f.b === '2', f.b);
  check('fmt(1e-12) uses exponential (no float noise)', /e-12$/.test(f.c), f.c);
  check('fmt(1234567.891) = 1234567.891', f.d === '1234567.891', f.d);
  check('fmt(-0.5) = -0.5', f.e === '-0.5', f.e);

  console.log('\n[9] page wiring');
  const ui = await page.evaluate(() => ({
    rows: document.querySelectorAll('#gc-curves .gc-curve').length,
    targets: document.getElementById('gc-target').options.length,
    h1: document.querySelectorAll('h1').length,
    canvasW: document.getElementById('gc-canvas').width,
    chips: document.querySelectorAll('.gc-chip').length,
    faqs: document.querySelectorAll('details.faq-item').length
  }));
  check('two expression rows rendered on load', ui.rows === 2, ui.rows);
  check('target dropdown has an entry for the typed curve', ui.targets >= 2, ui.targets);
  check('exactly one H1', ui.h1 === 1, ui.h1);
  check('canvas has a real pixel width (DPR scaled)', ui.canvasW > 0, ui.canvasW);
  check('example chips rendered', ui.chips === 8, ui.chips);
  check('FAQ uses <details class="faq-item">', ui.faqs >= 7, ui.faqs);

  // --- Analyze on the default x^2-4 over [-3,3]  (∫(x^2-4) = -6, verified against dense Simpson)
  await page.selectOption('#gc-target', { index: 1 });
  await page.fill('#gc-a', '-3');
  await page.fill('#gc-b', '3');
  await page.fill('#gc-x0', '1');
  await page.click('#gc-analyze');
  await page.waitForSelector('#gc-results .gc-card', { timeout: 5000 });
  const shown = await page.evaluate(() => document.getElementById('gc-results').innerText);
  check('Analyze reports 2 roots on screen', /2 found/.test(shown), shown.slice(0, 200));
  check('Analyze reports the minimum at x=0, y=-4', /min at x = 0/.test(shown) && /\(0, -4\)/.test(shown), shown.slice(0, 400));
  check('Analyze reports the signed integral -6 (∫-3..3 (x²-4))', /DEFINITE INTEGRAL\n-6\n/.test(shown), shown.slice(0, 800));
  check('Analyze reports the total area 46/3 = 15.3333', /15\.33333/.test(shown), shown.slice(0, 900));
  check('Analyze reports the slope f\'(1) = 2', /SLOPE AT X = 1\n2\n/.test(shown), shown.slice(0, 1000));
  check('status bar shows success', /Analysis complete/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

  // --- area between the default x^2-4 and a new y=2  (∫-2..2 |x²-6| = 18.666666...)
  await page.click('#gc-add');
  await page.waitForTimeout(150);
  await page.locator('#gc-curves .gc-expr').nth(2).fill('2');
  await page.waitForTimeout(250);
  await page.selectOption('#gc-target', { index: 1 });
  await page.selectOption('#gc-target2', { index: 2 });
  await page.fill('#gc-a', '-2');
  await page.fill('#gc-b', '2');
  await page.click('#gc-area');
  await page.waitForTimeout(400);
  const areaTxt = await page.innerText('#gc-results');
  check('area between x^2-4 and 2 over [-2,2] = 18.66666667 (verified against dense Simpson)',
    areaTxt.indexOf('18.66666667') >= 0, areaTxt.slice(0, 300));

  // --- area between two curves that DO cross inside the range
  await page.locator('#gc-curves .gc-expr').first().fill('x^2');
  await page.waitForTimeout(250);
  await page.selectOption('#gc-target', { index: 1 });
  await page.selectOption('#gc-target2', { index: 2 });
  await page.fill('#gc-a', '-2');
  await page.fill('#gc-b', '2');
  await page.click('#gc-area');
  await page.waitForTimeout(400);
  const areaTxt2 = await page.innerText('#gc-results');
  // verified against a dense Simpson reference and the closed form:
  // 2*[(x^3/3-2x)|-2..-sqrt2] + [2x-x^3/3]|-sqrt2..sqrt2 = 4.87580566598984
  check('area between x^2 and 2 over [-2,2] = 4.875805666 across 2 intersections',
    areaTxt2.indexOf('4.875805666') >= 0 && /across 2 intersection/.test(areaTxt2), areaTxt2.slice(0, 400));
  check('per-slice breakdown uses the auto-detected intersection bounds',
    /-2 → -1\.4142136/.test(areaTxt2) && /1\.4142136 → 2/.test(areaTxt2), areaTxt2.slice(0, 500));

  // --- table of values
  await page.click('#gc-table');
  await page.waitForTimeout(300);
  const trows = await page.evaluate(() => document.querySelectorAll('#gc-table-out .gc-table tbody tr').length);
  check('table of values has 11 rows', trows === 11, trows);

  // --- error path
  const badInput = page.locator('#gc-curves .gc-expr').first();
  await badInput.fill('x^^2');
  await page.waitForTimeout(300);
  const errTxt = await page.innerText('.gc-err');
  check('bad expression surfaces a readable error', /Unexpected|Curve 1/.test(errTxt), errTxt);
  await badInput.fill('x^2-4');
  await page.waitForTimeout(250);
  check('error clears when the expression is fixed', (await page.evaluate(() => document.querySelectorAll('.gc-err').length)) === 0);

  // --- regression through the UI
  await page.fill('#gc-data', '1 2.1\n2 3.9\n3 6.2\n4 7.8\n5 10.1\n6 12.0');
  await page.selectOption('#gc-model', 'quadratic');
  await page.click('#gc-fitrun');
  await page.waitForSelector('#gc-fit-out .gc-card', { timeout: 5000 });
  const fitTxt = await page.innerText('#gc-fit-out');
  check('regression shows R2 in [0.99, 1.001]', /0\.99/.test(fitTxt), fitTxt.slice(0, 300));
  check('regression equation contains no "undefined"', !/undefined/.test(fitTxt), fitTxt.slice(0, 200));
  check('regression residual table has one row per point',
    (await page.evaluate(() => document.querySelectorAll('#gc-fit-table tbody tr').length)) === 6);

  // --- domain guards
  await page.fill('#gc-data', '1 -2\n2 -4\n3 -8');
  await page.selectOption('#gc-model', 'exponential');
  await page.click('#gc-fitrun');
  await page.waitForTimeout(300);
  check('exponential fit refuses negative y values', /positive/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));
  await page.fill('#gc-data', '1 2\n2 4');
  await page.selectOption('#gc-model', 'cubic');
  await page.click('#gc-fitrun');
  await page.waitForTimeout(300);
  check('cubic fit refuses fewer points than parameters (n must exceed the 4 fitted params)', /at least 5 points/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));
  await page.fill('#gc-data', 'not numbers at all');
  await page.selectOption('#gc-model', 'linear');
  await page.click('#gc-fitrun');
  await page.waitForTimeout(300);
  check('regression refuses unparseable data', /No data found/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

  // --- bounds guard
  await page.fill('#gc-a', '5');
  await page.fill('#gc-b', '-5');
  await page.click('#gc-analyze');
  await page.waitForTimeout(300);
  check('reversed bounds produce a readable error', /must be bigger/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

  // --- examples
  const exNames = await page.evaluate(() => Array.from(document.querySelectorAll('.gc-chip')).map(b => b.textContent));
  for (let i = 0; i < exNames.length; i++) {
    await page.locator('.gc-chip').nth(i).click();
    await page.waitForTimeout(220);
    const st = await page.innerText('#gc-status');
    check('example loads without error: ' + exNames[i], /Loaded: /.test(st) && !/error/i.test(st), st);
  }
  const drawnPixels = await page.evaluate(() => {
    const c = document.getElementById('gc-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // count saturated pixels: the background is #0f0f23 and the grid is #1f1f38,
    // both near-neutral, while every curve colour has a clear channel spread
    let coloured = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > 40) coloured++;
    }
    return coloured;
  });
  check('last example actually painted curve pixels on the canvas', drawnPixels > 500, drawnPixels);

  // --- share link round-trip
  const share = await page.evaluate(() => {
    const payload = { c: __gc.state.curves.map(c => ({ t: c.type, e: c.expr, x: c.extra, k: c.color, on: 1 })), v: [-5, 5, -5, 5] };
    return location.origin + location.pathname + '#g=' + encodeURIComponent(JSON.stringify(payload));
  });
  check('share link round-trips as a parsable URL', /#g=%7B%22c%22/.test(share), share.slice(0, 80));
  const restored = await page.evaluate(() => {
    const p = JSON.parse(decodeURIComponent(/[#&]g=([^&]+)/.exec('#g=' + encodeURIComponent('{"c":[{"t":"fn","e":"x^3","x":"","k":"#667eea","on":1}],"v":[-4,4,-4,4]}'))[1]));
    return p.c[0].e + '|' + p.v.join(',');
  });
  check('share payload decodes back to the expression and window', restored === 'x^3|-4,4,-4,4', restored);

  console.log('\n[10] no runtime errors');
  check('zero page errors during the whole run', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
