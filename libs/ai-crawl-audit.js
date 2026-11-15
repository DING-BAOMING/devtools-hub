// AI crawler access + llms.txt audit logic (RFC 9309 robots.txt matcher + llmstxt.org spec).
// Pure functions, no I/O — imported by functions/api/ai-crawler-checker.js and by
// devtools-hub-docs/test-scripts/ai-crawler-checker-logic-test.mjs so the rules are
// testable in Node without a Worker runtime.

export const AI_CRAWLERS = [
  { token: 'GPTBot', vendor: 'OpenAI', use: 'training', note: 'Model training crawler' },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', use: 'search', note: 'Powers results in ChatGPT search' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', use: 'search', note: 'Fetched when a user pastes your link in ChatGPT' },
  { token: 'ClaudeBot', vendor: 'Anthropic', use: 'training', note: 'Training and retrieval index; replaced anthropic-ai' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', use: 'search', note: 'Powers results in Claude search' },
  { token: 'Claude-User', vendor: 'Anthropic', use: 'search', note: 'Fetched when a user pastes your link in Claude' },
  { token: 'anthropic-ai', vendor: 'Anthropic', use: 'training', note: 'Legacy agent token, superseded by ClaudeBot' },
  { token: 'PerplexityBot', vendor: 'Perplexity', use: 'search', note: 'Index behind Perplexity answers' },
  { token: 'Perplexity-User', vendor: 'Perplexity', use: 'search', note: 'Fetched when a user asks Perplexity about your page' },
  { token: 'Googlebot', vendor: 'Google', use: 'search', note: 'Google Search and AI Overviews' },
  { token: 'Google-Extended', vendor: 'Google', use: 'training', note: 'Gemini grounding and training only, no effect on Google Search' },
  { token: 'Bingbot', vendor: 'Microsoft', use: 'search', note: 'Bing index, also used by Copilot' },
  { token: 'Applebot-Extended', vendor: 'Apple', use: 'training', note: 'Apple Intelligence' },
  { token: 'meta-externalagent', vendor: 'Meta', use: 'training', note: 'Meta AI crawler' },
  { token: 'CCBot', vendor: 'Common Crawl', use: 'training', note: 'Open crawl dataset most model training runs on' },
  { token: 'Amazonbot', vendor: 'Amazon', use: 'search', note: 'Alexa and Rufus answers' },
  { token: 'cohere-ai', vendor: 'Cohere', use: 'training', note: 'Model training and research' },
  { token: 'Bytespider', vendor: 'ByteDance', use: 'training', note: 'Doubao and TikTok models' },
  { token: 'MistralAI-User', vendor: 'Mistral', use: 'search', note: 'Fetched when a user asks Le Chat about your page' },
];

const BLOCKED_HOST_SUFFIX = ['.local', '.internal', '.localhost', '.home.arpa', '.lan', '.test', '.invalid', '.example'];

// Requires a real public hostname: at least one dot, alphabetic TLD. This also rejects
// IP literals and bare hostnames (localhost, 10.0.0.1, 169.254.169.254), which is the
// SSRF guard — this endpoint fetches a URL the visitor supplies.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  d = d.split('@').pop().split(':')[0].replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) return null;
  if (d.split('.').slice(1).some((part) => BLOCKED_HOST_SUFFIX.includes('.' + part))) return null;
  return d;
}

export function isValidDomain(input) {
  return normalizeDomain(input) !== null;
}

// robots.txt path matching: '*' is any sequence of characters, a trailing '$' anchors
// the end of the path. Longest matching rule wins; Allow wins ties (RFC 9309 2.2.2).
function patternToRegExp(pattern) {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const body = p.split('*').map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let pendingAgents = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!value) continue;
      if (current && current.rules.length === 0 && current.agents.length > 0) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
      }
      pendingAgents = current;
      continue;
    }
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field !== 'allow' && field !== 'disallow' && field !== 'crawl-delay') continue;
    if (!current) continue; // rules before any user-agent line are invalid and ignored
    if (field === 'crawl-delay') {
      current.crawlDelay = value;
      continue;
    }
    // "Allow:" with an empty value is meaningless and ignored; "Disallow:" with an empty
    // value is a no-op too, not a rule that matches everything (RFC 9309 2.2.2), so both
    // are dropped here. A group left with no rules allows everything.
    if (value === '') continue;
    current.rules.push({ type: field, path: value });
  }

  return { groups, sitemaps, hasWildcard: groups.some((g) => g.agents.includes('*')) };
}

// robots.txt lint against Google's documented interpretation of the REP
// (developers.google.com/search/docs/crawling-indexing/robots/robots_txt, fetched
// 2026-11-08) and RFC 9309. Pure function, no I/O — shared by
// functions/api/robots-txt.js and by the logic test, so the rules a page reports
// are the rules the API enforces.
//
// Every message below is traceable to one of these documented facts:
//  - Google ignores the BOM, invalid lines and unknown fields; crawl-delay is not supported.
//  - Rules with no path are ignored, so a blank Disallow allows everything.
//  - The most specific group wins and specific/wildcard groups are never combined.
//  - The longest matching rule wins; on an equal-length conflict Google uses the
//    least restrictive rule (so Allow: / cancels an equal-length Disallow: /).
//  - Sitemap must be a fully qualified URL, is not tied to any user agent, and is
//    only followed by crawlers it is not disallowed for.
//  - noindex in robots.txt is not supported by Google.
//  - The file size limit is 500 KiB and content past it is ignored.
//  - A 4xx (except 429) means no restrictions; a 5xx means crawling stops.
const SUPPORTED_FIELDS = ['user-agent', 'allow', 'disallow', 'sitemap'];
const SIZE_LIMIT_BYTES = 500 * 1024;

export function validateRobotsTxt(text, opts = {}) {
  const issues = [];
  const raw = String(text == null ? '' : text);
  const body = raw.replace(/^﻿/, '');
  if (raw.length !== body.length) {
    issues.push({ level: 'warn', code: 'bom', msg: 'The file starts with a UTF-8 byte order mark. Google ignores the BOM and still parses the file, but other parsers may not, so re-save as plain UTF-8 without it.' });
  }

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > SIZE_LIMIT_BYTES) {
    issues.push({ level: 'error', code: 'size', msg: 'The file is ' + bytes + ' bytes and Google stops reading a robots.txt after 500 KiB (512,000 bytes); everything past that point is ignored. Consolidate rules instead of adding more lines.' });
  }

  if (/<(!doctype|html[\s>])/i.test(body)) {
    issues.push({ level: 'error', code: 'html', msg: 'This looks like an HTML page rather than rules. Google tries to extract rules from HTML and ignores the rest, so a server that answers /robots.txt with your 404 page is publishing a file that blocks nothing.' });
  }

  const parsed = parseRobots(body);
  const lines = body.split(/\r?\n/);
  let sawUserAgent = false;
  let orphanRules = 0;
  let blankDisallows = 0;
  let crawlDelay = 0;
  let noindex = 0;
  let hostLines = 0;
  const unknownFields = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) {
      issues.push({ level: 'info', code: 'no-colon', line: i + 1, msg: 'Line ' + (i + 1) + ' has no field name and colon, so every parser skips it: "' + lines[i].slice(0, 60) + '"' });
      continue;
    }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      sawUserAgent = value !== '';
      continue;
    }
    if (!sawUserAgent) {
      orphanRules += 1;
      continue;
    }
    if (field === 'disallow' && value === '') {
      blankDisallows += 1;
      continue;
    }
    if (!SUPPORTED_FIELDS.includes(field)) {
      if (field === 'crawl-delay') crawlDelay += 1;
      else if (field === 'noindex') noindex += 1;
      else if (field === 'host') hostLines += 1;
      else unknownFields.push(field);
    }
  }

  if (orphanRules) {
    issues.push({ level: 'warn', code: 'orphan-rules', occurrences: orphanRules, msg: orphanRules + ' Allow, Disallow, Sitemap or Crawl-delay line' + (orphanRules === 1 ? '' : 's') + ' appear before the first User-agent line. Crawlers ignore rules that have no group, so ' + (orphanRules === 1 ? 'it does' : 'they do') + ' nothing.' });
  }
  if (blankDisallows) {
    issues.push({ level: 'warn', code: 'blank-disallow', occurrences: blankDisallows, msg: 'A Disallow with no path is ignored, which means "allow everything", not "block everything". ' + blankDisallows + ' such line' + (blankDisallows === 1 ? '' : 's') + ' found; write Disallow: / to block a whole site.' });
  }
  if (crawlDelay) {
    issues.push({ level: 'info', code: 'crawl-delay', occurrences: crawlDelay, msg: 'Crawl-delay is not a Google directive and is ignored here. It only tells crawlers that read it to slow down, so a large value costs you crawl budget without protecting anything.' });
  }
  if (noindex) {
    issues.push({ level: 'error', code: 'noindex', occurrences: noindex, msg: 'Google does not support Noindex in robots.txt. The page has to be crawlable for a noindex to work, so use a noindex meta tag or an X-Robots-Tag header on the page itself.' });
  }
  if (hostLines) {
    issues.push({ level: 'info', code: 'host', occurrences: hostLines, msg: 'Host is a Yandex directive. Google ignores it, and for this purpose a canonical link or a redirect is the documented way to pick a preferred domain.' });
  }
  if (unknownFields.length) {
    const names = Array.from(new Set(unknownFields));
    issues.push({ level: 'info', code: 'unknown-field', occurrences: unknownFields.length, msg: 'Unsupported field' + (names.length === 1 ? '' : 's') + ' ' + names.map((f) => '"' + f + '"').join(', ') + ' will be skipped by every parser. Google supports only User-agent, Allow, Disallow and Sitemap.' });
  }

  // A sitemap URL is only followed when it is not itself disallowed, and the value
  // has to be a fully qualified URL including protocol and host.
  for (const sitemap of parsed.sitemaps) {
    if (!/^https?:\/\//i.test(sitemap)) {
      issues.push({ level: 'error', code: 'sitemap-relative', msg: 'Sitemap lines must be a complete URL including the protocol, for example https://example.com/sitemap.xml. "' + sitemap + '" is not one, and a relative Sitemap line is ignored.' });
      continue;
    }
    let path = '/';
    try { path = new URL(sitemap).pathname || '/'; } catch (e) { /* the absolute test above already passed */ }
    const access = checkAccess(parsed, '*', path);
    if (access.allowed === false) {
      issues.push({ level: 'error', code: 'sitemap-blocked', msg: 'The sitemap you declared is itself disallowed: ' + sitemap + ' is blocked by Disallow: ' + access.rule + ' for the wildcard group. A sitemap is only followed by crawlers it is not disallowed for, so this line advertises a file nobody can fetch.' });
    }
  }

  const perAgent = new Map();
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      perAgent.set(agent, (perAgent.get(agent) || 0) + 1);
    }
    const disallowsRoot = group.rules.filter((r) => r.type === 'disallow' && r.path === '/');
    if (disallowsRoot.length) {
      const allowsRoot = group.rules.some((r) => r.type === 'allow' && r.path.length >= 1 && (r.path === '/' || r.path === '/*'));
      const who = group.agents.includes('*') ? 'every crawler that has no group of its own' : group.agents.join(', ');
      if (allowsRoot) {
        issues.push({ level: 'warn', code: 'root-cancelled', msg: 'This group has both Disallow: / and an Allow rule covering the root, so the Allow wins: the group blocks nothing. Affected crawlers: ' + who + '.' });
      } else {
        issues.push({ level: 'error', code: 'root-blocked', msg: 'Disallow: / in the group for ' + who + ' blocks the entire host. Google may still index URLs it learns from other sites, without a snippet.' });
      }
    }
    for (const rule of group.rules) {
      if (rule.path.length > 1 && !rule.path.startsWith('/')) {
        issues.push({ level: 'warn', code: 'relative-path', msg: 'The path in a rule must start with / because it is matched against the URL path. "' + rule.path + '" does not, so it is treated as text and never matches.' });
      }
    }
  }

  const duplicateAgents = Array.from(perAgent.entries()).filter(([, n]) => n > 1).map(([a]) => a);
  if (duplicateAgents.length) {
    issues.push({ level: 'info', code: 'duplicate-agent', occurrences: duplicateAgents.length, msg: 'These user agents appear in more than one group: ' + duplicateAgents.join(', ') + '. Compliant parsers merge the rules of every group naming the same agent, so splitting one crawler across two groups works but is easy to misread later.' });
  }
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      if ((agent.includes('*') || agent.includes('/')) && agent !== '*') {
        issues.push({ level: 'info', code: 'agent-pattern', msg: 'A user agent value with a wildcard or a version suffix matches the bare crawler name, so "' + agent + '" is read as "' + agent.replace(/[*]/g, '').split('/')[0] + '". Write the bare token so the group is obvious.' });
      }
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => (order[a.level] - order[b.level]) || ((a.line || 0) - (b.line || 0)));

  return {
    issues: condenseIssues(issues, 3),
    stats: {
      bytes,
      groups: parsed.groups.length,
      agents: new Set(parsed.groups.flatMap((g) => g.agents)).size,
      rules: parsed.groups.reduce((n, g) => n + g.rules.length, 0),
      sitemaps: parsed.sitemaps.length,
      lines: lines.length,
      hasWildcard: parsed.hasWildcard,
      errors: issues.filter((i) => i.level === 'error').length,
      warns: issues.filter((i) => i.level === 'warn').length,
      infos: issues.filter((i) => i.level === 'info').length
    },
    parsed
  };
}

// Returns { allowed, rule, source } where source is the group that decided it:
// 'agent' = a group named for this exact crawler, 'wildcard' = the * group, 'none' = no rules apply.
export function checkAccess(robots, token, path) {
  const groups = (robots && robots.groups) || [];
  const wanted = String(token || '').toLowerCase();
  let group = groups.find((g) => g.agents.includes(wanted)) || null;
  let source = 'agent';
  if (!group) {
    group = groups.find((g) => g.agents.includes('*')) || null;
    source = 'wildcard';
  }
  if (!group) return { allowed: true, rule: null, source: 'none' };

  let best = null;
  for (const rule of group.rules) {
    if (rule.type !== 'allow' && rule.type !== 'disallow') continue;
    if (!patternToRegExp(rule.path).test(path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.type === 'allow')) {
      best = rule;
    }
  }
  if (!best) return { allowed: true, rule: null, source };
  return { allowed: best.type === 'allow', rule: best.path, source };
}

const LIST_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

// One file can trip the same rule on 300 lines (two links per list item across a whole
// catalogue, say). Emitting every hit buries the two findings that matter and drives the
// score to zero, so repeats of one code collapse into a single counted issue.
export function condenseIssues(issues, maxPerCode = 3) {
  const groups = new Map();
  for (const issue of issues) {
    if (!groups.has(issue.code)) groups.set(issue.code, []);
    groups.get(issue.code).push(issue);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length <= maxPerCode) {
      out.push.apply(out, list);
      continue;
    }
    const first = list[0];
    out.push({
      level: first.level,
      code: first.code,
      occurrences: list.length,
      msg: first.msg.replace(/\.\s*$/, '') + '. Found ' + list.length + ' times' + (first.line ? ', starting at line ' + first.line : '') + '.',
    });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => (rank[a.level] - rank[b.level]) || ((a.code < b.code) ? -1 : 1));
}

export function validateLlmsTxt(text) {
  const issues = [];
  const body = String(text || '').replace(/^\uFEFF/, '');
  const trimmed = body.trim();

  if (!trimmed) {
    issues.push({ level: 'error', code: 'empty', msg: 'The file exists but is empty.' });
    return { issues: condenseIssues(issues), stats: { h1: null, sections: 0, links: 0, words: 0, bytes: body.length } };
  }
  if (/^<(!doctype|html|\?xml)/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    issues.push({ level: 'error', code: 'html', msg: 'This is an HTML page, not markdown. An AI agent will read the markup instead of your content.' });
    return { issues: condenseIssues(issues), stats: { h1: null, sections: 0, links: 0, words: 0, bytes: body.length } };
  }
  if (/^[[{]/.test(trimmed)) {
    issues.push({ level: 'error', code: 'json', msg: 'This looks like JSON, not markdown. llms.txt is a plain markdown file.' });
    return { issues: condenseIssues(issues), stats: { h1: null, sections: 0, links: 0, words: 0, bytes: body.length } };
  }

  const lines = trimmed.split(/\r?\n/);
  const h1Lines = lines.filter((l) => /^#\s+\S/.test(l));
  let h1 = null;
  if (h1Lines.length === 0) {
    issues.push({ level: 'error', code: 'no-h1', msg: 'No H1 heading. The spec requires a single "# Name" line as the first line, and it is the only mandatory part of the file.' });
  } else if (h1Lines.length > 1) {
    issues.push({ level: 'error', code: 'multi-h1', msg: h1Lines.length + ' H1 headings found. Use exactly one; everything below it should be a "## Section".' });
    h1 = h1Lines[0].replace(/^#\s+/, '').trim();
  } else {
    h1 = h1Lines[0].replace(/^#\s+/, '').trim();
    const firstContent = lines.find((l) => l.trim() !== '');
    if (firstContent !== h1Lines[0]) {
      issues.push({ level: 'warn', code: 'h1-not-first', msg: 'The H1 must be the first line of the file. It is currently buried under other content.' });
    }
    if (!h1) issues.push({ level: 'error', code: 'empty-h1', msg: 'The H1 is empty. Put your site or product name there.' });
  }

  const h1Index = h1Lines.length ? lines.indexOf(h1Lines[0]) : -1;
  const afterH1 = h1Index >= 0 ? lines.slice(h1Index + 1) : [];
  const hasQuote = afterH1.some((l) => /^\s*>\s*\S/.test(l));
  if (!hasQuote) {
    issues.push({ level: 'warn', code: 'no-summary', msg: 'No blockquote summary. A "> one paragraph summary" right after the H1 is what most agents read first.' });
  }

  const sections = [];
  let currentSection = null;
  let strayLinks = 0;
  const seenUrls = new Map();

  lines.forEach((line, i) => {
    if (/^##\s+\S/.test(line)) {
      currentSection = { title: line.replace(/^##\s+/, '').trim(), links: 0, startLine: i + 1 };
      sections.push(currentSection);
      return;
    }
    if (/^#\s+\S/.test(line)) return;
    const item = line.match(LIST_ITEM_RE);
    if (!item) return;
    MD_LINK_RE.lastIndex = 0;
    const links = [];
    let m;
    while ((m = MD_LINK_RE.exec(item[1])) !== null) links.push({ text: m[1], url: m[2] });
    if (links.length === 0) return;
    if (!currentSection) {
      strayLinks += links.length;
      return;
    }
    // The spec wants one link per list item, "- [name](url): note". Taking the first
    // link still audits the entry correctly; a second link on the same line is a real
    // spec miss worth reporting, not a reason to drop the entry.
    currentSection.links++;
    if (links.length > 1) {
      issues.push({ level: 'warn', code: 'multi-link', line: i + 1, msg: 'Line ' + (i + 1) + ' has ' + links.length + ' links in one list item. Use one "- [name](url): note" per line so an agent can tell which name belongs to which URL.' });
    }
    const url = links[0].url;
    if (!/^https?:\/\//i.test(url)) {
      issues.push({ level: 'warn', code: 'relative-url', line: i + 1, msg: 'Link "' + url + '" is relative. Use full absolute URLs (https://yourdomain.com/...) so an agent that fetched only this file can follow it.' });
    }
    if (seenUrls.has(url)) {
      issues.push({ level: 'warn', code: 'dup-url', line: i + 1, msg: 'The URL ' + url + ' is listed more than once (lines ' + seenUrls.get(url) + ' and ' + (i + 1) + '). One page belongs in one section.' });
    } else {
      seenUrls.set(url, i + 1);
    }
    if (!links[0].text.trim()) {
      issues.push({ level: 'warn', code: 'empty-link-text', line: i + 1, msg: 'A link on line ' + (i + 1) + ' has no name. Agents rank by link text, not by URL.' });
    }
  });

  for (const s of sections) {
    if (s.links === 0) {
      issues.push({ level: 'warn', code: 'empty-section', line: s.startLine, msg: 'Section "' + s.title + '" has no links. Empty sections waste the token budget an agent spends reading the file.' });
    }
  }
  if (sections.length === 0) {
    issues.push({ level: 'warn', code: 'no-sections', msg: 'No "## Section" headings. Without sections, an agent gets a name and nothing to read.' });
  }
  if (strayLinks > 0) {
    issues.push({ level: 'warn', code: 'stray-links', msg: strayLinks + ' link' + (strayLinks > 1 ? 's are' : ' is') + ' outside any section. Move them under a "##" heading.' });
  }

  return {
    issues: condenseIssues(issues),
    stats: {
      h1,
      sections: sections.length,
      sectionTitles: sections.map((s) => s.title),
      links: seenUrls.size,
      words: trimmed.split(/\s+/).filter(Boolean).length,
      bytes: body.length,
    },
  };
}

const AI_GROUP_TEMPLATE = [
  'User-agent: GPTBot',
  'Allow: /',
  '',
  'User-agent: OAI-SearchBot',
  'Allow: /',
  '',
  'User-agent: ChatGPT-User',
  'Allow: /',
  '',
  'User-agent: ClaudeBot',
  'Allow: /',
  '',
  'User-agent: Claude-SearchBot',
  'Allow: /',
  '',
  'User-agent: PerplexityBot',
  'Allow: /',
  '',
  'User-agent: Google-Extended',
  'Allow: /',
  '',
  'User-agent: Applebot-Extended',
  'Allow: /',
  '',
  'User-agent: meta-externalagent',
  'Allow: /',
  '',
  'User-agent: CCBot',
  'Allow: /',
];

export function llmsTxtTemplate(domain) {
  return [
    '# ' + domain,
    '',
    '> One paragraph describing what this site is for and who it is for. This is the only part most agents read before deciding to keep going.',
    '',
    '## Docs',
    '',
    '- [Getting started](https://' + domain + '/docs/start): the shortest path from zero to a working result.',
    '- [API reference](https://' + domain + '/docs/api): every endpoint, parameter and limit.',
    '',
    '## Optional',
    '',
    '- [Changelog](https://' + domain + '/changelog): only if it helps an agent understand current behaviour.',
  ].join('\n');
}

// Ties the two files together. Every finding here is a state an LLM reading a pasted
// robots.txt cannot get right, because it depends on RFC 9309 precedence plus whether
// the other file exists at all.
export function audit(input) {
  const { domain, robotsTxt, robotsStatus, robotsType, llmsTxt, llmsStatus, llmsType, llmsFullStatus, homepageHtml, homeStatus } = input;

  // A domain that does not resolve must never score well. Cloudflare answers an
  // unresolvable host with a 530 page rather than a connection error, so "0 or 5xx"
  // is the dead signal, and both the homepage and robots.txt have to be dead before
  // that is the conclusion.
  const homeDead = homeStatus === undefined ? false : (homeStatus === 0 || homeStatus >= 500);
  const robotsDead = robotsStatus === 0 || robotsStatus >= 500;
  const domainResolves = !(homeDead && robotsDead);
  if (!domainResolves) {
    return {
      domain,
      domainResolves: false,
      homeStatus,
      robots: { found: false, status: robotsStatus, looksHtml: false, bytes: 0, groups: 0, namedGroups: 0, sitemaps: [], content: '' },
      crawlers: [],
      llms: { found: false, status: llmsStatus, contentType: '', fullFound: false, content: '', validation: null },
      findings: [{ level: 'error', area: 'dns', title: 'The domain did not resolve', msg: 'Neither the homepage nor /robots.txt answered, so there is nothing to audit. Check the spelling, or the domain may not exist yet.' }],
      score: 0,
      grade: 'F',
      fixes: { robotsGroup: AI_GROUP_TEMPLATE.join('\n'), llmsTemplate: llmsTxtTemplate(domain) },
    };
  }

  // status: 200 = retrieved, 404/410 = not published (which means "no restrictions"),
  // 0 = could not be reached at all, anything else = served but unusable.
  const robotsPresent = robotsStatus === 200;
  const robots = robotsPresent ? parseRobots(robotsTxt) : { groups: [], sitemaps: [] };
  const robotsLooksHtml = robotsPresent && /^\s*(<!doctype|<html)/i.test(String(robotsTxt || ''));

  const crawlers = AI_CRAWLERS.map((c) => {
    const root = checkAccess(robots, c.token, '/');
    const llms = checkAccess(robots, c.token, '/llms.txt');
    return {
      token: c.token,
      vendor: c.vendor,
      use: c.use,
      note: c.note,
      rootAllowed: root.allowed,
      llmsAllowed: llms.allowed,
      rule: llms.rule || root.rule,
      source: llms.source,
    };
  });

  const byToken = Object.fromEntries(crawlers.map((c) => [c.token, c]));
  const searchCrawlers = crawlers.filter((c) => c.use === 'search');
  const llmsFound = llmsStatus === 200;
  const validation = llmsFound ? validateLlmsTxt(llmsTxt) : null;

  const findings = [];

  if (robotsStatus === 0) {
    findings.push({ level: 'error', area: 'robots', title: 'Could not reach /robots.txt', msg: 'The request did not complete, so nothing below about this file could be verified. A crawler facing the same timeout sees the same thing: treat the whole site as unreachable rather than as open.' });
  } else if (!robotsPresent) {
    findings.push({ level: 'info', area: 'robots', title: 'No robots.txt, so nothing is blocked', msg: 'When /robots.txt returns 404 every crawler is allowed to fetch everything. That is fine, but it also means you have no place to state a policy, and no Sitemap: line for AI agents to read.' });
  } else if (robotsLooksHtml) {
    findings.push({ level: 'error', area: 'robots', title: '/robots.txt returns an HTML page', msg: 'The file loads with a 200 status but the body is HTML, usually a soft-404 or a "page not found" template. Crawlers that parse it strictly will treat the whole site as disallowed.' });
  } else if (!robots.hasWildcard && robots.groups.length === 0) {
    findings.push({ level: 'warn', area: 'robots', title: 'robots.txt has no usable groups', msg: 'No User-agent group was found, so no rule applies to any crawler.' });
  } else if (!robots.hasWildcard) {
    findings.push({ level: 'warn', area: 'robots', title: 'No wildcard group in robots.txt', msg: 'Every crawler is named explicitly. Any agent not on that list, including newer AI crawlers, falls back to your server defaults.' });
  }

  const namedGroups = robots.groups.filter((g) => !g.agents.includes('*') && g.agents.length > 0);
  const aiNamed = namedGroups.filter((g) => g.agents.some((a) => AI_CRAWLERS.some((c) => c.token.toLowerCase() === a)));
  if (robotsPresent && robots.hasWildcard && aiNamed.length === 0) {
    findings.push({ level: 'warn', area: 'robots', title: 'No AI crawler has its own group', msg: 'Every AI bot is falling through to the wildcard "*" group, so your access decision for ChatGPT is whatever that group happens to say. A named group always wins over the wildcard, so adding one lets you allow search bots while blocking training crawlers.' });
  }

  if (!llmsFound) {
    findings.push({ level: 'error', area: 'llms', title: 'No llms.txt at /llms.txt', msg: 'This is the file the llmstxt.org convention asks you to publish at the root of every domain. Without it an agent has to guess which of your pages matter, and it usually guesses wrong.' });
  } else {
    const blockedSearch = searchCrawlers.filter((c) => !c.llmsAllowed);
    if (searchCrawlers.length > 0 && blockedSearch.length === searchCrawlers.length) {
      findings.push({ level: 'error', area: 'llms', title: 'Every AI search crawler is blocked from /llms.txt', msg: 'The file is published, but no AI search agent can reach it. This is the single most common reason a site has an llms.txt and still gets no AI traffic.' });
    } else if (blockedSearch.length > 0) {
      findings.push({ level: 'warn', area: 'llms', title: blockedSearch.length + ' of ' + searchCrawlers.length + ' AI search crawlers cannot read /llms.txt', msg: 'Blocked: ' + blockedSearch.map((c) => c.token).join(', ') + '. Each one takes its rules from the same group, so a single line usually fixes all of them.' });
    }
    if (llmsType && /text\/html/i.test(llmsType)) {
      findings.push({ level: 'warn', area: 'llms', title: '/llms.txt is served as text/html', msg: 'It should be served as text/plain or text/markdown. Some fetchers refuse to treat an HTML content type as a document.' });
    }
  }

  if (llmsFound && llmsFullStatus !== 200) {
    findings.push({ level: 'warn', area: 'llms', title: 'No llms-full.txt', msg: 'llms.txt is meant to be a short index. The full text version, /llms-full.txt, is where the actual content goes. Many agents will look for it and give up on a one-line index.' });
  }

  if (llmsFound && homepageHtml && !/\/llms\.txt/i.test(String(homepageHtml))) {
    findings.push({ level: 'info', area: 'llms', title: 'Nothing on the homepage points at /llms.txt', msg: 'Discovering the file relies on the agent guessing the convention. A plain <a href="/llms.txt"> link or a Sitemap: entry in robots.txt makes it certain.' });
  }
  if (llmsFound && robots.sitemaps.length === 0) {
    findings.push({ level: 'info', area: 'robots', title: 'No Sitemap: line in robots.txt', msg: 'Adding Sitemap: https://' + domain + '/sitemap.xml gives crawlers, including AI agents, a definitive list of what exists on the site.' });
  }

  // The mistakes that are widely repeated, and that a chatbot reading a pasted
  // robots.txt will confidently get backwards.
  if (byToken.GPTBot && byToken['OAI-SearchBot']) {
    if (!byToken.GPTBot.llmsAllowed && byToken['OAI-SearchBot'].llmsAllowed) {
      findings.push({ level: 'info', area: 'policy', title: 'Training blocked, ChatGPT search allowed', msg: 'GPTBot and OAI-SearchBot are separate crawlers with separate jobs. Blocking GPTBot stops OpenAI training on your pages; allowing OAI-SearchBot keeps ChatGPT able to cite you. If that is deliberate, nothing needs fixing. It is the most common setup on the web and it is usually done by accident in the other direction.' });
    } else if (byToken.GPTBot.llmsAllowed && !byToken['OAI-SearchBot'].llmsAllowed) {
      findings.push({ level: 'warn', area: 'policy', title: 'You allow OpenAI training but block its search bot', msg: 'OAI-SearchBot is the crawler that feeds ChatGPT search results. Blocking it while allowing GPTBot means your pages can be used for training but will not be cited in answers, which is the opposite of what most sites want.' });
    }
  }
  if (byToken.Googlebot && byToken['Google-Extended']) {
    if (!byToken.Googlebot.rootAllowed) {
      findings.push({ level: 'error', area: 'policy', title: 'Googlebot is blocked', msg: 'Google-Extended only controls Gemini training and grounding. It has no effect on Google Search or AI Overviews. If Googlebot is blocked, you have removed yourself from Google entirely.' });
    } else if (!byToken['Google-Extended'].rootAllowed) {
      findings.push({ level: 'info', area: 'policy', title: 'Google-Extended is blocked, Googlebot is not', msg: 'This is a real choice, not a bug. You stay in Google Search and AI Overviews while opting out of Gemini training and grounding.' });
    }
  }
  const wildcard = robots.groups.find((g) => g.agents.includes('*'));
  if (wildcard && wildcard.rules.some((r) => r.type === 'disallow' && r.path === '/') && wildcard.rules.some((r) => r.type === 'allow' && r.path === '/')) {
    findings.push({ level: 'info', area: 'policy', title: 'Disallow: / and Allow: / sit in the same group', msg: 'Allow and Disallow have the same length, and Allow wins ties, so the site is open. The Disallow: / line does nothing and is worth deleting so the next reader is not misled.' });
  }

  // The meta layer contradicts the robots layer more often than anyone realises:
  // ai-train:no / noai / nomodai in a <meta name="robots"> while robots.txt says
  // "User-agent: GPTBot / Allow: /" sends two different signals to the same crawler,
  // and no engine documents which one wins.
  const metaDirectives = [];
  const metaTag = String(homepageHtml || '').match(/<meta[^>]+name=["']robots["'][^>]*>/i);
  if (metaTag) {
    const content = (metaTag[0].match(/content=["']([^"']*)["']/i) || [])[1] || '';
    for (const d of ['ai-train:no', 'noai', 'nomodai', 'noimageai', 'notrain']) {
      if (content.toLowerCase().includes(d)) metaDirectives.push(d);
    }
  }
  const trainingAllowed = crawlers.filter((c) => c.use === 'training' && c.rootAllowed).map((c) => c.token);
  if (metaDirectives.length > 0 && trainingAllowed.length > 0) {
    findings.push({ level: 'warn', area: 'policy', title: 'Your meta robots and robots.txt disagree about AI training', msg: 'The homepage meta tag carries "' + metaDirectives.join(', ') + '", while robots.txt lets ' + trainingAllowed.length + ' training crawler' + (trainingAllowed.length > 1 ? 's' : '') + ' through (' + trainingAllowed.slice(0, 5).join(', ') + '). These are two different signals to the same bot and no engine documents which one it honours. Pick one. Blocking training in robots.txt is the only layer every crawler is required to read.' });
  }

  const errors = findings.filter((f) => f.level === 'error').length + (validation ? validation.issues.filter((i) => i.level === 'error').length : 0);
  const warns = findings.filter((f) => f.level === 'warn').length + (validation ? validation.issues.filter((i) => i.level === 'warn').length : 0);
  const score = Math.max(0, Math.min(100, 100 - errors * 12 - warns * 5));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : score >= 45 ? 'E' : 'F';

  return {
    domain,
    domainResolves: true,
    homeStatus,
    robots: {
      found: robotsPresent,
      status: robotsStatus,
      looksHtml: robotsLooksHtml,
      bytes: robotsPresent ? String(robotsTxt || '').length : 0,
      groups: robots.groups.length,
      namedGroups: namedGroups.length,
      sitemaps: robots.sitemaps,
      content: robotsPresent ? String(robotsTxt || '').slice(0, 20000) : '',
    },
    crawlers,
    llms: {
      found: llmsFound,
      status: llmsStatus,
      contentType: llmsType || '',
      fullFound: llmsFullStatus === 200,
      content: llmsFound ? String(llmsTxt || '').slice(0, 20000) : '',
      validation,
    },
    findings,
    score,
    grade,
    fixes: {
      robotsGroup: AI_GROUP_TEMPLATE.join('\n'),
      llmsTemplate: llmsTxtTemplate(domain),
    },
  };
}
