// YouTube Tag Generator API
// AI-powered tag generation with multi-provider fallback
// Endpoints: POST /api/youtube-tag-generator (action=tags|hashtags, default tags)

import { discoverChatModels } from '../../libs/ai-provider.js';

const TAG_SYSTEM_PROMPT = `You are a YouTube SEO expert who generates highly targeted tags for videos. You output ONLY structured JSON, never explanations.`;

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchOembedMetadata(url, env) {
  const endpoints = [
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    `https://noembed.com/embed?url=${encodeURIComponent(url)}`
  ];
  const errors = [];
  for (const ep of endpoints) {
    try {
      const headers = { 'User-Agent': 'DevToolsHub/1.0 (+https://tools.scoreroute.com)' };
      const r = await fetch(ep, { headers });
      if (!r.ok) {
        errors.push(`${ep}: HTTP ${r.status}`);
        continue;
      }
      const data = await r.json();
      if (data && !data.error) return data;
    } catch (e) {
      errors.push(`${ep}: ${e.message}`);
    }
  }
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Could not extract video ID from URL. Use formats like https://www.youtube.com/watch?v=...');
  }
  return {
    title: '',
    author_name: '',
    thumbnail_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    video_id: videoId,
    note: 'Partial metadata: title/channel unavailable (oEmbed blocked). Thumbnail generated from video ID.'
  };
}

const HASHTAG_SYSTEM_PROMPT = `You are a YouTube Shorts hashtag expert. You output ONLY structured JSON, never explanations.`;

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
    envKey: 'DEVTOOLS_GROQ_API_KEY',
    buildBody: (messages, model, maxTokens) => ({
      model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    }),
    extractContent: (data) => data?.choices?.[0]?.message?.content
  },
  {
    name: 'nvidia',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    buildBody: (messages, model, maxTokens) => ({
      model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    }),
    extractContent: (data) => data?.choices?.[0]?.message?.content
  },
  {
    name: 'siliconflow',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    base: 'https://api.siliconflow.cn/v1',
    envKey: 'DEVTOOLS_SILICONFLOW_KEY',
    buildBody: (messages, model, maxTokens) => ({
      model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    }),
    extractContent: (data) => data?.choices?.[0]?.message?.content
  }
];

// The model id is read live from the provider, never written down here: Groq
// decommissioned the `llama-3.3-70b-versatile` this file used to pin, and NVIDIA
// answered 410 Gone for `meta/llama-3.3-70b-instruct` (BUG-327 / BUG-328).
const MODELS_PER_PROVIDER = 3;

async function callAI(env, messages, maxTokens) {
  const errors = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue;
    const models = await discoverChatModels(provider.base, apiKey);
    if (!models.length) {
      errors.push(provider.name + ': no live model');
      continue;
    }
    for (const model of models.slice(0, MODELS_PER_PROVIDER)) {
      try {
        const body = provider.buildBody(messages, model, maxTokens);
        const response = await fetch(provider.url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        if (response.status === 429) {
          errors.push(provider.name + ': rate_limited');
          break;
        }
        if (!response.ok) {
          errors.push(provider.name + '/' + model + ': HTTP ' + response.status);
          continue;
        }
        const data = await response.json();
        const content = provider.extractContent(data);
        if (content) return content;
      } catch (e) {
        errors.push(provider.name + '/' + model + ': ' + e.message);
      }
    }
  }
  throw new Error('All providers failed: ' + errors.join(', '));
}

function buildTagPrompt(topic, niche, language, tagCount) {
  const nicheLine = niche ? `The video is in the "${niche}" niche.` : '';
  return `Generate SEO-optimized YouTube tags for a video titled: "${topic}". ${nicheLine} The output language MUST be ${language}.

Return ONLY a JSON object with exactly 3 keys: "broad", "exact", "phrase".
- "broad" should contain ${tagCount} broad high-volume keyword tags (1-2 words each, e.g., "sourdough bread", "baking tips")
- "exact" should contain ${tagCount} exact-match tags including the full topic phrase (3-5 words, e.g., "how to make sourdough bread at home")
- "phrase" should contain ${tagCount} phrase-match long-tail tags (4-7 words each, e.g., "easy sourdough bread recipe for beginners")

Rules:
- All tags must be lowercase
- No hashtags (#), no special characters, only letters/numbers/spaces
- No duplicates across categories
- Tags must be relevant to the video topic
- Each tag should be searchable on YouTube
- Vary the tags - don't repeat similar phrases
- Output ONLY valid JSON, no markdown, no explanations`;
}

function buildHashtagPrompt(topic, count) {
  return `Generate trending hashtags for a YouTube Shorts video about: "${topic}".

Return ONLY a JSON object with one key: "hashtags" containing an array of exactly ${count} hashtags.
- Each hashtag must start with "#"
- Lowercase only
- 1-3 words per hashtag
- Mix of broad trending hashtags (#shorts, #viral, #trending) with niche-specific ones
- Relevant to the topic
- Output ONLY valid JSON, no markdown, no explanations`;
}

function extractJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) cleaned = match[1];
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

function fallbackGenerateTags(topic, niche, perCategory) {
  const words = topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const stop = new Set(['how', 'the', 'and', 'for', 'with', 'you', 'this', 'that', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will', 'would', 'should', 'about', 'into', 'your', 'they', 'them', 'their', 'our', 'out', 'what', 'when', 'where', 'why', 'who']);
  const keywords = [];
  for (const w of words) {
    if (!stop.has(w) && !keywords.includes(w)) keywords.push(w);
  }
  const base = keywords.slice(0, 6);
  const nicheTag = niche || '';
  const broad = [];
  const exact = [];
  const phrase = [];
  const broadSeeds = ['tutorial', 'guide', 'tips', 'how to', 'best', 'top', 'review', 'ideas', 'for beginners', 'step by step', 'easy', 'simple'];
  for (let b = 0; b < perCategory && b < broadSeeds.length; b++) {
    const seed = broadSeeds[b];
    for (let k = 0; k < base.length && broad.length < perCategory; k++) {
      let t = seed + ' ' + base[k];
      if (nicheTag) t = nicheTag + ' ' + t;
      if (!broad.includes(t)) broad.push(t);
    }
  }
  const exactSeeds = ['', 'tutorial', 'guide', 'tips', 'review', 'ideas', 'course', 'class'];
  for (let e = 0; e < perCategory; e++) {
    const seed2 = exactSeeds[e % exactSeeds.length];
    const phrase2 = base.join(' ');
    let t2 = (seed2 ? seed2 + ' ' : '') + phrase2;
    if (nicheTag && e % 3 === 0) t2 = nicheTag + ' ' + t2;
    if (!exact.includes(t2)) exact.push(t2);
  }
  const phraseSeeds = ['how to', 'best way to', 'easy', 'simple', 'quick', 'step by step', 'diy', 'free', 'the ultimate guide to', 'everything you need to know about'];
  for (let p = 0; p < perCategory; p++) {
    const seed3 = phraseSeeds[p % phraseSeeds.length];
    const t3 = seed3 + ' ' + topic.toLowerCase();
    if (!phrase.includes(t3)) phrase.push(t3);
  }
  return {
    broad: broad.slice(0, perCategory),
    exact: exact.slice(0, perCategory),
    phrase: phrase.slice(0, perCategory)
  };
}

function fallbackHashtags(topic, count) {
  const words = topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const seen = {};
  const tags = ['#shorts', '#youtubeshorts', '#viral', '#trending', '#fyp'];
  for (let i = 0; i < words.length && tags.length < count; i++) {
    const t = '#' + words[i];
    if (!seen[t]) { seen[t] = true; tags.push(t); }
  }
  if (words.length >= 2) {
    const combo = '#' + words.slice(0, 2).join('');
    if (!seen[combo]) { seen[combo] = true; tags.push(combo); }
  }
  return tags.slice(0, count);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await request.json();
    const action = body.action || 'tags';

    if (action === 'metadata') {
      const url = (body.url || '').trim();
      if (!url) {
        return new Response(JSON.stringify({ error: 'url is required' }), { status: 422, headers: CORS_HEADERS });
      }
      try {
        const data = await fetchOembedMetadata(url, env);
        return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (action === 'hashtags') {
      const topic = (body.topic || '').trim();
      const count = Math.min(Math.max(parseInt(body.count, 10) || 10, 5), 15);
      if (!topic) {
        return new Response(JSON.stringify({ error: 'topic is required' }), { status: 422, headers: CORS_HEADERS });
      }
      if (topic.length < 3) {
        return new Response(JSON.stringify({ error: 'topic must be at least 3 characters' }), { status: 422, headers: CORS_HEADERS });
      }

      try {
        const messages = [
          { role: 'system', content: HASHTAG_SYSTEM_PROMPT },
          { role: 'user', content: buildHashtagPrompt(topic, count) }
        ];
        const content = await callAI(env, messages, 400);
        const parsed = extractJson(content);
        const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h) => typeof h === 'string' && h.startsWith('#')).slice(0, count) : [];
        if (hashtags.length >= Math.max(3, count - 3)) {
          return new Response(JSON.stringify({ hashtags }), { headers: CORS_HEADERS });
        }
      } catch (e) {
        // fall through
      }
      const hashtags = fallbackHashtags(topic, count);
      return new Response(JSON.stringify({ hashtags }), { headers: CORS_HEADERS });
    }

    // Default: tags
    const topic = (body.topic || '').trim();
    const niche = (body.niche || '').trim();
    const language = (body.language || 'en').trim();
    const tagCount = Math.min(Math.max(parseInt(body.tagCount, 10) || 15, 5), 30);

    if (!topic) {
      return new Response(JSON.stringify({ error: 'topic is required' }), { status: 422, headers: CORS_HEADERS });
    }
    if (topic.length < 3) {
      return new Response(JSON.stringify({ error: 'topic must be at least 3 characters' }), { status: 422, headers: CORS_HEADERS });
    }
    if (topic.length > 200) {
      return new Response(JSON.stringify({ error: 'topic must be 200 characters or less' }), { status: 422, headers: CORS_HEADERS });
    }

    try {
      const messages = [
        { role: 'system', content: TAG_SYSTEM_PROMPT },
        { role: 'user', content: buildTagPrompt(topic, niche, language, tagCount) }
      ];
      const content = await callAI(env, messages, 1500);
      const parsed = extractJson(content);
      const broad = Array.isArray(parsed.broad) ? parsed.broad.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()).slice(0, tagCount) : [];
      const exact = Array.isArray(parsed.exact) ? parsed.exact.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()).slice(0, tagCount) : [];
      const phrase = Array.isArray(parsed.phrase) ? parsed.phrase.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()).slice(0, tagCount) : [];
      if (broad.length >= Math.max(5, tagCount - 5) && exact.length >= Math.max(5, tagCount - 5) && phrase.length >= Math.max(5, tagCount - 5)) {
        return new Response(JSON.stringify({ broad, exact, phrase }), { headers: CORS_HEADERS });
      }
    } catch (e) {
      // fall through to deterministic fallback
    }
    const fallback = fallbackGenerateTags(topic, niche, tagCount);
    return new Response(JSON.stringify(fallback), { headers: CORS_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Internal error' }), { status: 500, headers: CORS_HEADERS });
  }
}