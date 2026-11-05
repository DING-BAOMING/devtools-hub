export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let url;
  try {
    const body = await request.json();
    url = body.url;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!url) {
    return new Response(JSON.stringify({ error: 'No URL provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL format' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate slug
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let slug = '';
  for (let i = 0; i < 6; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }

  try {
    await env.FEEDBACK_KV.put('short:' + slug, url, { expirationTtl: 86400 * 365 });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Storage error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const shortUrl = 'https://tools.scoreroute.com/s/' + slug;

  return new Response(JSON.stringify({ slug, short_url: shortUrl, original_url: url }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
