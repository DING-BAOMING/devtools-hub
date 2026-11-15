import { resolveModelId } from '../../libs/ai-provider.js';
import { fetchWithTimeout, extractJson, getLanguageName } from '../../libs/http.js';
/**
 * AI Content Brief API
 * Single AI call generates a complete SEO content brief from a target keyword + audience context
 * Multi-provider fallback: Agnes -> Groq -> NVIDIA -> deterministic
 * Optional DeAI post-processing to humanize AI-generated prose (env: DEVTOOLS_DEAI_KEY)
 *
 * Endpoints:
 *   POST /api/ai-content-brief   - Generate content brief
 *   GET  /api/ai-content-brief   - Health check
 *
 * Env: DEVTOOLS_AGNES_KEY_1 / DEVTOOLS_AGNES_KEY_2 / DEVTOOLS_GROQ_API_KEY / DEVTOOLS_NVIDIA_KEY_1 / DEVTOOLS_DEAI_KEY
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const PROVIDERS = [
  { name: 'agnes1', url: 'https://apihub.agnes-ai.com/v1/chat/completions', base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', envKey: 'DEVTOOLS_AGNES_KEY_1' },
  { name: 'agnes2', url: 'https://apihub.agnes-ai.com/v1/chat/completions', base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', envKey: 'DEVTOOLS_AGNES_KEY_2' },
  { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', base: 'https://api.groq.com/openai/v1', envKey: 'DEVTOOLS_GROQ_API_KEY' },
  { name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', base: 'https://integrate.api.nvidia.com/v1', envKey: 'DEVTOOLS_NVIDIA_KEY_1' }
];

async function callAI(env, messages, maxTokens) {
  const errors = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue;
    try {
      const body = {
        model: await resolveModelId(provider, apiKey),
        messages,
        temperature: 0.75,
        max_tokens: maxTokens
      };
      const response = await fetchWithTimeout(provider.url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }, 60000);
      if (response.status === 429) {
        errors.push(provider.name + ': rate_limited');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      if (!response.ok) {
        const errTxt = await response.text().catch(() => '');
        errors.push(provider.name + ': HTTP ' + response.status + ' ' + errTxt.substring(0, 80));
        continue;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content) {
        return { content, provider: provider.name };
      }
      errors.push(provider.name + ': empty_content');
    } catch (e) {
      errors.push(provider.name + ': ' + (e.message || 'unknown'));
    }
  }
  throw new Error('All providers failed: ' + errors.join(' | '));
}

async function humanizeText(env, text) {
  if (!env.DEVTOOLS_DEAI_KEY || !text || text.length < 20) return text;
  try {
    const response = await fetchWithTimeout('https://deai.029101.xyz/humanize', {
      method: 'POST',
      headers: {
        'X-API-Key': env.DEVTOOLS_DEAI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        mode: 'balanced',
        multi_run: 1,
        adversarial: false,
        wait: true
      })
    }, 45000);
    if (!response.ok) return text;
    const data = await response.json();
    if (data && data.result && typeof data.result === 'string') return data.result;
    return text;
  } catch (e) {
    return text;
  }
}

async function maybeHumanizeResult(env, result) {
  if (!env.DEVTOOLS_DEAI_KEY) return { result, deai_used: false };
  try {
    const brief = result.brief || {};
    const tasks = [];
    if (brief.outline) tasks.push(humanizeText(env, brief.outline).then(t => { brief.outline = t; }));
    if (brief.faqs && brief.faqs.length) {
      for (let i = 0; i < brief.faqs.length; i++) {
        if (brief.faqs[i].answer) {
          const idx = i;
          tasks.push(humanizeText(env, brief.faqs[idx].answer).then(t => { brief.faqs[idx].answer = t; }));
        }
      }
    }
    if (brief.questions && brief.questions.length) {
      for (let i = 0; i < brief.questions.length; i++) {
        if (brief.questions[i].answer) {
          const idx = i;
          tasks.push(humanizeText(env, brief.questions[idx].answer).then(t => { brief.questions[idx].answer = t; }));
        }
      }
    }
    if (brief.meta_description) tasks.push(humanizeText(env, brief.meta_description).then(t => { brief.meta_description = t; }));
    await Promise.allSettled(tasks);
    result.brief = brief;
    return { result, deai_used: true };
  } catch (e) {
    return { result, deai_used: false };
  }
}

function buildSystemPrompt(language, includeFaq, includeGeo) {
  const langName = getLanguageName(language);
  return 'You are a senior SEO content strategist and brief writer who understands search intent, topical authority, and how AI search engines (Google AI Overviews, ChatGPT, Claude, Gemini, Perplexity) surface content.\n\nYou will produce a COMPLETE SEO content brief for one target keyword in a single response.\n\nSEMANTIC + INTENT ANALYSIS (key: "semantic" → object):\n- intent: one of "informational" | "commercial" | "navigational" | "transactional" | "local" | "entertaining" | "question". Choose the dominant intent and explain in one sentence.\n- topic_cluster: array of 2-6 closely related subtopics that should be covered.\n\nTARGET KEYWORDS (key: "target_keywords" → array of 3-6 strings): Long-tail keyword phrases most likely to convert intent into a page. Lowercase, no duplicates.\n\nSERP STRUCTURE (key: "serp_structure" → array of objects {heading, rationale}): The H2/H3 outline of the pages currently ranking for the keyword (infer typical structure). Each with rationale tied to intent.\n\nOUTLINE (key: "outline" → array of objects {heading, level, points[] }): Writing outline. Level 1 = H2, level 2 = H3. points[] = what must be covered in each section. Must be actionable for a writer.\n\nQUESTIONS (key: "questions" → array of {question, answer}): answerable questions (People Also Ask style) with concise factual answers.\n\nFAQ SUGGESTIONS (key: "faqs" → array of exactly 5 {question, answer}): Content reader concerns. Answers 1-3 sentences, factual, helpful.\n\nWORD COUNT (key: "word_count" → object {min, max}): Reasonable range for intent depth.\n\nMETA DESCRIPTION (key: "meta_description" → string): HARD LIMIT 155 characters, primary keyword natural, call-to-action, no fluff.\n\nGEO FIELDS (key: "geo" → object):\n- ai_overviews_angle: how the content should be structured so AI Overviews / AI assistants can cite it (direct answer near top, clear structure, quotable facts).\n- ai_sub_questions: array of 3-5 sub-questions AI search engines are likely to decompose the topic into.\n- citation_signals: array of factual statements/entities that should be explicit and sourced.\n\n' + (includeFaq ? 'FAQPage JSON-LD SCHEMA (key: "faq_schema" → string): Valid Schema.org FAQPage JSON-LD, parseable JSON, all 5 FAQs in mainEntity with Question/Answer types.\n\n' : 'Skip FAQs and FAQPage schema.\n\n') + 'OUTPUT LANGUAGE: All text fields in ' + langName + '.\n\nCRITICAL OUTPUT FORMAT:\nReturn ONLY a valid JSON object (no markdown fences, no preamble, no explanations). Use these top-level keys exactly: "semantic", "target_keywords", "serp_structure", "outline", "questions", "faqs", "word_count", "meta_description", "geo", ' + (includeFaq ? '"faq_schema"' : '""') + '. Hard limits MUST be respected strictly.';

  return systemPrompt;
}

function buildUserPrompt(input) {
  const lines = [];
  lines.push('Target Keyword: ' + input.keyword);
  if (input.audience) {
    lines.push('');
    lines.push('Target Audience: ' + input.audience);
  }
  if (input.context) {
    lines.push('');
    lines.push('Content Context / Product or Brand Context: ' + input.context);
  }
  if (input.language) {
    lines.push('');
    lines.push('Output Language: ' + getLanguageName(input.language));
  }
  lines.push('');
  lines.push('Generate the complete content brief. Prioritize helpful, accurate, non-speculative content. Return only the JSON.');
  return lines.join('\n');
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.substring(0, max - 3) + '...';
}

function keyContextPoints(context, audience) {
  const ctx = (context || '').trim();
  const aud = (audience || '').trim();
  if (ctx) return ctx.substring(0, 120);
  if (aud) return aud.substring(0, 120);
  return 'core concepts and practical steps.';
}

function generateFallbackBrief(input) {
  const keyword = input.keyword;
  const audience = input.audience || 'general readers';
  const context = input.context || 'general product or topic context';
  const brief = {
    keyword: keyword,
    semantic: { intent: 'informational', topic_cluster: [keyword, 'related_' + keyword] },
    target_keywords: [keyword.toLowerCase(), keyword.toLowerCase() + ' guide', keyword.toLowerCase() + ' for beginners'],
    serp_structure: [{ heading: keyword, rationale: 'Primary target page structure inferred from intent.' }],
    outline: [{ heading: keyword, level: 1, points: [keyword + ' overview for ' + audience, keyContextPoints(context, audience)] }],
    questions: [{ question: 'What is ' + keyword + '?', answer: 'A clear, factual definition of ' + keyword + '.' }],
    faqs: [{ question: 'What is ' + keyword + '?', answer: 'A clear, factual explanation of ' + keyword + ' for ' + audience + '.' }],
    word_count: { min: 800, max: 1600 },
    meta_description: truncate(keyword + ' - practical guidance for ' + audience + '.', 155),
    geo: {
      ai_overviews_angle: 'Lead with a direct, factual answer near the top of the brief-driven content.',
      ai_sub_questions: ['What is ' + keyword, 'How to get started with ' + keyword],
      citation_signals: ['definition', 'key facts about ' + keyword]
    },
    faq_schema: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': [
        {
          '@type': 'Question',
          'name': 'What is ' + keyword + '?',
          'acceptedAnswer': { '@type': 'Answer', 'text': 'A clear, factual explanation of ' + keyword + ' for ' + audience + '.' }
        }
      ]
    }, null, 2)
  };
  return { brief: brief, deai_used: false };
}

export async function onRequest(context) {
  const headers = Object.assign({}, CORS_HEADERS);
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  try {
    const url = new URL(context.request.url);
    const path = url.pathname;

    if (context.request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'ai-content-brief',
        version: 'v1'
      }), { headers });
    }

    if (context.request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    }

    const body = await context.request.json();
    const input = {
      keyword: (body.keyword || '').toString().trim(),
      audience: body.audience ? body.audience.toString().trim() : '',
      context: body.context ? body.context.toString().trim() : '',
      language: body.language ? body.language.toString().trim() : 'en'
    };

    if (!input.keyword) {
      return new Response(JSON.stringify({ error: 'keyword is required (20+ chars minimum)' }), { status: 422, headers });
    }
    if (input.keyword.length < 20) {
      return new Response(JSON.stringify({ error: 'keyword must be at least 20 characters' }), { status: 422, headers });
    }

    const includeFaq = body.include_faq !== false;
    const includeGeo = body.include_geo !== false;

    const fallback = generateFallbackBrief(input);
    let aiProvider = null;
    let aiError = null;
    let aiBrief = null;
    try {
      const systemPrompt = buildSystemPrompt(input.language, includeFaq, includeGeo);
      const userPrompt = buildUserPrompt(input);
      const aiResult = await callAI(context.env, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], 3000);
      aiProvider = aiResult.provider;
      try {
        const parsed = extractJson(aiResult.content);
        if (parsed && typeof parsed === 'object') {
          aiBrief = (parsed.brief && typeof parsed.brief === 'object') ? parsed.brief : parsed;
        }
      } catch (parseErr) {
        aiError = 'AI JSON parse error: ' + parseErr.message;
      }
    } catch (e) {
      aiError = e.message;
    }

    const briefObj = aiBrief || fallback.brief;
    const result = { brief: briefObj };

    const { result: humanizedResult, deai_used: deaiUsed } = await maybeHumanizeResult(context.env, result);

    return new Response(JSON.stringify({
      brief: humanizedResult.brief || briefObj,
      provider: aiProvider,
      deai_used: deaiUsed,
      ai_error: aiError
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
