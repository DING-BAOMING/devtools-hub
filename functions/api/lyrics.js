// BUG-442: proxy the lyrics upstream so the page never calls a third-party API
// directly (CORS flakes read as "not found" to visitors).
// GET /api/lyrics?artist=X&title=Y → { found: true, artist, title, lyrics }
export async function onRequest(context) {
  try {
    if (context.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (context.request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const u = new URL(context.request.url);
    const artist = u.searchParams.get('artist') || '';
    const title = u.searchParams.get('title') || '';
    if (!artist || !title) {
      return new Response(JSON.stringify({ found: false, error: 'artist and title required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), 10000);
    try {
      const resp = await fetch('https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title), {
        redirect: 'manual',
        signal: ctl.signal,
      });
      if (resp.status === 200) {
        const data = await resp.json();
        if (data && data.lyrics) {
          return new Response(JSON.stringify({ found: true, artist, title, lyrics: data.lyrics }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }
        return new Response(JSON.stringify({ found: false }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      if (resp.status === 404) {
        return new Response(JSON.stringify({ found: false }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response(JSON.stringify({ found: false, error: 'upstream ' + resp.status }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ found: false, error: 'upstream ' + e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
