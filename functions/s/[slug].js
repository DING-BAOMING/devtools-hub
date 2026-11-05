export async function onRequest(context) {
  const slug = context.params.slug || '';
  if (!slug) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const url = await context.env.FEEDBACK_KV.get('short:' + slug);
    if (!url) {
      return new Response('Link not found or expired', { status: 404 });
    }
    return Response.redirect(url, 302);
  } catch {
    return new Response('Error', { status: 500 });
  }
}
