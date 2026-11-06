/**
 * EmailHandler - QQ 邮箱 IMAP 读 + SMTP 发
 * 用于 Playwright 自主注册流程中的: 验证邮件接收, 验证码/链接提取, 邮件触发
 *
 * 邮箱: bm.d@qq.com
 * 授权码: 见未跟踪的凭据存储 (SMTP_AUTH_CODE)
 * IMAP: imap.qq.com:993 (SSL)
 * SMTP: smtp.qq.com:465 (SSL)
 *
 * 使用:
 *   const eh = new EmailHandler();
 *   await eh.connect();
 *   const { code, email } = await eh.waitForVerificationCode('openweathermap', 90);
 *   await eh.disconnect();
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const fs = require('fs');

// The auth code is not in this file: env first, then the untracked credential store.
function readSecret(name) {
  const txt = fs.readFileSync('/home/ubuntu/.secrets/devtools-hub.env', 'utf8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0 || line.slice(0, i).trim() !== name) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }
  throw new Error('missing credential ' + name);
}

class EmailHandler {
  constructor() {
    this.config = {
      email: 'bm.d@qq.com',
      authCode: process.env.SMTP_AUTH_CODE || readSecret('SMTP_AUTH_CODE'),
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465
    };
    this.imap = null;
  }

  async connect() {
    if (this.imap && this.imap.state === 'authenticated') return this.imap;
    this.imap = new Imap({
      user: this.config.email,
      password: this.config.authCode,
      host: this.config.imapHost,
      port: this.config.imapPort,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });
    return new Promise((resolve, reject) => {
      this.imap.once('ready', () => resolve(this.imap));
      this.imap.once('error', reject);
      this.imap.connect();
    });
  }

  async disconnect() {
    if (this.imap && this.imap.state !== 'disconnected') {
      this.imap.end();
    }
  }

  async getRecentEmails(limit = 5, sinceMinutes = 10) {
    const imap = await this.connect();
    return new Promise((resolve, reject) => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) return reject(err);
        const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
        const sinceStr = since.toISOString().slice(0, 10);
        imap.search([['SINCE', sinceStr]], (err, results) => {
          if (err) return reject(err);
          if (!results || results.length === 0) {
            imap.end();
            return resolve([]);
          }
          const fetch = imap.fetch(results.slice(-limit), { bodies: '' });
          const emails = [];
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream).then((p) => {
                emails.push({
                  from: p.from && p.from.text ? p.from.text : '',
                  to: p.to && p.to.text ? p.to.text : '',
                  subject: p.subject || '',
                  text: p.text || '',
                  html: typeof p.html === 'string' ? p.html : '',
                  date: p.date || new Date()
                });
              }).catch(() => {});
            });
          });
          fetch.once('error', reject);
          fetch.once('end', () => {
            imap.end();
            emails.sort((a, b) => b.date - a.date);
            resolve(emails);
          });
        });
      });
    });
  }

  extractVerificationCode(text) {
    if (!text) return null;
    const patterns = [
      /验证码[是为:]?\s*([0-9]{4,8})/i,
      /verification code[:\s]+([0-9]{4,8})/i,
      /your code[:\s]+([0-9]{4,8})/i,
      /one-time code[:\s]+([0-9]{4,8})/i,
      /code[:\s]+([0-9]{4,8})/i,
      /PIN[:\s]+([0-9]{4,8})/i,
      /\b([0-9]{6})\b/,
      /\b([0-9]{4})\b/
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  extractVerificationLink(html, text) {
    const content = html || text || '';
    const patterns = [
      /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|valid|signup|register|email-confirm|verify-email|account-confirm)[^\s"'<>]*/gi,
      /<a[^>]+href=["']([^"']+)["'][^>]*>(?:verify|confirm|click here|activate|here|verify email)/gi
    ];
    for (const p of patterns) {
      const m = content.match(p);
      if (m) {
        if (m[1] && m[1].startsWith('http')) return m[1];
        return m[0];
      }
    }
    return null;
  }

  async waitForVerificationCode(fromKeyword, timeoutSec = 90, pollInterval = 5) {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      try {
        const emails = await this.getRecentEmails(3, 10);
        for (const e of emails) {
          if (fromKeyword && !e.from.toLowerCase().includes(fromKeyword.toLowerCase()) && !e.subject.toLowerCase().includes(fromKeyword.toLowerCase())) {
            continue;
          }
          const code = this.extractVerificationCode(e.text || e.html);
          if (code) return { code, email: e };
        }
      } catch (err) {
        // 单次失败不影响轮询
      }
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
    }
    return null;
  }

  async waitForVerificationLink(fromKeyword, timeoutSec = 90) {
    const start = Date.now();
    while (Date.now() - start < timeoutSec * 1000) {
      try {
        const emails = await this.getRecentEmails(3, 10);
        for (const e of emails) {
          if (fromKeyword && !e.from.toLowerCase().includes(fromKeyword.toLowerCase()) && !e.subject.toLowerCase().includes(fromKeyword.toLowerCase())) {
            continue;
          }
          const link = this.extractVerificationLink(e.html, e.text);
          if (link) return { link, email: e };
        }
      } catch (err) {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  }

  async sendEmail(to, subject, text) {
    const transporter = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: true,
      auth: { user: this.config.email, pass: this.config.authCode }
    });
    return transporter.sendMail({ from: this.config.email, to, subject, text });
  }
}

module.exports = EmailHandler;
