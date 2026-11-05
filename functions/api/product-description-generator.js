import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * Product Description Generator API
 * Single AI call generates descriptions for 5 e-commerce platforms + SEO data + JSON-LD schema
 * Multi-provider fallback: Agnes -> Groq -> NVIDIA -> deterministic
 * Optional DeAI post-processing to humanize AI-generated prose (env: DEVTOOLS_DEAI_KEY)
 *
 * Endpoints:
 *   POST /api/product-description-generator   - Generate product descriptions
 *   GET  /api/product-description-generator   - Health check
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
    const desc = result.descriptions || {};
    const tasks = [];
    if (desc.amazon) {
      if (desc.amazon.description) tasks.push(humanizeText(env, desc.amazon.description).then(t => { desc.amazon.description = t; }));
      if (desc.amazon.bullets) tasks.push(humanizeText(env, desc.amazon.bullets).then(t => { desc.amazon.bullets = t; }));
    }
    if (desc.ebay && desc.ebay.description) tasks.push(humanizeText(env, desc.ebay.description).then(t => { desc.ebay.description = t; }));
    if (desc.etsy && desc.etsy.description) tasks.push(humanizeText(env, desc.etsy.description).then(t => { desc.etsy.description = t; }));
    if (desc.shopify && desc.shopify.description) tasks.push(humanizeText(env, desc.shopify.description).then(t => { desc.shopify.description = t; }));
    if (desc.walmart && desc.walmart.description) tasks.push(humanizeText(env, desc.walmart.description).then(t => { desc.walmart.description = t; }));
    if (result.faqs && result.faqs.length) {
      for (let i = 0; i < result.faqs.length; i++) {
        if (result.faqs[i].answer) {
          const idx = i;
          tasks.push(humanizeText(env, result.faqs[idx].answer).then(t => { result.faqs[idx].answer = t; }));
        }
      }
    }
    if (result.meta_description) tasks.push(humanizeText(env, result.meta_description).then(t => { result.meta_description = t; }));
    await Promise.allSettled(tasks);
    result.descriptions = desc;
    return { result, deai_used: true };
  } catch (e) {
    return { result, deai_used: false };
  }
}

function getLanguageName(code) {
  const map = {
    en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
    it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)',
    hi: 'Hindi', ar: 'Arabic', ru: 'Russian'
  };
  return map[code] || 'English';
}

function buildSystemPrompt(voice, language, includeKeywords, includeFaq, includeProductSchema, brand) {
  const langName = getLanguageName(language);
  const voiceGuides = {
    professional: 'Professional. Authoritative voice. Focus on specifications, certifications, and tangible benefits. Avoid hype words.',
    casual: 'Casual. Friendly conversational tone. Contractions, second-person pronouns, relatable scenarios.',
    luxury: 'Luxury. Premium sophisticated language. Emphasize craftsmanship, heritage, exclusivity.',
    playful: 'Playful. Fun energetic tone. Energetic language, occasional exclamation.',
    technical: 'Technical. Engineer-focused. Specifications first, then features. Use precise measurements and technical vocabulary.'
  };

  return `You are a world-class e-commerce copywriter who knows Amazon Style Guide, eBay listing rules, Etsy seller handbook, Shopify product SEO, and Walmart Marketplace standards.

Given a single product input, you will produce FIVE platform-optimized product descriptions plus SEO data in a single response.

PLATFORM SPECIFICATIONS (CRITICAL — RESPECT ALL HARD LIMITS):

AMAZON (key: "amazon" → {title, bullets, description}):
- Title: HARD LIMIT 200 characters. Format: Brand + Product Line + Key Feature + Size/Quantity. No promotional language (no "best", "#1", "free shipping").
- Bullets: EXACTLY 5 bullet points, HARD LIMIT 500 characters TOTAL (combined). Each starts with a CAPITALIZED benefit verb. No period at end. Focus on 5 distinct features.
- Description: HARD LIMIT 2000 characters. Plain text or basic HTML (h2, p, ul, li, b). No promotional language.

EBAY (key: "ebay" → {title, description}):
- Title: HARD LIMIT 80 characters. Format: Brand + Product + Key Feature + Condition. No all-caps words.
- Description: HARD LIMIT 4000 characters. HTML allowed (h2, h3, p, ul, li, b, br). Buyer-focused.

ETSY (key: "etsy" → {title, description, tags}):
- Title: HARD LIMIT 140 characters. Friendly, descriptive, no keyword stuffing.
- Description: HARD LIMIT 10000 characters. Personal story tone OK. HTML allowed.
- Tags: EXACTLY 13 tags, EACH max 20 characters. Multi-word phrases OK (e.g., "birthday gift").

SHOPIFY (key: "shopify" → {title, description, seo_title, seo_description}):
- Title: No hard limit but keep under 100 chars. Plain text.
- Description: HTML allowed (h2, h3, p, ul, li, b). Rich formatting encouraged.
- SEO Title: HARD LIMIT 70 characters.
- SEO Description: HARD LIMIT 160 characters.

WALMART (key: "walmart" → {title, description}):
- Title: 75-200 characters. Brand + Product + Key Feature + Spec.
- Description: HARD LIMIT 4000 characters. Plain text or basic HTML.

VOICE: ${voiceGuides[voice] || voiceGuides.professional}

${includeKeywords ? 'SEO KEYWORDS (key: "seo_keywords" → array of 15-20 strings): Ranked by search relevance. Mix of head terms (high volume) and long-tail (specific). All lowercase. No duplicates.' : 'Skip SEO keywords array.'}

META DESCRIPTION (key: "meta_description" → string): HARD LIMIT 155 characters. Optimized for Google SERP. Includes primary keyword naturally. Has a call-to-action.

${includeFaq ? `FAQ SUGGESTIONS (key: "faqs" → array of exactly 5 {question, answer} objects): Each question addresses a real buyer concern (shipping, sizing, compatibility, warranty, materials). Each answer is 1-3 sentences, factual and helpful. Optimized to qualify for FAQPage rich result schema.

FAQPage JSON-LD SCHEMA (key: "faq_schema" → string): Valid Schema.org FAQPage JSON-LD. Must be parseable JSON. Include all 5 FAQs in mainEntity array. Use schema.org/Question and schema.org/Answer types.` : 'Skip FAQs and FAQPage schema.'}

${includeProductSchema ? `PRODUCT JSON-LD SCHEMA (key: "product_schema" → string): Valid Schema.org Product JSON-LD. Must be parseable JSON. Include @context, @type: "Product", name, description, sku, brand ({"@type":"Brand","name":"${brand || 'Brand Name'}"}), aggregateRating ({"@type":"AggregateRating","ratingValue":"4.5","reviewCount":"127"}), and offers ({"@type":"Offer","priceCurrency":"USD","price":"29.99","availability":"https://schema.org/InStock"}).` : 'Skip Product schema.'}

OUTPUT LANGUAGE: All text fields in ${langName}. SEO keywords also in ${langName} (lowercase).

CRITICAL OUTPUT FORMAT:
Return ONLY a valid JSON object (no markdown fences, no preamble, no explanations). Use these top-level keys exactly: "amazon", "ebay", "etsy", "shopify", "walmart", "seo_keywords", "meta_description", "faqs", "product_schema", "faq_schema". Each platform key holds an object with the platform-specific fields described above. Hard character limits MUST be respected strictly.`;
}

function buildUserPrompt(input) {
  const lines = [];
  lines.push('Product Name: ' + input.product_name);
  if (input.brand) lines.push('Brand: ' + input.brand);
  if (input.category) lines.push('Category: ' + input.category);
  lines.push('');
  lines.push('Key Features & Specs:');
  lines.push(input.key_features);
  if (input.audience) {
    lines.push('');
    lines.push('Target Audience: ' + input.audience);
  }
  lines.push('');
  lines.push('Generate all 5 platform descriptions plus SEO data. Stay within every character limit. Return only the JSON.');
  return lines.join('\n');
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

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.substring(0, max - 3) + '...';
}

function generateFallback(input) {
  const name = input.product_name;
  const feats = input.key_features;
  const brand = input.brand || 'Brand';
  const featureList = feats.split(/[.,;\n]/).filter(f => f.trim().length > 5).slice(0, 5);

  const amazonTitle = truncate((brand ? brand + ' ' : '') + name, 200);
  const amazonBullets = featureList.map(f => '• ' + truncate(f.trim().replace(/^[•\-*\s]+/, ''), 95).toUpperCase().charAt(0) + truncate(f.trim().replace(/^[•\-*\s]+/, ''), 95).substring(1)).join('\n');
  const amazonBulletsTrim = truncate(amazonBullets, 500);
  const amazonDesc = truncate(feats + '\n\nAbout this product:\n' + name + ' is designed for ' + (input.audience || 'everyday use') + '. Made by ' + brand + '.', 2000);

  const ebayTitle = truncate((brand ? brand + ' ' : '') + name, 80);
  const ebayDesc = '<h2>' + name + '</h2>\n<p>' + feats + '</p>\n<ul>' + featureList.map(f => '<li>' + f.trim() + '</li>').join('') + '</ul>';

  const etsyTitle = truncate(name, 140);
  const etsyDesc = truncate('<h2>' + name + '</h2>\n<p>' + feats + '</p>\n<p>Perfect for ' + (input.audience || 'daily use') + '.</p>', 10000);
  const etsyTags = ['gift idea', 'handmade', 'quality', 'premium', 'unique', 'handcrafted', 'special', 'popular', 'trending', 'bestseller', 'new', 'sale', 'limited'].slice(0, 13).map(t => t.substring(0, 20));

  const shopifyTitle = truncate(name, 100);
  const shopifyDesc = '<h2>' + name + '</h2>\n<p>' + feats + '</p>\n<h3>Features</h3><ul>' + featureList.map(f => '<li>' + f.trim() + '</li>').join('') + '</ul>';
  const shopifySeoTitle = truncate(name, 70);
  const shopifySeoDesc = truncate(feats.substring(0, 150), 160);

  const walmartTitle = truncate((brand ? brand + ' ' : '') + name, 200);
  const walmartDesc = truncate('<h2>' + name + '</h2>\n<p>' + feats + '</p>', 4000);

  const keywords = [name.toLowerCase(), brand.toLowerCase()].concat(
    feats.toLowerCase().split(/\W+/).filter(w => w.length > 4).slice(0, 18)
  ).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);

  const metaDesc = truncate(name + ' - ' + feats.substring(0, 100), 155);

  const faqs = [
    { question: 'What is included in the package?', answer: 'The package includes ' + name + ' and all accessories needed for immediate use.' },
    { question: 'How long does shipping take?', answer: 'Standard shipping takes 3-7 business days. Express options are available at checkout.' },
    { question: 'Is there a warranty?', answer: 'Yes, this product comes with a standard 1-year manufacturer warranty covering defects in materials and workmanship.' },
    { question: 'What if I am not satisfied?', answer: 'We offer a 30-day money-back guarantee. Contact our support team for a full refund or exchange.' },
    { question: 'How do I contact customer support?', answer: 'You can reach our support team 24/7 via email or live chat on our website.' }
  ];

  return {
    descriptions: {
      amazon: { title: amazonTitle, bullets: amazonBulletsTrim, description: amazonDesc },
      ebay: { title: ebayTitle, description: ebayDesc },
      etsy: { title: etsyTitle, description: etsyDesc, tags: etsyTags },
      shopify: { title: shopifyTitle, description: shopifyDesc, seo_title: shopifySeoTitle, seo_description: shopifySeoDesc },
      walmart: { title: walmartTitle, description: walmartDesc }
    },
    seo_keywords: keywords,
    meta_description: metaDesc,
    faqs: faqs,
    product_schema: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      'name': name,
      'description': metaDesc,
      'sku': 'SKU-' + Date.now(),
      'brand': { '@type': 'Brand', 'name': brand },
      'aggregateRating': { '@type': 'AggregateRating', 'ratingValue': '4.5', 'reviewCount': '127' },
      'offers': { '@type': 'Offer', 'priceCurrency': 'USD', 'price': '29.99', 'availability': 'https://schema.org/InStock' }
    }, null, 2),
    faq_schema: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': faqs.map(f => ({
        '@type': 'Question',
        'name': f.question,
        'acceptedAnswer': { '@type': 'Answer', 'text': f.answer }
      }))
    }, null, 2)
  };
}

function sanitizeResult(parsed, input) {
  const out = { descriptions: {}, seo_keywords: [], meta_description: '', faqs: [], product_schema: '', faq_schema: '' };
  if (parsed.amazon && typeof parsed.amazon === 'object') {
    out.descriptions.amazon = {
      title: truncate(parsed.amazon.title || '', 200),
      bullets: truncate(parsed.amazon.bullets || '', 500),
      description: truncate(parsed.amazon.description || '', 2000)
    };
  }
  if (parsed.ebay && typeof parsed.ebay === 'object') {
    out.descriptions.ebay = {
      title: truncate(parsed.ebay.title || '', 80),
      description: truncate(parsed.ebay.description || '', 4000)
    };
  }
  if (parsed.etsy && typeof parsed.etsy === 'object') {
    let tags = Array.isArray(parsed.etsy.tags) ? parsed.etsy.tags : [];
    tags = tags.slice(0, 13).map(t => truncate(String(t), 20));
    out.descriptions.etsy = {
      title: truncate(parsed.etsy.title || '', 140),
      description: truncate(parsed.etsy.description || '', 10000),
      tags: tags
    };
  }
  if (parsed.shopify && typeof parsed.shopify === 'object') {
    out.descriptions.shopify = {
      title: truncate(parsed.shopify.title || '', 200),
      description: truncate(parsed.shopify.description || '', 5000),
      seo_title: truncate(parsed.shopify.seo_title || '', 70),
      seo_description: truncate(parsed.shopify.seo_description || '', 160)
    };
  }
  if (parsed.walmart && typeof parsed.walmart === 'object') {
    out.descriptions.walmart = {
      title: truncate(parsed.walmart.title || '', 200),
      description: truncate(parsed.walmart.description || '', 4000)
    };
  }
  if (Array.isArray(parsed.seo_keywords)) {
    out.seo_keywords = parsed.seo_keywords.slice(0, 20).map(k => String(k));
  }
  out.meta_description = truncate(parsed.meta_description || '', 155);
  if (Array.isArray(parsed.faqs)) {
    out.faqs = parsed.faqs.slice(0, 5).map(f => ({
      question: String(f.question || '').substring(0, 200),
      answer: String(f.answer || '').substring(0, 500)
    }));
  }
  if (typeof parsed.product_schema === 'string') {
    try {
      const test = JSON.parse(parsed.product_schema);
      if (test['@type'] === 'Product') out.product_schema = JSON.stringify(test, null, 2);
    } catch (e) { /* ignore */ }
  }
  if (typeof parsed.faq_schema === 'string') {
    try {
      const test = JSON.parse(parsed.faq_schema);
      if (test['@type'] === 'FAQPage') out.faq_schema = JSON.stringify(test, null, 2);
    } catch (e) { /* ignore */ }
  }
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'product-description-generator',
      version: '1.0.0',
      status: 'ready',
      providers: PROVIDERS.map(p => p.name),
      platforms: ['amazon', 'ebay', 'etsy', 'shopify', 'walmart'],
      features: ['multi_platform', 'seo_keywords', 'meta_description', 'faqs', 'json_ld_product', 'json_ld_faqpage'],
      note: 'Single AI call generates descriptions for 5 e-commerce platforms plus SEO data and JSON-LD schema markup.'
    }), { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const productName = (body.product_name || '').toString().trim();
  const keyFeatures = (body.key_features || '').toString().trim();
  const category = (body.category || '').toString().trim();
  const audience = (body.audience || '').toString().trim();
  const brand = (body.brand || '').toString().trim();
  const voice = (body.voice || 'professional').toString();
  const language = (body.language || 'en').toString();
  const includeKeywords = body.include_keywords !== false;
  const includeFaq = body.include_faq !== false;
  const includeProductSchema = body.include_product_schema !== false;

  if (!productName) {
    return new Response(JSON.stringify({ error: 'product_name is required' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!keyFeatures) {
    return new Response(JSON.stringify({ error: 'key_features is required' }), { status: 422, headers: CORS_HEADERS });
  }
  if (keyFeatures.length < 20) {
    return new Response(JSON.stringify({ error: 'key_features must be at least 20 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (productName.length > 200) {
    return new Response(JSON.stringify({ error: 'product_name must be 200 characters or less' }), { status: 422, headers: CORS_HEADERS });
  }
  if (keyFeatures.length > 2000) {
    return new Response(JSON.stringify({ error: 'key_features must be 2000 characters or less' }), { status: 422, headers: CORS_HEADERS });
  }

  const validVoices = ['professional', 'casual', 'luxury', 'playful', 'technical'];
  if (!validVoices.includes(voice)) {
    return new Response(JSON.stringify({ error: 'invalid voice' }), { status: 422, headers: CORS_HEADERS });
  }

  const input = { product_name: productName, key_features: keyFeatures, category, audience, brand, voice, language };

  let result = null;
  let aiProvider = null;
  let aiError = null;
  try {
    const systemPrompt = buildSystemPrompt(voice, language, includeKeywords, includeFaq, includeProductSchema, brand);
    const userPrompt = buildUserPrompt(input);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const aiResult = await callAI(env, messages, 4000);
    aiProvider = aiResult.provider;
    try {
      const parsed = extractJson(aiResult.content);
      if (parsed && typeof parsed === 'object') {
        result = sanitizeResult(parsed, input);
        if (Object.keys(result.descriptions).length === 0) {
          aiError = 'AI returned no valid platform descriptions';
          result = null;
        }
      } else {
        aiError = 'AI returned non-object response';
      }
    } catch (parseErr) {
      aiError = 'AI JSON parse error: ' + parseErr.message;
    }
  } catch (e) {
    aiError = e.message;
  }

  if (!result) {
    result = generateFallback(input);
  }

  const deaiResult = await maybeHumanizeResult(env, result);

  return new Response(JSON.stringify({
    descriptions: deaiResult.result.descriptions,
    seo_keywords: deaiResult.result.seo_keywords,
    meta_description: deaiResult.result.meta_description,
    faqs: deaiResult.result.faqs,
    product_schema: deaiResult.result.product_schema,
    faq_schema: deaiResult.result.faq_schema,
    meta: {
      product_name: productName,
      brand,
      voice,
      language,
      category,
      audience,
      ai_provider: aiProvider,
      ai_error: aiError,
      deai_used: deaiResult.deai_used,
      char_counts: Object.fromEntries(Object.entries(deaiResult.result.descriptions || {}).map(([k, v]) => [k, JSON.stringify(v).length])),
      keywords_count: (deaiResult.result.seo_keywords || []).length,
      faqs_count: (deaiResult.result.faqs || []).length
    }
  }), { headers: CORS_HEADERS });
}
