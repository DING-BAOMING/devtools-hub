import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let text, mode;
  try {
    const body = await request.json();
    text = body.text;
    mode = body.mode || 'standard';
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!text) {
    return new Response(JSON.stringify({ error: 'No text provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const modePrompts = {
    standard: 'Rewrite the following text to be clearer and more natural while preserving the original meaning. Return the rewritten version only.',
    fluency: 'Fix grammar and phrasing issues to make the text sound natural and fluent. Return the corrected version only.',
    formal: 'Rewrite in a formal, professional tone for business or academic contexts. Return the rewritten version only.',
    academic: 'Rewrite using academic language for research papers. Use formal vocabulary. Return the rewritten version only.',
    creative: 'Rewrite in a creative, engaging style with vivid language. Return the rewritten version only.',
    expand: 'Expand the text by adding more detail and examples while preserving the original message. Return the expanded version only.',
    shorten: 'Condense the text to its essential meaning while preserving key information. Return the shortened version only.',
    humanize: 'Rewrite this AI-generated text to sound human-written. Vary sentence structure, use natural patterns, add transitions. Preserve all facts. Return only the rewritten version.'
  };

  const systemPrompt = modePrompts[mode] || modePrompts.standard;

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.5,
      max_tokens: 4096
    });

    return new Response(JSON.stringify(ai.data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
