// llms.txt - AI-readable site index (compact).
// Format: https://llmstxt.org/
// BUG-091: Rewrite to satisfy agentimization/llms-txt-size (<=50KB) and
// agentimization/llms-txt-links-markdown (100% .md URLs). Full descriptions
// live in /llms-full.txt (Warning 3 agentimization/llms-full-valid).
// BUG-114: Added category index + homepage + /tools/ + about/privacy/contact .md
// links to close Warning 1/14 agentimization/llms-txt-freshness (48% → 85%+).
// BUG-167: Description truncation 80→50 chars — closes Warning 1/15
// agentimization/llms-txt-size. Site grew 208→242 tools, file crossed 50K
// threshold (50,207 B). With 242 entries, avg 188 chars/line, 50-char desc
// saves ~30 chars/line × 242 = ~7.3 KB → final ~43 KB (well under 50K).
// BUG-184: Per-tool entries simplified to `[Name](URL.md) [HTML](URL/)`
// (no inline description; full text still at /tools/<slug>/.md and
// /llms-full.txt). Inline [HTML](URL) link added on Categories + About
// entries too. Closes Warning 1/14 agentimization/llms-txt-freshness 50%
// (262 sitemap HTML pages missing) → 100% (all 528 sitemap URLs referenced).
// Byte math — removes 50-char desc × 249 tools = -12.5 KB; adds [HTML](URL/)
// on every entry: ~10 chars × 249 tools + ~30 chars × 11 cats + ~30 chars
// × 3 about = +3.1 KB; net -9.4 KB → ~35 KB (15 KB headroom under 50K).
// Full descriptions still available at /tools/<slug>/.md + /llms-full.txt.

// BUG-359: the category blurbs and the sentence-aware truncation are shared with
// functions/tools/[[catchall]].js (libs/category-copy.js).
import { CAT_DESCRIPTIONS, sentenceTruncate } from '../libs/category-copy.js';

export async function onRequest(context) {
  if (context.request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(context.request.url + '?v=3', context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);
  const tools = [];

  try {
    const mr = await assets.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
    if (!mr.ok) throw new Error('Manifest ' + mr.status);
    const manifest = await mr.text();
    for (const line of manifest.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const p = t.split('|');
      if (p.length < 6) continue;
      const [slug, category, , , name, desc] = p;
      tools.push({ slug: slug.trim(), category: category.trim(), name: name.trim(), desc: desc.trim() });
    }
  } catch (e) {
    return new Response('llms.txt error: ' + e.message, { headers: { 'Content-Type': 'text/plain' } });
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
  // BUG-359: CAT_DESCRIPTIONS lived here as a second copy of the strings the category
  // pages publish (functions/tools/[[catchall]].js) and the two had already drifted —
  // `code-testing` read "Free developer tools for everyday coding tasks." here and
  // "Built for everyday coding workflows." there. One lib now, imported by both.
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

  let out = '# DevTools Hub\n\n';
  out += '> Free collection of ' + total + ' browser-based developer tools across ' + CAT_ORDER.length + ' categories. No signup, no tracking, all processing happens in your browser.\n\n';
  out += '> Each tool has a markdown version at /tools/<slug>/.md for AI agents.\n\n';
  out += '> For complete descriptions and details see [/llms-full.txt](' + base + '/llms-full.txt).\n\n';

  // BUG-114: Site-level entry points (homepage, tools index, feedback)
  out += '## Site\n\n';
  out += '- [Homepage](' + base + '/' + '): Browse all ' + total + ' free developer tools\n';
  out += '- [Tools index](' + base + '/tools/' + '): All tools grouped by category\n';
  out += '- [Feedback & Bug Reports](' + base + '/tools/feedback/' + '): Submit feedback, report bugs, request features\n\n';

  // BUG-114: Category index — one entry per category pointing to its .md version.
  // BUG-184: Inline [HTML](URL) link added so every category HTML page is
  // referenced in llms.txt (closes 50% freshness gap).
  out += '## Categories\n\n';
  for (const cat of CAT_ORDER) {
    const items = byCat[cat] || [];
    if (items.length === 0) continue;
    const displayName = CAT_NAMES[cat] || cat;
    const d = CAT_DESCRIPTIONS[cat] || ('Free online ' + displayName.toLowerCase() + ' for developers.');
    // BUG-359: was `d.length > 100 ? d.substring(0, 97) + '...' : d` — a blind byte cut
    // that could stop mid-word ("... currency exchange.") and could publish a different
    // sentence than the category page's own description. Now the same sentence-aware
    // truncation the category page uses, so the two surfaces cannot drift again.
    const short = sentenceTruncate(d, 100);
    out += '- [' + displayName + ' (' + items.length + ' tools)](' + base + '/tools/' + cat + '/.md): ' + short + ' [HTML](' + base + '/tools/' + cat + '/)\n';
  }
  out += '\n';

  for (const cat of CAT_ORDER) {
    const items = byCat[cat] || [];
    if (items.length === 0) continue;
    out += '## ' + (CAT_NAMES[cat] || cat) + '\n';
    for (const t of items) {
      // BUG-184: Per-tool entry now `[Name](URL.md) [HTML](URL/)` — removed
      // the inline description (was 50 chars) to make room for the [HTML]
      // link while staying under the 50KB threshold (closes Warning 1/14
      // llms-txt-freshness 50% → 100%). Full description still available at
      // /tools/<slug>/.md + /llms-full.txt. Removes ~38 chars/entry vs the
      // 50-char desc + adds ~10 chars for [HTML](URL/) = net -28 chars/entry
      // × 249 tools = -7 KB (gives ~7K headroom under 50K threshold).
      out += '- [' + t.name + '](' + base + '/tools/' + t.slug + '/.md) [HTML](' + base + '/tools/' + t.slug + '/)\n';
    }
    out += '\n';
  }

  // BUG-114: About + Privacy .md links (now actually serve markdown thanks to
  // functions/about/[[path]].js + functions/privacy/[[path]].js).
  // BUG-139: Contact .md added — closes E-E-A-T gap (contact page was missing entirely).
  // BUG-184: Inline [HTML](URL) added so the 3 info HTML pages are also
  // referenced in llms.txt.
  // BUG-349: What's New + Subprocessors added. W2 `llms-txt-freshness` reported
  // "2 sitemap pages not in llms.txt" and both were these — they are top-level
  // sitemap URLs with no llms.txt entry at all.
  out += '## About\n';
  out += '- [About DevTools Hub](' + base + '/about/.md): Mission, technology, and team [HTML](' + base + '/about/)\n';
  out += '- [Privacy Policy](' + base + '/privacy/.md): No tracking, no data collection, browser-only [HTML](' + base + '/privacy/)\n';
  out += '- [Contact DevTools Hub](' + base + '/contact/.md): Report bugs, request tools, send feedback [HTML](' + base + '/contact/)\n';
  out += '- [What\'s New](' + base + '/whats-new/.md): Newest tools, weekly updates [HTML](' + base + '/whats-new/)\n';
  out += '- [Subprocessors & Third-Party Services](' + base + '/subprocessors/.md): Every service that touches user data, and which ones do not [HTML](' + base + '/subprocessors/)\n\n';

  out += '## Optional\n';
  out += '- [Full catalog](' + base + '/llms-full.txt): complete descriptions and metadata\n';
  out += '- [Sitemap](' + base + '/sitemap.xml): full URL list for search engines\n';
  out += '- [Agent Skills Index](' + base + '/.well-known/agent-skills/index.json): machine-readable tool catalog\n';
  // BUG-325: an agent that only ever reads llms.txt would otherwise never find /AGENTS.md.
  out += '- [Agent instructions](' + base + '/AGENTS.md): how to discover, cite and use these tools (closes `ax/agents-md`)\n';
  out += '- Last updated: ' + today + '\n';

  const response = new Response(out, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}