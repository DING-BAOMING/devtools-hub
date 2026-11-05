import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let problem;
  try {
    const body = await request.json();
    problem = body.problem;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!problem) {
    return new Response(JSON.stringify({ error: 'No problem provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a math solver. Provide step-by-step solutions to math problems.' },
        { role: 'user', content: problem }
      ],
      temperature: 0.3,
      max_tokens: 2048
    });

    return new Response(JSON.stringify(ai.data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
