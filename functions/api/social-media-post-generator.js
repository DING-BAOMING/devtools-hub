import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Social Media Post Generator API
 * Single AI call generates all 5 platform posts
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes -> deterministic
 *
 * Endpoints:
 *   POST /api/social-media-post-generator   - Generate 5 platform posts
 *   GET  /api/social-media-post-generator   - Health check
 *
 * Env: DEVTOOLS_GROQ_API_KEY / DEVTOOLS_NVIDIA_KEY_1 / DEVTOOLS_AGNES_KEY_1 / DEVTOOLS_AGNES_KEY_2
 */

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const PLATFORM_LIMITS = {
  twitter: 280,
  linkedin: 3000,
  instagram: 2200,
  facebook: 5000,
  tiktok: 2200
};

const PLATFORM_NAMES = {
  twitter: 'Twitter / X',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok'
};

const PROVIDERS = [
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1'
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2'
  },
  {
    name: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    base: 'https://api.groq.com/openai/v1',
    envKey: 'DEVTOOLS_GROQ_API_KEY'
  },
  {
    name: 'nvidia',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1'
  }
];

async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAI(env, messages, maxTokens) {
  const errors = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue;
    try {
      const body = {
        model: await resolveModelId(provider, apiKey),
        messages,
        temperature: 0.85,
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

function getLanguageName(code) {
  const map = {
    en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
    it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)',
    hi: 'Hindi', ar: 'Arabic', ru: 'Russian'
  };
  return map[code] || 'English';
}

function buildSystemPrompt(tone, language, includeHashtags, includeEmoji, includeCta, niche) {
  const langName = getLanguageName(language);
  const nicheLine = niche ? `Niche/Industry: ${niche}.` : '';
  const hashtagsLine = includeHashtags ? 'Include hashtags where appropriate for each platform (see platform specs).' : 'Do NOT include any hashtags in any platform output.';
  const emojiLine = includeEmoji ? 'Use emojis naturally where they add value (do not overdo it).' : 'Do NOT use emojis in any platform output.';
  const ctaLine = includeCta ? 'Include a clear call-to-action at the end of each post where natural.' : 'No explicit call-to-action needed.';

  const toneGuides = {
    professional: 'Professional. Formal vocabulary, no slang, authoritative voice. B2B appropriate.',
    casual: 'Casual. Friendly, conversational, contractions (don\'t, you\'re). Like texting a smart friend.',
    humorous: 'Humorous. Witty, playful, meme-friendly. Puns, observational humor.',
    inspirational: 'Inspirational. Motivational, story-driven, uplifting. Focus on growth, resilience.',
    educational: 'Educational. How-to, factual, structured. Numbered lists, clear takeaways.'
  };

  return `You are a world-class social media copywriter. Given a single input, you will produce 5 platform-optimized posts in a single response.

PLATFORM SPECIFICATIONS:

TWITTER / X (key: "twitter"):
- HARD LIMIT: 280 characters total (including hashtags and emojis)
- Style: punchy, hook in the first 7 words, short sentences
- 1-2 inline hashtags MAX, placed at the very end
- 0-3 emojis total
- Single tweet format

LINKEDIN (key: "linkedin"):
- HARD LIMIT: 3000 characters
- Style: professional, thoughtful, first-person
- 3-5 professional hashtags at the END
- 0-3 emojis, used as line-breaks not every sentence
- Paragraphs of 1-3 lines with line breaks
- Lead with a bold claim, question, or surprising stat

INSTAGRAM (key: "instagram"):
- HARD LIMIT: 2200 characters
- Style: engaging, emoji-rich, warm caption
- 5-10 hashtags grouped at the END after 3 line breaks
- 5-15 emojis throughout
- Lead with scroll-stopping hook
- Encourage engagement (question, save, tag a friend)

FACEBOOK (key: "facebook"):
- HARD LIMIT: 5000 characters
- Style: friendly, conversational, story-friendly
- 0-2 hashtags max (Facebook hashtags are often skipped)
- 0-3 emojis
- Paragraphs of 2-4 lines
- Ask a question or invite comments at the end

TIKTOK CAPTION (key: "tiktok"):
- HARD LIMIT: 2200 characters
- Style: trendy, Gen-Z, punchy, curiosity-driven
- 3-5 hashtags at the END (#fyp #viral plus 2-3 niche)
- 3-8 emojis used to break up text
- Short sentences, lots of line breaks
- Hook in first line (POV, wait for it, this changed everything)

${toneGuides[tone] || toneGuides.professional}

${hashtagsLine}
${emojiLine}
${ctaLine}
${nicheLine}

Output language for ALL platforms: ${langName}.

CRITICAL OUTPUT FORMAT:
Return ONLY a valid JSON object (no markdown fences, no preamble, no explanations) with exactly these 5 keys: "twitter", "linkedin", "instagram", "facebook", "tiktok". Each value is the post text for that platform. Respect the hard character limits for each platform strictly.`;
}

function buildUserPrompt(inputMode, inputValue) {
  if (inputMode === 'topic') {
    return `Topic/idea: ${inputValue}\n\nWrite all 5 platform posts. Stay within each platform's hard character limit. Return only the JSON.`;
  }
  if (inputMode === 'url') {
    return `Source article URL: ${inputValue}\n\nInfer the likely topic/key points from this URL. Write all 5 platform posts based on the inferred content. Stay within each platform's hard character limit. Return only the JSON.`;
  }
  if (inputMode === 'existing') {
    return `Source content (extract the key points and repurpose):\n\n${inputValue}\n\nWrite all 5 platform posts capturing the most engaging angle. Stay within each platform's hard character limit. Return only the JSON.`;
  }
  return `Write all 5 platform posts about: ${inputValue}`;
}

function extractJson(text) {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) {
    const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) cleaned = m[1];
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    cleaned = cleaned.substring(first, last + 1);
  }
  return JSON.parse(cleaned);
}

function fallbackPost(platform, inputValue, includeHashtags, includeEmoji) {
  const summary = (inputValue || '').substring(0, 100).trim();
  let text = summary;
  if (platform === 'twitter') {
    text = summary.substring(0, 250);
  } else if (platform === 'linkedin') {
    text = `Quick thought:\n\n${summary}\n\nWhat do you think?`;
  } else if (platform === 'instagram') {
    const tags = includeHashtags ? '\n\n.\n.\n.\n#inspiration #daily #community' : '';
    const emoji = includeEmoji ? '✨ ' : '';
    text = `${emoji}${summary}${tags}`;
  } else if (platform === 'facebook') {
    text = `Sharing this: ${summary}`;
  } else if (platform === 'tiktok') {
    const tags = includeHashtags ? '\n\n#fyp #viral' : '';
    const emoji = includeEmoji ? '🔥 ' : '';
    text = `${emoji}${summary}${tags}`;
  }
  if (text.length > PLATFORM_LIMITS[platform]) {
    text = text.substring(0, PLATFORM_LIMITS[platform] - 3) + '...';
  }
  return text;
}

function generateFallbackPosts(inputValue, includeHashtags, includeEmoji) {
  return {
    twitter: fallbackPost('twitter', inputValue, includeHashtags, includeEmoji),
    linkedin: fallbackPost('linkedin', inputValue, includeHashtags, includeEmoji),
    instagram: fallbackPost('instagram', inputValue, includeHashtags, includeEmoji),
    facebook: fallbackPost('facebook', inputValue, includeHashtags, includeEmoji),
    tiktok: fallbackPost('tiktok', inputValue, includeHashtags, includeEmoji)
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'social-media-post-generator',
      version: '1.1.0',
      status: 'ready',
      providers: PROVIDERS.map(p => p.name),
      platforms: Object.keys(PLATFORM_LIMITS),
      limits: PLATFORM_LIMITS,
      note: 'Single AI call generates all 5 platform posts. Sequential provider fallback.'
    }), { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const inputMode = (body.input_mode || 'topic').toString();
  const inputValue = (body.input_value || '').toString().trim();
  const tone = (body.tone || 'professional').toString();
  const language = (body.language || 'en').toString();
  const niche = (body.niche || '').toString().trim();
  const includeHashtags = body.include_hashtags !== false;
  const includeEmoji = body.include_emoji !== false;
  const includeCta = body.include_cta === true;

  if (!inputValue) {
    return new Response(JSON.stringify({ error: 'input_value is required' }), { status: 422, headers: CORS_HEADERS });
  }
  if (inputValue.length < 5) {
    return new Response(JSON.stringify({ error: 'input_value must be at least 5 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (inputValue.length > 5000) {
    return new Response(JSON.stringify({ error: 'input_value must be 5000 characters or less' }), { status: 422, headers: CORS_HEADERS });
  }

  const validTones = ['professional', 'casual', 'humorous', 'inspirational', 'educational'];
  if (!validTones.includes(tone)) {
    return new Response(JSON.stringify({ error: 'invalid tone' }), { status: 422, headers: CORS_HEADERS });
  }

  const validModes = ['topic', 'url', 'existing'];
  if (!validModes.includes(inputMode)) {
    return new Response(JSON.stringify({ error: 'invalid input_mode' }), { status: 422, headers: CORS_HEADERS });
  }

  let inputSummary = '';
  if (inputMode === 'topic') inputSummary = inputValue.substring(0, 100);
  else if (inputMode === 'url') inputSummary = 'URL: ' + inputValue;
  else if (inputMode === 'existing') inputSummary = 'Repurposed from existing content';

  let posts = null;
  let aiProvider = null;
  let aiError = null;
  try {
    const systemPrompt = buildSystemPrompt(tone, language, includeHashtags, includeEmoji, includeCta, niche);
    const userPrompt = buildUserPrompt(inputMode, inputValue);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const result = await callAI(env, messages, 3500);
    aiProvider = result.provider;
    const parsed = extractJson(result.content);
    if (parsed && typeof parsed === 'object') {
      const validPlatforms = ['twitter', 'linkedin', 'instagram', 'facebook', 'tiktok'];
      const filtered = {};
      for (const p of validPlatforms) {
        if (typeof parsed[p] === 'string' && parsed[p].trim().length > 0) {
          let text = parsed[p].trim();
          if (text.length > PLATFORM_LIMITS[p]) {
            text = text.substring(0, PLATFORM_LIMITS[p] - 3) + '...';
          }
          filtered[p] = text;
        }
      }
      if (Object.keys(filtered).length === 5) {
        posts = filtered;
      } else {
        aiError = 'AI returned incomplete posts: ' + Object.keys(filtered).join(',');
      }
    } else {
      aiError = 'AI returned non-object response';
    }
  } catch (e) {
    aiError = e.message;
  }

  if (!posts) {
    posts = generateFallbackPosts(inputValue, includeHashtags, includeEmoji);
  }

  return new Response(JSON.stringify({
    posts,
    meta: {
      input_mode: inputMode,
      tone,
      language,
      niche,
      include_hashtags: includeHashtags,
      include_emoji: includeEmoji,
      include_cta: includeCta,
      input_summary: inputSummary,
      char_counts: Object.fromEntries(Object.entries(posts).map(([k, v]) => [k, v.length])),
      limits: PLATFORM_LIMITS,
      ai_provider: aiProvider,
      ai_error: aiError
    }
  }), { headers: CORS_HEADERS });
}
