// URL Metadata Extractor API v1
// Server-side proxy to fetch any URL and extract meta tags, OG data, JSON-LD, etc.
export async function onRequest(context) {
  var request = context.request;
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  try {
    var body = await request.json();
    var targetUrl = body.url;

    if (!targetUrl || typeof targetUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'URL field required' }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    var parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL format' }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    var hostname = parsedUrl.hostname;
    if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.0\.0\.0$|localhost$)/.test(hostname)) {
      return new Response(JSON.stringify({ error: 'Cannot check private/internal URLs' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    var startTime = Date.now();
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 12000);

    var response;
    try {
      response = await fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DevToolsHub-MetadataExtractor/1.0; +https://tools.scoreroute.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        redirect: 'follow'
      });
    } finally {
      clearTimeout(timeout);
    }

    var elapsed = Date.now() - startTime;
    var html = await response.text();
    // Only parse first 500KB to avoid memory issues
    if (html.length > 512000) {
      html = html.substring(0, 512000);
    }

    var result = {
      url: targetUrl,
      finalUrl: response.url,
      statusCode: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') || '',
      responseTime: elapsed,
      redirectChain: response.redirected ? response.url : null,
      title: extractTitle(html),
      description: extractMetaContent(html, 'description'),
      charset: extractCharset(html),
      viewport: extractMetaContent(html, 'viewport'),
      robots: extractMetaContent(html, 'robots'),
      keywords: extractMetaContent(html, 'keywords'),
      author: extractMetaContent(html, 'author'),
      language: extractLanguage(html),
      canonical: extractLinkHref(html, 'canonical'),
      favicon: extractFavicon(html, targetUrl),
      og: extractOG(html),
      twitter: extractTwitter(html),
      jsonLd: extractJsonLd(html),
      hreflang: extractAllHreflang(html),
      headings: extractHeadings(html),
      hasTitle: !!extractTitle(html),
      hasDescription: !!extractMetaContent(html, 'description'),
      hasOGImage: !!extractMetaContent(html, 'og:image'),
      hasCanonical: !!extractLinkHref(html, 'canonical'),
      missingTags: getMissingTags(html)
    };

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  } catch (e) {
    if (e.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Request timed out (12s)' }), { status: 504, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    return new Response(JSON.stringify({ error: e.message || 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTitle(html) {
  var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(m[1].trim()) : '';
}

function extractCharset(html) {
  var m = html.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"';\s>]+)/i);
  if (m) return m[1];
  m = html.match(/content-type[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^"';\s>]+)/i);
  return m ? m[1] : '';
}

function extractMetaContent(html, name) {
  var patterns = [
    new RegExp('<meta[^>]+(?:name|property)\\s*=\\s*["\']' + escapeRegExp(name) + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]+(?:name|property)\\s*=\\s*["\']' + escapeRegExp(name) + '["\']', 'i')
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m) return decodeHtml(m[1]);
  }
  return '';
}

function extractLinkHref(html, rel) {
  var m = html.match(new RegExp('<link[^>]+rel\\s*=\\s*["\']' + escapeRegExp(rel) + '["\'][^>]*href\\s*=\\s*["\']([^"\']*)["\']', 'i'));
  if (m) return m[1];
  m = html.match(new RegExp('<link[^>]+href\\s*=\\s*["\']([^"\']*)["\'][^>]*rel\\s*=\\s*["\']' + escapeRegExp(rel) + '["\']', 'i'));
  return m ? m[1] : '';
}

function extractFavicon(html, baseUrl) {
  var m = html.match(/<link[^>]+rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  if (!m) {
    m = html.match(/<link[^>]+rel\s*=\s*["']apple-touch-icon["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  }
  if (m) {
    try {
      return new URL(m[1], baseUrl).toString();
    } catch (e) {
      return m[1];
    }
  }
  try {
    return new URL('/favicon.ico', baseUrl).toString();
  } catch (e) {
    return '';
  }
}

function extractLanguage(html) {
  var m = html.match(/<html[^>]*lang\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function extractOG(html) {
  var og = {};
  var props = ['title', 'description', 'image', 'url', 'type', 'site_name', 'locale', 'image:width', 'image:height', 'video', 'audio'];
  for (var i = 0; i < props.length; i++) {
    var val = extractMetaContent(html, 'og:' + props[i]);
    if (val) og[props[i]] = val;
  }
  return og;
}

function extractTwitter(html) {
  var tw = {};
  var props = ['card', 'title', 'description', 'image', 'site', 'creator', 'image:alt'];
  for (var i = 0; i < props.length; i++) {
    var val = extractMetaContent(html, 'twitter:' + props[i]);
    if (val) tw[props[i]] = val;
  }
  return tw;
}

function extractJsonLd(html) {
  var results = [];
  var regex = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(match[1].trim());
      // Return first meaningful JSON-LD
      if (parsed && typeof parsed === 'object') {
        results.push(parsed);
        if (results.length >= 3) break;
      }
    } catch (e) {
      // Skip invalid JSON-LD
    }
  }
  return results.length > 0 ? results : [];
}

function extractAllHreflang(html) {
  var results = [];
  var regex = /<link[^>]+rel\s*=\s*["']alternate["'][^>]*>/gi;
  var match;
  while ((match = regex.exec(html)) !== null) {
    var hreflangM = match[0].match(/hreflang\s*=\s*["']([^"']+)["']/i);
    var hrefM = match[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (hreflangM && hrefM) {
      results.push({ lang: hreflangM[1], href: hrefM[1] });
    }
  }
  return results;
}

function extractHeadings(html) {
  var h = { h1: [], h2: [], h3: [] };
  var regex1 = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  var m1;
  while ((m1 = regex1.exec(html)) !== null && h.h1.length < 5) {
    h.h1.push(stripTags(m1[1]).trim().substring(0, 100));
  }
  var regex2 = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  var m2;
  while ((m2 = regex2.exec(html)) !== null && h.h2.length < 5) {
    h.h2.push(stripTags(m2[1]).trim().substring(0, 100));
  }
  var regex3 = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  var m3;
  while ((m3 = regex3.exec(html)) !== null && h.h3.length < 5) {
    h.h3.push(stripTags(m3[1]).trim().substring(0, 100));
  }
  return h;
}

function getMissingTags(html) {
  var missing = [];
  if (!extractMetaContent(html, 'description')) missing.push({ tag: 'meta description', severity: 'high', note: 'Missing meta description impacts SEO and social sharing' });
  if (!extractMetaContent(html, 'og:title')) missing.push({ tag: 'og:title', severity: 'high', note: 'Facebook, LinkedIn, and most platforms use og:title for link previews' });
  if (!extractMetaContent(html, 'og:image')) missing.push({ tag: 'og:image', severity: 'high', note: 'Without og:image, social previews show no thumbnail' });
  if (!extractMetaContent(html, 'og:description')) missing.push({ tag: 'og:description', severity: 'medium', note: 'Fallback to meta description if absent' });
  if (!extractMetaContent(html, 'twitter:card')) missing.push({ tag: 'twitter:card', severity: 'medium', note: 'Twitter/X needs twitter:card for rich link previews' });
  if (!extractLinkHref(html, 'canonical')) missing.push({ tag: 'canonical', severity: 'low', note: 'Canonical URL helps prevent duplicate content issues' });
  if (!extractMetaContent(html, 'viewport')) missing.push({ tag: 'viewport', severity: 'medium', note: 'Viewport meta is essential for mobile rendering' });
  return missing;
}

function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
}

function stripTags(str) {
  return str.replace(/<[^>]*>/g, '');
}
