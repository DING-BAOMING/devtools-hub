// ATS Resume Checker - AI suggestions endpoint
// Computes AI improvement suggestions through the shared provider chain (libs/ai-provider.js).
// Core ATS scoring is 100% client-side; this endpoint is only called for the optional AI suggestions button.

import { aiChat } from '../../libs/ai-provider.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const SYSTEM_PROMPT = 'You are an expert resume coach and ATS optimization specialist. You help job seekers improve their resumes to pass Applicant Tracking Systems. Be specific, actionable, and reference the actual missing keywords and weak areas in the resume. Never fabricate experience the user does not have. Focus on practical improvements that a real ATS would reward.';

// Every leg this used to try named a retired model, so the AI-suggestions
// button returned "All AI providers unavailable" (BUG-327).
async function callWithFallback(env, prompt) {
  const ai = await aiChat(env, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4,
    max_tokens: 1500,
    json: true
  });
  return { content: ai.content, provider: ai.provider };
}

function extractMissingKeywords(jd, resume) {
  // Lightweight keyword extraction (server-side, mirrors client logic for prompt context)
  const STOP_WORDS = new Set('a,an,and,are,as,at,be,by,for,from,has,have,he,in,is,it,its,of,on,or,that,the,to,was,were,will,with,you,your,our,we,this,these,those,their,they,them,us,more,most,also,can,may,should,would,could,do,does,did,doing,done,been,being,am,i,me,my,mine,his,her,hers,she,him,what,when,where,which,who,whom,why,how,all,any,both,each,few,many,no,nor,not,only,own,same,so,than,too,very,just,into,over,after,before,because,while,through,during,about,above,below,up,down,out,off,against,between'.split(','));
  const tokenize = (text) => text.toLowerCase().replace(/[^\w\s\-\+\#\.\/]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  const jdTokens = new Set(tokenize(jd));
  const resumeTokens = new Set(tokenize(resume));
  const missing = [];
  for (const t of jdTokens) {
    if (!resumeTokens.has(t)) missing.push(t);
  }
  return missing.slice(0, 30);
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS, status: 204 });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS_HEADERS });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS_HEADERS });
  }

  const resume = (data.resume || '').trim();
  const jd = (data.jd || '').trim();

  if (!resume || resume.length < 50) {
    return new Response(JSON.stringify({ error: 'Resume must be at least 50 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!jd || jd.length < 50) {
    return new Response(JSON.stringify({ error: 'Job description must be at least 50 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (resume.length > 20000 || jd.length > 20000) {
    return new Response(JSON.stringify({ error: 'Resume and job description must each be under 20,000 characters' }), { status: 422, headers: CORS_HEADERS });
  }

  const missingKeywords = extractMissingKeywords(jd, resume);

  const userPrompt = `Analyze this resume against the job description and provide 5-7 specific, actionable improvement suggestions. Focus on the missing keywords, weak bullet points, and ATS compatibility issues.

JOB DESCRIPTION:
${jd.slice(0, 4000)}

RESUME:
${resume.slice(0, 4000)}

MISSING KEYWORDS DETECTED:
${missingKeywords.join(', ')}

Return JSON only with this exact format:
{
  "suggestions": [
    "Specific actionable suggestion 1",
    "Specific actionable suggestion 2",
    "Specific actionable suggestion 3",
    "Specific actionable suggestion 4",
    "Specific actionable suggestion 5"
  ]
}

Each suggestion should be a concrete action the user can take right now, not generic advice. Reference the actual missing keywords or specific bullet points from the resume. Be brief - one to two sentences per suggestion.`;

  try {
    const result = await callWithFallback(env, userPrompt);
    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch (e) {
      // If model returned non-JSON, try to extract suggestions array
      const match = result.content.match(/\[\s*["'].*["']\s*\]/s);
      if (match) {
        parsed = { suggestions: JSON.parse(match[0]) };
      } else {
        // Split by lines as fallback
        parsed = { suggestions: result.content.split('\n').filter(l => l.trim().length > 10).slice(0, 7) };
      }
    }

    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 7).map(s => String(s).trim()).filter(Boolean) : [];
    return new Response(JSON.stringify({ suggestions, provider: result.provider }), { headers: CORS_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'AI suggestion service unavailable: ' + e.message, note: 'Your ATS score above is still valid - it was computed locally and is not affected by this error.' }), {
      status: 500, headers: CORS_HEADERS
    });
  }
}
