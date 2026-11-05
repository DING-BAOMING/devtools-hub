/**
 * 多 API 试注册批量探针
 *
 * 每个候选: 访问注册页 → 检测 CAPTCHA → 自动选择 selectors → 填表 → 提交 → 等邮件
 *
 * 用法: node probe-batch.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const EmailHandler = require('./email-handler');

const TEMP_DIR = '/tmp/probe-batch';

const CANDIDATES = [
  {
    name: 'OpenRouter',
    signupUrl: 'https://openrouter.ai/auth',
    account: { email: 'bm.d@qq.com', password: 'BA0mingR0ute!2026Secure#' },
    submit: async (page) => {
      await page.locator('input[type="email"]').first().fill('bm.d@qq.com');
      await page.locator('input[type="password"]').first().fill('BA0mingR0ute!2026Secure#');
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /sign up|create account|register|continue/i }).first().click({ timeout: 5000 }).catch(() => {});
    },
    verifyFrom: 'openrouter',
    postSubmit: async (page) => {
      // 如果跳转到 dashboard 或显示 API key, 抓
      await page.waitForTimeout(3000);
      const url = page.url();
      const text = await page.locator('body').innerText().catch(() => '');
      return { url, text: text.slice(0, 500), hasKey: /sk-or-[a-zA-Z0-9]{20,}/.test(text) };
    }
  },
  {
    name: 'Resend',
    signupUrl: 'https://resend.com/signup',
    account: { email: 'bm.d@qq.com', password: 'BA0mingR0ute!2026Secure#' },
    submit: async (page) => {
      await page.locator('input[type="email"]').first().fill('bm.d@qq.com');
      await page.locator('input[type="password"]').first().fill('BA0mingR0ute!2026Secure#');
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /create account/i }).first().click({ timeout: 5000 }).catch(() => {});
    },
    verifyFrom: 'resend',
    postSubmit: async (page) => {
      await page.waitForTimeout(3000);
      const url = page.url();
      const text = await page.locator('body').innerText().catch(() => '');
      return { url, text: text.slice(0, 500) };
    }
  },
  {
    name: 'WeatherAPI',
    signupUrl: 'https://www.weatherapi.com/signup.aspx',
    account: { email: 'bm.d@qq.com', password: 'BA0mingR0ute!2026Secure#', first_name: 'BAOMING', last_name: 'DING' },
    submit: async (page) => {
      // 找所有 input, 第一个是 email
      const inputs = await page.locator('input').all();
      for (const inp of inputs) {
        const type = await inp.getAttribute('type');
        const name = await inp.getAttribute('name');
        const placeholder = await inp.getAttribute('placeholder');
        const id = await inp.getAttribute('id');
        const sig = (name || id || placeholder || '').toLowerCase();
        try {
          if (type === 'email' || /e-?mail/i.test(sig)) {
            await inp.fill('bm.d@qq.com');
          } else if (type === 'password' || /pass/i.test(sig)) {
            await inp.fill('BA0mingR0ute!2026Secure#');
          } else if (/first|fname|given/i.test(sig)) {
            await inp.fill('BAOMING');
          } else if (/last|lname|sur/i.test(sig)) {
            await inp.fill('DING');
          } else if (type === 'text' && sig) {
            await inp.fill('BAOMING');
          }
        } catch {}
      }
      await page.locator('input[type="submit"], button[type="submit"], button:has-text("Sign Up"), button:has-text("Register")').first().click({ timeout: 5000 }).catch(() => {});
    },
    verifyFrom: 'weatherapi',
    postSubmit: async (page) => {
      await page.waitForTimeout(3000);
      const url = page.url();
      const text = await page.locator('body').innerText().catch(() => '');
      return { url, text: text.slice(0, 800) };
    }
  },
  {
    name: 'CurrentsAPI',
    signupUrl: 'https://currentsapi.services/en/register',
    account: { email: 'bm.d@qq.com', password: 'BA0mingR0ute!2026Secure#', name: 'BAOMING' },
    submit: async (page) => {
      const inputs = await page.locator('input').all();
      for (const inp of inputs) {
        const type = await inp.getAttribute('type');
        const name = await inp.getAttribute('name');
        const placeholder = await inp.getAttribute('placeholder');
        const id = await inp.getAttribute('id');
        const sig = (name || id || placeholder || '').toLowerCase();
        try {
          if (type === 'email' || /e-?mail/i.test(sig)) await inp.fill('bm.d@qq.com');
          else if (type === 'password' || /pass/i.test(sig)) await inp.fill('BA0mingR0ute!2026Secure#');
          else if (/name/i.test(sig) && type === 'text') await inp.fill('BAOMING');
        } catch {}
      }
      await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 }).catch(() => {});
    },
    verifyFrom: 'currentsapi',
    postSubmit: async (page) => {
      await page.waitForTimeout(3000);
      const url = page.url();
      const text = await page.locator('body').innerText().catch(() => '');
      return { url, text: text.slice(0, 800) };
    }
  }
];

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]'
];

async function detectCaptcha(page) {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const c = await page.locator(sel).count();
      if (c > 0) return { found: true, type: sel };
    } catch {}
  }
  const html = await page.content().catch(() => '');
  if (/just a moment|checking your browser|verify you are human|amzn-captcha/i.test(html.slice(0, 5000))) {
    return { found: true, type: 'cloudflare-or-waf' };
  }
  return { found: false };
}

async function test(c) {
  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  const result = { name: c.name, signupUrl: c.signupUrl, success: false, captcha: null, error: null, postUrl: null, postText: null, apiKey: null };

  try {
    await page.goto(c.signupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const cap = await detectCaptcha(page);
    if (cap.found) {
      result.captcha = cap;
      await page.screenshot({ path: `${TEMP_DIR}/${c.name}-captcha.png` }).catch(() => {});
      return result;
    }

    await c.submit(page);
    await page.waitForTimeout(4000);

    // 再次检测
    const cap2 = await detectCaptcha(page);
    if (cap2.found) {
      result.captcha = cap2;
      await page.screenshot({ path: `${TEMP_DIR}/${c.name}-captcha-after.png` }).catch(() => {});
      return result;
    }

    // 抓 post submit 状态
    const post = await c.postSubmit(page);
    result.postUrl = post.url;
    result.postText = post.text;
    if (post.hasKey) {
      const m = post.text.match(/sk-or-[a-zA-Z0-9]{20,}/);
      if (m) result.apiKey = m[0];
    }

    // 等验证邮件 (90s)
    const eh = new EmailHandler();
    const verify = await eh.waitForVerificationCode(c.verifyFrom, 90);
    if (verify) {
      result.email = { from: verify.email.from.slice(0, 80), subject: verify.email.subject.slice(0, 80), code: verify.code };
    } else {
      result.email = null;
    }

    await page.screenshot({ path: `${TEMP_DIR}/${c.name}-final.png`, fullPage: true }).catch(() => {});
  } catch (e) {
    result.error = e.message.slice(0, 200);
  } finally {
    await browser.close();
  }

  return result;
}

(async () => {
  for (const c of CANDIDATES) {
    console.log('\n=== 测试: ' + c.name + ' (' + c.signupUrl + ') ===');
    const r = await test(c);
    console.log('  captcha:', r.captcha ? r.captcha.type : '无');
    console.log('  post-url:', r.postUrl);
    console.log('  apiKey:', r.apiKey);
    console.log('  email:', r.email);
    console.log('  error:', r.error ? r.error.slice(0, 150) : '无');
    console.log('  postText (前 300):', (r.postText || '').slice(0, 300).replace(/\n/g, ' | '));
  }
})();
