const STOCK_HEADERS = { 'Content-Type': 'application/json' };

export async function onRequest({ request }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: STOCK_HEADERS });
  }

  let symbol;
  try {
    const body = await request.json();
    symbol = (body.symbol || '').trim().toUpperCase();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: STOCK_HEADERS });
  }

  if (!symbol) {
    return new Response(JSON.stringify({ error: 'No symbol provided' }), { status: 400, headers: STOCK_HEADERS });
  }

  try {
    // Yahoo Finance chart endpoint — free, no API key, no registration.
    // (The previous Alpha Vantage `apikey=demo` hardcode is demo-key-only and
    //  answered "Symbol not found" for every symbol except IBM.)
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DevToolsHub/1.0; +https://tools.scoreroute.com/)' } }
    );

    if (res.status === 429) {
      return new Response(JSON.stringify({ error: 'Stock quote API rate limit reached. Try again later.' }),
        { status: 429, headers: STOCK_HEADERS });
    }
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Stock quote API error: ' + res.status }),
        { status: 502, headers: STOCK_HEADERS });
    }

    const data = await res.json();
    if (data.chart && data.chart.error) {
      const e = data.chart.error;
      const msg = (e.description || e.code || 'Unknown error');
      return new Response(JSON.stringify({ error: /no data found, symbol may be delisted/i.test(msg) ? 'Symbol not found' : msg }),
        { status: res.status === 404 ? 404 : 502, headers: STOCK_HEADERS });
    }

    const result = (data.chart && data.chart.result && data.chart.result[0]) || {};
    const meta = result.meta || {};
    const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = (quote.close || []).filter(c => c != null);

    const price = meta.regularMarketPrice;
    if (price == null) {
      return new Response(JSON.stringify({ error: 'Symbol not found' }), { status: 404, headers: STOCK_HEADERS });
    }

    const change = (meta.fulldayChange != null)
      ? meta.fulldayChange
      : price - (meta.chartPreviousClose != null ? meta.chartPreviousClose : price);
    const changePercent = (meta.fulldayChangePercent != null)
      ? meta.fulldayChangePercent
      : (change / price) * 100;

    return new Response(JSON.stringify({
      symbol: meta.symbol || symbol,
      price: price,
      change: change,
      changePercent: changePercent,
      high: (meta.regularMarketDayHigh != null) ? meta.regularMarketDayHigh : Math.max(price, price - change),
      low: (meta.regularMarketDayLow != null) ? meta.regularMarketDayLow : Math.min(price, price - change),
      volume: meta.regularMarketVolume || 0,
      previousClose: price - change,
      updatedAt: new Date().toLocaleString()
    }), { headers: STOCK_HEADERS });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: STOCK_HEADERS });
  }
}
