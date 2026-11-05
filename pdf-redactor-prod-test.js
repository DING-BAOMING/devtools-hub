// Production Playwright test for /tools/pdf-redactor/
const { chromium } = require('playwright');
const fs = require('fs');

const SITE_URL = 'https://tools.scoreroute.com/tools/pdf-redactor/';
const TOOL_SLUG = 'pdf-redactor';
const TEMP_DIR = '/tmp/pdf-redactor-prod-test';

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

    try {
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
        fs.mkdirSync(TEMP_DIR, { recursive: true });

        browser = await chromium.launch({
            headless: true,
            executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            acceptDownloads: true
        });
        const page = await context.newPage();
        const consoleErrors = [];
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
        page.on('console', msg => {
            if (msg.type() === 'error') {
                const t = msg.text();
                if (t.includes('cloudflareinsights')) return;
                if (t.includes('Failed to load resource') && t.includes('ERR_FAILED')) return;
                if (t.includes('net::ERR_')) return;
                consoleErrors.push('console.error: ' + t);
            }
        });

        // [A] Page loads
        console.log('\n=== [A] Page loads on production ===');
        try {
            await page.goto(SITE_URL + '?cb=' + Math.random(), { waitUntil: 'networkidle', timeout: 30000 });
            const title = await page.title();
            const desc = await page.locator('meta[name="description"]').getAttribute('content');
            const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
            const robots = await page.locator('meta[name="robots"]').getAttribute('content');
            const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
            if (!title.includes('PDF Redactor')) throw new Error('Wrong title: ' + title);
            if (title.length > 60) throw new Error('Title too long: ' + title.length);
            if (!desc || desc.length > 155 || desc.length < 30) throw new Error('Bad desc len: ' + (desc||'').length);
            if (!canonical || !canonical.includes('/tools/pdf-redactor/')) throw new Error('Bad canonical');
            if (!robots || !robots.includes('ai-train:no')) throw new Error('Missing ai-train:no');
            const ldCount = await page.locator('script[type="application/ld+json"]').count();
            if (ldCount < 2) throw new Error('Missing JSON-LD count=' + ldCount);
            console.log('  title=' + title.length + ' desc=' + desc.length + ' ld=' + ldCount + ' robots=' + (robots||'').slice(0, 30));
            console.log('[A] PASS'); results.passed.push('A: Production page loads with SEO');
        } catch (e) { console.log('[A] FAIL: ' + e.message); results.failed.push('A: ' + e.message); }

        // [B] Upload + redaction end-to-end
        console.log('\n=== [B] Full redaction workflow ===');
        try {
            await page.locator('#fileInput').setInputFiles('/tmp/test-pdf-redactor.pdf');
            await page.waitForFunction(() => {
                const el = document.getElementById('pageCount');
                return el && el.textContent && parseInt(el.textContent) > 0;
            }, { timeout: 30000 });
            const pages = await page.locator('#pageCount').textContent();
            // Search + apply
            await page.locator('#searchInput').fill('John Smith');
            await page.locator('#findInstancesBtn').click();
            await page.waitForTimeout(3000);
            const ic = await page.locator('#instanceCount').textContent();
            await page.locator('#overlayInput').fill('REDACTED');
            const [dl] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                page.locator('#applyBtn').click()
            ]);
            const dlPath = TEMP_DIR + '/prod-redacted.pdf';
            await dl.saveAs(dlPath);
            const sz = fs.statSync(dlPath).size;
            const head = fs.readFileSync(dlPath).slice(0, 8).toString();
            if (!head.startsWith('%PDF')) throw new Error('Not a PDF');
            console.log('  pages=' + pages + ' matches=' + ic + ' size=' + sz + 'B');
            console.log('[B] PASS'); results.passed.push('B: Full workflow');
        } catch (e) { console.log('[B] FAIL: ' + e.message); results.failed.push('B: ' + e.message); }

        // [C] Permanent mode - text truly destroyed
        console.log('\n=== [C] Permanent mode destroys text ===');
        try {
            await page.locator('#resetBtn').click();
            await page.waitForTimeout(300);
            await page.locator('#fileInput').setInputFiles('/tmp/test-pdf-redactor.pdf');
            await page.waitForFunction(() => {
                const el = document.getElementById('pageCount');
                return el && el.textContent && parseInt(el.textContent) > 0;
            }, { timeout: 30000 });
            await page.locator('button.pr-tab[data-mode="patterns"]').click();
            await page.waitForTimeout(200);
            await page.locator('.pr-pattern-chip[data-pattern="email"]').click();
            await page.waitForTimeout(2000);
            // switch to permanent
            await page.locator('#modePermanentBtn').click();
            await page.waitForTimeout(200);
            const [dl] = await Promise.all([
                page.waitForEvent('download', { timeout: 60000 }),
                page.locator('#applyBtn').click()
            ]);
            const dlPath = TEMP_DIR + '/prod-permanent.pdf';
            await dl.saveAs(dlPath);
            const sz = fs.statSync(dlPath).size;
            console.log('  size=' + sz + 'B');
            console.log('[C] PASS'); results.passed.push('C: Permanent mode');
        } catch (e) { console.log('[C] FAIL: ' + e.message); results.failed.push('C: ' + e.message); }

        // [D] Verify permanent destroys text via pypdf
        console.log('\n=== [D] Permanent PDF text truly destroyed ===');
        try {
            const { execSync } = require('child_process');
            const py = "from pypdf import PdfReader; r = PdfReader('" + TEMP_DIR + "/prod-permanent.pdf'); print(sum(len(p.extract_text() or '') for p in r.pages))";
            const txtLen = parseInt(execSync('python3 -c "' + py.replace(/"/g, '\\"') + '"', { encoding: 'utf-8', timeout: 30000 }).trim());
            if (txtLen > 5) throw new Error('Text still extractable: ' + txtLen + ' chars');
            console.log('  text len=' + txtLen + ' (expected ~0)');
            console.log('[D] PASS'); results.passed.push('D: Permanent text destroyed');
        } catch (e) { console.log('[D] FAIL: ' + e.message); results.failed.push('D: ' + e.message); }

        // [E] Site integration: sitemap, llms, api, category
        console.log('\n=== [E] Site integration ===');
        try {
            const cb = Math.random();
            const sitemap = await fetch('https://tools.scoreroute.com/sitemap.xml?cb=' + cb).then(r => r.text());
            const sitemapCount = (sitemap.match(/<loc>/g) || []).length;
            if (!sitemap.includes('pdf-redactor')) throw new Error('Not in sitemap');
            const llms = await fetch('https://tools.scoreroute.com/llms.txt?cb=' + cb).then(r => r.text());
            if (!llms.toLowerCase().includes('pdf-redactor')) throw new Error('Not in llms.txt');
            const api = await fetch('https://tools.scoreroute.com/api/tools?cb=' + cb).then(r => r.json());
            const found = api.tools.find(t => t.slug === 'pdf-redactor');
            if (!found) throw new Error('Not in /api/tools');
            if (found.category !== 'pdf-tools') throw new Error('Wrong category: ' + found.category);
            const cat = await fetch('https://tools.scoreroute.com/tools/pdf-tools/?cb=' + cb).then(r => r.text());
            if (!cat.includes('pdf-redactor')) throw new Error('Not in category page');
            const home = await fetch('https://tools.scoreroute.com/?cb=' + cb).then(r => r.text());
            const footerCount = (home.match(/(\d+) tools/i) || ['', ''])[1];
            console.log('  sitemap=' + sitemapCount + ' footer=' + footerCount);
            console.log('[E] PASS'); results.passed.push('E: Site integration');
        } catch (e) { console.log('[E] FAIL: ' + e.message); results.failed.push('E: ' + e.message); }

        // [F] No JS errors
        console.log('\n=== [F] No JS errors ===');
        try {
            if (consoleErrors.length > 0) {
                console.log('  errors:', consoleErrors.slice(0, 5));
                throw new Error(consoleErrors.length + ' console errors');
            }
            console.log('[F] PASS'); results.passed.push('F: No JS errors');
        } catch (e) { console.log('[F] FAIL: ' + e.message); results.failed.push('F: ' + e.message); }

        // Report
        console.log('\n=== PROD SUMMARY ===');
        console.log('Passed:', results.passed.length);
        results.passed.forEach(p => console.log('  ✓', p));
        console.log('Failed:', results.failed.length);
        results.failed.forEach(f => console.log('  ✗', f));

        if (results.failed.length === 0) {
            console.log('\n✅ ALL PROD TESTS PASS');
            process.exit(0);
        } else {
            console.log('\n❌ SOME PROD TESTS FAILED');
            process.exit(1);
        }

    } catch (e) {
        console.error('Fatal:', e);
        process.exit(2);
    } finally {
        await cleanup(browser);
    }
}

main();