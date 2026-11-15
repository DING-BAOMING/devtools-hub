// Compliance gate: no published page may assert something the site's own code contradicts.
//
// Each rule is a PURE predicate over a set of page bodies, so the anti-vacuity tier can feed
// it a body containing the violation and require it to return false. A rule that cannot go red
// is not a gate. (Same reasoning as the bug334/335/336 gates in this directory.)
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const R = (p) => readFileSync(ROOT + '/' + p, 'utf8');
const stripTags = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let fails = 0;
const A = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? ' — ' + d : '')); if (!c) fails++; };

// ---------- FACTS, read out of the code ----------
const feedbackHtml = R('tools/feedback/index.html');
const feedbackFn = R('functions/api/feedback.js');
const manifest = R('manifest.txt');

const fact_emailPersisted = /name="email"/.test(feedbackHtml) && /email:\s*email\s*\|\|\s*''/.test(feedbackFn);

let aiPosting = 0;
for (const d of manifest.split('\n')) {
  if (!d.trim() || d.startsWith('#')) continue;
  let src; try { src = R('tools/' + d.split('|')[0] + '/index.html'); } catch { continue; }
  if (/fetch\(\s*['"`]\/api\//.test(src)) aiPosting++;
}

// The category label map is the source of truth in libs/category-copy.js (it used to be a
// local const inside functions/tools/[[catchall]].js — BUG-114's shape). Read it there.
const catCopy = R('libs/category-copy.js');
const catLabelsSrc = catCopy.match(/export const CAT_LABELS = \{([\s\S]*?)\n\};/);
const CAT_NAMES = Object.fromEntries(
  [...(catLabelsSrc ? catLabelsSrc[1] : '').matchAll(/'([a-z0-9-]+)':\s*'([^']*)'/g)].map(m => [m[1], m[2]]));
const CAT_COUNT = Object.keys(CAT_NAMES).length;

const BODIES = {
  privacy: stripTags(R('privacy/index.html')),
  about: stripTags(R('about/index.html')),
  contact: stripTags(R('contact/index.html')),
  aboutRaw: R('about/index.html'),
  feedback: R('tools/feedback/index.html'),
};

// ---------- RULES: (page, description, predicate, the phrase that must make it red) ----------
const RULES = [
  ['privacy', 'must not say no email is collected while the form persists one',
    b => !fact_emailPersisted || !/No email or identity is required/.test(b.privacy),
    'No email or identity is required'],
  ['privacy', 'must disclose the optional email under "Information We Do Collect"',
    b => /optional email field/i.test(b.privacy),
    'REMOVE_ME'],
  ['privacy', 'must not promise "nothing to delete" while a stored email exists',
    b => !fact_emailPersisted || !/there is nothing to delete or export(?!\.\s*The one exception)/.test(b.privacy),
    'there is nothing to delete or export'],
  ['privacy', 'must not assert personal data is never collected',
    b => !fact_emailPersisted || !/collect personal data/.test(b.privacy),
    'collect personal data'],
  ['about', 'must not claim every tool runs in the browser while server-backed tools exist',
    b => aiPosting === 0 || !/\bEvery tool runs entirely in your browser\b/.test(b.about),
    'Every tool runs entirely in your browser'],
  ['about', 'must not claim "all processing client-side"',
    b => aiPosting === 0 || !/all processing client-side/.test(b.about),
    'all processing client-side'],
  ['about', 'must not claim "your input never reaches a server"',
    b => aiPosting === 0 || !/your input never reaches a server/.test(b.about),
    'your input never reaches a server'],
  ['about', 'must link the page that names every third party',
    b => /href="\/subprocessors\/"/.test(b.aboutRaw),
    'x'],
  ['about', 'must name the categories exactly as the category pages do',
    b => {
      const m = b.about.match(/across (\d+) categories: ([^.]+)\./);
      if (!m) return false;
      const names = m[2].split(/,\s*and\s+|,\s*/).map(s => s.trim()).filter(Boolean);
      return Number(m[1]) === CAT_COUNT && JSON.stringify(names) === JSON.stringify(Object.values(CAT_NAMES));
    },
    'x'],
  ['contact', 'must not publish a fixed bug-fix SLA',
    b => !/within 24 hours/i.test(b.contact),
    'fixed within 24 hours'],
  ['contact', 'the green-badge claim must match the markup that renders it',
    b => /resolved-badge/.test(b.feedback),
    'x'],
];

console.log('FACTS (read from code, not asserted by hand)');
A('feedback form has an email field AND the Function persists it', fact_emailPersisted);
A('>= 20 tools POST to a server API', aiPosting >= 20, aiPosting + ' tools');
A('category label map (libs/category-copy.js) is non-empty', CAT_COUNT > 0, CAT_COUNT + ' entries');

console.log('\nTIER A — shipped pages');
for (const [page, desc, test] of RULES) A(`[/${page}] ${desc}`, test(BODIES));

// A rule of the shape "body must CONTAIN x" cannot be made red by appending text — only a
// rule of the shape "body must NOT contain x" can. Those are handled here by deleting the
// phrase they look for. Getting this distinction wrong is how a gate passes for the wrong
// reason, so it is spelled out rather than swept into a loop.
console.log('\nTIER B — anti-vacuity');
for (const [page, desc, test, over] of RULES) {
  if (over === 'x') { console.log(`  SKIP [/${page}] ${desc} — presence rule, see Tier B2`); continue; }
  if (over === 'REMOVE_ME') {
    A(`[/${page}] ${desc} — red once the disclosure is removed`,
      !test({ ...BODIES, [page]: BODIES[page].replace(/optional email field/i, 'the field') }));
    continue;
  }
  A(`[/${page}] ${desc} — red once the violation is appended`, !test({ ...BODIES, [page]: BODIES[page] + ' ' + over }));
}

console.log('\nTIER B2 — the three non-injectable rules, shown non-vacuous by removing what they check');
A('subprocessors-link rule is FALSE when every link is removed',
  !/href="\/subprocessors\/"/.test(BODIES.aboutRaw.replace(/href="\/subprocessors\/"/g, 'href="/nope/"')));
A('green-badge rule is FALSE when the badge markup is renamed',
  !/resolved-badge/.test(BODIES.feedback.replace(/resolved-badge/g, 'nothing-here')));
A('category rule is FALSE on the old "Formatters" list',
  (() => {
    const wrong = BODIES.about.replace('Code Formatters, Calculators', 'Formatters, Calculators');
    const m = wrong.match(/across (\d+) categories: ([^.]+)\./);
    if (!m) return true; // the sentence is gone entirely — the rule cannot pass
    const names = m[2].split(/,\s*and\s+|,\s*/).map(s => s.trim()).filter(Boolean);
    return JSON.stringify(names) !== JSON.stringify(Object.values(CAT_NAMES));
  })());

// ---------- GEO: robots.txt must not contradict the page-level ai-train:no ----------
// Google/bot semantics (RFC 9309): for a given UA the MOST SPECIFIC matching group wins,
// and INSIDE that group the LONGEST matching path rule wins (Allow wins a tie). A group may
// therefore carry both Allow and Disallow — the site's own `User-agent: *` group does
// (Allow: / for the pages, Disallow: /api/ for the machine catalogue) — and the crawler
// resolves it by longest prefix, exactly as the ai-crawl-audit library does.
function parseRobotsGroups(txt) {
  const groups = [];
  let cur = null;
  for (const raw of txt.split('\n')) {
    const l = raw.split('#')[0].trim();
    if (!l) continue;
    const i = l.indexOf(':');
    if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (cur && cur.rules.length === 0) cur.agents.push(v.toLowerCase());
      else { cur = { agents: [v.toLowerCase()], rules: [] }; groups.push(cur); }
    } else if (cur && (k === 'allow' || k === 'disallow')) {
      cur.rules.push({ type: k, path: v });
    }
  }
  return groups;
}
// '*' is any sequence, a trailing '$' anchors the end (RFC 9309 2.2.3).
function robotsPathToRegExp(pattern) {
  let p = pattern;
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p.split('*').map(seg => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}
function robotsVerdict(txt, ua, path = '/') {
  const groups = parseRobotsGroups(txt);
  const wanted = String(ua).toLowerCase();
  const group = groups.find(g => g.agents.includes(wanted)) || groups.find(g => g.agents.includes('*'));
  if (!group) return 'ALLOWED'; // no rules apply to this crawler
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;                       // empty Disallow means "no restriction"
    if (!robotsPathToRegExp(rule.path).test(path)) continue;
    if (!best || rule.path.length > best.path.length ||
        (rule.path.length === best.path.length && rule.type === 'allow')) best = rule;
  }
  if (!best) return 'ALLOWED';
  return best.type === 'allow' ? 'ALLOWED' : 'BLOCKED';
}

const robotsTxt = R('robots.txt');
const TRAINING = ['GPTBot', 'CCBot', 'Google-Extended'];
const RETRIEVAL = ['ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot'];
console.log('\nTIER C — GEO: robots.txt vs the page-level ai-train:no directive');
for (const ua of TRAINING)
  A(`robots.txt must BLOCK the training crawler ${ua}`, robotsVerdict(robotsTxt, ua) === 'BLOCKED', robotsVerdict(robotsTxt, ua));
for (const ua of RETRIEVAL)
  A(`robots.txt must ALLOW the retrieval crawler ${ua} (this is what produces citations)`, robotsVerdict(robotsTxt, ua) === 'ALLOWED', robotsVerdict(robotsTxt, ua));
A('robots.txt must allow general search engines', robotsVerdict(robotsTxt, 'Googlebot') === 'ALLOWED', robotsVerdict(robotsTxt, 'Googlebot'));
A('robots.txt must still point at the sitemap', /^Sitemap:\s*https:\/\/tools\.scoreroute\.com\/sitemap\.xml$/m.test(robotsTxt));
// The deliberate design: the wildcard group allows the pages and withholds the JSON API
// from search engines, while the AI retrieval crawlers get /api/ explicitly.
A('robots.txt must withhold /api/ from the wildcard (search-engine) group',
  robotsVerdict(robotsTxt, 'Googlebot', '/api/tools') === 'BLOCKED', robotsVerdict(robotsTxt, 'Googlebot', '/api/tools'));
A('robots.txt must still allow /api/ for the named AI retrieval crawlers',
  robotsVerdict(robotsTxt, 'OAI-SearchBot', '/api/tools') === 'ALLOWED', robotsVerdict(robotsTxt, 'OAI-SearchBot', '/api/tools'));

console.log('\nTIER C2 — the robots parser is non-vacuous (reverting any one line flips its verdict)');
for (const ua of TRAINING) {
  const reverted = robotsTxt.replace(new RegExp('(User-agent:\\s*' + ua + '\\s*\\n)Disallow:\\s*/', 'i'), '$1Allow: /');
  A(`${ua}: flipping Disallow->Allow is detected`, reverted !== robotsTxt && robotsVerdict(reverted, ua) === 'ALLOWED',
    `${robotsVerdict(robotsTxt, ua)} -> ${robotsVerdict(reverted, ua)}`);
}
for (const ua of RETRIEVAL) {
  const reverted = robotsTxt.replace(new RegExp('(User-agent:\\s*' + ua + '\\s*\\n)Allow:\\s*/', 'i'), '$1Disallow: /');
  A(`${ua}: flipping Allow->Disallow is detected`, reverted !== robotsTxt && robotsVerdict(reverted, ua) === 'BLOCKED',
    `${robotsVerdict(robotsTxt, ua)} -> ${robotsVerdict(reverted, ua)}`);
}

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
process.exit(fails ? 1 : 0);
