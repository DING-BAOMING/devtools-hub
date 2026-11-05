const { chromium } = require('playwright');
const fs = require('fs');
const SITE_URL = 'https://tools.scoreroute.com';
const TOOL_SLUG = "aspect-ratio-calculator";
const TEMP_DIR = '/tmp/playwright-test';

async function cleanup(browser) {
    if (browser) {
        for (const ctx of browser.contexts()) { for (const p of ctx.pages()) await p.close(); await ctx.close(); }
        await browser.close();
    }
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

async function main() {
    let browser;
    const results = { passed: [], failed: [] };
    let allPassed = true;

    try {
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
        fs.mkdirSync(TEMP_DIR, { recursive: true });

        browser = await chromium.launch({ headless: true, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-fake-ui-for-media-stream'] });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        const page = await context.newPage();

        // [A] Homepage loads
        console.log('\n=== [A] Homepage loads correctly ===');
        try {
            await page.goto(SITE_URL, { waitUntil: 'networkidle', timeout: 20000 });
            const title = await page.title();
            if (title.includes('DevTools Hub')) { console.log('[A] PASS'); results.passed.push('A: Homepage loads'); }
            else { throw new Error('Wrong title: ' + title); }
        } catch (e) { console.log('[A] FAIL: ' + e.message); results.failed.push('A: ' + e.message); allPassed = false; }

        // [B] Tool page loads directly
        console.log('\n=== [B] Tool page loads ===');
        try {
            await page.goto(SITE_URL + '/tools/' + TOOL_SLUG + '/', { waitUntil: 'networkidle', timeout: 20000 });
            const t = await page.title();
            if (t.includes('Aspect Ratio Calculator')) { console.log('[B] PASS'); results.passed.push('B: Tool page loads'); }
            else { throw new Error('Wrong title: ' + t); }
        } catch (e) { console.log('[B] FAIL: ' + e.message); results.failed.push('B: ' + e.message); allPassed = false; }

        // [C] UI elements exist
        console.log('\n=== [C] UI elements exist ===');
        try {
            await page.locator('#arc-width').waitFor({ state: 'visible', timeout: 5000 });
            if (!(await page.locator('#arc-width').isVisible())) throw new Error('#arc-width not visible');
            if (!(await page.locator('#arc-height').isVisible())) throw new Error('#arc-height not visible');
            if (!(await page.locator('#tab-dims').isVisible())) throw new Error('tab-dims not visible');
            if (!(await page.locator('#tab-ratio').isVisible())) throw new Error('tab-ratio not visible');
            if (!(await page.locator('button').filter({ hasText: 'Clear' }).first().isVisible())) throw new Error('Clear btn not visible');
            if (!(await page.locator('button').filter({ hasText: 'Calculate Ratio' }).first().isVisible())) throw new Error('Calculate Ratio btn not visible');
            console.log('[C] PASS'); results.passed.push('C: UI elements present');
        } catch (e) { console.log('[C] FAIL: ' + e.message); results.failed.push('C: ' + e.message); allPassed = false; }

        // [D] Calculate ratio from dimensions
        console.log('\n=== [D] Calculate ratio from dimensions ===');
        try {
            // Dimensions → Ratio is default, just fill values
            await page.locator('#arc-width').fill('1920');
            await page.locator('#arc-height').fill('1080');
            await page.waitForTimeout(300);
            await page.locator('#arc-result').waitFor({ state: 'visible', timeout: 5000 });
            var resultText = await page.locator('#arc-result').innerText();
            if (resultText.includes('16:9')) { console.log('[D] PASS'); results.passed.push('D: Ratio calc works'); }
            else { throw new Error('Expected 16:9, got: ' + resultText.substring(0, 50)); }
        } catch (e) { console.log('[D] FAIL: ' + e.message); results.failed.push('D: ' + e.message); allPassed = false; }

        // [E] Calculate dimensions from ratio
        console.log('\n=== [E] Calculate dimensions from ratio ===');
        try {
            await page.locator('#tab-ratio').click();
            await page.waitForTimeout(200);
            await page.locator('#arc-ratio-w').fill('16');
            await page.locator('#arc-ratio-h').fill('9');
            await page.locator('#arc-base-val').fill('1920');
            await page.locator('#arc-base-type').selectOption('width');
            await page.waitForTimeout(300);
            await page.locator('#arc-result').waitFor({ state: 'visible', timeout: 5000 });
            var resultText = await page.locator('#arc-result').innerText();
            if (resultText.includes('1080')) { console.log('[E] PASS'); results.passed.push('E: Dimension calc works'); }
            else { throw new Error('Expected height 1080, got: ' + resultText.substring(0, 50)); }
        } catch (e) { console.log('[E] FAIL: ' + e.message); results.failed.push('E: ' + e.message); allPassed = false; }

        // [F] Preset button works
        console.log('\n=== [F] Preset button works ===');
        try {
            var presetBtn = page.locator('button.arc-preset-btn').first();
            await presetBtn.evaluate(function(el) { el.click(); });
            await page.waitForTimeout(400);
            await page.locator('#arc-result').waitFor({ state: 'visible', timeout: 5000 });
            var resultText = await page.locator('#arc-result').innerText();
            if (resultText.includes('px')) { console.log('[F] PASS'); results.passed.push('F: Preset works'); }
            else { throw new Error('No px in result'); }
        } catch (e) { console.log('[F] FAIL: ' + e.message); results.failed.push('F: ' + e.message); allPassed = false; }

        // [G] Clear button resets
        console.log('\n=== [G] Clear button resets ===');
        try {
            await page.evaluate(function() { clearAll(); });
            await page.waitForTimeout(200);
            var styleAttr = await page.locator('#arc-result').getAttribute('style');
            if (styleAttr && styleAttr.includes('none')) { console.log('[G] PASS'); results.passed.push('G: Clear works'); }
            else { throw new Error('Result still visible'); }
        } catch (e) { console.log('[G] FAIL: ' + e.message); results.failed.push('G: ' + e.message); allPassed = false; }

        // [H] SEO meta tags
        console.log('\n=== [H] SEO meta tags ===');
        try {
            await page.goto(SITE_URL + '/tools/' + TOOL_SLUG + '/', { waitUntil: 'networkidle', timeout: 20000 });
            var desc = await page.locator('meta[name="description"]').getAttribute('content');
            var canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
            var title = await page.title();
            if (desc && desc.length > 10 && canonical && canonical.includes(TOOL_SLUG) && title && title.length > 5) {
                console.log('[H] PASS'); results.passed.push('H: SEO tags');
            } else { throw new Error('Missing SEO tags'); }
        } catch (e) { console.log('[H] FAIL: ' + e.message); results.failed.push('H: ' + e.message); allPassed = false; }

        // [I] FAQ section exists
        console.log('\n=== [I] FAQ section exists ===');
        try {
            var faqItems = await page.locator('details.faq-item').all();
            if (faqItems.length >= 5) { console.log('[I] PASS (' + faqItems.length + ' FAQs)'); results.passed.push('I: FAQs'); }
            else { throw new Error('Only ' + faqItems.length + ' FAQs'); }
        } catch (e) { console.log('[I] FAIL: ' + e.message); results.failed.push('I: ' + e.message); allPassed = false; }

        // [J] JSON-LD schema
        console.log('\n=== [J] JSON-LD schema ===');
        try {
            var jsonld = page.locator('script[type="application/ld+json"]');
            var content = await jsonld.first().innerHTML();
            if (content.includes('WebApplication')) { console.log('[J] PASS'); results.passed.push('J: JSON-LD'); }
            else { throw new Error('Schema missing WebApplication'); }
        } catch (e) { console.log('[J] FAIL: ' + e.message); results.failed.push('J: ' + e.message); allPassed = false; }

        // [K] Social media reference table
        console.log('\n=== [K] Social media reference table ===');
        try {
            var table = page.locator('table.arc-ref-table').first();
            await table.waitFor({ state: 'visible', timeout: 5000 });
            var rows = await table.locator('tbody tr').count();
            if (rows >= 8) { console.log('[K] PASS (' + rows + ' rows)'); results.passed.push('K: Reference table'); }
            else { throw new Error('Only ' + rows + ' rows'); }
        } catch (e) { console.log('[K] FAIL: ' + e.message); results.failed.push('K: ' + e.message); allPassed = false; }

        // [L] Visual preview updates
        console.log('\n=== [L] Visual preview updates ===');
        try {
            await page.locator('#tab-dims').click();
            await page.waitForTimeout(200);
            await page.locator('#arc-width').fill('400');
            await page.locator('#arc-height').fill('300');
            await page.waitForTimeout(300);
            var rect = page.locator('#arc-visual-rect');
            var rectStyle = await rect.getAttribute('style');
            if (rectStyle && rectStyle.includes('width')) { console.log('[L] PASS'); results.passed.push('L: Visual preview'); }
            else { throw new Error('Rect style missing'); }
        } catch (e) { console.log('[L] FAIL: ' + e.message); results.failed.push('L: ' + e.message); allPassed = false; }

        // [M] CSS output updates
        console.log('\n=== [M] CSS output updates ===');
        try {
            var cssOutput = await page.locator('#arc-css-output').innerText();
            if (cssOutput && cssOutput.includes('aspect-ratio')) { console.log('[M] PASS'); results.passed.push('M: CSS output'); }
            else { throw new Error('No CSS output: ' + cssOutput); }
        } catch (e) { console.log('[M] FAIL: ' + e.message); results.failed.push('M: ' + e.message); allPassed = false; }

        // [N] Tool card exists on homepage (check DOM, not visibility)
        console.log('\n=== [N] Tool card on homepage ===');
        try {
            await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
            var card = page.locator('a[href="/tools/' + TOOL_SLUG + '/"]');
            await card.waitFor({ state: 'attached', timeout: 10000 });
            var cardHref = await card.getAttribute('href');
            var cardHtml = await card.innerHTML();
            if (cardHref && cardHref.includes(TOOL_SLUG)) { console.log('[N] PASS'); results.passed.push('N: Card on homepage'); }
            else { throw new Error('Card not found'); }
        } catch (e) { console.log('[N] FAIL: ' + e.message); results.failed.push('N: ' + e.message); allPassed = false; }

        // [O] Copy buttons exist
        console.log('\n=== [O] Copy buttons exist ===');
        try {
            await page.goto(SITE_URL + '/tools/' + TOOL_SLUG + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            var copyResultBtn = page.locator('#arc-copy-btn');
            var copyCssBtn = page.locator('#arc-copy-css');
            await copyResultBtn.waitFor({ state: 'visible', timeout: 5000 });
            if (await copyResultBtn.isVisible() || await copyCssBtn.isVisible()) {
                console.log('[O] PASS'); results.passed.push('O: Copy buttons');
            } else { throw new Error('Copy buttons not visible'); }
        } catch (e) { console.log('[O] FAIL: ' + e.message); results.failed.push('O: ' + e.message); allPassed = false; }

    } catch (e) {
        console.error('Fatal:', e);
        allPassed = false;
    } finally {
        await cleanup(browser);
    }

    console.log('\n' + '='.repeat(60));
    console.log('RESULTS: ' + results.passed.length + ' passed, ' + results.failed.length + ' failed');
    if (results.failed.length > 0) results.failed.forEach(function(r) { console.log('  FAIL: ' + r); });
    console.log('Overall: ' + (allPassed ? 'ALL PASSED' : 'SOME FAILED'));
    console.log('='.repeat(60));
    process.exit(allPassed ? 0 : 1);
}
main();
