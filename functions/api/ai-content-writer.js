import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Content Writer API - full SEO blog post content package generator
 *
 * Generates, in ONE call, the complete content package a publisher needs to
 * publish an SEO-friendly blog post:
 *   title, meta description, outline (H2/H3), body draft, FAQ (Q&A),
 *   FAQPage JSON-LD schema and keyword cluster notes.
 *
 * This is the "problem solver" shape: one tool turn -> publish-ready content
 * package (generation + SEO surfaces together), instead of a bare text generator.
 *
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes. Optional DeAI post-process
 * for humanization of the body draft.
 * Env: DEVTOOLS_GROQ_API_KEY / DEVTOOLS_NVIDIA_KEY_1 / DEVTOOLS_AGNES_KEY_1 / DEVTOOLS_AGNES_KEY_2 / DEVTOOLS_DEAI_KEY
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const PROVIDERS = [
  {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    base: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    envKey: 'DEVTOOLS_GROQ_API_KEY',
    maxTokens: 4000
  },
  {
    name: 'nvidia1',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    model: 'mistralai/mistral-large-2-instruct',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    maxTokens: 4000
  },
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1',
    maxTokens: 4000
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2',
    maxTokens: 4000
  }
];

const TONES = {
  general: 'General audience. Clear, accurate, engaging. No jargon unless explained.',
  professional: 'Professional / business audience. Polished, credible, no hype.',
  casual: 'Casual / friendly. Conversational, contractions allowed, simple vocabulary.',
  academic: 'Semi-academic / educational. Structured, evidence-aware, hedged claims.',
  persuasive: 'Persuasive. Clear position, rhetorical flow, call to action, strong conclusion.'
};

const LENGTHS = {
  short: '400-550 words. 3-4 sections, single H2 plus H3s. Tight.',
  medium: '800-1100 words. 4-6 sections with H2/H3 outline, single H1 title implied.',
  long: '1400-1800 words. 7-9 sections, deeper outline with subsections, FAQ at end.'
};

const AUDIENCES = {
  general: 'General audience with no specialist background.',
  technical: 'Technical audience with some domain background.',
  business: 'Business / marketing audience. ROI-aware.',
  student: 'Student audience. Learning-oriented.'
};

const CONTENT_FORMATS = { blog_post: 'blog post / article' };

function buildPrompt(params) {
  const topic = params.topic || '';
  const tone = TONES[params.tone] || TONES.general;
  const length = LENGTHS[params.length] || LENGTHS.medium;
  const audience = AUDIENCES[params.audience] || AUDIENCES.general;
  const keywords = Array.isArray(params.keywords) ? params.keywords.filter(Boolean).slice(0, 8) : [];
  const keyPoints = params.keyPoints || '';

  const keywordLine = keywords.length
    ? 'Target keywords / semantic cluster: ' + keywords.join(', ') + '.'
    : 'No explicit keywords supplied; infer a sensible primary keyword and 3-5 semantic keywords from the topic.';

  return [
    'You are an expert content strategist and SEO writer.',
    'Task: write a complete SEO content package for ONE topic.',
    'Format: ' + (CONTENT_FORMATS[params.format] || 'blog post / article') + '.',
    'Topic: ' + topic + '.',
    'Tone: ' + tone + '.',
    'Target length: ' + length + '.',
    'Audience: ' + audience + '.',
    keywordLine,
    keyPoints ? 'Extra requirements / key points the article must cover: ' + keyPoints + '.' : '',
    'Return STRICT JSON with exactly these keys:',
    '{"title": string, "meta_description": string, "outline": [{"heading": string, "level": "H2"|"H3", "notes": string}], "body": string, "faq": [{"question": string, "answer": string}], "keywords": [string], "reading_time_minutes": number}',
    'Rules:',
    '- title: compelling, <= 60 chars, includes the primary keyword naturally.',
    '- meta_description: <= 155 chars, human tone, includes primary keyword, no clickbait.',
    '- outline: 4-7 items. headings must be actionable and non-duplicative.',
    '- body: markdown string with H2 sections matching outline, prose only, no fake citations.',
    '- faq: 3-5 Q&A pairs that answer real long-tail questions about the topic.',
    '- keywords: 3-6 keyword strings for internal SEO use.',
    '- reading_time_minutes: integer derived from word count.',
    'Return ONLY the JSON object. No markdown fences. No commentary.'
  ].filter(Boolean).join('\n');
}

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAI(env, systemPrompt, userPrompt, maxTokens) {
  const errors = [];
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.envKey];
    if (!apiKey || apiKey === 'NOT_SET') continue;
    try {
      const body = {
        model: await resolveModelId(provider, apiKey),
        messages,
        temperature: 0.65,
        max_tokens: maxTokens || provider.maxTokens
      };
      if (provider.name === 'groq') {
        body.response_format = { type: 'json_object' };
      }
      const response = await fetchWithTimeout(provider.url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }, 90000);
      if (response.status === 429) {
        errors.push(provider.name + ': rate_limited');
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      if (!response.ok) {
        const errTxt = await response.text().catch(() => '');
        errors.push(provider.name + ': HTTP ' + response.status + ' ' + errTxt.substring(0, 80));
        continue;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content) return { content, provider: provider.name };
      errors.push(provider.name + ': empty');
    } catch (e) {
      errors.push(provider.name + ': ' + (e.message || 'unknown'));
    }
  }
  throw new Error('All providers failed: ' + errors.join(' | '));
}

function buildSystemPrompt(params) {
  const lang = params.language === 'zh' ? 'Chinese' : 'English';
  const formatLabel = CONTENT_FORMATS[params.format] || 'blog post / article';
  const tone = TONES[params.tone] || TONES.general;
  const length = LENGTHS[params.length] || LENGTHS.medium;
  const audience = AUDIENCES[params.audience] || AUDIENCES.general;

  return [
    'You are an expert content strategist and SEO writer.',
    'LANGUAGE: Write in ' + lang + '.',
    'Task: write a complete SEO content package for ONE topic.',
    'Format: ' + formatLabel + '.',
    'Topic: ' + params.topic + '.',
    'Tone: ' + tone + '.',
    'Target length: ' + length + '.',
    'Audience: ' + audience + '.',
    params.keyPoints ? 'Extra requirements / key points the article must cover: ' + params.keyPoints + '.' : '',
    'Return STRICT JSON with exactly these keys:',
    '{"title": string, "meta_description": string, "outline": [{"heading": string, "level": "H2"|"H3", "notes": string}], "body": string, "faq": [{"question": string, "answer": string}], "keywords": [string], "reading_time_minutes": number}',
    'Rules:',
    '- title: compelling, <= 60 chars, includes the primary keyword naturally.',
    '- meta_description: <= 155 chars, human tone, includes primary keyword, no clickbait.',
    '- outline: 4-7 items. headings must be actionable and non-duplicative.',
    '- body: markdown string with H2 sections matching outline, prose only, no fake citations.',
    '- faq: 3-5 Q&A pairs that answer real long-tail questions about the topic.',
    '- keywords: 3-6 keyword strings for internal SEO use.',
    '- reading_time_minutes: integer derived from word count.',
    'Return ONLY the JSON object. No markdown fences. No commentary.'
  ].join('\n');
}

function safeParse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); }
  catch (e) { return null; }
}

function countWords(s) {
  if (!s) return 0;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  return t.split(' ').length;
}

function cleanFaq(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || !f.question || !f.answer) continue;
    out.push({ question: String(f.question), answer: String(f.answer) });
    if (out.length >= 5) break;
  }
  return out;
}

async function safeHumanize(text, env) {
  if (!text || text.length < 60) return text;
  const apiKey = env.DEVTOOLS_DEAI_KEY;
  if (!apiKey || apiKey === 'NOT_SET') return text;
  try {
    const response = await fetchWithTimeout('https://deai.029101.xyz/humanize', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.substring(0, 6000), mode: 'balanced', multi_run: 1, adversarial: false, return_readability: false, wait: true })
    }, 35000);
    if (!response.ok) return text;
    const data = await response.json();
    if (data && data.result && typeof data.result === 'string' && data.result.trim()) return data.result;
    return text;
  } catch (e) { return text; }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'ai-content-writer',
      version: '1.0.0',
      status: 'ready',
      formats: Object.keys(CONTENT_FORMATS),
      tones: Object.keys(TONES),
      lengths: Object.keys(LENGTHS),
      audiences: Object.keys(AUDIENCES),
      providers: PROVIDERS.map(p => p.name),
      deai_available: !!(env.DEVTOOLS_DEAI_KEY && env.DEVTOOLS_DEAI_KEY !== 'NOT_SET')
    }), { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const topic = (body.topic || '').toString().trim();
  const tone = Object.prototype.hasOwnProperty.call(TONES, body.tone) ? body.tone : 'general';
  const length = Object.prototype.hasOwnProperty.call(LENGTHS, body.length) ? body.length : 'medium';
  const audience = Object.prototype.hasOwnProperty.call(AUDIENCES, body.audience) ? body.audience : 'general';
  const format = Object.prototype.hasOwnProperty.call(CONTENT_FORMATS, body.format) ? body.format : 'blog_post';
  const keyPoints = (body.key_points || '').toString().trim();

  if (topic.length < 3) {
    return new Response(JSON.stringify({ error: 'Topic is required (min 3 chars)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (topic.length > 500) {
    return new Response(JSON.stringify({ error: 'Topic is too long (max 500 chars)' }), { status: 422, headers: CORS_HEADERS });
  }

  const generated = await callAI(env, buildSystemPrompt({ topic, tone, length, audience, format, keyPoints }), buildPrompt({ topic, tone, length, audience, format, keyPoints, keywords: Array.isArray(body.keywords) ? body.keywords : [] }), 4000);

  const content = safeParse(generated.content);
  if (!content) {
    return new Response(JSON.stringify({ error: 'AI provider returned unparseable content', provider: generated.provider, raw: String(generated.content) }), { status: 502, headers: CORS_HEADERS });
  }

  const title = String(content.title || (topic + ' - A Complete Guide')).trim();
  const metaDescription = String(content.meta_description || title).trim();
  const outlineRaw = Array.isArray(content.outline) ? content.outline : [];
  const outline = outlineRaw
    .map(o => ({ heading: String(o.heading || ''), level: String(o.level || 'H2'), notes: String(o.notes || '') }))
    .filter(o => o.heading);
  const bodyText = String(content.body || '');
  const faq = cleanFaq(content.faq);
  const keywords = Array.isArray(content.keywords) ? content.keywords.map(String).filter(Boolean) : [];
  const readingTime = Number.isFinite(Number(content.reading_time_minutes)) ? Number(content.reading_time_minutes) : Math.max(1, Math.round(countWords(bodyText) / 200));

  let humanizedBody = bodyText;
  if (bodyText && bodyText.length >= 60) {
    humanizedBody = await safeHumanize(bodyText, env);
  }

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer }
    }))
  };

  return new Response(JSON.stringify({
    tool: 'ai-content-writer',
    topic,
    title,
    meta_description: metaDescription,
    outline,
    body: humanizedBody,
    faq,
    keywords,
    reading_time_minutes: readingTime,
    word_count: countWords(bodyText),
    faq_schema: faqSchema,
    generated: true
  }), { headers: CORS_HEADERS });
}
