/**
 * Playwright 通用注册流程模板
 *
 * 调用方填入: signupUrl, selectors, accountInfo, emailVerifierLink|emailVerifierCode
 * 模块负责: 启动浏览器, 填表, 提交, 等待验证, 抓 key
 *
 * 用法:
 *   const result = await signup({
 *     site: 'finnhub.io',
 *     signupUrl: 'https://finnhub.io/register',
 *     account: { email: 'bm.d@qq.com', password: 'xxx', name: 'BAOMING' },
 *     fields: {
 *       email: 'input[name="email"]',
 *       password: 'input[name="password"]',
 *       name: 'input[name="name"]',
 *       submit: 'button[type="submit"]'
 *     },
 *     verifyBy: 'link',  // 'link' | 'code'
 *     verifyFrom: 'finnhub.io',  // 邮件发送方域名匹配
 *     extractKey: async (page) => await page.locator('#api-key').innerText(),
 *     detectCaptcha: true
 *   });
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const EmailHandler = require('./email-handler');

const TEMP_DIR = '/tmp/playwright-signup';

async function cleanup(browser) {
  if (browser) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) await p.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="captcha"]',
  '.g-recaptcha',
  '.h-captcha',
  '#cf-challenge-running',
  'input[name="g-recaptcha-response"]',
  'input[name="h-captcha-response"]',
  'input[name="cf-turnstile-response"]'
];

async function detectCaptcha(page) {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const visible = await page.locator(sel).first().isVisible({ timeout: 500 });
      if (visible) return { found: true, type: sel };
    } catch {}
  }
  // 检查页面是否进入 Cloudflare challenge
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  if (/just a moment|checking your browser|attention required|verify you are human/i.test(title + ' ' + html.slice(0, 2000))) {
    return { found: true, type: 'cloudflare-challenge' };
  }
  return { found: false };
}

async function signup(opts) {
  const {
    site,
    signupUrl,
    account,
    fields,
    verifyBy = 'link',
    verifyFrom,
    extractKey,
    preSteps,
    postSteps,
    timeout = 90000,
    detectCaptcha: doDetect = true
  } = opts;

  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const eh = new EmailHandler();
  const result = {
    site,
    signupUrl,
    success: false,
    captcha: null,
    error: null,
    apiKey: null,
    screenshot: null,
    steps: []
  };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US'
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    result.steps.push('1. 访问注册页');
    await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (doDetect) {
      const cap = await detectCaptcha(page);
      if (cap.found) {
        result.captcha = cap;
        result.error = `CAPTCHA detected: ${cap.type}`;
        result.screenshot = `${TEMP_DIR}/captcha.png`;
        await page.screenshot({ path: result.screenshot }).catch(() => {});
        return result;
      }
    }

    if (preSteps) {
      result.steps.push('2. 执行 preSteps');
      await preSteps(page);
    }

    result.steps.push('3. 填写表单');
    for (const [key, selector] of Object.entries(fields)) {
      if (key === 'submit') continue;
      const value = account[key];
      if (value == null) continue;
      try {
        await page.locator(selector).first().fill(value, { timeout: 5000 });
      } catch (e) {
        result.steps.push(`   字段 ${key}=${selector} 失败: ${e.message.slice(0, 80)}`);
      }
    }

    result.steps.push('4. 提交');
    if (fields.submit) {
      await page.locator(fields.submit).first().click({ timeout: 5000 });
    }

    // 提交后再次检测 CAPTCHA（有时提交时才出）
    await page.waitForTimeout(3000);
    if (doDetect) {
      const cap2 = await detectCaptcha(page);
      if (cap2.found) {
        result.captcha = cap2;
        result.error = `CAPTCHA detected after submit: ${cap2.type}`;
        result.screenshot = `${TEMP_DIR}/captcha-after-submit.png`;
        await page.screenshot({ path: result.screenshot }).catch(() => {});
        return result;
      }
    }

    // 等待邮件
    result.steps.push(`5. 等待验证邮件 (${verifyBy}=${verifyFrom})`);
    let verifyResult = null;
    if (verifyBy === 'link') {
      verifyResult = await eh.waitForVerificationLink(verifyFrom, 90);
    } else {
      verifyResult = await eh.waitForVerificationCode(verifyFrom, 90);
    }

    if (!verifyResult) {
      result.error = `验证邮件未在 90s 内到达`;
      result.screenshot = `${TEMP_DIR}/after-submit.png`;
      await page.screenshot({ path: result.screenshot, fullPage: true }).catch(() => {});
      return result;
    }

    // 处理验证
    if (verifyBy === 'link') {
      result.steps.push(`6. 打开验证链接: ${verifyResult.link.slice(0, 80)}...`);
      await page.goto(verifyResult.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      result.steps.push(`6. 使用验证码: ${verifyResult.code}`);
      // 用户在 signup form 可能需要填 code，由 postSteps 处理
    }

    if (postSteps) {
      result.steps.push('7. 执行 postSteps');
      await postSteps(page, verifyResult);
    }

    // 抓 key
    if (extractKey) {
      result.steps.push('8. 提取 API key');
      try {
        const k = await extractKey(page);
        if (k && typeof k === 'string' && k.length > 8) {
          result.apiKey = k.trim();
        }
      } catch (e) {
        result.steps.push(`   提取失败: ${e.message.slice(0, 80)}`);
      }
    }

    result.screenshot = `${TEMP_DIR}/final.png`;
    await page.screenshot({ path: result.screenshot, fullPage: true }).catch(() => {});

    if (result.apiKey) {
      result.success = true;
    } else {
      result.error = '未提取到 key, 检查 final.png';
    }
  } catch (e) {
    result.error = `异常: ${e.message.slice(0, 200)}`;
  } finally {
    await cleanup(browser);
    try { await eh.disconnect(); } catch {}
  }

  return result;
}

module.exports = { signup, detectCaptcha, cleanup };
