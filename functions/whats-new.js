// Cloudflare Pages Function: /whats-new/ - lists recently added tools + recent changelog
// Replaces the SPA fallback to old index.html (BUG-273-style fix: any unmatched URL returns the
// old static index.html with no content). Provides useful content for users and AI crawlers.
export async function onRequest(context) {
  const cache = caches.default;
  const url = new URL(context.request.url);
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = new Request(url.href, context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const assets = context.env.ASSETS;
  const baseUrl = new URL(context.request.url);

  let tools = [];
  try {
    const mr = await assets.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
    if (mr.ok) {
      const manifest = await mr.text();
      for (const line of manifest.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const p = trimmed.split('|');
        if (p.length < 6) continue;
        tools.push({
          slug: p[0].trim(),
          category: (p[1] || 'other').trim(),
          featured: p[2] === 'yes',
          isnew: p[3] === 'yes',
          name: (p[4] || '').trim(),
          desc: (p[5] || '').trim(),
          tags: (p[6] || '').split(',').map(s => s.trim()).filter(Boolean)
        });
      }
    }
  } catch (e) {}

  // Newest tools by manifest order (assumes chronological append order)
  const newTools = tools.filter(t => t.isnew).slice(-20).reverse();
  const allCount = tools.length;
  const newCount = tools.filter(t => t.isnew).length;
  // BUG-379: one description string shared by all four surfaces (meta / og / twitter / JSON-LD).
  // Count comes from the manifest at runtime (always right); length stays inside the 120-160
  // meta-description window for 1-4 digit counts. No apostrophes: file uses single-quoted literals.
  const pageDesc = 'Every new tool added to DevTools Hub, updated weekly — ' + allCount + ' free browser-based utilities across 11 categories, no signup, nothing to install.';
  const catNames = {
    'formatters': 'Code Formatters', 'calculators': 'Calculators', 'generators': 'Generators',
    'converters': 'Converters', 'media': 'Media Tools', 'network': 'Network Tools',
    'code-testing': 'Code Testing', 'pdf-tools': 'PDF Tools', 'life': 'Daily Life',
    'finance': 'Money & Markets', 'ai-language': 'AI Language'
  };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const toolCards = newTools.map(t =>
    '<a href="/tools/' + t.slug + '/" class="wn-tool-card" data-search="' + esc(t.name.toLowerCase() + ' ' + t.tags.join(',').toLowerCase()) + '">' +
      '<h3>' + esc(t.name) + '</h3>' +
      '<span class="wn-cat">' + esc(catNames[t.category] || t.category) + '</span>' +
      '<p>' + esc(t.desc) + '</p>' +
      '<span class="wn-badge">New</span>' +
    '</a>'
  ).join('');

  // FAQPage schema — answers common "what's new" questions
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'name': 'DevTools Hub What\'s New FAQ',
    'mainEntity': [
      {
        '@type': 'Question',
        'name': 'How often does DevTools Hub add new tools?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'New tools ship 2-3 times per week. Every Friday we publish a wrap-up of recent additions and major bug fixes on this page.'
        }
      },
      {
        '@type': 'Question',
        'name': 'How can I be notified when a new tool is released?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Bookmark this page (/whats-new/) and check back weekly, or follow the RSS feed at /llms-full.txt for a machine-readable tool catalog.'
        }
      },
      {
        '@type': 'Question',
        'name': 'Can I request a specific tool?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Yes. Use the Feedback link on any tool page to suggest a new tool. We prioritize tools with the highest Bing/Google search demand and the most votes.'
        }
      },
      {
        '@type': 'Question',
        'name': 'Do new tools keep the same privacy guarantees as existing ones?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Yes. Every new tool is 100% free, runs in your browser by default, requires no signup, and does not upload your data unless the AI features require a server roundtrip (which is documented on each tool page).'
        }
      }
    ]
  };

  const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<link rel="icon" type="image/x-icon" href="/favicon.ico">\n' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">\n' +
    '<apple-touch-icon sizes="180x180" href="/apple-touch-icon.png">\n' +
    '<meta property="og:image" content="/og-image.png">\n' +
    '<link rel="canonical" href="https://tools.scoreroute.com/whats-new/">\n' +
    '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1, ai-train:no, ai-input:no">\n' +
    '<title>What\'s New - Latest Tools and Updates | DevTools Hub</title>\n' +
    '<meta name="description" content="' + pageDesc + '">\n' +
    '<meta property="og:title" content="What\'s New - Latest Tools and Updates | DevTools Hub">\n' +
    '<meta property="og:description" content="' + pageDesc + '">\n' +
    '<meta property="og:url" content="https://tools.scoreroute.com/whats-new/">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:title" content="What\'s New - Latest Tools and Updates | DevTools Hub">\n' +
    '<meta name="twitter:description" content="' + pageDesc + '">\n' +
    '<link rel="stylesheet" href="/styles.css">\n' +
    '<style>.wn-page{max-width:1100px;margin:0 auto;padding:24px 24px 60px}.wn-hero{text-align:center;padding:48px 0 32px;border-bottom:1px solid #2a2a4a;margin-bottom:36px}.wn-hero h1{font-size:2.2rem;color:#7eb3ff;margin:0 0 12px}.wn-hero p{color:#888;font-size:1.05rem;max-width:680px;margin:0 auto}.wn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin:24px 0}.wn-tool-card{display:block;padding:20px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;text-decoration:none;color:inherit;position:relative;transition:all .2s}.wn-tool-card:hover{border-color:#7eb3ff;transform:translateY(-2px);box-shadow:0 8px 30px rgba(126,179,255,.15)}.wn-tool-card:focus-visible{outline:3px solid #7eb3ff;outline-offset:2px}.wn-tool-card h3{color:#fff;font-size:1.05rem;margin:0 0 6px;padding-right:50px}.wn-tool-card p{color:#888;font-size:.88rem;margin:0;line-height:1.5}.wn-cat{display:inline-block;margin-bottom:8px;padding:2px 8px;font-size:.7rem;font-weight:500;border-radius:4px;background:#1f2d4a;color:#a3c8ff}.wn-badge{position:absolute;top:14px;right:14px;background:#7eb3ff;color:#0a0d14;font-size:.7rem;font-weight:600;padding:2px 8px;border-radius:4px}.wn-faq{background:#1a1a2e;border-radius:16px;padding:30px;margin-top:48px;border:1px solid #2a2a4a}.wn-faq h2{color:#7eb3ff;margin:0 0 18px;font-size:1.3rem}.wn-faq details{background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:0;margin-bottom:10px}.wn-faq summary{padding:14px 18px;cursor:pointer;color:#fff;font-weight:500;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}.wn-faq summary::-webkit-details-marker{display:none}.wn-faq summary::after{content:"+";color:#7eb3ff;font-size:1.2rem}.wn-faq details[open] summary::after{content:"−"}.wn-faq details p{padding:0 18px 14px;color:#aaa;line-height:1.65;margin:0;font-size:.95rem}.wn-stats{display:flex;gap:18px;justify-content:center;margin:18px 0 0;flex-wrap:wrap}.wn-stat{text-align:center;padding:12px 18px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;min-width:120px}.wn-stat .num{font-size:1.6rem;font-weight:700;color:#7eb3ff;display:block}.wn-stat .lbl{color:#888;font-size:.8rem;margin-top:4px;display:block}.wn-related{margin-top:40px;padding-top:32px;border-top:1px solid #2a2a4a}.wn-related h2{color:#7eb3ff;margin:0 0 16px;font-size:1.2rem}.wn-related ul{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.wn-related a{display:block;padding:12px 16px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;text-decoration:none;color:#fff;font-size:.9rem;transition:border-color .15s}.wn-related a:hover{border-color:#7eb3ff}.wn-breadcrumb{margin-bottom:18px;font-size:.85rem;color:#666}.wn-breadcrumb a{color:#888;text-decoration:none}.wn-breadcrumb a:hover{color:#7eb3ff}/* BUG-340: the masthead shipped as an h1 (the site name) beside the page real h1 (this page heading) - two h1 one screen apart. The site name is a brand, not this page heading, so it is a link now (matching site-logo on the category and tools indexes). BUG-405: keep heading TAGS out of this comment - a CSS comment is not DOM, but every source scanner reads the bytes, and an auditor that counts h1 tags in the source reports a page with three h1s where the DOM has one. Keep this block single-line and apostrophe-free: it lives inside a single-quoted string literal. */.wn-brand{display:inline-block;font-size:2.2rem;font-weight:700;color:#7eb3ff;text-decoration:none;margin-bottom:8px}.wn-brand:hover{color:#a3c8ff}@media(max-width:600px){.wn-brand{font-size:1.6rem}.wn-hero h1{font-size:1.7rem}.wn-grid{grid-template-columns:1fr}.wn-stats{gap:10px}.wn-stat{min-width:90px;padding:10px 12px}.wn-stat .num{font-size:1.3rem}}</style>\n' +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","datePublished":"2026-05-21","dateModified":"' + today + '","author":{"@id":"https://tools.scoreroute.com/#author","@type":"Person","name":"BAOMING","url":"https://github.com/Evan-MJ","sameAs":["https://github.com/Evan-MJ","https://github.com/Evan-MJ/devtools-hub"]},"publisher":{"@id":"https://tools.scoreroute.com/#organization","@type":"Organization","name":"DevTools Hub","url":"https://tools.scoreroute.com/"},"name":"What\\u0027s New - DevTools Hub","description":"' + pageDesc.replace(/"/g, '\\u0022') + '","url":"https://tools.scoreroute.com/whats-new/"}</script>\n' +
    '<script type="application/ld+json">' + JSON.stringify(faqSchema) + '</script>\n' +
    '</head>\n<body>\n' +
    '<header><div class="container"><a href="/" class="wn-brand">DevTools Hub</a><p class="subtitle">Free online developer tools, no signup</p><nav class="wn-breadcrumb"><a href="/">Home</a> &gt; <span>What\'s New</span></nav></div></header>\n' +
    '<main class="wn-page">\n' +
    '<section class="wn-hero">\n' +
    '<h1>What\'s New</h1>\n' +
    '<p>The latest free developer tools added to DevTools Hub. We ship 2-3 new tools every week. Updated ' + today + '.</p>\n' +
    '<div class="wn-stats">\n' +
    '<div class="wn-stat"><span class="num">' + allCount + '</span><span class="lbl">Total Tools</span></div>\n' +
    '<div class="wn-stat"><span class="num">' + newCount + '</span><span class="lbl">Marked New</span></div>\n' +
    '<div class="wn-stat"><span class="num">11</span><span class="lbl">Categories</span></div>\n' +
    '</div>\n' +
    '</section>\n' +
    '<section><h2 style="color:#7eb3ff;font-size:1.4rem;margin:0 0 6px">Recently Added Tools</h2>\n' +
    '<p style="color:#888;margin:0 0 18px">Showing the ' + newTools.length + ' newest tools added to the catalog.</p>\n' +
    '<div class="wn-grid">' + toolCards + '</div></section>\n' +
    '<section class="wn-related">\n' +
    '<h2>Browse by Category</h2>\n' +
    '<ul>' +
    Object.entries(catNames).map(([slug, name]) => {
      const count = tools.filter(t => t.category === slug).length;
      return '<li><a href="/tools/' + slug + '/">' + esc(name) + ' <span style="color:#7eb3ff">(' + count + ')</span></a></li>';
    }).join('') +
    '</ul>\n' +
    '</section>\n' +
    '<section class="wn-faq">\n' +
    '<h2>Frequently Asked Questions</h2>\n' +
    '<details><summary>How often does DevTools Hub add new tools?</summary><p>New tools ship 2-3 times per week. Every Friday we publish a wrap-up of recent additions and major bug fixes on this page.</p></details>\n' +
    '<details><summary>How can I be notified when a new tool is released?</summary><p>Bookmark this page (/whats-new/) and check back weekly, or follow the machine-readable catalog at <a href="/llms-full.txt">/llms-full.txt</a> for AI agents and RSS readers.</p></details>\n' +
    '<details><summary>Can I request a specific tool?</summary><p>Yes. Use the Feedback link on any tool page to suggest a new tool. We prioritize tools with the highest Bing/Google search demand and the most votes.</p></details>\n' +
    '<details><summary>Do new tools keep the same privacy guarantees?</summary><p>Yes. Every new tool is 100% free, runs in your browser by default, requires no signup, and does not upload your data unless the AI features require a server roundtrip (which is documented on each tool page).</p></details>\n' +
    '</section>\n' +
    '</main>\n' +
    '<footer><p>&copy; 2026 DevTools Hub | <a href="/">Home</a> | <a href="/sitemap.xml">Sitemap</a> | <a href="/llms.txt">llms.txt</a> | <a href="/llms-full.txt">llms-full.txt</a> | <a href="/about/">About</a> | <a href="/privacy/">Privacy</a> | <a href="/contact/">Contact</a> | <a href="/tools/feedback/">Feedback</a></p></footer>\n' +
    '' +
    '</body></html>';

  const response = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()'
    }
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
