import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let text;
  try {
    const body = await request.json();
    text = body.text;
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

  try {
    const data = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a grammar checker. Check the user\'s text for grammar errors and explain why each error is wrong, then provide the corrected version.' },
        { role: 'user', content: text }
      ],
      temperature: 0.3,
      max_tokens: 2048
    });

    return new Response(JSON.stringify(data.data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
