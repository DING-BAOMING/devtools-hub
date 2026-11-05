import { aiChat } from '../../libs/ai-provider.js';

const MAX_SUMMARY_INPUT = 12000;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function extractVideoId(urlStr) {
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

async function fetchTranscriptText(videoId) {
  const url = 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=eng&fmt=json';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) return '';
  const data = await resp.json();
  const events = data?.events || [];
  let text = '';
  for (const ev of events) {
    const segs = ev?.segs || [];
    if (segs.length) {
      for (const s of segs) {
        text += (s.utf8 || '') + ' ';
      }
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

export async function onRequest({ request, env }) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const url = new URL(request.url);
  const text = (url.searchParams.get('text') || '').trim();
  const ytUrl = (url.searchParams.get('url') || '').trim();
  const videoId = extractVideoId(ytUrl);

  let content = text;
  if (!content && videoId) {
    content = await fetchTranscriptText(videoId);
  }

  if (!content) {
    return json({ error: 'Transcript content is required for summarization. Provide text or a resolvable YouTube video.' }, 422);
  }

  if (content.length > MAX_SUMMARY_INPUT) {
    return json({ error: 'Content too long. Please keep it under ' + MAX_SUMMARY_INPUT + ' characters.' }, 413);
  }

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a helpful, harmless, and honest AI assistant. Provide clear, concise, and accurate summaries. Use plain text formatting without excessive markdown unless asked. If you are unsure, say so rather than guess.' },
        { role: 'user', content: 'Summarize the following video transcript/content. Provide a concise summary and list key points.\n\n' + content }
      ],
      temperature: 0.7,
      max_tokens: 1024
    });

    return json({
      summary: ai.content,
      provider: ai.provider,
      model: ai.model,
      source: text ? 'text' : 'youtube',
      videoId: videoId || null,
      chars: content.length
    });
  } catch (error) {
    return json({ error: error.message || 'Summarization failed' }, 503);
  }
}
