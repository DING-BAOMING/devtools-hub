#!/usr/bin/env node
/**
 * Verify a newly published tool, end to end, from the OUTSIDE.
 *
 * WHY THIS EXISTS
 * Publishing used to be three separate manual steps for whoever (or whichever AI)
 * did it: find the new tool's URL, open it in a browser and look for problems,
 * then go read the mailbox to see whether the quality inspector had already filed
 * a bug against it. Three steps, three places to forget one, and the mailbox was
 * the wrong place anyway — it is a per-hour digest of ALL tools, not a live feed
 * for the one tool you just shipped.
 *
 * So the three steps live here now, and the answer to "is the new tool healthy?"
 * is one command with one verdict.
 *
 * WHAT IT CHECKS
 *   1. LINK     the tool is in the live catalogue and its URL answers 200 with a
 *               canonical that points at itself (a canonical pointing elsewhere is
 *               the classic "the new tool cannibalises the old one" bug).
 *   2. BROWSER  a real Chromium loads it: no page errors, no console errors, the
 *               page has exactly one <h1>, and it is not a mobile-overflow page.
 *   3. REPORT   the site's own feedback API (/api/feedback — the same KV the
 *               quality inspector writes into via submit_issue_to_feedback())
 *               has no unresolved bug filed against this tool.
 *
 * WHERE THE SIGNALS COME FROM (this is the part that used to be confused)
 *   - "did it publish?"        -> GitHub (gates check green + merge) and
 *                                  Cloudflare (deployment status success).
 *                                  scripts/publish.sh already prints both.
 *   - "is the new tool broken?"-> this script. The mailbox is NOT consulted:
 *                                  /home/ubuntu/n8n-workflow/quality_inspection_workflow.py
 *                                  emails a per-hour summary of every tool it
 *                                  inspected; the machine-readable form of the
 *                                  same finding is the feedback API.
 *
 * Usage:
 *   node scripts/verify-new-tool.js <slug> [<slug> ...]
 *   node scripts/verify-new-tool.js --list          # every live slug
 *   node scripts/verify-new-tool.js --recent 3      # the 3 newest slugs
 *
 * Exit code: 0 = every checked tool is healthy, 1 = at least one is not.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.env.VERIFY_BASE || 'https://tools.scoreroute.com';
const ROOT = path.join(__dirname, '..');

// Playwright is a devDependency; the Cloudflare build installs --omit=dev, so it
// is only ever present on a machine that has it. Say so plainly instead of
// crashing with a module error the caller has to decode.
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  /* handled below */
}

function liveSlugs() {
  const out = execSync(
    "curl -s --max-time 60 '" + BASE + "/api/tools' | python3 -c \"import sys,json;print('\\n'.join(t['slug'] for t in json.load(sys.stdin)['tools']))\"",
    { maxBuffer: 1e8 }
  ).toString().trim();
  return out ? out.split('\n').filter(Boolean) : [];
}

// The newest slugs, by the date the site itself records (tool-dates.json is
// generated from the git history of the page, so "newest" means "newest code").
function recentSlugs(n) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'tool-dates.json'), 'utf8'));
  return Object.entries(map)
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, n)
    .map(([slug]) => slug);
}

let pass = 0;
let fail = 0;
const problems = [];

function ok(cond, label, detail) {
  if (cond) { pass++; console.log('    ok   ' + label); return true; }
  fail++;
  problems.push(label + (detail ? ' — ' + detail : ''));
  console.log('    FAIL ' + label + (detail ? '  ->  ' + detail : ''));
  return false;
}

async function checkBrowser(slug) {
  if (!chromium) {
    console.log('    SKIP browser checks (playwright is not installed here)');
    return;
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    const url = BASE + '/tools/' + slug + '/?cb=' + Date.now();
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    ok(resp && resp.status() === 200, 'the page answers 200', resp ? String(resp.status()) : 'no response');
    ok(errs.length === 0, 'no JavaScript errors on the page', errs.slice(0, 3).join(' | '));

    const h1 = await page.locator('h1').count();
    ok(h1 === 1, 'exactly one <h1>', 'found ' + h1);

    // A tool page wider than the viewport means a horizontal scrollbar on a phone.
    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    ok(overflow <= 2, 'no horizontal overflow at 390px', overflow + 'px');

    await page.close();
  } finally {
    await browser.close();
  }
}

// The site's own bug tracker for tools. The quality inspector files into it via
// the /tools/feedback/ form, so an unresolved bug for this slug is a real,
// already-known defect — not something to re-discover by reading email.
async function checkFeedback(slug) {
  let list;
  try {
    const res = await fetch(BASE + '/api/feedback', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VerifyNewTool/1.0)' } });
    list = await res.json();
  } catch (e) {
    ok(false, 'the feedback API answers', String(e).slice(0, 120));
    return;
  }
  const hits = (list || []).filter((f) => {
    if (f.resolved) return false;
    if (f.type !== 'bug') return false;
    const d = String(f.description || '');
    return d.includes('/tools/' + slug + '/') || d.includes('Tool: ' + slug);
  });
  ok(hits.length === 0,
    'no unresolved bug filed against this tool',
    hits.length ? hits.length + ' open: ' + hits.slice(0, 2).map((h) => String(h.description).slice(0, 120)).join(' || ') : '');
}

(async () => {
  const args = process.argv.slice(2);
  let slugs;
  if (args.includes('--list')) {
    slugs = liveSlugs();
  } else if (args.includes('--recent')) {
    const n = Number(args[args.indexOf('--recent') + 1]) || 3;
    slugs = recentSlugs(n);
  } else {
    slugs = args.filter((a) => !a.startsWith('--'));
  }
  if (!slugs.length) {
    console.error('usage: node scripts/verify-new-tool.js <slug>... | --list | --recent N');
    process.exit(1);
  }

  console.log('Verifying ' + slugs.length + ' tool page(s) on ' + BASE + '\n');
  for (const slug of slugs) {
    console.log('  [' + slug + ']');
    console.log('    LINK');
    try {
      const res = await fetch(BASE + '/tools/' + slug + '/?cb=' + Date.now(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VerifyNewTool/1.0)' },
      });
      const html = await res.text();
      ok(res.status === 200, 'the URL answers 200', String(res.status));
      const canon = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || '';
      ok(canon.replace(/\/$/, '') === (BASE + '/tools/' + slug).replace(/\/$/, ''),
        'the canonical points at this tool', canon);
      ok(/<h1[\s>]/.test(html), 'the page has an <h1>');
    } catch (e) {
      ok(false, 'the URL answers 200', String(e).slice(0, 120));
    }
    console.log('    BROWSER');
    await checkBrowser(slug);
    console.log('    REPORT');
    await checkFeedback(slug);
    console.log('');
  }

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('');
    for (const p of problems) console.log('  ! ' + p);
    console.log('');
    console.log('  The site is LIVE but this tool is not healthy. Fix it, commit, and publish again:');
    console.log('    cd ' + ROOT + ' && git add -A && git commit -m "fix: <slug>" && bash scripts/publish.sh');
    process.exit(1);
  }
  console.log('  green');
})().catch((e) => {
  console.error('verify-new-tool crashed: ' + String(e).slice(0, 300));
  process.exit(1);
});
