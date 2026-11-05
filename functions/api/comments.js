// Comments API - per-tool comments using shared FEEDBACK_KV
// Storage key: comment_<slug> → [{ id, name, content, rating, timestamp, approved }]
// Rate limit key: ratelimit_comment_<ip>_<minute> → count (60s TTL, 3 per IP per minute)
// Same admin secret as feedback.js, via the shared libs/admin-auth.js helper.
// No new KV namespace needed.

import { isAdmin } from '../../libs/admin-auth.js';

const MAX_COMMENT_LENGTH = 1000;
const MAX_NAME_LENGTH = 50;
const MAX_PER_TOOL = 200;
const RATE_LIMIT_PER_MIN = 3;
const ALLOWED_RATINGS = new Set([1, 2, 3, 4, 5]);

function commentKey(slug) {
  return 'comment_' + slug.replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function rateLimitKey(ip) {
  const minute = Math.floor(Date.now() / 60000);
  return 'ratelimit_comment_' + String(ip).replace(/[^0-9a-f.:]/g, '').slice(0, 64) + '_' + minute;
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return badRequest('Missing slug');

  try {
    const list = await context.env.FEEDBACK_KV.get(commentKey(slug), 'json') || [];
    const visible = list.filter(c => c.approved !== false);
    visible.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const avg = visible.length
      ? (visible.reduce((s, c) => s + (c.rating || 0), 0) / visible.length).toFixed(1)
      : 0;
    return jsonResponse({ comments: visible, count: visible.length, average: Number(avg) });
  } catch (e) {
    return jsonResponse({ comments: [], count: 0, average: 0 });
  }
}

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); }
  catch { return badRequest('Invalid JSON'); }

  const slug = (body.slug || '').toString();
  const name = (body.name || 'Anonymous').toString().trim().slice(0, MAX_NAME_LENGTH);
  const content = (body.content || '').toString().trim().slice(0, MAX_COMMENT_LENGTH);
  const rating = ALLOWED_RATINGS.has(Number(body.rating)) ? Number(body.rating) : 0;

  if (!slug) return badRequest('Missing slug');
  if (!content || content.length < 3) return badRequest('Comment too short (min 3 chars)');

  // IP rate limit: 3 comments per minute per IP. Admin secret bypasses.
  const adminBypass = isAdmin(context, new URL(context.request.url).searchParams);
  if (!adminBypass) {
    const ip = getClientIp(context.request);
    const rlKey = rateLimitKey(ip);
    try {
      const cur = parseInt(await context.env.FEEDBACK_KV.get(rlKey), 10) || 0;
      if (cur >= RATE_LIMIT_PER_MIN) {
        return jsonResponse({ error: 'Too many comments. Please wait a minute before posting again.' }, 429);
      }
      await context.env.FEEDBACK_KV.put(rlKey, String(cur + 1), { expirationTtl: 70 });
    } catch (e) {
      // Rate limit check failed — proceed (fail-open) to avoid breaking legitimate users on KV error
    }
  }

  try {
    const list = await context.env.FEEDBACK_KV.get(commentKey(slug), 'json') || [];
    const newComment = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: name || 'Anonymous',
      content,
      rating,
      timestamp: new Date().toISOString(),
      approved: true
    };
    list.unshift(newComment);
    if (list.length > MAX_PER_TOOL) list.length = MAX_PER_TOOL;
    await context.env.FEEDBACK_KV.put(commentKey(slug), JSON.stringify(list));
    return jsonResponse({ success: true, id: newComment.id }, 201);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { searchParams } = new URL(context.request.url);
  if (!isAdmin(context, searchParams)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await context.request.json(); }
  catch { return badRequest('Invalid JSON'); }

  const slug = (body.slug || '').toString();
  const id = (body.id || '').toString();
  if (!slug || !id) return badRequest('Missing slug or id');

  try {
    const list = await context.env.FEEDBACK_KV.get(commentKey(slug), 'json') || [];
    const filtered = list.filter(c => c.id !== id);
    await context.env.FEEDBACK_KV.put(commentKey(slug), JSON.stringify(filtered));
    return jsonResponse({ success: true, deleted: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
