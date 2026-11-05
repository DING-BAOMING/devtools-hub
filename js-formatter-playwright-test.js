const { chromium } = require('playwright');
const fs = require('fs');

const TEMP_DIR = '/tmp/js-formatter-test';
const TARGET_URL = 'http://localhost:8790/tools/js-formatter/';

async function main() {
  let browser;

  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true });
    }
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for page to fully load and sample code to load
    await page.waitForSelector('#input-js', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Step A: Clear and type messy JavaScript
    const messyJS = 'function add(a,b){return a+b}const x=10;const y=20;console.log(add(x,y));if(x>5){for(let i=0;i<3;i++){console.log(i);}}';
    await page.fill('#input-js', '');
    await page.fill('#input-js', messyJS);
    await page.waitForTimeout(500);

    // Step B: Click Beautify JS
    await page.click('text=Beautify JS');
    await page.waitForTimeout(1000);

    // Step C: Check output
    const output = await page.locator('#output-js').inputValue();
    if (!output || output.length === 0) {
      throw new Error('Beautify output is empty');
    }
    if (!output.includes('function add') || !output.includes('return a + b')) {
      throw new Error('Beautify output does not contain expected formatted code');
    }
    console.log('Step A-C (Beautify): PASS');

    // Step D: Test Minify
    await page.fill('#input-js', '/* comment */\nfunction greet(name) {\n  return "Hello, " + name + "!";\n}\n\ngreet("World");');
    await page.click('text=Minify JS');
    await page.waitForTimeout(500);
    const minified = await page.locator('#output-js').inputValue();
    if (!minified || minified.length === 0) {
      throw new Error('Minify output is empty');
    }
    if (minified.includes('/* comment */')) {
      throw new Error('Minify did not remove comments');
    }
    console.log('Step D (Minify): PASS');

    // Step E: Test Validate
    await page.fill('#input-js', 'var x = 1;');
    await page.click('text=Validate Syntax');
    await page.waitForTimeout(500);
    const statusText = await page.locator('#status').innerText();
    if (!statusText.includes('valid')) {
      throw new Error('Validate did not report valid syntax: ' + statusText);
    }
    console.log('Step E (Validate): PASS');

    // Step F: Test Validate with bad syntax
    await page.fill('#input-js', 'var x = ;;;');
    await page.click('text=Validate Syntax');
    await page.waitForTimeout(500);
    const errorStatus = await page.locator('#status').innerText();
    if (!errorStatus.includes('error')) {
      throw new Error('Validate should have reported error for bad syntax');
    }
    console.log('Step F (Validate Bad Syntax): PASS');

    // Step G: Test Remove Comments
    await page.fill('#input-js', '// line comment\n/* block comment */\nvar a = 1;');
    await page.click('text=Remove Comments');
    await page.waitForTimeout(500);
    const noComments = await page.locator('#output-js').inputValue();
    if (noComments.includes('comment')) {
      throw new Error('Remove Comments did not strip comments');
    }
    console.log('Step G (Remove Comments): PASS');

    // Step H: Test Copy button
    await page.fill('#input-js', 'var x = 1;');
    await page.click('text=Beautify JS');
    await page.waitForTimeout(500);
    await page.click('#copyBtn');
    await page.waitForTimeout(300);
    console.log('Step H (Copy): PASS');

    // Step I: Test Clear button
    await page.click('text=Clear');
    await page.waitForTimeout(300);
    const clearedInput = await page.locator('#input-js').inputValue();
    if (clearedInput !== '') {
      throw new Error('Clear did not empty input');
    }
    console.log('Step I (Clear): PASS');

    await page.screenshot({ path: TEMP_DIR + '/final.png' });

    console.log('\nAll tests PASSED!');

  } catch (e) {
    console.error('Test failed:', e.message);
    if (browser) {
      const page = (await browser.contexts()[0]?.pages())?.[0];
      if (page) {
        await page.screenshot({ path: TEMP_DIR + '/error.png' });
        const content = await page.content();
        fs.writeFileSync(TEMP_DIR + '/error.html', content);
      }
    }
    process.exit(1);
  } finally {
    if (browser) {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) await p.close();
        await ctx.close();
      }
      await browser.close();
    }
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  }
}

main();
