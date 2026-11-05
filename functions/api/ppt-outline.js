/**
 * AI PPT Outline Generator API
 *
 * Endpoints:
 *   POST /api/ppt-outline   - Generate slide outline (JSON) using Groq
 *   GET  /api/ppt-outline   - Health check
 *
 * Env: DEVTOOLS_GROQ_API_KEY (primary), DEVTOOLS_NVIDIA_KEY_1/3, DEVTOOLS_SILICONFLOW_KEY
 *
 * Input: { topic: string, slideCount: number, style: string, language: string }
 * Output: { title, subtitle, slides: [{title, bullets[], notes}], style }
 *
 * The outline is consumed by PptxGenJS in the browser to build a real .pptx file.
 * This function only generates the structured text; binary generation is client-side.
 *
 * Provider chain lives in libs/ai-provider.js (model ids discovered, never pinned).
 * Fallback chain: Groq -> NVIDIA Key1 -> NVIDIA Key3 -> SiliconFlow (dynamic model)
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

var MIN_SLIDES = 3;
var MAX_SLIDES = 20;
var ALLOWED_STYLES = {
  modern: 1,
  minimal: 1,
  corporate: 1,
  educational: 1
};
var ALLOWED_LANGUAGES = {
  en: 1, zh: 1, es: 1, fr: 1, de: 1, ja: 1, ko: 1, pt: 1, ru: 1, ar: 1
};

var STYLE_GUIDANCE = {
  modern: 'Vibrant gradient-friendly titles, concise action-oriented bullets (4-6 per slide), contemporary tech/business language.',
  minimal: 'Sparse, elegant language. 2-3 short bullets per slide max. Whitespace-friendly. Focus on one idea per slide.',
  corporate: 'Professional consulting/McKinsey-style. Data-driven, structured. Use parallel grammatical structure in bullets.',
  educational: 'Pedagogical structure. Each slide introduces ONE concept with clear explanation in bullets. Include a recap/summary slide at the end.'
};

function buildSystemPrompt(style, language, slideCount) {
  var langName = ({en: 'English', zh: 'Chinese (Simplified)', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic'})[language] || 'English';
  var styleGuide = STYLE_GUIDANCE[style] || STYLE_GUIDANCE.modern;

  return 'You are a world-class presentation designer. Generate a slide deck outline as a strict JSON object.\n\n' +
    'CRITICAL RULES:\n' +
    '1. Output ONLY valid JSON, no markdown, no commentary, no code fences.\n' +
    '2. The deck must have exactly ' + slideCount + ' slides (not more, not less).\n' +
    '3. The first slide is the title slide: "title" = deck title, "subtitle" = subtitle, "bullets" = empty array.\n' +
    '4. The last slide should be a conclusion/recap/summary slide (or thank-you Q&A slide).\n' +
    '5. Each non-title slide has 3-5 bullet points (concise, parallel structure, no full sentences longer than 12 words).\n' +
    '6. Each slide has 1-3 sentences of "notes" (speaker notes for the presenter, full sentences).\n' +
    '7. Write all content in ' + langName + '.\n' +
    '8. Style guidance: ' + styleGuide + '\n\n' +
    'JSON schema (strict, no extra keys):\n' +
    '{\n' +
    '  "title": "string (max 80 chars)",\n' +
    '  "subtitle": "string (max 120 chars, can be empty)",\n' +
    '  "slides": [\n' +
    '    { "title": "string (max 60 chars)", "bullets": ["string", ...], "notes": "string (1-3 sentences)" },\n' +
    '    ...\n' +
    '  ]\n' +
    '}\n\n' +
    'Respond with ONLY the JSON object.';
}

function buildUserPrompt(topic, slideCount, style) {
  return 'Create a ' + slideCount + '-slide presentation outline about: ' + topic + '\n' +
    'Style: ' + style + '\n' +
    'Remember: output ONLY the JSON object, no commentary.';
}

async function tryParseJsonFromText(text) {
  if (!text) return null;
  var trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {}
  // Try to find a JSON object in the text
  var start = trimmed.indexOf('{');
  var end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.substring(start, end + 1));
    } catch (e) {}
  }
  return null;
}

function validateOutline(outline) {
  if (!outline || typeof outline !== 'object') return null;
  if (typeof outline.title !== 'string' || outline.title.length === 0) return null;
  if (!Array.isArray(outline.slides) || outline.slides.length === 0) return null;

  var cleanSlides = [];
  for (var i = 0; i < outline.slides.length; i++) {
    var s = outline.slides[i];
    if (!s || typeof s !== 'object') continue;
    if (typeof s.title !== 'string') continue;
    cleanSlides.push({
      title: String(s.title).substring(0, 200),
      bullets: Array.isArray(s.bullets) ? s.bullets.map(function(b) { return String(b).substring(0, 300); }).slice(0, 8) : [],
      notes: typeof s.notes === 'string' ? s.notes.substring(0, 600) : ''
    });
  }
  if (cleanSlides.length === 0) return null;

  return {
    title: String(outline.title).substring(0, 200),
    subtitle: typeof outline.subtitle === 'string' ? outline.subtitle.substring(0, 300) : '',
    slides: cleanSlides
  };
}

import { aiChat } from '../../libs/ai-provider.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (context.request.method === 'GET') {
    return json({
      tool: 'ai-ppt-maker-outline',
      version: '1.0.0',
      status: 'ready',
      limits: { min_slides: MIN_SLIDES, max_slides: MAX_SLIDES },
      styles: Object.keys(ALLOWED_STYLES),
      languages: Object.keys(ALLOWED_LANGUAGES)
    });
  }

  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use GET for health or POST to generate outline.' }, 405);
  }

  var body;
  try { body = await context.request.json(); }
  catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  var topic = (body.topic || '').toString().trim();
  var slideCount = parseInt(body.slideCount, 10);
  var style = (body.style || 'modern').toString();
  var language = (body.language || 'en').toString();

  if (!topic) {
    return json({ error: 'Topic is required.' }, 400);
  }
  if (topic.length > 500) {
    return json({ error: 'Topic too long (max 500 chars).' }, 400);
  }
  if (!slideCount || slideCount < MIN_SLIDES) slideCount = MIN_SLIDES;
  if (slideCount > MAX_SLIDES) slideCount = MAX_SLIDES;
  if (!ALLOWED_STYLES[style]) {
    return json({ error: 'Invalid style. Use: ' + Object.keys(ALLOWED_STYLES).join(', ') }, 400);
  }
  if (!ALLOWED_LANGUAGES[language]) {
    return json({ error: 'Invalid language. Use: ' + Object.keys(ALLOWED_LANGUAGES).join(', ') }, 400);
  }

  var systemPrompt = buildSystemPrompt(style, language, slideCount);
  var userPrompt = buildUserPrompt(topic, slideCount, style);

  // One chain for the whole site. The four legs this had all named retired
  // models, so the whole tool returned 500 (BUG-327).
  try {
    var ai = await aiChat(context.env, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.6,
      max_tokens: 4096,
      json: true
    });
    var validated = validateOutline(await tryParseJsonFromText(ai.content));
    if (validated) {
      // Truncate or pad to requested slide count
      if (validated.slides.length > slideCount) {
        validated.slides = validated.slides.slice(0, slideCount);
      } else if (validated.slides.length < slideCount) {
        while (validated.slides.length < slideCount) {
          validated.slides.push({
            title: 'Additional Insights',
            bullets: ['Continue exploring key points', 'Reference earlier discussion'],
            notes: 'Continue the presentation with supporting material.'
          });
        }
      }
      return json({
        outline: validated,
        provider: ai.provider,
        style: style,
        language: language,
        slideCount: slideCount
      });
    }
    return json({ error: ai.provider + ' returned an outline this tool could not read. Try again.' }, 502);
  } catch (e) {
    console.error('PPT outline failed:', e && e.message);
    return json({ error: e.message || 'Outline generation failed' }, 502);
  }
}
