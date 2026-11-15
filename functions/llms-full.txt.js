// llms-full.txt - Full AI-readable catalog with complete descriptions.
// Format: https://llmstxt.org/ (extended llms-full.txt spec)
// BUG-091: Companion to /llms.txt (compact index). Satisfies
// agentimization/llms-full-valid (markdown headings) and provides
// machine-readable descriptions for AI agents that need the full catalog.

import { loadManifest } from '../libs/manifest.js';

export async function onRequest(context) {
  if (context.request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(context.request.url + '?v=1', context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);
  const tools = [];

  try {
    // BUG-513: one manifest parser for every reader (libs/manifest.js).
    for (const t of await loadManifest(assets, baseUrl)) {
      tools.push({ slug: t.slug, category: t.category, name: t.name, desc: t.desc, tags: t.tags });
    }
  } catch (e) {
    return new Response('llms-full.txt error: ' + e.message, { headers: { 'Content-Type': 'text/plain' } });
  }

  const CAT_NAMES = {
    'formatters': 'Code Formatters',
    'calculators': 'Calculators',
    'generators': 'Generators',
    'converters': 'Converters',
    'media': 'Media Tools',
    'network': 'Network Tools',
    'code-testing': 'Code Testing',
    'pdf-tools': 'PDF Tools',
    'life': 'Daily Life',
    'finance': 'Money & Markets',
    'ai-language': 'AI Language',
  };
  const CAT_ORDER = Object.keys(CAT_NAMES);
  const knownCats = new Set(CAT_ORDER);
  const byCat = {};
  for (const t of tools) {
    if (!byCat[t.category]) byCat[t.category] = [];
    byCat[t.category].push(t);
    if (!knownCats.has(t.category)) { CAT_ORDER.push(t.category); knownCats.add(t.category); }
  }
  const total = tools.length;
  const today = new Date().toISOString().split('T')[0];
  const base = 'https://tools.scoreroute.com';

  let out = '# DevTools Hub - Full Catalog\n\n';
  out += '> Complete catalog of ' + total + ' browser-based developer tools. For a compact index see [/llms.txt](' + base + '/llms.txt).\n\n';
  out += '## Site Information\n\n';
  out += '- Name: DevTools Hub\n';
  out += '- URL: ' + base + '/\n';
  out += '- Owner: BAOMING\n';
  out += '- Host: Cloudflare Pages\n';
  out += '- Total tools: ' + total + '\n';
  out += '- Categories: ' + CAT_ORDER.length + '\n';
  out += '- Last updated: ' + today + '\n';
  out += '- License: Free to use, no signup, no tracking, 100% client-side\n\n';

  for (const cat of CAT_ORDER) {
    const items = byCat[cat] || [];
    if (items.length === 0) continue;
    const displayName = CAT_NAMES[cat] || cat;
    out += '## ' + displayName + ' (' + items.length + ' tools)\n\n';
    out += 'Browse all: [' + displayName + '](' + base + '/tools/' + cat + '/.md)\n\n';
    for (const t of items) {
      out += '### ' + t.name + '\n\n';
      out += '- URL: ' + base + '/tools/' + t.slug + '/\n';
      out += '- Markdown: ' + base + '/tools/' + t.slug + '/.md\n';
      out += '- Category: ' + displayName + '\n';
      if (t.tags) {
        const tagList = t.tags.join(', ');
        if (tagList) out += '- Tags: ' + tagList + '\n';
      }
      out += '\n' + t.desc + '\n\n';
    }
  }

  out += '## Pages\n\n';
  out += '- [Homepage](' + base + '/): Browse all ' + total + ' tools\n';
  out += '- [About](' + base + '/about/): Mission, technology stack, contact\n';
  out += '- [Privacy Policy](' + base + '/privacy/): No tracking, no personal data collection\n';
  out += '- [Contact](' + base + '/contact/): Report a bug, request a tool, or send feedback\n';
  // BUG-349: keeps this list in step with llms.txt + sitemap.xml — the two pages W2
  // `llms-txt-freshness` reported as "sitemap pages not in llms.txt".
  out += '- [What\'s New](' + base + '/whats-new/): Newest tools and weekly updates\n';
  out += '- [Subprocessors](' + base + '/subprocessors/): Third-party services that touch user data\n';
  out += '- [Feedback](' + base + '/tools/feedback/): Submit bugs or feature requests\n';
  out += '- [Sitemap](' + base + '/sitemap.xml): Full URL list for search engines\n';
  out += '- [Compact llms.txt](' + base + '/llms.txt): Short index for AI agents\n\n';

  const response = new Response(out, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}