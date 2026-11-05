import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let text, style;
  try {
    const body = await request.json();
    text = body.text;
    style = body.style || 'apa';
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!text || text.length < 10) {
    return new Response(JSON.stringify({ error: 'Please enter more details about the source' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const styleNames = { apa: 'APA 7th edition', mla: 'MLA 9th edition', chicago: 'Chicago 17th edition', harvard: 'Harvard', ieee: 'IEEE' };
  const styleName = styleNames[style] || 'APA 7th edition';

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a citation generation expert. Generate a properly formatted citation in ' + styleName + ' style based on the user\'s source description. Return valid JSON only: {"citation":"the formatted citation","style":"style name","components":{"author":"","title":"","year":"","publisher":""},"inline_citation":"the in-text citation format"}' },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: 1024,
      json: true
    });

    const content = ai.content;
    let result;

    try {
      result = JSON.parse(content.replace(/```json\n?|```/g, '').trim());
    } catch {
      result = { citation: content, style: styleName, components: {}, inline_citation: '' };
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
