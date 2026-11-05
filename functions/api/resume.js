import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  let data;
  try { data = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (!data.name) {
    return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const prompt = `Generate a professional resume for:
Name: ${data.name || ''}
Title: ${data.title || 'Professional'}
Email: ${data.email || ''}
Phone: ${data.phone || ''}
Location: ${data.location || ''}
Summary: ${data.summary || ''}
Experience: ${data.experience || ''}
Education: ${data.education || ''}
Skills: ${data.skills || ''}

Return valid JSON only: {name, title, contact:{email,phone,location}, summary, experience:[{company,role,dates,description}], education:[{institution,degree,year}], skills:[]}`;

  try {
    const ai = await aiChat(env, {
      messages: [{ role: 'system', content: 'You are a professional resume writer. Generate a well-formatted resume in JSON.' }, { role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 2048,
      json: true
    });

    const content = ai.content;
    let resume;
    try { resume = JSON.parse(content.replace(/```json\n?|```/g, '').trim()); } catch { resume = { content, name: data.name }; }

    return new Response(JSON.stringify(resume), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
