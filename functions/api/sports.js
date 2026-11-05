export async function onRequest(context) {
  var request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  var url = new URL(request.url);
  var sport = url.searchParams.get('sport') || 'football';
  var league = url.searchParams.get('league') || 'nfl';
  var dates = url.searchParams.get('dates') || '';

  var apiUrl = 'https://site.api.espn.com/apis/site/v2/sports/' + encodeURIComponent(sport) + '/' + encodeURIComponent(league) + '/scoreboard';

  if (dates) {
    apiUrl += '?dates=' + encodeURIComponent(dates);
  }

  try {
    var res = await fetch(apiUrl);
    if (!res.ok) {
      var text = await res.text();
      return new Response(JSON.stringify({ error: 'ESPN API ' + res.status + ': ' + text.substring(0, 200) }), {
        status: res.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    var data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
