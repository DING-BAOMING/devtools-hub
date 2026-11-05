import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let text, length;
  try {
    const body = await request.json();
    text = body.text;
    length = body.length || 30;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!text) {
    return new Response(JSON.stringify({ error: 'No text provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (text.length < 50) {
    return new Response(JSON.stringify({ error: 'Text must be at least 50 characters' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' }
    });
  }


  const ratio = Math.max(0.1, Math.min(0.7, parseInt(length) / 100));
  const wordCount = text.split(/\s+/).length;
  const targetWords = Math.max(30, Math.round(wordCount * ratio));

  const systemPrompt = 'You are a precise text summarizer. Summarize the following text in about ' + targetWords + ' words. Rules: 1. Only include information that is explicitly stated in the source text. 2. Do not add any facts, opinions, or interpretations. 3. Preserve the original meaning and key points. 4. Write in clear, concise paragraphs. 5. Do not use phrases like "the text discusses" or "the author says" - just present the summary directly. 6. Output only the summary, no preamble or commentary.';

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.3,
      max_tokens: Math.min(4096, Math.max(256, targetWords * 3))
    });

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    };
    return new Response(JSON.stringify({
      summary: ai.content,
      model: ai.model,
      provider: ai.provider,
      usage: ai.data.usage || null
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
