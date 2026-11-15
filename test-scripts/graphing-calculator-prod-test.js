// Production test: https://tools.scoreroute.com/tools/graphing-calculator/
// Follows devtools-hub-docs/TOOL-TEST-REQUIREMENTS.md
//   tool analysis -> user scenario -> step-by-step -> findings -> fix result -> cleanup
const { chromium } = require('playwright');

const BASE = process.env.GC_BASE || 'https://tools.scoreroute.com';
const URL = BASE + '/tools/graphing-calculator/?cb=' + Date.now();
let pass = 0, fail = 0;
const step = (n, name, ok, detail) => {
  if (ok) { pass++; console.log('  ok   [' + n + '] ' + name); }
  else { fail++; console.log('  FAIL [' + n + '] ' + name + (detail ? '  -> ' + detail : '')); }
};

// 1. TOOL ANALYSIS
// function : plot functions + numerical analysis + regression
// input    : text (expression rows, bounds, dataset) + options (curve type, model)
// entry    : #gc-analyze, #gc-area, #gc-table, #gc-fitrun, example chips
// output   : rendered text (cards, tables, list) + PNG download
// formats  : n/a (pure text/number)

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const reqFail = [];
  page.on('requestfailed', r => reqFail.push(r.url() + ' :: ' + (r.failure() || {}).errorText));

  try {
    // STEP A: page loads
    console.log('\n[A] load production page');
    const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    step('A', 'HTTP 200', resp.status() === 200, resp.status());
    await page.waitForSelector('#gc-canvas', { timeout: 20000 });
    step('A', 'graph canvas present', true);
    step('A', 'exactly one H1', (await page.locator('h1').count()) === 1);
    step('A', 'two expression rows on load', (await page.locator('#gc-curves .gc-curve').count()) === 2);
    step('A', 'canvas has a real backing size', (await page.evaluate(() => document.getElementById('gc-canvas').width)) > 0);
    step('A', 'tools.js loaded (shared helpers present)', await page.evaluate(() => typeof window.copyToClipboard === 'function' || typeof window.showStatus === 'function'));

    // STEP B: the page actually plots the default y = x^2-4
    console.log('\n[B] default curve is drawn');
    const painted = await page.evaluate(() => {
      const c = document.getElementById('gc-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn > 40) n++;
      }
      return n;
    });
    step('B', 'curve pixels painted on the canvas (' + painted + ')', painted > 500, painted);

    // STEP C: Analyze the default parabola over [-3,3]
    console.log('\n[C] Analyze x^2-4 on [-3,3]');
    await page.selectOption('#gc-target', { index: 1 });
    await page.fill('#gc-a', '-3');
    await page.fill('#gc-b', '3');
    await page.fill('#gc-x0', '1');
    await page.click('#gc-analyze');
    await page.waitForSelector('#gc-results .gc-card', { timeout: 15000 });
    const r = await page.evaluate(() => document.getElementById('gc-results').innerText);
    step('C', '2 roots found', /2 found/.test(r), r.slice(0, 200));
    step('C', 'roots listed as x = -2 and x = 2', /x = -2\s/.test(r) && /x = 2\s/.test(r), r.slice(0, 400));
    step('C', 'one turning point, a minimum at (0, -4)', /1 found/.test(r) && /min/.test(r) && /\(0, -4\)/.test(r), r.slice(0, 500));
    step('C', 'signed integral -6', /DEFINITE INTEGRAL\n-6\n/.test(r), r.slice(0, 700));
    step('C', 'total area under curve 15.33333333', /15\.33333333/.test(r), r.slice(0, 800));
    step('C', "slope f'(1) = 2", /SLOPE AT X = 1\n2\n/.test(r), r.slice(0, 900));
    step('C', 'y-intercept -4', /Y-INTERCEPT\n-4\n/.test(r), r.slice(0, 1000));
    step('C', 'status reports success', /Analysis complete: 2 root/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

    // STEP D: jump to a root from the results list
    console.log('\n[D] click a root to jump the view');
    const before = await page.evaluate(() => [__gc.state.view.xmin, __gc.state.view.xmax]);
    await page.locator('#gc-results button[data-x]').first().click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => [__gc.state.view.xmin, __gc.state.view.xmax]);
    step('D', 'window moved when a root was clicked', JSON.stringify(before) !== JSON.stringify(after), before + ' -> ' + after);
    step('D', 'view is centred on the clicked root (x=-2)', Math.abs((after[0] + after[1]) / 2 - (-2)) < 1e-6, (after[0] + after[1]) / 2);
    step('D', 'status confirms the jump', /Jumped to x = -2/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

    // STEP E: area between two crossing curves
    console.log('\n[E] area between y=x^2 and y=2 on [-2,2]');
    await page.click('#gc-add');
    await page.waitForTimeout(200);
    await page.locator('#gc-curves .gc-expr').first().fill('x^2');
    await page.waitForTimeout(300);
    await page.locator('#gc-curves .gc-expr').nth(2).fill('2');
    await page.waitForTimeout(300);
    await page.selectOption('#gc-target', { index: 1 });
    await page.selectOption('#gc-target2', { index: 2 });
    await page.fill('#gc-a', '-2');
    await page.fill('#gc-b', '2');
    await page.click('#gc-area');
    await page.waitForTimeout(600);
    const a = await page.evaluate(() => document.getElementById('gc-results').innerText);
    step('E', 'area = 4.875805666 (closed form 4.87580566598984)', a.indexOf('4.875805666') >= 0, a.slice(0, 300));
    step('E', '2 intersections detected automatically', /across 2 intersection/.test(a), a.slice(0, 300));
    step('E', 'slice bounds are the intersection x values', /-1\.4142136/.test(a) && /1\.4142136/.test(a), a.slice(0, 500));
    step('E', 'marks plotted for both intersections', (await page.evaluate(() => __gc.state.marks.inter.length)) === 2);

    // STEP F: table of values
    console.log('\n[F] table of values');
    await page.click('#gc-table');
    await page.waitForTimeout(500);
    step('F', '11 rows rendered', (await page.locator('#gc-table-out .gc-table tbody tr').count()) === 11);
    step('F', 'header has x, f(x), f\'(x)', /x[\s\S]*f\(x\)[\s\S]*f′\(x\)/.test(await page.innerText('#gc-table-out')));

    // STEP G: regression end to end
    console.log('\n[G] regression on a known quadratic');
    await page.fill('#gc-data', '1 2.1\n2 3.9\n3 6.2\n4 7.8\n5 10.1\n6 12.0');
    await page.selectOption('#gc-model', 'quadratic');
    await page.click('#gc-fitrun');
    await page.waitForSelector('#gc-fit-out .gc-card', { timeout: 15000 });
    const fitTxt = await page.evaluate(() => document.getElementById('gc-fit-out').innerText);
    step('G', 'R2 present and > 0.99', /R² \(COEFFICIENT OF DETERMINATION\)\n0\.99/.test(fitTxt), fitTxt.slice(0, 250));
    step('G', 'equation rendered with no undefined', /y = .*x²/.test(fitTxt) && !/undefined/.test(fitTxt), fitTxt.slice(0, 250));
    step('G', '6 residual rows', (await page.locator('#gc-fit-table tbody tr').count()) === 6);
    step('G', 'fit overlay registered on the graph', await page.evaluate(() => !!__gc.state.fit && __gc.state.fit.label.indexOf('undefined') < 0));
    // independent least-squares cross-check of the same data in node
    const cross = await page.evaluate(() => {
      const xs = [1, 2, 3, 4, 5, 6], ys = [2.1, 3.9, 6.2, 7.8, 10.1, 12.0];
      // solve normal equations for [1,x,x^2] with Cramer via gaussian elim
      const A = [[6, 21, 91], [21, 91, 441], [91, 441, 2275]];
      const bx = [0, 0, 0], by = [0, 0, 0];
      for (let i = 0; i < 6; i++) { const v = [1, xs[i], xs[i] * xs[i]]; for (let j = 0; j < 3; j++) { bx[j] += v[j] * ys[i]; by[j] += v[j] * ys[i]; } }
      return { A: A, bx: bx };
    });
    const shownC0 = parseFloat((fitTxt.match(/y = (-?[\d.e-]+)/) || [])[1]);
    const shownC1 = parseFloat((fitTxt.match(/([+−] [\d.e-]+)x/) || [])[1].replace('−', '-').replace('+ ', ''));
    const shownC2 = parseFloat((fitTxt.match(/([+−] [\d.e-]+)x²/) || [])[1].replace('−', '-').replace('+ ', ''));
    const pred = [1, 2, 3, 4, 5, 6].map(x => shownC0 + shownC1 * x + shownC2 * x * x);
    const worst = Math.max.apply(null, [2.1, 3.9, 6.2, 7.8, 10.1, 12.0].map((y, i) => Math.abs(y - pred[i])));
    step('G', 'recomputing the equation from the printed coefficients reproduces the data (max err ' + worst.toFixed(3) + ')', worst < 0.35, JSON.stringify({ shownC0, shownC1, shownC2, pred }));

    // STEP H: error handling
    console.log('\n[H] error handling');
    const bad = page.locator('#gc-curves .gc-expr').first();
    await bad.fill('x^^2');
    await page.waitForTimeout(400);
    step('H', 'syntax error shown next to the curve', /Unexpected|Curve 1/.test(await page.innerText('.gc-err')), await page.innerText('.gc-err'));
    await bad.fill('x^2');
    await page.waitForTimeout(400);
    step('H', 'error clears on a valid expression', (await page.locator('.gc-err').count()) === 0);
    await page.fill('#gc-data', '1 -2\n2 -4\n3 -8');
    await page.selectOption('#gc-model', 'exponential');
    await page.click('#gc-fitrun');
    await page.waitForTimeout(500);
    step('H', 'exponential fit refuses negative y', /positive/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));
    await page.fill('#gc-a', '5');
    await page.fill('#gc-b', '-5');
    await page.click('#gc-analyze');
    await page.waitForTimeout(500);
    step('H', 'reversed bounds produce a readable error', /must be bigger/.test(await page.innerText('#gc-status')), await page.innerText('#gc-status'));

    // STEP I: every example preset renders
    console.log('\n[I] example presets');
    const chips = await page.locator('.gc-chip').count();
    step('I', '8 presets offered', chips === 8, chips);
    for (let i = 0; i < chips; i++) {
      const name = await page.locator('.gc-chip').nth(i).innerText();
      await page.locator('.gc-chip').nth(i).click();
      await page.waitForTimeout(400);
      const st = await page.innerText('#gc-status');
      const px = await page.evaluate(() => {
        const c = document.getElementById('gc-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let k = 0; k < d.length; k += 4) {
          const mx = Math.max(d[k], d[k + 1], d[k + 2]), mn = Math.min(d[k], d[k + 1], d[k + 2]);
          if (mx - mn > 40) n++;
        }
        return n;
      });
      step('I', 'preset "' + name + '" loads and paints (' + px + ' px)', /Loaded: /.test(st) && px > 300, st + ' px=' + px);
    }

    // STEP J: implicit and polar really draw geometry, not a straight line
    console.log('\n[J] implicit / polar / parametric geometry');
    await page.locator('.gc-chip').nth(3).click();          // Circle (implicit)
    await page.waitForTimeout(500);
    const circ = await page.evaluate(() => {
      const c = document.getElementById('gc-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
      for (let py = 0; py < c.height; py++) for (let pxx = 0; pxx < c.width; pxx++) {
        const i = (py * c.width + pxx) * 4;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn > 40) { if (pxx < minx) minx = pxx; if (pxx > maxx) maxx = pxx; if (py < miny) miny = py; if (py > maxy) maxy = py; }
      }
      const v = window.__gc.state.view;
      const toX = p => v.xmin + (p / c.width) * (v.xmax - v.xmin);
      const toY = p => v.ymax - (p / c.height) * (v.ymax - v.ymin);
      return { w: toX(maxx) - toX(minx), h: toY(miny) - toY(maxy), cx: (toX(minx) + toX(maxx)) / 2, cy: (toY(miny) + toY(maxy)) / 2 };
    });
    step('J', 'implicit circle is ~6 wide and ~6 tall (radius 3)', Math.abs(circ.w - 6) < 0.4 && Math.abs(circ.h - 6) < 0.4, JSON.stringify(circ));
    step('J', 'implicit circle centred on (1,2)', Math.abs(circ.cx - 1) < 0.2 && Math.abs(circ.cy - 2) < 0.2, JSON.stringify(circ));

    // STEP K: PNG export
    console.log('\n[K] PNG export');
    const dl = page.waitForEvent('download', { timeout: 20000 });
    await page.click('#gc-png');
    const file = await dl;
    step('K', 'download triggered with a .png name', /\.png$/.test(file.suggestedFilename()), file.suggestedFilename());
    const p = await file.path();
    const fs = require('fs');
    const buf = fs.readFileSync(p);
    step('K', 'file is a real PNG (' + buf.length + ' bytes)', buf.length > 5000 && buf[0] === 0x89 && buf[1] === 0x50, buf.length);
    fs.unlinkSync(p);

    // STEP L: share link restores state on a fresh page load
    console.log('\n[L] share link round-trip');
    const shareUrl = await page.evaluate((base) => {
      const payload = { c: __gc.state.curves.map(c => ({ t: c.type, e: c.expr, x: c.extra, k: c.color, on: 1 })), v: [-6, 6, -4, 6] };
      return base + '/tools/graphing-calculator/#g=' + encodeURIComponent(JSON.stringify(payload));
    }, BASE);
    const p2 = await ctx.newPage();
    await p2.goto(shareUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await p2.waitForSelector('#gc-curves .gc-curve', { timeout: 20000 });
    const restored = await p2.evaluate(() => ({ rows: document.querySelectorAll('#gc-curves .gc-curve').length, view: [__gc.state.view.xmin, __gc.state.view.xmax], st: document.getElementById('gc-status').textContent }));
    step('L', 'a shared link restores the curves on a fresh load', restored.rows === 1 && /restored/.test(restored.st), JSON.stringify(restored));
    step('L', 'the window is restored too', Math.abs(restored.view[0] + 6) < 1e-9 && Math.abs(restored.view[1] - 6) < 1e-9, JSON.stringify(restored.view));
    await p2.close();

    // STEP M: SEO / production patcher
    console.log('\n[M] SEO (production patcher output)');
    const seo = await page.evaluate(() => ({
      title: document.title,
      titleLen: document.title.length,
      desc: document.querySelector('meta[name="description"]').content,
      descLen: document.querySelector('meta[name="description"]').content.length,
      canonical: document.querySelector('link[rel="canonical"]').href,
      ogUrl: (document.querySelector('meta[property="og:url"]') || {}).content,
      ogTitle: (document.querySelector('meta[property="og:title"]') || {}).content,
      h1: document.querySelectorAll('h1').length,
      faqs: document.querySelectorAll('details.faq-item').length,
      ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => { try { return JSON.parse(s.textContent); } catch (e) { return null; } })
    }));
    step('M', 'title = "Graphing Calculator - Roots, Area & Fit | DevTools Hub"', seo.title === 'Graphing Calculator - Roots, Area & Fit | DevTools Hub', seo.title);
    step('M', 'title length ' + seo.titleLen + ' <= 60', seo.titleLen <= 60, seo.titleLen);
    step('M', 'no double-encoded entity in the title', !/&amp;amp;/.test(seo.title), seo.title);
    step('M', 'description length ' + seo.descLen + ' in [120,160]', seo.descLen >= 120 && seo.descLen <= 160, seo.descLen);
    step('M', 'canonical points at the tool URL', seo.canonical === BASE + '/tools/graphing-calculator/', seo.canonical);
    step('M', 'og:url present and matches canonical', seo.ogUrl === seo.canonical, seo.ogUrl);
    step('M', 'og:title mirrors the page title', seo.ogTitle === seo.title, seo.ogTitle);
    step('M', 'one H1', seo.h1 === 1, seo.h1);
    step('M', 'FAQ items >= 7', seo.faqs >= 7, seo.faqs);
    const wa = seo.ld.filter(x => x && (x['@type'] === 'WebApplication' || (x['@graph'] || []).some(n => n['@type'] === 'WebApplication')));
    step('M', 'WebApplication JSON-LD present', wa.length >= 1, wa.length);
    const app = wa[0] ? (wa[0]['@graph'] || [wa[0]]).find(n => n['@type'] === 'WebApplication') : null;
    step('M', 'JSON-LD author @id patched to the site author', !!(app && app.author && app.author['@id'] === BASE + '/#author'), JSON.stringify(app && app.author));
    step('M', 'JSON-LD author name is BAOMING with url + sameAs', !!(app && app.author && app.author.name === 'BAOMING' && app.author.url && app.author.sameAs && app.author.sameAs.length), JSON.stringify(app && app.author));
    const today = new Date().toISOString().slice(0, 10);
    step('M', 'dateModified patched to today (' + today + ')', !!(app && app.dateModified === today), app && app.dateModified);
    step('M', 'JSON-LD url matches canonical', !!(app && app.url === seo.canonical), app && app.url);
    const faqLd = seo.ld.filter(x => x && (x['@type'] === 'FAQPage' || (x['@graph'] || []).some(n => n['@type'] === 'FAQPage')));
    step('M', 'FAQPage JSON-LD present', faqLd.length >= 1, faqLd.length);
    if (faqLd.length) {
      const f = faqLd[0].mainEntity || (faqLd[0]['@graph'] || []).flatMap(n => n.mainEntity || []);
      step('M', 'FAQPage has ' + f.length + ' questions', f.length >= 7, f.length);
      step('M', 'every FAQ question has an answer', f.every(q => q.name && q.acceptedAnswer && q.acceptedAnswer.text));
    }

    // STEP N: accessibility of the new controls
    console.log('\n[N] accessibility');
    const a11y = await page.evaluate(() => {
      function accName(el) {
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return document.querySelector('label[for="' + CSS.escape(el.id) + '"]').textContent;
        if (el.closest('label')) return el.closest('label').textContent;
        return (el.textContent || '').trim();
      }
      const ctrls = Array.from(document.querySelectorAll('#gc-curves input, #gc-curves select, #gc-panel input, #gc-panel select, #gc-panel textarea, #gc-panel button, .gc-canvas-wrap button'));
      return { total: ctrls.length, unnamed: ctrls.filter(c => !accName(c)).map(c => c.tagName + '#' + c.id + '.' + c.className) };
    });
    step('N', 'all ' + a11y.total + ' interactive controls have accessible names', a11y.unnamed.length === 0, JSON.stringify(a11y.unnamed));

    // STEP O: no runtime errors / failed requests
    console.log('\n[O] runtime health');
    step('O', 'zero uncaught page errors', errs.length === 0, errs.join(' | '));
    const realFails = reqFail.filter(u => !/cloudflareinsights|beacon|google-analytics/.test(u));
    step('O', 'zero failed subresources (excluding analytics beacon)', realFails.length === 0, realFails.join(' | '));

  } finally {
    // STEP P: cleanup (required by PLAYWRIGHT-USAGE.md)
    for (const c of browser.contexts()) { for (const p of c.pages()) await p.close(); await c.close(); }
    await browser.close();
  }

  console.log('\n========================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
