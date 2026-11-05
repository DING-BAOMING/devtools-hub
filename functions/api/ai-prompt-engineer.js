/**
 * AI Prompt Engineer API - multi-mode Groq proxy
 *
 * Endpoints:
 *   POST /api/ai-prompt-engineer   - Run prompt or convert or improve
 *   GET  /api/ai-prompt-engineer   - Health
 *
 * Modes:
 *   test     - Send prompt through the shared provider chain (Groq/NVIDIA/Gemini)
 *   convert  - Rewrite prompt for 8 platforms
 *   improve  - Generate 3 improved variants of a draft prompt
 *
 * Env: read by libs/ai-provider.js - DEVTOOLS_GROQ_API_KEY, DEVTOOLS_NVIDIA_KEY_1,
 *      DEVTOOLS_NVIDIA_KEY_3, DEVTOOLS_GEMINI_KEY
 */

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

var TASK_SYSTEM = {
  general: 'You are a helpful, accurate AI assistant. Be concise, structured, and actionable.',
  coding: 'You are a senior software engineer. Provide code that is production-ready, secure, and well-commented. Explain non-obvious decisions briefly.',
  writing: 'You are an expert writer. Match the requested tone exactly. Avoid cliches. Vary sentence length.',
  analysis: 'You are a senior analyst. Be specific, cite evidence, surface assumptions, and quantify when possible.',
  creative: 'You are a creative writer. Surprise the reader. Show, do not tell. Use vivid sensory details.',
  translation: 'You are an expert translator. Preserve meaning, tone, and nuance. Note any untranslatable terms and how you handled them.'
};

var PLATFORM_HINTS = {
  'ChatGPT': 'Format for ChatGPT (GPT-4o/o1): use markdown, structured sections, explicit instructions. Optimize for clarity and step-by-step reasoning.',
  'Claude': 'Format for Claude (Sonnet 4.5): use long-form context with thinking-out-loud reasoning. Be precise and nuanced.',
  'Gemini': 'Format for Google Gemini (2.0 Flash): use bullet points and tables. Optimize for fast scanning and Google search integration.',
  'Llama': 'Format for Meta Llama models: direct, no fluff. Use clear role/task/format instructions.',
  'Copilot': 'Format for Microsoft Copilot: business-friendly tone. Use headings and tables. Cite sources where applicable.'
};

var IMAGE_PLATFORM_HINTS = {
  'Midjourney': 'Midjourney v6 syntax. Include parameters at the end: --ar (aspect ratio), --v 6, --s (stylize 0-1000), --q (quality). Comma-separated descriptive phrases. No quotes around the prompt.',
  'DALL-E': 'DALL-E 3 style. Natural language sentences, not comma-separated. Describe scene in flowing prose. Specify lighting, mood, and composition.',
  'Stable Diffusion': 'Stable Diffusion XL style. Use weight syntax (keyword:1.3) to boost key elements. Include a negative prompt line.'
};

function buildSystemPrompt(mode, payload) {
  if (mode === 'test') {
    var task = payload.task || 'general';
    var base = TASK_SYSTEM[task] || TASK_SYSTEM.general;
    if (payload.platform && PLATFORM_HINTS[payload.platform]) {
      return base + '\n\n' + PLATFORM_HINTS[payload.platform];
    }
    if (payload.platform && IMAGE_PLATFORM_HINTS[payload.platform]) {
      return 'You are generating an image prompt. Optimize the following prompt for the target platform.\n\n' + IMAGE_PLATFORM_HINTS[payload.platform] + '\n\nReturn ONLY the optimized image prompt, nothing else.';
    }
    return base;
  }
  if (mode === 'convert') {
    return 'You are an expert prompt engineer. You rewrite prompts to match the exact syntax and conventions of each AI platform.\n\n' +
      'You must respond with valid JSON only, no markdown, no prose outside JSON. Schema:\n' +
      '{\n' +
      '  "ChatGPT": "rewritten prompt for ChatGPT",\n' +
      '  "Claude": "rewritten prompt for Claude",\n' +
      '  "Midjourney": "Midjourney v6 prompt with --ar, --v 6 flags",\n' +
      '  "DALL-E": "natural language image prompt",\n' +
      '  "Stable Diffusion": "SDXL prompt with weight syntax",\n' +
      '  "Gemini": "Gemini prompt",\n' +
      '  "Llama": "Llama prompt",\n' +
      '  "Copilot": "Copilot prompt"\n' +
      '}\n\n' +
      'Keep each version semantically equivalent to the original but optimized for the platform. ' +
      'For Midjourney use comma-separated descriptors and flags. For DALL-E use flowing natural language. ' +
      'For SDXL use weight syntax and end with a separate negative prompt line "Negative: low quality, blurry, ugly".';
  }
  if (mode === 'improve') {
    return 'You are an expert prompt engineer. The user gives you a vague or weak prompt. You rewrite it 3 different ways, each emphasizing a different optimization angle.\n\n' +
      'Respond with valid JSON only:\n' +
      '{"variants":[{"style":"clear","text":"..."},{"style":"specific","text":"..."},{"style":"structured","text":"..."}]}\n\n' +
      '- "clear" variant: rewrites for unambiguity, removes vague terms.\n' +
      '- "specific" variant: adds concrete details, numbers, named examples.\n' +
      '- "structured" variant: adds explicit role, task, format, constraints sections.\n\n' +
      'Keep meaning close to original. Do not change the goal. Do not add new requirements.';
  }
  return TASK_SYSTEM.general;
}

// One chain for every AI tool on the site: see libs/ai-provider.js. The three
// hand-rolled fallbacks this replaced all named retired models (BUG-327).
async function callWithFallback(env, systemPrompt, userPrompt, maxTokens) {
  var start = Date.now();
  var ai = await aiChat(env, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: maxTokens || 1024
  });
  return {
    content: ai.content,
    usage: ai.data.usage || null,
    model: ai.model,
    provider: ai.provider,
    elapsed_sec: (Date.now() - start) / 1000
  };
}

function tryParseJson(text) {
  if (!text) return null;
  var cleaned = text.replace(/```json\n?|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  var m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) {}
  }
  return null;
}

import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (context.request.method === 'GET') {
    return json({
      tool: 'ai-prompt-engineer',
      version: '1.0.0',
      status: 'ready',
      modes: ['test', 'convert', 'improve'],
      providers: ['groq', 'nvidia1', 'nvidia3', 'gemini']
    });
  }

  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  var body;
  try { body = await context.request.json(); }
  catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  var mode = (body.mode || 'test').toString();
  var prompt = (body.prompt || '').toString().trim();

  if (!prompt) return json({ error: 'Prompt is required.' }, 400);
  if (prompt.length < 5) return json({ error: 'Prompt too short (min 5 chars).' }, 400);
  if (prompt.length > 8000) return json({ error: 'Prompt too long (max 8000 chars).' }, 400);

  try {
    var systemPrompt = buildSystemPrompt(mode, body);
    var maxTokens = mode === 'convert' ? 2048 : mode === 'improve' ? 1536 : Math.min(parseInt(body.max_tokens, 10) || 1024, 4096);

    if (mode === 'test') {
      var r = await callWithFallback(context.env, systemPrompt, prompt, maxTokens);
      return json({
        mode: 'test',
        result: r.content,
        model: r.model,
        provider: r.provider,
        usage: r.usage,
        elapsed_sec: r.elapsed_sec,
        platform: body.platform || null
      });
    }

    if (mode === 'convert') {
      var r2 = await callWithFallback(context.env, systemPrompt, prompt, maxTokens);
      var platforms = tryParseJson(r2.content);
      if (!platforms || typeof platforms !== 'object') {
        return json({
          mode: 'convert',
          result: r2.content,
          elapsed_sec: r2.elapsed_sec,
          model: r2.model,
          provider: r2.provider,
          parse_error: 'AI response was not valid JSON; raw result returned.'
        });
      }
      return json({
        mode: 'convert',
        platforms: platforms,
        elapsed_sec: r2.elapsed_sec,
        model: r2.model,
        provider: r2.provider
      });
    }

    if (mode === 'improve') {
      var r3 = await callWithFallback(context.env, systemPrompt, prompt, maxTokens);
      var improved = tryParseJson(r3.content);
      if (!improved || !improved.variants) {
        return json({
          mode: 'improve',
          result: r3.content,
          elapsed_sec: r3.elapsed_sec,
          model: r3.model,
          provider: r3.provider,
          parse_error: 'AI response was not valid JSON; raw result returned.'
        });
      }
      return json({
        mode: 'improve',
        variants: improved.variants,
        elapsed_sec: r3.elapsed_sec,
        model: r3.model,
        provider: r3.provider
      });
    }

    return json({ error: 'Unknown mode: ' + mode }, 400);
  } catch (e) {
    return json({ error: e.message || 'Unknown error' }, 500);
  }
}
