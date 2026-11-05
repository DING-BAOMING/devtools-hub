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

  if (!data.name || !data.jobTitle) {
    return new Response(JSON.stringify({ error: 'Name and job title are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }


  const tone = data.tone || 'Professional';
  const template = data.template || 'Standard';
  const recipientName = data.recipientName || 'Hiring Manager';
  const companyName = data.companyName || '';
  const skills = data.skills || '';
  const experience = data.experience || '';

  const toneGuide = {
    'Professional': 'Use a professional, confident, and respectful tone. Be specific about achievements.',
    'Enthusiastic': 'Use an energetic, passionate tone that shows genuine excitement for the role.',
    'Formal': 'Use a formal, traditional business letter tone. Be precise and courteous.',
    'Concise': 'Be brief and direct. Use short paragraphs. Focus on key qualifications only.'
  };

  const prompt = `Generate a ${tone.toLowerCase()} cover letter for:

Candidate Name: ${data.name}
Candidate Email: ${data.email || ''}
Candidate Phone: ${data.phone || ''}
Recipient: ${recipientName}
Company: ${companyName}
Job Title: ${data.jobTitle}
Key Skills: ${skills}
Relevant Experience: ${experience}
Tone: ${toneGuide[tone] || toneGuide['Professional']}
Template Style: ${template}

Return valid JSON only: {
  "name": "candidate name",
  "email": "candidate email",
  "phone": "candidate phone",
  "date": "today's date",
  "recipientName": "recipient name",
  "companyName": "company name",
  "jobTitle": "job title",
  "subject": "cover letter subject line",
  "body": "Full cover letter body with proper paragraph breaks (4-5 paragraphs). Use \\n\\n between paragraphs.",
  "closing": "Sincerely,"
}`;

  try {
    const ai = await aiChat(env, {
      messages: [
        { role: 'system', content: 'You are a professional cover letter writer. Generate compelling, personalized cover letters in JSON format. The body should have 4-5 paragraphs with proper spacing.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4, max_tokens: 2048,
      json: true
    });

    const content = ai.content;
    let coverLetter;
    try {
      coverLetter = JSON.parse(content.replace(/```json\n?|```/g, '').trim());
    } catch {
      coverLetter = { body: content, name: data.name, jobTitle: data.jobTitle };
    }

    return new Response(JSON.stringify(coverLetter), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
