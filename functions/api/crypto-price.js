/**
 * Cryptocurrency Price Tracker API
 *
 * Uses CoinGecko Demo API with x-cg-demo-api-key header.
 * Actions: markets, coin, search, trending, global, convert
 */

var COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

function makeHeaders(env) {
  var headers = { 'Accept': 'application/json' };
  if (env && env.DEVTOOLS_COINGECKO_KEY) {
    headers['x-cg-demo-api-key'] = env.DEVTOOLS_COINGECKO_KEY;
  }
  return headers;
}

async function coingeckoFetch(path, env) {
  var headers = makeHeaders(env);
  var res = await fetch(COINGECKO_BASE + path, { headers: headers });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('CoinGecko ' + res.status + ': ' + text.substring(0, 200));
  }
  return res.json();
}

async function getMarkets(env, page, perPage, vsCurrency) {
  var path = '/coins/markets?vs_currency=' + encodeURIComponent(vsCurrency) +
    '&order=market_cap_desc&per_page=' + perPage + '&page=' + page +
    '&sparkline=true&price_change_percentage=1h,24h,7d';
  return coingeckoFetch(path, env);
}

async function getCoinDetail(env, coinId) {
  var path = '/coins/' + encodeURIComponent(coinId) +
    '?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=true';
  return coingeckoFetch(path, env);
}

async function searchCoins(env, query) {
  return coingeckoFetch('/search?query=' + encodeURIComponent(query), env);
}

async function getTrending(env) {
  return coingeckoFetch('/search/trending', env);
}

async function getGlobal(env) {
  return coingeckoFetch('/global', env);
}

async function getSimplePrice(env, ids, vsCurrencies) {
  var path = '/simple/price?ids=' + encodeURIComponent(ids) +
    '&vs_currencies=' + encodeURIComponent(vsCurrencies) +
    '&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true';
  return coingeckoFetch(path, env);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'public, max-age=30'
    }
  });
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status || 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  if (request.method !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  var url = new URL(request.url);
  var action = url.searchParams.get('action') || 'markets';

  try {
    if (action === 'markets') {
      var page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      var perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '50', 10)));
      var vsCurrency = url.searchParams.get('vs_currency') || 'usd';
      var data = await getMarkets(env, page, perPage, vsCurrency);
      return jsonResponse(data);
    }

    if (action === 'coin') {
      var coinId = url.searchParams.get('id');
      if (!coinId) return errorResponse('Missing id parameter', 400);
      var coin = await getCoinDetail(env, coinId);
      var vsCcy = url.searchParams.get('vs_currency') || 'usd';
      var md = coin.market_data || {};
      var result = {
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        image: coin.image && coin.image.large ? coin.image.large : '',
        market_cap_rank: coin.market_cap_rank,
        market_data: {
          current_price: md.current_price ? md.current_price[vsCcy] : null,
          market_cap: md.market_cap ? md.market_cap[vsCcy] : null,
          total_volume: md.total_volume ? md.total_volume[vsCcy] : null,
          price_change_percentage_24h: md.price_change_percentage_24h,
          price_change_percentage_7d: md.price_change_percentage_7d,
          price_change_percentage_30d: md.price_change_percentage_30d,
          high_24h: md.high_24h ? md.high_24h[vsCcy] : null,
          low_24h: md.low_24h ? md.low_24h[vsCcy] : null,
          ath: md.ath ? md.ath[vsCcy] : null,
          ath_change_percentage: md.ath_change_percentage ? md.ath_change_percentage[vsCcy] : null,
          ath_date: md.ath_date ? md.ath_date[vsCcy] : null,
          atl: md.atl ? md.atl[vsCcy] : null,
          atl_change_percentage: md.atl_change_percentage ? md.atl_change_percentage[vsCcy] : null,
          atl_date: md.atl_date ? md.atl_date[vsCcy] : null,
          circulating_supply: md.circulating_supply,
          total_supply: md.total_supply,
          max_supply: md.max_supply,
          fully_diluted_valuation: md.fully_diluted_valuation ? md.fully_diluted_valuation[vsCcy] : null,
        },
        sparkline_in_7d: md.sparkline_7d ? md.sparkline_7d.price : null,
        last_updated: coin.last_updated,
        categories: coin.categories || [],
        description: coin.description && coin.description.en ? coin.description.en.substring(0, 500) : '',
        links: coin.links ? {
          homepage: coin.links.homepage ? coin.links.homepage[0] : '',
          blockchain_site: coin.links.blockchain_site ? coin.links.blockchain_site[0] : '',
          subreddit: coin.links.subreddit || '',
        } : null
      };
      return jsonResponse(result);
    }

    if (action === 'search') {
      var query = url.searchParams.get('q');
      if (!query) return errorResponse('Missing q parameter', 400);
      var search = await searchCoins(env, query);
      var coins = (search.coins || []).slice(0, 20).map(function(c) {
        return { id: c.id, symbol: c.symbol, name: c.name, market_cap_rank: c.market_cap_rank, thumb: c.thumb };
      });
      return jsonResponse({ coins: coins });
    }

    if (action === 'trending') {
      var trending = await getTrending(env);
      var items = (trending.coins || []).map(function(item) {
        var c = item.item;
        return {
          id: c.id,
          symbol: c.symbol,
          name: c.name,
          market_cap_rank: c.market_cap_rank,
          thumb: c.small,
          price_btc: c.price_btc,
          score: c.score
        };
      });
      return jsonResponse({ coins: items, updated_at: trending.updated_at });
    }

    if (action === 'global') {
      var global = await getGlobal(env);
      var d = global.data;
      return jsonResponse({
        active_cryptocurrencies: d.active_cryptocurrencies,
        markets: d.markets,
        total_market_cap: d.total_market_cap,
        total_volume: d.total_volume,
        market_cap_percentage: d.market_cap_percentage,
        market_cap_change_percentage_24h_usd: d.market_cap_change_percentage_24h_usd
      });
    }

    if (action === 'convert') {
      var fromId = url.searchParams.get('from');
      var toCurrency = url.searchParams.get('to') || 'usd';
      var amount = parseFloat(url.searchParams.get('amount') || '1');
      if (!fromId) return errorResponse('Missing from parameter', 400);
      var priceData = await getSimplePrice(env, fromId, toCurrency);
      if (!priceData[fromId]) return errorResponse('Coin not found: ' + fromId, 404);
      var price = priceData[fromId][toCurrency.toLowerCase()];
      if (!price) return errorResponse('Currency not supported: ' + toCurrency, 400);
      return jsonResponse({
        from: fromId,
        to: toCurrency,
        amount: amount,
        price: price,
        result: amount * price,
        change_24h: priceData[fromId][toCurrency.toLowerCase() + '_24h_change'] || 0,
        market_cap: priceData[fromId][toCurrency.toLowerCase() + '_market_cap'] || 0
      });
    }

    return errorResponse('Unknown action: ' + action + '. Use: markets, coin, search, trending, global, convert', 400);
  } catch (err) {
    if (err.message && err.message.indexOf('429') !== -1) {
      return errorResponse('Rate limit exceeded. Please wait a moment and try again.', 429);
    }
    return errorResponse(err.message || 'Internal server error', 500);
  }
}
