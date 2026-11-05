import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let text;
  try {
    const body = await request.json();
    text = body.text;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!text || text.length < 20) {
    return new Response(JSON.stringify({ error: 'Please enter at least 20 characters' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a plagiarism detection expert. Analyze the user\'s text for common phrases, overused patterns, and language that might indicate lack of originality. Return valid JSON only with this exact structure: {"similarity_percentage":0-100,"is_plagiarized":false,"matched_phrases":[],"warnings":[],"suggestions[]}.' },
        { role: 'user', content: text.substring(0, 2000) }
      ],
      temperature: 0.1,
      max_tokens: 1024,
      json: true
    });

    const content = ai.content;
    let analysis;

    try {
      analysis = JSON.parse(content.replace(/```json\n?|```/g, '').trim());
    } catch (e) {
      analysis = { similarity_percentage: 0, is_plagiarized: false, matched_phrases: [], warnings: ['Analysis completed with limited results'], suggestions: ['Try rephrasing common phrases to improve originality'] };
    }

    return new Response(JSON.stringify(analysis), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
