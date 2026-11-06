# 自主接入资源模块 (Autonomous Resources)

> 2026-06-05 重建（按用户授权）。原本是手动运行的脚本，现在做成模块。

## 文件清单

| 文件 | 用途 |
|------|------|
| `email-handler.js` | QQ 邮箱 IMAP 读 + SMTP 发；验证码/链接提取；轮询等待 |
| `playwright-signup.js` | Playwright 通用注册流程：启动浏览器 → 填表 → 检测 CAPTCHA → 等待验证 → 抓 key |
| `test-api.js` | CLI: 4 步评分（访问 → 填表 → 等待验证邮件 → 抓 key），遇到 CAPTCHA 自动停 |

## 邮箱配置（已内置在 `email-handler.js`）

| 项 | 值 |
|---|-----|
| 邮箱 | `bm.d@qq.com` |
| 授权码 | 不入库：`SMTP_AUTH_CODE`（环境变量优先，其次 `/home/ubuntu/.secrets/devtools-hub.env`） |
| IMAP | `imap.qq.com:993` (SSL) |
| SMTP | `smtp.qq.com:465` (SSL) |

## 4 步评分标准

```
1. 访问注册页 → 是否 200 OK 且无 "Just a moment..."？
   ├─ 否 (Cloudflare Challenge) → ❌ 弃
   ├─ 是 → 继续
2. 提交注册表单 → 是否触发 reCAPTCHA / hCaptcha / FunCaptcha？
   ├─ 是 → ❌ 弃
   ├─ 否 → 继续
3. 邮箱验证邮件 → 是否在 90s 内到达 bm.d@qq.com？
   ├─ 否 → ❌ 弃
   ├─ 是 → 提取链接/验证码，访问
4. 控制台生成 key → key 是否可立即调用？
   └─ 调用 1 次测试 → ✅ 入库
```

## CAPTCHA 检测（自动）

`detectCaptcha(page)` 会扫描以下信号：

| 信号 | 来源 |
|---|---|
| `iframe[src*="recaptcha"]` | Google reCAPTCHA |
| `iframe[src*="hcaptcha"]` | hCaptcha |
| `iframe[src*="turnstile"]` | Cloudflare Turnstile |
| `.g-recaptcha` / `.h-captcha` | 旧式渲染 |
| `#cf-challenge-running` | Cloudflare challenge |
| 页面标题/HTML 包含 "just a moment" / "checking your browser" | Cloudflare |
| 页面标题/HTML 包含 "verify you are human" | 通用 |

检测到任一信号 → 立即停，标记 `captcha: { found: true, type: ... }`。

## 用法

### 方式 1: 命令行快速探测
```bash
node tools/_autonomous-resources/test-api.js https://finnhub.io/register --from=finnhub
```

### 方式 2: 在脚本里调用
```javascript
const { signup } = require('./tools/_autonomous-resources/playwright-signup');

const r = await signup({
  site: 'finnhub.io',
  signupUrl: 'https://finnhub.io/register',
  account: { email: 'bm.d@qq.com', password: '...', name: 'BAOMING' },
  fields: {
    email: 'input[name="email"]',
    password: 'input[name="password"]',
    name: 'input[name="name"]',
    submit: 'button[type="submit"]'
  },
  verifyBy: 'link',
  verifyFrom: 'finnhub.io',
  extractKey: async (page) => {
    await page.goto('https://finnhub.io/dashboard');
    return await page.locator('#api-key').innerText();
  }
});

if (r.success) console.log('Key:', r.apiKey);
else if (r.captcha) console.log('CAPTCHA blocked:', r.captcha.type);
else console.log('Failed:', r.error);
```

## 入库流程

拿到 key 后，自动化：
```bash
echo "KEY_VALUE" | npx wrangler pages secret put DEVTOOLS_<SERVICE>_KEY --project-name devtools-hub
```

随后写 `functions/api/<service>.js` 调用。
