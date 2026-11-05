import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Sentence Rewriter API
 *
 * Rewrites a single sentence in one of 8 modes, in one of 12 languages.
 *
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes (x2) -> deterministic template.
 * Env: DEVTOOLS_GROQ_API_KEY / DEVTOOLS_NVIDIA_KEY_1 / DEVTOOLS_AGNES_KEY_1 / DEVTOOLS_AGNES_KEY_2
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
    maxTokens: 600
  },
  {
    name: 'nvidia1',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    maxTokens: 600
  },
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1',
    maxTokens: 600
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2',
    maxTokens: 600
  }
];

const MODE_PROMPTS = {
  standard: 'Rewrite the sentence for general clarity and natural phrasing. Preserve the original meaning and approximate length. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  fluency: 'Fix grammar, awkward phrasing, and broken syntax in the sentence. Smooth out choppy or ungrammatical language while preserving meaning and length. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  formal: 'Shift the sentence to a professional or business register. Remove contractions, colloquialisms, and casual slang. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  simple: 'Rewrite the sentence in plain English at a lower reading level. Replace jargon with common words, break up long clauses into shorter ones. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  creative: 'Rewrite the sentence with vivid verbs, sensory details, and figurative language. Preserve the original meaning. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  expand: 'Lengthen the sentence by adding context, examples, or qualifiers. Keep the original meaning and tone. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  shorten: 'Remove redundancy. Condense the sentence to a concise equivalent without losing the core meaning. Output only the rewritten sentence, no commentary, no quotes, no labels.',
  humanize: 'Rewrite the sentence so it sounds less like AI-generated text. Vary sentence structure, use less predictable word choices, prefer concrete nouns over abstract ones. Preserve meaning. Output only the rewritten sentence, no commentary, no quotes, no labels.'
};

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian',
  zh: 'Simplified Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', ar: 'Arabic', ru: 'Russian'
};

const ATOMIC_PATTERNS = [
  /\bhttps?:\/\/[^\s]+/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b\d[\d,.\-]*\b/g,
  /`[^`]+`/g,
  /\$\{[^}]+\}/g
];

function preserveAtomics(text) {
  var preserved = [];
  var safe = text;
  for (var i = 0; i < ATOMIC_PATTERNS.length; i++) {
    safe = safe.replace(ATOMIC_PATTERNS[i], function(m) {
      var idx = preserved.length;
      preserved.push(m);
      return '\u0001ATOM_' + idx + '\u0001';
    });
  }
  return { safe: safe, restore: function(s) {
    var out = s;
    for (var k = 0; k < preserved.length; k++) {
      out = out.split('\u0001ATOM_' + k + '\u0001').join(preserved[k]);
    }
    return out;
  }, count: preserved.length };
}

function extractRewrite(raw, original) {
  if (!raw) return null;
  var s = String(raw).trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  var lines = s.split(/\n+/);
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (/^(here is|here's|rewritten|rewrite|sure|okay|certainly|output|result|answer)\b/i.test(line)) continue;
    if (line.length < 5) continue;
    if (!/[.!?]$/.test(line)) {
      var lastChar = line.charAt(line.length - 1);
      if (!/[.!?]/.test(lastChar)) line = line + (original.match(/[.!?]$/) ? original.slice(-1) : '.');
    }
    best = line;
    break;
  }
  if (!best) best = s.replace(/\n/g, ' ').trim();
  return best;
}

async function callProvider(provider, sentence, mode, language) {
  var apiKey = null;
  if (provider.envKey && typeof this[provider.envKey] !== 'undefined') {
    apiKey = this[provider.envKey];
  } else if (provider.envKey && this.env && this.env[provider.envKey]) {
    apiKey = this.env[provider.envKey];
  }
  if (!apiKey) return null;

  var atomic = preserveAtomics(sentence);
  var modeHint = MODE_PROMPTS[mode] || MODE_PROMPTS.standard;
  var langName = LANG_NAMES[language] || 'English';
  var langDirective = language === 'en'
    ? 'Output the rewrite in English.'
    : 'Output the rewrite in ' + langName + ' (not in English).';

  var userPrompt = 'Rewrite this sentence.\n\nMode: ' + mode + '\nLanguage: ' + langName + '\nSentence: ' + atomic.safe;

  var sysPrompt = 'You are a precise sentence rewriter.\n' + modeHint + '\n' + langDirective + '\n' +
    'Hard rules:\n' +
    '- Output ONLY the rewritten sentence. No preamble, no labels, no quotation marks.\n' +
    '- Preserve the exact meaning.\n' +
    '- Do NOT alter URL tokens, email addresses, or numeric tokens (they appear as placeholders in the input; copy them unchanged into your output).\n' +
    '- If the input is already well-written, output it nearly unchanged.\n' +
    '- Keep proper nouns, brand names, and technical terms intact.';

  var body = {
    model: await resolveModelId(provider, apiKey),
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: mode === 'humanize' ? 0.7 : (mode === 'creative' ? 0.85 : 0.4),
    max_tokens: provider.maxTokens,
    stream: false
  };

  var ctrl = new AbortController();
  var timeout = setTimeout(function() { ctrl.abort(); }, 30000);

  try {
    var res = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    var data = await res.json();
    var raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) return null;
    var rewritten = extractRewrite(raw, atomic.safe);
    if (!rewritten) return null;
    return atomic.restore(rewritten);
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

function deterministicRewrite(sentence, mode) {
  var SYNS = {
    'good': 'great', 'bad': 'poor', 'big': 'large', 'small': 'compact',
    'fast': 'quick', 'slow': 'gradual', 'help': 'assist', 'use': 'utilize',
    'show': 'display', 'get': 'obtain', 'make': 'create', 'tell': 'inform',
    'start': 'begin', 'end': 'finish', 'think': 'consider', 'find': 'discover',
    'important': 'significant', 'many': 'numerous', 'also': 'additionally',
    'very': 'particularly', 'really': 'genuinely', 'about': 'regarding',
    'people': 'individuals', 'thing': 'item', 'way': 'method', 'problem': 'issue',
    'need': 'require', 'want': 'desire', 'like': 'appreciate', 'new': 'novel'
  };
  var s = sentence;
  var re = new RegExp('\\b(' + Object.keys(SYNS).join('|') + ')\\b', 'gi');
  s = s.replace(re, function(m) {
    var lower = m.toLowerCase();
    var repl = SYNS[lower];
    if (m[0] >= 'A' && m[0] <= 'Z' && repl) return repl.charAt(0).toUpperCase() + repl.slice(1);
    return repl || m;
  });
  if (mode === 'shorten') {
    s = s.replace(/\s+(very|really|also|just|that|which)\s+/gi, ' ');
  }
  if (mode === 'formal') {
    s = s.replace(/\bdon't\b/gi, 'do not');
    s = s.replace(/\bcan't\b/gi, 'cannot');
    s = s.replace(/\bwon't\b/gi, 'will not');
    s = s.replace(/\bI'm\b/g, 'I am');
    s = s.replace(/\byou're\b/gi, 'you are');
  }
  if (mode === 'expand') {
    s = s.replace(/\. /g, '. In addition, ');
  }
  if (mode === 'simple') {
    s = s.replace(/\butilize\b/gi, 'use');
    s = s.replace(/\bobtain\b/gi, 'get');
  }
  return s;
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env || {};
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS, status: 204 });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS_HEADERS });
  }

  var payload;
  try { payload = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS_HEADERS });
  }

  var sentence = (payload.text || '').toString().trim();
  var mode = (payload.mode || 'standard').toString();
  var language = (payload.language || 'en').toString();

  if (!sentence || sentence.length < 5) {
    return new Response(JSON.stringify({ error: 'Sentence too short (need 5+ chars)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (sentence.length > 2000) {
    return new Response(JSON.stringify({ error: 'Sentence too long (max 2000 chars)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!MODE_PROMPTS[mode]) {
    return new Response(JSON.stringify({ error: 'Unknown mode: ' + mode, valid: Object.keys(MODE_PROMPTS) }), { status: 422, headers: CORS_HEADERS });
  }
  if (!LANG_NAMES[language]) {
    return new Response(JSON.stringify({ error: 'Unknown language: ' + language, valid: Object.keys(LANG_NAMES) }), { status: 422, headers: CORS_HEADERS });
  }

  var tried = 0;
  for (var i = 0; i < PROVIDERS.length; i++) {
    var p = PROVIDERS[i];
    var apiKey = env[p.envKey];
    if (!apiKey) continue;
    tried++;
    var result;
    try {
      result = await callProvider.call(env, p, sentence, mode, language);
    } catch (e) {
      result = null;
    }
    if (result && result.trim()) {
      return new Response(JSON.stringify({
        original: sentence,
        rewrite: result.trim(),
        mode: mode,
        language: language,
        source: p.name,
        tried: tried
      }), { headers: CORS_HEADERS });
    }
  }

  var fallback = deterministicRewrite(sentence, mode);
  return new Response(JSON.stringify({
    original: sentence,
    rewrite: fallback,
    mode: mode,
    language: language,
    source: 'deterministic-fallback',
    fallback: true,
    warning: tried === 0 ? 'No AI provider keys configured' : 'All AI providers failed'
  }), { headers: CORS_HEADERS });
}
