// Dynamic /api/tools - reads /manifest.txt, returns JSON
// Single source of truth: manifest.txt
//
// BUG-287: added `desc` + `tags` to each tool. The homepage search (functions/index.js) lazily
// fetches this endpoint to match queries against ALL tools, because the homepage only renders
// PAGE_SIZE (50) cards per page — without desc/tags the global search had name-only recall.
// Also useful for AI agents consuming the public JSON API.

  // BUG-336: 'formatters' read 'Formatters' here and on the homepage grid while the category
  // page, /tools/, llms.txt and llms-full.txt all called it 'Code Formatters'. The category page
  // is the canonical surface for the slug, so its name wins; see functions/index.js CAT_ORDER.
  const CAT_LABELS = {
    'formatters': 'Code Formatters', 'calculators': 'Calculators', 'generators': 'Generators',
    'converters': 'Converters', 'media': 'Media Tools', 'network': 'Network Tools',
    'code-testing': 'Code Testing', 'pdf-tools': 'PDF Tools',
    'life': 'Daily Life', 'finance': 'Money & Markets',
    'ai-language': 'AI Language',
  };

import { loadManifest } from '../../libs/manifest.js';

export async function onRequestGet(context) {
  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);
  const tools = [];

  try {
    // BUG-513: one manifest parser for every reader (libs/manifest.js).
    for (const t of await loadManifest(assets, baseUrl)) {
      tools.push({
        slug: t.slug,
        name: t.name,
        desc: t.desc,
        tags: t.tags,
        category: t.category,
        categoryLabel: CAT_LABELS[t.category] || t.category,
        featured: t.featured,
        isnew: t.isnew,
        url: '/tools/' + t.slug + '/'
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Tool index unavailable' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    categories: CAT_LABELS,
    tools
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
