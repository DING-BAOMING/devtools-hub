export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let symbol;
  try {
    const body = await request.json();
    symbol = (body.symbol || '').trim().toUpperCase();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!symbol) {
    return new Response(JSON.stringify({ error: 'No symbol provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = env.DEVTOOLS_ALPHA_VANTAGE_KEY || env.DEVTOOLS_GROQ_API_KEY;

  try {
    // Use free financial API - Twelve Data or alternative
    // Try alternative: financialmodelingprep
    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=demo`);

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Stock API error: ' + res.status }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await res.json();

    // Check for API limit or error
    if (data.Note) {
      return new Response(JSON.stringify({ error: 'API rate limit reached. Try again later.', note: data.Note }), {
        status: 429, headers: { 'Content-Type': 'application/json' }
      });
    }

    const quote = data['Global Quote'];
    if (!quote || !quote['01. symbol']) {
      return new Response(JSON.stringify({ error: 'Symbol not found', raw: data }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      symbol: quote['01. symbol'],
      price: parseFloat(quote['05. price'] || 0),
      change: parseFloat(quote['09. change'] || 0),
      changePercent: (quote['10. change percent'] || '').replace('%', ''),
      high: parseFloat(quote['03. high'] || 0),
      low: parseFloat(quote['04. low'] || 0),
      volume: parseInt(quote['06. volume'] || 0),
      previousClose: parseFloat(quote['08. previous close'] || 0),
      updatedAt: new Date().toLocaleString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
