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

export async function onRequestGet(context) {
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
      const [slug, category, featured, isnew, name, desc, tags] = p;
      const cat = (category || '').trim();
      tools.push({
        slug: slug.trim(),
        name: (name || '').trim(),
        desc: (desc || '').trim(),
        tags: (tags || '').split(',').map(s => s.trim()).filter(Boolean),
        category: cat,
        categoryLabel: CAT_LABELS[cat] || cat,
        featured: (featured || '').trim() === 'yes',
        isnew: (isnew || '').trim() === 'yes',
        url: '/tools/' + slug.trim() + '/'
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
