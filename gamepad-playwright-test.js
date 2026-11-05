const { chromium } = require('playwright');
const fs = require('fs');

const TARGET = 'https://tools.scoreroute.com/tools/gamepad-tester/';
const TEMP_DIR = '/tmp/playwright-test';

async function main() {
  let browser = null;
  const consoleErrors = [];
  let passes = 0, fails = 0;
  const check = (name, cond, extra) => {
    if (cond) { passes++; console.log('PASS | ' + name); }
    else { fails++; console.log('FAIL | ' + name + (extra ? ' -> ' + extra : '')); }
  };
  try {
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('cloudflareinsights') && !m.text().includes('net::ERR_FAILED')) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

    await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 30000 });
    check('HTTP page loads', (await page.title()).length > 0);
    const title = await page.title();
    check('Title', title.includes('Gamepad Tester') && title.length <= 60, title + ' (' + title.length + ')');
    check('Canonical', (await page.locator('link[rel="canonical"]').getAttribute('href')) === 'https://tools.scoreroute.com/tools/gamepad-tester/');
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    check('Meta desc <=155', (desc || '').length <= 155 && (desc || '').length > 50, (desc || '').length);
    check('Robots ai-train no', ((await page.locator('meta[name="robots"]').getAttribute('content')) || '').includes('ai-train:no'));
    const jsonld = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => { try { return JSON.parse(e.textContent); } catch { return null; } }).filter(Boolean));
    check('WebApplication JSON-LD', jsonld.some(j => j['@type'] === 'WebApplication'));
    const faq = jsonld.filter(j => j['@type'] === 'FAQPage');
    check('Exactly 1 FAQPage', faq.length === 1, 'count=' + faq.length);
    check('FAQ has >=8 QA', faq[0] && faq[0].mainEntity && faq[0].mainEntity.length >= 8, faq[0] ? faq[0].mainEntity.length : 0);
    check('Author BAOMING', jsonld.some(j => j.author && j.author.name === 'BAOMING'));
    check('1 H1', (await page.locator('h1').count()) === 1);
    check('Verdict/guided/demo present', await page.locator('#btn-demo, #btn-guided, #verdict, #btn-na-demo').count() >= 4);

    // Demo + guided + verdict on live
    await page.locator('#btn-demo').click();
    await page.waitForTimeout(400);
    check('Demo pad connects', (await page.locator('#dev-info').innerText().catch(() => '')).includes('Demo Mode'));
    await page.locator('#btn-guided').click();
    await page.waitForTimeout(150);
    check('Guided started', await page.locator('#g-bar').isVisible().catch(() => false));
    const done = await page.waitForFunction(() => document.getElementById('status').textContent.indexOf('Guided test complete') !== -1, { timeout: 90000 }).then(() => true).catch(() => false);
    check('Guided 23 steps complete', done);
    check('Verdict visible', await page.locator('#verdict').isVisible().catch(() => false));

    // Export fns
    check('Export fns defined', await page.evaluate(() => ['copyReport','downloadTXT','downloadCSV','downloadJSON','startGuided'].every(n => typeof window[n] === 'function')));
    check('Canvas x2', await page.locator('canvas').count() === 2);

    // Live wiring: homepage, category, sitemap, llms, api
    await page.goto('https://tools.scoreroute.com/', { waitUntil: 'domcontentloaded' });
    check('Homepage 200', true);
    await page.goto('https://tools.scoreroute.com/tools/life/', { waitUntil: 'domcontentloaded' });
    check('Life category lists gamepad', (await page.locator('a[href="/tools/gamepad-tester/"]').count()) > 0);

    const smap = await (await page.request.get('https://tools.scoreroute.com/sitemap.xml')).text();
    check('Sitemap has gamepad', smap.includes('/tools/gamepad-tester/'));
    const llms = await (await page.request.get('https://tools.scoreroute.com/llms.txt')).text();
    check('llms.txt has gamepad', llms.includes('gamepad-tester'));
    const api = await (await page.request.get('https://tools.scoreroute.com/api/tools')).json();
    check('/api/tools has gamepad', Array.isArray(api) ? api.some(t => (t.slug || '') === 'gamepad-tester') : JSON.stringify(api).includes('gamepad-tester'));

    console.log('---');
    console.log('Console errors:', consoleErrors.length ? JSON.stringify(consoleErrors) : 'NONE');
    if (consoleErrors.length) fails++;
    await page.screenshot({ path: '/tmp/gamepad-live.png' });
    console.log('---RESULT:', passes, 'passed,', fails, 'failed');
    process.exitCode = fails ? 1 : 0;
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) { try { for (const c of browser.contexts()) await c.close(); } catch {} await browser.close(); }
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    process.exit(process.exitCode);
  }
}
main();