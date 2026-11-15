#!/usr/bin/env node
// BUG-447 gate — the CTR round: a tool's published title/description must be the one the
// manifest promises, must fit the SERP budget, and must match the page's own heading.
//
// WHY
// The 28-day GSC pull showed 148,124 impressions and 475 clicks (0.32% CTR). Three pages
// carried 72% of the impressions (calculator 53,367, time-calculator 36,948,
// area-calculator 17,160) and 14% of the clicks. The pages ranked (positions 7-9) — the
// SERP snippet was not earning the click. The fix was the title/description of 12 pages.
//
// These strings are NOT in the page HTML by hand: `functions/tools/[[catchall]].js` ->
// patchToolHtml() overwrites <title>, meta description, og:*, twitter:* and the JSON-LD
// name/description from `manifest.txt` (fields 5 and 6) on every request, through
// smartTitle() (<=60 escaped chars) and smartDesc() (<=155). Two things follow, and they
// are what this gate protects:
//
//   1. The manifest is the ONLY place the promise is written. A page whose manifest row
//      disagrees with the copy in its own file publishes something nobody wrote down.
//   2. A title that drifts from the page's <h1> is the BUG-434/437 class: the SERP says
//      "Calorie & Macro Calculator" while the page heading says "Calorie Calculator", and
//      the reader has no reason to trust either.
//
// The 12 pages below were rewritten for CTR. The features named in their titles and
// descriptions were each verified on the live page (see BUGS.md BUG-447). This gate keeps
// that promise honest: the strings stay in budget, stay unique, stay aligned with the
// heading, and keep naming a feature the page actually has.
//
// Usage: node bug447-ctr-metadata-gate.js [--root <dir>]
'use strict';

const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..')));

const escapeHtmlAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// smartTitle() / smartDesc() — the runtime's own rules, mirrored.
function smartTitle(name) {
  const BRAND = ' | DevTools Hub';
  if (escapeHtmlAttr(name + BRAND).length <= 60) return name + BRAND;
  if (escapeHtmlAttr(name).length <= 60) return name;
  for (let target = 59; target > 0; target--) {
    let cut = name.substring(0, target);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 30) cut = cut.substring(0, lastSpace);
    cut = cut.replace(/[,;:.]$/, '') + '…';
    if (escapeHtmlAttr(cut).length <= 60) return cut;
  }
  return name.substring(0, 50) + '…';
}
function smartDesc(desc) {
  if (escapeHtmlAttr(desc).length <= 155) return desc;
  for (let target = 155; target > 0; target--) {
    let cut = desc.substring(0, target);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 100) cut = cut.substring(0, lastSpace);
    cut = cut.replace(/[,;:.]$/, '') + '.';
    if (escapeHtmlAttr(cut).length <= 155) return cut;
  }
  return desc.substring(0, 50);
}

// A word that cannot end a title on its own (BUG-405's list, kept so this gate stands alone).
const DANGLING = new Set(['find', 'encode', 'decode', 'compare', 'create', 'convert', 'validate',
  'format', 'beautify', 'minify', 'generate', 'translate', 'detect', 'show', 'track', 'build',
  'edit', 'remove', 'merge', 'count', 'measure', 'scan', 'analyze', 'optimise', 'optimize',
  'reverse', 'extract', 'parse', 'render', 'resize', 'crop', 'split', 'test', 'check',
  'special', 'sidebyside', 'printable']);
const NON_COMPLETER = new Set(['and', 'or', '&', '+', 'to', 'of', 'for', 'with', 'from']);

// The CTR set: slug -> the head phrase the SERP must carry (== the page's <h1>) and the
// feature tokens the title/description must still name. The tokens were each read off the
// live page; dropping one means the description now promises less than the tool does.
const CTR = {
  'calculator': {
    h1: 'Free Online Calculator',
    title: ['Free Online Calculator', 'Scientific', 'BMI'],
    desc: ['scientific', 'BMI', 'loan payments'],
  },
  'area-calculator': {
    h1: 'Area Calculator',
    title: ['Area Calculator', 'Square Feet'],
    desc: ['square feet', 'paint', 'carpet'],
  },
  'time-calculator': {
    h1: 'Time Calculator',
    title: ['Time Calculator', 'Add', 'Subtract'],
    desc: ['overnight', 'decimal', 'break'],
  },
  'due-date-calculator': {
    h1: 'Due Date Calculator',
    title: ['Due Date Calculator', 'IVF'],
    desc: ['LMP', 'IVF', 'ovulation'],
  },
  'electricity-cost-calculator': {
    h1: 'Electricity Cost Calculator',
    title: ['Electricity Cost Calculator', 'kWh', 'Bill'],
    desc: ['kWh rate', 'bill', 'appliance'],
  },
  'calorie-calculator': {
    h1: 'Calorie & Macro Calculator',
    title: ['Calorie & Macro Calculator', 'BMR', 'TDEE'],
    desc: ['Mifflin', 'TDEE', 'macro'],
  },
  'gpa-calculator': {
    h1: 'GPA Calculator',
    title: ['GPA Calculator', 'Scales', 'Target'],
    desc: ['4 scales', 'target GPA', 'Honors'],
  },
  'age-calculator': {
    h1: 'Age Calculator',
    title: ['Age Calculator', 'Birthday'],
    desc: ['birthday countdown', 'milestone', 'months'],
  },
  'cron-generator': {
    h1: 'Cron Generator',
    title: ['Cron Generator', 'Cron Expressions'],
    desc: ['next 5 runs'],
    forbidden: ['next 10'],
  },
  'ai-crawler-checker': {
    h1: 'AI Crawler Checker',
    title: ['AI Crawler Checker', 'GPTBot'],
    desc: ['19 AI bots', 'llms.txt', 'GPTBot'],
  },
  'number-to-words': {
    h1: 'Number to Words Converter',
    title: ['Number to Words Converter', 'Number'],
    desc: ['lakh', 'decimal', 'English'],
  },
  'what-day-is-it': {
    h1: 'What Day Is It?',
    title: ['What Day Is It?', 'Week Number'],
    desc: ['8 formats', 'week number', 'calendar'],
  },
};

function parseManifest(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('|');
    if (p.length < 6) continue;
    rows.push({ slug: p[0].trim(), name: p[4].trim(), desc: p[5].trim() });
  }
  return rows;
}

const unescapeHtmlAttr = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

function attrOf(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}
function stripTags(html, re) {
  const m = html.match(re);
  return m ? unescapeHtmlAttr(m[1].replace(/<[^>]+>/g, '')).trim() : null;
}

// check() — the rule under test. `overrides` lets the anti-vacuity tier inject other bytes.
function check(manifestText, overrides) {
  overrides = overrides || {};
  const bad = [];
  const rows = parseManifest(manifestText);
  if (rows.length < 300) {
    bad.push({ slug: '(manifest)', why: 'the scan is degenerate — only ' + rows.length + ' rows parsed' });
    return { bad, rows };
  }

  // 1. Site-wide: every published title is unique (two pages fighting for one snippet is
  //    the same bug as a title nobody can rank).
  const seen = new Map();
  for (const r of rows) {
    const t = smartTitle(r.name);
    if (seen.has(t)) {
      bad.push({ slug: r.slug, why: 'duplicate title, also used by ' + seen.get(t) + ': "' + t + '"' });
    } else {
      seen.set(t, r.slug);
    }
    const esc = escapeHtmlAttr(r.name).length;
    if (esc > 60) bad.push({ slug: r.slug, why: 'name escapes to ' + esc + ' chars — smartTitle() would cut it' });
    const words = r.name.split(/\s+/).filter(Boolean);
    const last = (words[words.length - 1] || '').replace(/[^\w&+]/g, '').toLowerCase();
    const prev = (words[words.length - 2] || '').replace(/[^\w&+]/g, '').toLowerCase();
    if (DANGLING.has(last) && (NON_COMPLETER.has(prev) || DANGLING.has(prev))) {
      bad.push({ slug: r.slug, why: 'title ends on the dangling word "' + last + '"' });
    }
  }

  const bySlug = new Map(rows.map(r => [r.slug, r]));

  // 2. The CTR set: budget, heading agreement, feature promise, and the published copy.
  for (const slug of Object.keys(CTR)) {
    const spec = CTR[slug];
    const row = bySlug.get(slug);
    if (!row) { bad.push({ slug, why: 'not in manifest.txt' }); continue; }

    const title = smartTitle(row.name);
    const desc = smartDesc(row.desc);
    const descLen = escapeHtmlAttr(row.desc).length;

    if (descLen < 120 || descLen > 155) {
      bad.push({ slug, why: 'description is ' + descLen + ' chars (must be 120-155)' });
    }
    if (desc !== row.desc) {
      bad.push({ slug, why: 'the manifest description is over budget — smartDesc() would clip it mid-sentence' });
    }
    if (!/\.\s*$/.test(desc)) {
      bad.push({ slug, why: 'description does not end on a complete sentence' });
    }
    for (const token of spec.title) {
      if (!title.includes(token)) bad.push({ slug, why: 'title is missing "' + token + '"' });
    }
    for (const token of spec.desc) {
      if (!desc.toLowerCase().includes(token.toLowerCase())) {
        bad.push({ slug, why: 'description is missing the feature "' + token + '"' });
      }
    }
    for (const token of (spec.forbidden || [])) {
      if (desc.toLowerCase().includes(token.toLowerCase())) {
        bad.push({ slug, why: 'description still claims "' + token + '" — the page does not show it' });
      }
    }

    const file = path.join(ROOT, 'tools', slug, 'index.html');
    let html;
    try {
      html = overrides[slug] !== undefined ? overrides[slug] : fs.readFileSync(file, 'utf8');
    } catch (e) {
      bad.push({ slug, why: 'page file missing: ' + e.message });
      continue;
    }

    const h1 = stripTags(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1 === null) { bad.push({ slug, why: 'no <h1> in the page' }); continue; }
    if (h1 !== spec.h1) {
      bad.push({ slug, why: 'the <h1> is "' + h1 + '" but the SERP promise is "' + spec.h1 + '"' });
    }
    if (!title.startsWith(h1)) {
      bad.push({ slug, why: 'title "' + title + '" does not start with the <h1> "' + h1 + '"' });
    }

    const wantTitle = escapeHtmlAttr(title);
    const wantDesc = escapeHtmlAttr(desc);
    const checks = [
      ['<title>', attrOf(html, /<title>([\s\S]*?)<\/title>/i), wantTitle],
      ['meta description', attrOf(html, /<meta name="description" content="([^"]*)"/i), wantDesc],
      ['og:title', attrOf(html, /<meta property="og:title" content="([^"]*)"/i), wantTitle],
      ['og:description', attrOf(html, /<meta property="og:description" content="([^"]*)"/i), wantDesc],
    ];
    for (const m of html.matchAll(/<meta name="twitter:(title|description)" content="([^"]*)"/gi)) {
      checks.push(['twitter:' + m[1].toLowerCase(), m[2], m[1].toLowerCase() === 'title' ? wantTitle : wantDesc]);
    }
    for (const [what, got, want] of checks) {
      if (got === null) { bad.push({ slug, why: 'the published copy has no ' + what }); continue; }
      if (got !== want) bad.push({ slug, why: 'the published ' + what + ' is "' + got + '", not the manifest\'s "' + want + '"' });
    }

    // JSON-LD: the runtime rewrites `name` and `description` on every node it sees.
    let ldSeen = 0;
    for (const m of html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
      let j;
      try { j = JSON.parse(m[1]); } catch (e) { continue; }
      const nodes = Array.isArray(j['@graph']) ? j['@graph'] : [j];
      for (const node of nodes) {
        if (node.name !== undefined) {
          ldSeen++;
          if (node.name !== title) bad.push({ slug, why: 'JSON-LD name is "' + node.name + '", not "' + title + '"' });
        }
        if (node.description !== undefined) {
          ldSeen++;
          if (node.description !== desc) bad.push({ slug, why: 'JSON-LD description is not the manifest description' });
        }
      }
    }
    if (!ldSeen) bad.push({ slug, why: 'no JSON-LD name/description found' });
  }
  return { bad, rows };
}

// ── run ─────────────────────────────────────────────────────────────────────
const manifestPath = path.join(ROOT, 'manifest.txt');
if (!fs.existsSync(manifestPath)) {
  console.log('  ✗ FAIL no manifest.txt at ' + manifestPath);
  process.exit(1);
}
const text = fs.readFileSync(manifestPath, 'utf8');
const { bad, rows } = check(text);

console.log('\nmanifest tools: ' + rows.length + ' · CTR set: ' + Object.keys(CTR).length +
  ' · pass: ' + (rows.length * 2 + Object.keys(CTR).length - bad.length) + ' · FAIL: ' + bad.length);
bad.forEach(b => console.log('  ✗ FAIL /tools/' + b.slug + '/ — ' + b.why));

if (bad.length === 0 && Object.keys(CTR).length !== 12) {
  console.log('  ✗ FAIL the CTR set is incomplete — ' + Object.keys(CTR).length + ' of 12 pages');
  process.exit(1);
}

// ── anti-vacuity ────────────────────────────────────────────────────────────
// A green gate that never goes red is a green light wired to nothing. Each case below is a
// state the site was actually in, and each must be caught.
const PRE_FIX = {
  'calculator': ['Free Online Calculator - Scientific & Unit Converter', 'Free online calculator with scientific functions, unit conversion, loan payments and BMI in metric and imperial units. Runs in your browser, no signup.'],
  'area-calculator': ['Area Calculator - 6 Shapes, Square Feet & Wall Area', 'Calculate area for 6 shapes - rectangle, square, triangle, circle, trapezoid and L-shaped rooms - plus square footage for floors, walls and paint. Free.'],
  'time-calculator': ['Time Calculator - Free Hours Minutes Duration & Add Time', 'Free time calculator. Calculate duration between two times, add or subtract hours and minutes, hours-to-decimal converter, multi-period sum.'],
  'due-date-calculator': ['Due Date Calculator - Pregnancy Due Date and Ovulation', 'Free due date calculator. Calculate your pregnancy due date using LMP, conception date, or IVF transfer. Ovulation calculator & period predictor.'],
  'electricity-cost-calculator': ['Electricity Cost Calculator - Appliance kWh & Bill Split', 'See what each appliance costs on your electric bill. Enter watts and hours per device plus your own kWh rate for daily, monthly and yearly costs.'],
  'calorie-calculator': ['Calorie Calculator - TDEE & BMR Macro Calculator', 'Free calorie calculator. Calculate your TDEE, BMR, and optimal macros for weight loss, maintenance, or muscle gain. Mifflin-St Jeor equation, no signup.'],
  'gpa-calculator': ['GPA Calculator - 4 Scales, Semester & Cumulative', 'Free GPA calculator with 4 scales (US 4.0/4.3, Indian 10.0, percentage), unlimited semesters, prior GPA integration, target GPA planner, and Honors/AP/IB.'],
  'age-calculator': ['Age Calculator - Years, Months, Days', 'Free age calculator. Calculate your exact age in years, months, days, hours. See next birthday countdown and milestone dates. No signup required.'],
  'cron-generator': ['Cron Generator - Create Cron Expressions', 'Generate cron expressions interactively. Select minute, hour, day, month, weekday. See the next 10 execution times and copy to your clipboard.'],
  'ai-crawler-checker': ['AI Crawler Access Checker - GPTBot', 'Free AI crawler access checker. Audit robots.txt against 19 AI bots and validate llms.txt to spec. See the exact rule that blocks GPTBot. No signup.'],
  'number-to-words': ['Number to Words Converter - Free Online Tool', 'Free number to words converter. Convert any number to English words instantly. Spell out numbers for checks, invoices, legal documents. Supports decimals.'],
  'what-day-is-it': ["What Day Is It? - Today's Date & Day of Week", "What day is it today? Free online date calculator. Today's date in 8 formats, day of year, week number, days between dates, add/subtract days. No signup."],
};

let vac = 0;
function expectRed(label, injectedText, injectedFiles, mustMention, slug) {
  const res = check(injectedText, injectedFiles);
  const hits = res.bad.filter(b => (!mustMention || b.why.includes(mustMention)) && (!slug || b.slug === slug));
  if (hits.length === 0) {
    console.log('  ✗ FAIL ANTI-VACUITY — ' + label + ' was NOT caught');
    vac++;
  } else {
    console.log('  anti-vacuity: ' + label + ' -> red ("' + hits[0].why.slice(0, 70) + '")');
  }
}

// 1. The pre-fix titles/descriptions: two pages carried a title that disagreed with their
//    own heading, and one promised "the next 10 execution times" on a page that shows 5.
const preText = text.split('\n').map(line => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return line;
  const p = t.split('|');
  const pre = PRE_FIX[p[0].trim()];
  if (!pre) return line;
  p[4] = pre[0]; p[5] = pre[1];
  return p.join('|');
}).join('\n');
expectRed('the pre-fix calorie-calculator title vs its <h1>', preText, {}, 'does not start with the <h1>', 'calorie-calculator');
expectRed('the pre-fix cron-generator description claiming "next 10"', preText, {}, 'next 10', 'cron-generator');
expectRed('the pre-fix ai-crawler-checker title vs the current <h1>', preText, {}, 'does not start with the <h1>', 'ai-crawler-checker');

// 2. A published copy that drifts from the manifest must be caught.
const staleFile = fs.readFileSync(path.join(ROOT, 'tools', 'calculator', 'index.html'), 'utf8')
  .replace(/<title>[\s\S]*?<\/title>/, '<title>Free Online Calculator - Math Problem Solver | DevTools Hub</title>');
expectRed('a page file whose <title> drifted from the manifest', text, { 'calculator': staleFile }, 'published <title>', 'calculator');

// 3. An over-budget description must be caught.
const fat = text.replace(/^(gpa-calculator\|[^\n]*)$/m, (m) => {
  const p = m.split('|');
  p[5] = 'Free GPA calculator with 4 scales, unlimited semesters, prior GPA integration, a target GPA planner, and Honors, AP and IB classes, plus a full transcript export, a weighted-by-credit toggle, and a printable report.';
  return p.join('|');
});
expectRed('a description over the 155-char budget', fat, {}, 'chars (must be 120-155)', 'gpa-calculator');

console.log('  anti-vacuity: ' + (4 - vac) + '/4 pre-fix states go red');
process.exit(bad.length === 0 && vac === 0 ? 0 : 1);
