/**
 * Listener-duplication check: does any tool page bind the SAME element + event type
 * more than once (different function references), so that one user action fires
 * several handlers?
 *
 * WHY
 * A page that re-renders and re-binds a persistent element accumulates handlers:
 * the Nth click fires N handlers. The static scan cannot decide this — a binding
 * inside a function is not necessarily inside a function that runs twice — so the
 * decision has to be made at runtime, in a real browser, on the served page.
 *
 * WHAT IT DOES
 * 1. Hooks EventTarget.prototype.addEventListener before the page's own scripts run
 *    and counts registrations per (element, type).
 * 2. Snapshots the counts after load, then fires one 'input' event on the first
 *    input/textarea (the cheapest interaction that makes most tools re-render),
 *    then snapshots again.
 * 3. Reports every (element, type) whose count GREW — i.e. the page binds the same
 *    element again while rendering, so one user action ends up firing the handler
 *    several times. Two DIFFERENT handlers on one element from the start are not
 *    a defect (e.g. size-converter binds #cl-gender twice on purpose: one to
 *    repopulate the size list, one to redraw the diagram).
 *
 * Usage: node test-scripts/listener-duplication-check.js [slug ...]
 *   (no args = every tool page in manifest.txt)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://tools.scoreroute.com';
const ROOT = path.join(__dirname, '..');
const CONC = 8;

const manifest = fs.readFileSync(path.join(ROOT, 'manifest.txt'), 'utf8');
const slugs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : manifest.split('\n').filter((l) => /^[a-z0-9]/.test(l)).map((l) => l.split('|')[0]);

async function check(page, slug) {
  const findings = [];
  page.on('console', () => {});
  await page.addInitScript(() => {
    window.__dup = {};
    const ids = new WeakMap();
    let nextId = 0;
    const idOf = (el) => {
      if (!ids.has(el)) ids.set(el, ++nextId);
      return ids.get(el);
    };
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      try {
        // Only ELEMENT targets count. window/document listeners come from third-party
        // scripts (gtag, Cloudflare RUM) — the served page HTML contains no
        // 'pageshow'/'scrollend'/'resize' listener of its own, yet those counts grow
        // after an interaction because gtag's async script binds them when it loads.
        // That is noise, not a defect of our page.
        if (this instanceof Element) {
          const key = idOf(this) + ':' + type;
          const rec = (window.__dup[key] = window.__dup[key] || { n: 0, fns: [], tag: this.tagName || '?', id: this.id || '' });
          rec.n++;
          if (fn) {
            // count how often THIS handler reference was registered for this pair
            const hit = rec.fns.find((f) => f.fn === fn);
            if (hit) hit.count++;
            else rec.fns.push({ fn, count: 1 });
          }
        }
      } catch (e) {}
      return orig.call(this, type, fn, opts);
    };
  });
  const res = await page.goto(`${BASE}/tools/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!res || res.status() !== 200) return { slug, status: res ? res.status() : 0, findings };
  await page.waitForTimeout(600);
  // Snapshot: per (element, type) -> [total registrations, max times the SAME
  // handler reference was registered]. The second number is the defect signal:
  // the same function registered twice on one element fires twice per action.
  // Two DIFFERENT functions on one element is not a defect (size-converter binds
  // #cl-gender twice on purpose: one repopulates the size list, one redraws).
  const snapshot = () => page.evaluate(() => {
    const out = {};
    for (const [key, rec] of Object.entries(window.__dup)) {
      let max = 0;
      for (const f of rec.fns) if (f.count > max) max = f.count;
      out[key] = { n: rec.n, max };
    }
    return out;
  });
  const before = await snapshot();
  // One cheap interaction: type into the first field (most tools re-render on input).
  await page.evaluate(() => {
    const el = document.querySelector('input:not([type=hidden]), textarea');
    if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const after = await snapshot();
  for (const key of Object.keys(after)) {
    const a = after[key];
    const b = before[key] || { n: 0, max: 0 };
    // A defect = the same handler bound more than once for one (element, type).
    if (a.max >= 2) {
      const rec = await page.evaluate((k) => ({ tag: window.__dup[k].tag, id: window.__dup[k].id }), key);
      findings.push(`${rec.tag}${rec.id ? '#' + rec.id : ''} ${key.split(':')[1]} — the same handler bound ${a.max}x (${b.n} → ${a.n} registrations)`);
    }
  }
  return { slug, status: res.status(), findings };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const ctx = await browser.newContext();
  let i = 0;
  const out = [];
  async function worker() {
    while (i < slugs.length) {
      const slug = slugs[i++];
      const page = await ctx.newPage();
      try { out.push(await check(page, slug)); }
      catch (e) { out.push({ slug, status: 'ERR', findings: [String(e.message).slice(0, 120)] }); }
      await page.close();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await browser.close();

  const bad = out.filter((r) => r.findings.length);
  console.log(`checked ${out.length} page(s) at ${new Date().toUTCString()}`);
  console.log(`pages with a duplicated (element, type) binding: ${bad.length}`);
  for (const b of bad) console.log(`  ${b.slug} [${b.status}] ${b.findings.join(' | ')}`);
  process.exitCode = bad.length ? 1 : 0;
})();
