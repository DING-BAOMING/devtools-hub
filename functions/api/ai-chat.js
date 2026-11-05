import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  const userMessage = typeof body.message === 'string' ? body.message : null;

  if (!messages && !userMessage) {
    return new Response(JSON.stringify({ error: 'No message provided' }), {
      status: 400,
      headers
    });
  }

  const finalMessages = messages || [{ role: 'user', content: userMessage }];

  const lastUserMessage = [...finalMessages].reverse().find(function(m) { return m.role === 'user'; });
  if (!lastUserMessage || !lastUserMessage.content || !lastUserMessage.content.trim()) {
    return new Response(JSON.stringify({ error: 'Empty message content' }), {
      status: 400,
      headers
    });
  }

  if (lastUserMessage.content.length > 4000) {
    return new Response(JSON.stringify({ error: 'Message too long. Please keep it under 4000 characters.' }), {
      status: 400,
      headers
    });
  }

  const systemPrompt = {
    role: 'system',
    content: 'You are a helpful, harmless, and honest AI assistant. Provide clear, concise, and accurate answers. Use plain text formatting without excessive markdown unless asked. If you are unsure, say so rather than guess.'
  };

  const requestMessages = [systemPrompt].concat(finalMessages).slice(-20);

  try {
    const ai = await aiChat(env, {
      messages: requestMessages,
      temperature: 0.7,
      max_tokens: 1024
    });

    return new Response(JSON.stringify({
      reply: ai.content,
      provider: ai.provider,
      model: ai.model,
      label: ai.model + ' (' + ai.provider + ')'
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 503,
      headers
    });
  }
}
