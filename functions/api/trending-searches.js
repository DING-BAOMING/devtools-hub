/**
 * Trending Searches - live trend feed + live related questions.
 *
 * Two jobs, one endpoint:
 *   ?geo=US            -> the live "Daily Search Trends" list for a market
 *   ?q=<topic>         -> what people are actually asking about a topic
 *
 * Sources (all public, no auth, no key):
 *   https://trends.google.com/trending/rss?geo={CC}     volume gradient + news
 *   https://suggestqueries.google.com/complete/search     related questions
 *   https://api.bing.com/osjson.aspx?query=             related questions
 *
 * Trends churn by the hour, so this is fetched live and edge-cached for 5 minutes.
 * Nothing is written to disk and no value is hardcoded here.
 */

var TRENDS_URL = 'https://trends.google.com/trending/rss?geo=';
var GOOGLE_SUGGEST = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=';
var BING_SUGGEST = 'https://api.bing.com/osjson.aspx?query=';

// Trends: short TTL, the list is different every 30 minutes.
// Questions: longer TTL, autosuggest output is stable for a given query and a
// hot cache is what keeps us under Google's 429 threshold.
var TTL = { trends: 300, questions: 1800 };

// Google's feed is fixed at 10 items per market. Anything outside this set is
// either unsupported or returns an empty channel, and an empty list is a worse
// answer than an honest "not available for this market".
var GEOS = ['US', 'GB', 'CA', 'AU', 'IN', 'JP', 'DE', 'FR', 'ES', 'IT', 'BR', 'MX'];

var UA = 'Mozilla/5.0 (compatible; DevToolsHub/1.0; +https://tools.scoreroute.com/)';

function json(body, headers, status) {
  return new Response(JSON.stringify(body), { headers: headers, status: status || 200 });
}

function baseHeaders(ttl) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=' + ttl
  };
}

// The feed and the two suggestion endpoints all emit HTML-escaped text
// (&amp;, &quot;, &#39;). Node-free decode, no dependencies.
function unescape(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function strip(s) {
  return unescape(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// "10000+" -> 10000. Used only for sorting; the original string is what we show,
// because the gradient is Google's own wording and rounding it would be a lie.
function trafficNum(s) {
  var n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return isFinite(n) ? n : 0;
}

function tag(block, name) {
  var re = new RegExp('<(?:[a-z0-9]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?' + name + '>', 'i');
  var m = block.match(re);
  return m ? strip(m[1]) : '';
}

function parseFeed(xml) {
  var out = [];
  var re = /<item>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var block = m[1];
    var title = tag(block, 'title');
    if (!title) continue;

    var news = [];
    var nre = /<(?:ht:)?news_item>([\s\S]*?)<\/(?:ht:)?news_item>/g;
    var n;
    while ((n = nre.exec(block)) !== null) {
      var nb = n[1];
      var ntitle = tag(nb, 'news_item_title');
      var nurl = tag(nb, 'news_item_url');
      if (!ntitle || !nurl) continue;
      news.push({ title: ntitle, url: nurl, source: tag(nb, 'news_item_source') || hostOf(nurl) });
    }

    var traffic = tag(block, 'approx_traffic') || '100+';
    var pub = tag(block, 'pubDate');
    var ageHours = 0;
    if (pub) {
      var t = Date.parse(pub);
      if (isFinite(t)) ageHours = Math.max(0, Math.round((Date.now() - t) / 36e5));
    }

    out.push({
      title: title,
      traffic: traffic,
      trafficNum: trafficNum(traffic),
      pubDate: pub || '',
      ageHours: ageHours,
      picture: tag(block, 'picture') || '',
      pictureSource: tag(block, 'picture_source') || '',
      news: news.slice(0, 5)
    });
  }
  return out;
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function cachedFetch(key, ttl, run) {
  const cacheKey = new Request(key);
  const hit = await caches.default.match(cacheKey);
  if (hit) return { data: await hit.json(), cached: true };
  const data = await run();
  await caches.default.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return { data: data, cached: false };
}

async function getTrends(geo) {
  const url = TRENDS_URL + encodeURIComponent(geo);
  return cachedFetch(url, TTL.trends, async function () {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' } });
    if (!res.ok) throw new Error('Google Trends returned HTTP ' + res.status);
    const trends = parseFeed(await res.text());
    if (!trends.length) throw new Error('Google Trends returned no items for ' + geo);
    return {
      geo: geo,
      source: 'https://trends.google.com/trending?geo=' + geo,
      fetchedAt: new Date().toISOString(),
      count: trends.length,
      trends: trends
    };
  });
}

async function googleQuestions(q) {
  const url = GOOGLE_SUGGEST + encodeURIComponent(q);
  return cachedFetch(url, TTL.questions, async function () {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return Array.isArray(d[1]) ? d[1].slice(0, 10) : [];
  });
}

async function bingQuestions(q) {
  const url = BING_SUGGEST + encodeURIComponent(q);
  return cachedFetch(url, TTL.questions, async function () {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return Array.isArray(d[1]) ? d[1].slice(0, 10) : [];
  });
}

export async function onRequest(context) {
  const { request } = context;
  const headers = baseHeaders(TTL.trends);

  if (request.method === 'OPTIONS') return new Response(null, { headers: headers, status: 204 });
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, headers, 405);
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const geo = (url.searchParams.get('geo') || 'US').toUpperCase().slice(0, 2);

  if (q) {
    // Both engines are asked at once and each failure is reported on its own.
    // A dead source must not take the other one down with it.
    const results = await Promise.allSettled([googleQuestions(q), bingQuestions(q)]);
    const google = results[0].status === 'fulfilled' ? results[0].value.data : [];
    const bing = results[1].status === 'fulfilled' ? results[1].value.data : [];
    if (!google.length && !bing.length) {
      const why = results.map(function (r) {
        return r.status === 'rejected' ? r.reason.message : 'empty';
      }).join('; ');
      return json({ error: 'No live suggestions returned (' + why + ')' }, headers, 502);
    }
    return json({
      q: q,
      fetchedAt: new Date().toISOString(),
      google: google,
      bing: bing,
      sources: {
        google: google.length ? 'ok' : 'unavailable',
        bing: bing.length ? 'ok' : 'unavailable'
      }
    }, baseHeaders(TTL.questions));
  }

  if (GEOS.indexOf(geo) === -1) {
    return json({ error: 'Unsupported market. Use one of: ' + GEOS.join(', ') }, headers, 400);
  }

  try {
    const r = await getTrends(geo);
    return json({ cached: r.cached, data: r.data }, headers);
  } catch (e) {
    return json({ error: 'Live trend feed unavailable: ' + e.message }, headers, 502);
  }
}
