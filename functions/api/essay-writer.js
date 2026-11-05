import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Essay Writer API
 *
 * Generates structured academic essays for 9 essay types (Argumentative,
 * Persuasive, Compare/Contrast, Cause/Effect, Narrative, Descriptive,
 * Expository, Critical/Analytical, Process), 4 academic levels (Middle School,
 * High School, Undergraduate, Graduate), and 5 citation styles (APA, MLA,
 * Chicago, Harvard, IEEE).
 *
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes -> deterministic template.
 * Optional DeAI post-processing for humanization.
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
    maxTokens: 3200
  },
  {
    name: 'nvidia1',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    model: 'mistralai/mistral-large-2-instruct',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    maxTokens: 3200
  },
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1',
    maxTokens: 3200
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2',
    maxTokens: 3200
  }
];

const ESSAY_TYPES = {
  argumentative: {
    label: 'Argumentative',
    hint: 'Take a clear position on a debatable topic. State a thesis, present 3 strong arguments with supporting evidence and counter-arguments, and conclude by reinforcing your position. Address the strongest objection to your view.',
    structure: ['Hook + context', 'Thesis statement', 'Argument 1 + evidence', 'Argument 2 + evidence', 'Counter-argument + rebuttal', 'Conclusion + restated thesis'],
    needs_counter_argument: true
  },
  persuasive: {
    label: 'Persuasive',
    hint: 'Convince the reader to take action or adopt a viewpoint. Use emotional appeal, credibility (ethos), logical reasoning (logos), and stories. End with a strong call to action.',
    structure: ['Attention-grabber', 'Clear position', 'Emotional appeal', 'Logical support', 'Credibility signal', 'Call to action'],
    needs_counter_argument: false
  },
  compare_contrast: {
    label: 'Compare & Contrast',
    hint: 'Examine two subjects, highlighting both similarities and differences. Use either point-by-point (alternating) or block (all of A then all of B) structure. End with a meaningful insight about what the comparison reveals.',
    structure: ['Introduction with both subjects', 'Similarity 1 / Difference 1', 'Similarity 2 / Difference 2', 'Similarity 3 / Difference 3', 'Synthesis: what the comparison reveals'],
    needs_counter_argument: false
  },
  cause_effect: {
    label: 'Cause & Effect',
    hint: 'Examine why something happens (causes) and what results from it (effects). Trace the chain of causation. Distinguish between immediate and remote causes. Consider unintended effects.',
    structure: ['Introduction to the phenomenon', 'Primary cause', 'Contributing causes', 'Immediate effects', 'Long-term effects', 'Conclusion'],
    needs_counter_argument: false
  },
  narrative: {
    label: 'Narrative',
    hint: 'Tell a story with a clear beginning, middle, and end. Use vivid sensory detail, dialogue, and a consistent point of view. Convey a broader meaning or lesson without stating it explicitly.',
    structure: ['Scene setting', 'Inciting incident', 'Rising tension', 'Climax', 'Resolution', 'Reflection / lesson'],
    needs_counter_argument: false
  },
  descriptive: {
    label: 'Descriptive',
    hint: 'Paint a vivid picture using sensory details, figurative language, and concrete observations. Organize by spatial order, chronological order, or importance. Avoid simply listing features.',
    structure: ['Overall impression', 'Dominant detail cluster', 'Secondary detail cluster', 'Unusual or memorable detail', 'Concluding impression'],
    needs_counter_argument: false
  },
  expository: {
    label: 'Expository',
    hint: 'Explain a concept, process, or topic objectively. Use clear definitions, examples, comparisons, and cause-effect reasoning. Stay neutral; do not argue a position.',
    structure: ['Topic + scope', 'Definition or background', 'Category 1 explained', 'Category 2 explained', 'Example or case study', 'Summary of key points'],
    needs_counter_argument: false
  },
  critical: {
    label: 'Critical / Analytical',
    hint: 'Analyze a text, idea, or work by breaking it into parts, evaluating each, and synthesizing a judgment. Move beyond summary to interpretation. Use specific evidence.',
    structure: ['Work or text introduced', 'Summary in your own words', 'Analysis of key element 1', 'Analysis of key element 2', 'Synthesis / overall judgment'],
    needs_counter_argument: false
  },
  process: {
    label: 'Process',
    hint: 'Explain how to do something or how something works. Use chronological order with clear transition words. Define any technical terms. Include warnings or common pitfalls where relevant.',
    structure: ['Overview of the process', 'Materials or prerequisites', 'Step 1', 'Step 2', 'Step 3', 'Final result or troubleshooting'],
    needs_counter_argument: false
  }
};

const LEVELS = {
  middle: 'Middle school (grades 6-8). Sentences 10-15 words. Vocabulary at 7th-grade reading level. Concrete examples. Avoid jargon. Explain any abstract term.',
  high: 'High school (grades 9-12). Sentences 12-20 words. Vocabulary at 10th-grade reading level. Mix of concrete and abstract examples. Some technical terms allowed with brief definition.',
  undergrad: 'Undergraduate / college freshman-sophomore. Sentences 15-25 words. College-level vocabulary. Comfortable with discipline-specific terms. Expects analytical depth.',
  graduate: 'Graduate / upper-college. Sentences 18-30 words. Advanced academic vocabulary. Assumes disciplinary literacy. Engagement with scholarly debates expected. Nuanced argument.'
};

const CITATIONS = {
  apa: 'APA 7th edition. Author-date in-text (Smith, 2023) plus References list. Author surnames in references reversed: Smith, J. M.',
  mla: 'MLA 9th edition. Author-page in-text (Smith 42) plus Works Cited list. Container-system hierarchy. Medium-of-publication tags.',
  chicago: 'Chicago Manual of Style 17th (author-date). Author-date in-text (Smith 2023) plus Reference list. Notes-Bibliography style for humanities.',
  harvard: 'Harvard (similar to APA). Author-date in-text (Smith, 2023). Alphabetical reference list. Common in UK and Australian universities.',
  ieee: 'IEEE Editorial Style. Numeric in-text [1] plus References list numbered in order of appearance. Standard for engineering and CS.'
};

const TONES = {
  academic: 'Academic. Formal third-person. Evidence-based. No first-person. Hedging where appropriate (e.g., "suggests", "appears to").',
  persuasive: 'Persuasive. Direct address of the reader. Rhetorical devices allowed. Calls to action.',
  analytical: 'Analytical. Neutral observation. Categorize and compare. No advocacy.',
  reflective: 'Reflective. First-person allowed. Personal insight balanced with critical thinking.',
  conversational: 'Conversational. Accessible to a general reader. Contractions allowed. Short sentences.'
};

const LENGTHS = {
  short: '300-450 words. 3 paragraphs. Tight structure. One supporting point per body paragraph.',
  medium: '600-800 words. 4-5 paragraphs. Standard academic essay. Intro with thesis, 2-3 body paragraphs, conclusion.',
  long: '1000-1400 words. 6-8 paragraphs. Extended treatment. Multiple supporting points, transitions between paragraphs, deeper analysis.',
  extended: '1600-2200 words. 8-12 paragraphs. Full research-essay treatment. Multiple sources cited, counter-arguments engaged with.'
};

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

function buildSystemPrompt(opts, mode) {
  const lang = opts.language === 'zh' ? 'Chinese' : 'English';
  const typeObj = ESSAY_TYPES[opts.essay_type] || ESSAY_TYPES.expository;
  const level = LEVELS[opts.academic_level] || LEVELS.undergrad;
  const citation = CITATIONS[opts.citation_style] || CITATIONS.apa;
  const tone = TONES[opts.tone] || TONES.academic;
  const length = LENGTHS[opts.length] || LENGTHS.medium;

  if (mode === 'outline') {
    return `You are an academic writing instructor. Design a structured outline for an essay.

LANGUAGE: Write in ${lang}.

ESSAY TYPE: ${typeObj.label}
STRUCTURE TEMPLATE TO FOLLOW: ${typeObj.structure.join(' | ')}

ACADEMIC LEVEL: ${level}

LENGTH TARGET: ${length}

OUTPUT FORMAT — return ONLY a JSON object with this exact shape:
{
  "thesis": "one-sentence thesis statement that takes a clear position or states a focused claim",
  "outline": [
    {"section": "Introduction", "purpose": "what this section accomplishes", "key_points": ["point 1", "point 2"]},
    {"section": "Body Paragraph 1", "purpose": "...", "key_points": ["..."]},
    {"section": "Body Paragraph 2", "purpose": "...", "key_points": ["..."]},
    {"section": "Body Paragraph 3", "purpose": "...", "key_points": ["..."]},
    {"section": "Conclusion", "purpose": "...", "key_points": ["..."]}
  ],
  "citation_reminders": ["where in the essay a citation is needed", "..."]
}

CITATION STYLE TO RECOMMEND: ${opts.citation_style} - ${citation}

RULES:
- The thesis must be specific, arguable, and answer a real question.
- Each outline section must have 2-4 concrete key_points, not vague gestures.
- citation_reminders should name 3-5 places where evidence is required.
- Return ONLY the JSON. No prose before or after. No markdown fences.`;
  }

  if (mode === 'thesis') {
    return `You are an academic writing instructor. Generate 3 alternative thesis statements.

LANGUAGE: Write in ${lang}.

ESSAY TYPE: ${typeObj.label}

ACADEMIC LEVEL: ${level}

OUTPUT FORMAT — return ONLY a JSON object with this exact shape:
{
  "theses": [
    {"thesis": "first thesis statement", "strength": "why this is a strong thesis"},
    {"thesis": "second thesis statement", "strength": "why this is a strong thesis"},
    {"thesis": "third thesis statement", "strength": "why this is a strong thesis"}
  ],
  "recommendation": "which thesis to use and why"
}

RULES:
- Each thesis must take a clear, arguable position.
- Each thesis must be specific, not generic.
- Each thesis must be 1-2 sentences, 20-40 words.
- Recommendation must justify the choice in 1-2 sentences.
- Return ONLY the JSON. No prose before or after. No markdown fences.`;
  }

  return `You are an academic writing instructor. Write a complete essay that follows the academic conventions of its essay type and citation style.

LANGUAGE: Write the entire essay in ${lang}.

ESSAY TYPE: ${typeObj.label}
STRUCTURE TEMPLATE TO FOLLOW: ${typeObj.structure.join(' | ')}

ACADEMIC LEVEL: ${level}

TONE: ${tone}

LENGTH: ${length}

CITATION STYLE: ${opts.citation_style} - ${citation}
PLACE CITATION MARKERS in the body where evidence is required. Use the format consistent with the citation style (e.g., (Smith, 2023) for APA, (Smith 42) for MLA, [1] for IEEE).

OUTPUT FORMAT — return ONLY a JSON object with this exact shape:
{
  "title": "essay title",
  "thesis": "the thesis statement",
  "introduction": "the introduction paragraph(s), plain text, no markdown",
  "body": "the body paragraphs separated by \\n\\n, plain text, no markdown, citation markers included inline",
  "conclusion": "the conclusion paragraph(s), plain text, no markdown",
  "references": ["reference 1 in ${opts.citation_style} format", "reference 2", "..."],
  "citation_markers": ["every citation marker that appears in the body, e.g., (Smith, 2023)"],
  "counter_argument": ${typeObj.needs_counter_argument ? '"the strongest objection to the thesis and a brief rebuttal, 1-2 sentences"' : '""'}
}

RULES:
- The introduction must end with the thesis statement.
- Body paragraphs must each open with a topic sentence and close with a transition or wrap-up.
- ${typeObj.needs_counter_argument ? 'You MUST include the counter_argument field, acknowledging the strongest objection and refuting it.' : 'counter_argument may be empty since this essay type does not need one.'}
- Citation markers should be realistic (author + year / page / number) but the author names do not need to be real living scholars; use plausible academic names.
- The references list must contain at least 3 entries in the proper ${opts.citation_style} format.
- Use plain text only. No markdown, no bullet characters, no bold, no em-dashes.
- The writing must read as a real student essay, not as a chatbot.
- Return ONLY the JSON. No prose before or after. No markdown fences.`;
}

function buildUserPrompt(opts, mode) {
  const lines = [
    `Essay type: ${(ESSAY_TYPES[opts.essay_type] || ESSAY_TYPES.expository).label}`,
    `Academic level: ${opts.academic_level}`,
    `Citation style: ${opts.citation_style}`,
    `Tone: ${opts.tone}`,
    `Length: ${opts.length}`,
    `Topic: ${opts.topic || '(none provided — invent a reasonable topic)'}`,
    `Key points or arguments to include (verbatim — do NOT drop any):`,
    opts.key_points || '(no specific key points — use your judgment to develop the topic)'
  ];
  return lines.join('\n');
}

function extractJson(text) {
  let cleaned = (text || '').trim();
  if (!cleaned) throw new Error('Empty AI response');
  if (cleaned.startsWith('```')) {
    const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) cleaned = m[1];
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object in AI response');
  }
  cleaned = cleaned.substring(first, last + 1);
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    const fixed = cleaned
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/([\u201C\u201D])/g, '"')
      .replace(/([\u2018\u2019])/g, "'");
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      throw new Error('AI JSON parse failed: ' + e2.message);
    }
  }
}

function fallbackOutline(opts) {
  const typeObj = ESSAY_TYPES[opts.essay_type] || ESSAY_TYPES.expository;
  const sections = typeObj.structure.map((s, i) => ({
    section: i === 0 ? 'Introduction' : (i === typeObj.structure.length - 1 ? 'Conclusion' : ('Body Paragraph ' + i)),
    purpose: s,
    key_points: [
      'Open with a hook related to ' + (opts.topic || 'the topic') + '.',
      'Develop the ' + s.toLowerCase() + '.',
      'Use a real-world example or evidence.'
    ]
  }));
  return {
    thesis: 'A clear position on ' + (opts.topic || 'this topic') + ' that the essay will defend.',
    outline: sections,
    citation_reminders: [
      'Introduction — citing recent statistics on the topic',
      'Body Paragraph 1 — citing primary research',
      'Body Paragraph 2 — citing a contrasting viewpoint',
      'Conclusion — citing forward-looking data'
    ],
    _meta: { source: 'fallback' }
  };
}

function fallbackThesis(opts) {
  const t = opts.topic || 'this topic';
  return {
    theses: [
      { thesis: 'While ' + t + ' is often seen as simple, a closer examination reveals that it requires careful analysis of multiple dimensions.', strength: 'Frames a nuanced position that resists a simplistic reading.' },
      { thesis: 'The most important consequence of ' + t + ' is not its immediate impact but its long-term effect on related systems.', strength: 'Takes a clear, arguable position with depth.' },
      { thesis: 'Understanding ' + t + ' requires separating the technical reality from the popular narrative that surrounds it.', strength: 'Sets up an analytical frame that the essay can develop.' }
    ],
    recommendation: 'Use the second thesis. It takes the clearest position and lends itself to multi-paragraph development.',
    _meta: { source: 'fallback' }
  };
}

function fallbackEssay(opts) {
  const topic = opts.topic || 'this topic';
  const typeObj = ESSAY_TYPES[opts.essay_type] || ESSAY_TYPES.expository;
  const intro = [
    'Few topics invite as much discussion as ' + topic + '. The question matters because it shapes how we think about related issues.',
    'This essay argues that ' + topic + ' deserves more careful attention than it usually receives, and that a clearer picture emerges when we examine it systematically.'
  ].join(' ');
  const body = [
    'The first thing to notice about ' + topic + ' is that it rarely appears in isolation. Related factors always accompany it, and ignoring those factors leads to incomplete conclusions.',
    'A second consideration is timing. The way ' + topic + ' is approached changes depending on when the analysis is done. Earlier work focused on one set of assumptions; later work corrects those assumptions.',
    'Third, there are reasonable objections to the view presented here. Some readers will argue that the picture is more complicated than this essay allows, and they have a point.'
  ].join('\n\n');
  const conclusion = 'The evidence suggests that ' + topic + ' benefits from careful analysis rather than quick summary. Future work can build on this foundation by examining the assumptions that the analysis relied on, and by testing them against new data.';
  const references = [
    'Smith, J. M. (2023). ' + topic + ' reconsidered. Academic Press.',
    'Patel, R. & Chen, L. (2022). New perspectives on ' + topic + '. Journal of Studies, 18(3), 145-162.',
    'Garcia, A. (2021). ' + topic + ': a critical introduction. University Press.'
  ];
  return {
    title: 'Understanding ' + topic + ': a closer look',
    thesis: 'A clear, defensible position on ' + topic + ' emerges only after systematic analysis.',
    introduction: intro,
    body: body,
    conclusion: conclusion,
    references: references,
    citation_markers: references.map(function() { return '(citation needed)'; }),
    counter_argument: typeObj.needs_counter_argument ? 'Some readers will argue that the analysis is too narrow; however, the focus on systematic evidence rather than anecdote responds directly to that concern.' : '',
    _meta: { source: 'fallback' }
  };
}

function renderEssay(parsed) {
  const parts = [];
  if (parsed.title) parts.push(parsed.title);
  if (parsed.thesis) parts.push('Thesis: ' + parsed.thesis);
  if (parsed.introduction) {
    parts.push('');
    parts.push('Introduction');
    parts.push(parsed.introduction);
  }
  if (parsed.body) {
    parts.push('');
    parts.push('Body');
    parts.push(parsed.body);
  }
  if (parsed.counter_argument) {
    parts.push('');
    parts.push('Counter-argument');
    parts.push(parsed.counter_argument);
  }
  if (parsed.conclusion) {
    parts.push('');
    parts.push('Conclusion');
    parts.push(parsed.conclusion);
  }
  if (parsed.references && parsed.references.length) {
    parts.push('');
    parts.push('References');
    parts.push(parsed.references.join('\n'));
  }
  return parts.join('\n');
}

function countWords(s) {
  if (!s) return 0;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  return t.split(' ').length;
}

function essayWordCount(parsed) {
  if (!parsed) return 0;
  let n = 0;
  if (parsed.introduction) n += countWords(parsed.introduction);
  if (parsed.body) n += countWords(parsed.body);
  if (parsed.conclusion) n += countWords(parsed.conclusion);
  if (parsed.counter_argument) n += countWords(parsed.counter_argument);
  return n;
}

async function safeHumanize(text, env) {
  if (!text || text.length < 60) return text;
  const apiKey = env.DEVTOOLS_DEAI_KEY;
  if (!apiKey || apiKey === 'NOT_SET') return text;
  try {
    const response = await fetchWithTimeout('https://deai.029101.xyz/humanize', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text.substring(0, 6000),
        mode: 'balanced',
        multi_run: 1,
        adversarial: false,
        return_readability: false,
        wait: true
      })
    }, 35000);
    if (!response.ok) return text;
    const data = await response.json();
    if (data && data.result && typeof data.result === 'string' && data.result.trim()) {
      return data.result;
    }
    return text;
  } catch (e) {
    return text;
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'essay-writer',
      version: '1.0.0',
      status: 'ready',
      essay_types: Object.keys(ESSAY_TYPES),
      academic_levels: Object.keys(LEVELS),
      citation_styles: Object.keys(CITATIONS),
      tones: Object.keys(TONES),
      lengths: Object.keys(LENGTHS),
      providers: PROVIDERS.map(p => p.name),
      deai_available: !!env.DEVTOOLS_DEAI_KEY && env.DEVTOOLS_DEAI_KEY !== 'NOT_SET'
    }), { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const opts = {
    essay_type: (body.essay_type || 'expository').toString(),
    academic_level: (body.academic_level || 'undergrad').toString(),
    citation_style: (body.citation_style || 'apa').toString(),
    tone: (body.tone || 'academic').toString(),
    length: (body.length || 'medium').toString(),
    language: (body.language || 'en').toString(),
    topic: (body.topic || '').toString().trim(),
    key_points: (body.key_points || '').toString().trim(),
    mode: (body.mode || 'essay').toString(),
    humanize: body.humanize === true
  };

  if (!ESSAY_TYPES[opts.essay_type]) {
    return new Response(JSON.stringify({ error: 'invalid essay_type' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!LEVELS[opts.academic_level]) {
    return new Response(JSON.stringify({ error: 'invalid academic_level' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!CITATIONS[opts.citation_style]) {
    return new Response(JSON.stringify({ error: 'invalid citation_style' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!TONES[opts.tone]) {
    return new Response(JSON.stringify({ error: 'invalid tone' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!LENGTHS[opts.length]) {
    return new Response(JSON.stringify({ error: 'invalid length' }), { status: 422, headers: CORS_HEADERS });
  }
  if (opts.topic.length < 3) {
    return new Response(JSON.stringify({ error: 'topic is required (at least 3 characters)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (opts.topic.length > 500) {
    return new Response(JSON.stringify({ error: 'topic is too long (max 500 chars)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (opts.key_points.length > 2000) {
    return new Response(JSON.stringify({ error: 'key_points is too long (max 2000 chars)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!['outline', 'thesis', 'essay'].includes(opts.mode)) {
    return new Response(JSON.stringify({ error: 'invalid mode' }), { status: 422, headers: CORS_HEADERS });
  }

  let result = null;
  let aiProvider = null;
  let aiError = null;
  let humanized = false;

  try {
    if (opts.mode === 'outline') {
      const systemPrompt = buildSystemPrompt(opts, 'outline');
      const userPrompt = buildUserPrompt(opts, 'outline');
      const ai = await callAI(env, systemPrompt, userPrompt, 1400);
      aiProvider = ai.provider;
      const parsed = extractJson(ai.content);
      if (parsed && Array.isArray(parsed.outline)) {
        result = parsed;
      } else {
        aiError = 'AI returned no outline';
      }
    } else if (opts.mode === 'thesis') {
      const systemPrompt = buildSystemPrompt(opts, 'thesis');
      const userPrompt = buildUserPrompt(opts, 'thesis');
      const ai = await callAI(env, systemPrompt, userPrompt, 900);
      aiProvider = ai.provider;
      const parsed = extractJson(ai.content);
      if (parsed && Array.isArray(parsed.theses)) {
        result = parsed;
      } else {
        aiError = 'AI returned no theses';
      }
    } else {
      const systemPrompt = buildSystemPrompt(opts, 'essay');
      const userPrompt = buildUserPrompt(opts, 'essay');
      const ai = await callAI(env, systemPrompt, userPrompt, 3200);
      aiProvider = ai.provider;
      const parsed = extractJson(ai.content);
      if (parsed && parsed.body && parsed.body.trim()) {
        if (opts.humanize) {
          const hIntro = await safeHumanize(parsed.introduction || '', env);
          const hBody = await safeHumanize(parsed.body || '', env);
          const hConclusion = await safeHumanize(parsed.conclusion || '', env);
          const hCounter = parsed.counter_argument ? await safeHumanize(parsed.counter_argument, env) : '';
          const anyChanged = (hIntro !== parsed.introduction) || (hBody !== parsed.body) || (hConclusion !== parsed.conclusion) || (hCounter !== parsed.counter_argument);
          if (anyChanged) {
            parsed.introduction = hIntro;
            parsed.body = hBody;
            parsed.conclusion = hConclusion;
            parsed.counter_argument = hCounter;
            humanized = true;
          }
        }
        result = parsed;
      } else {
        aiError = 'AI returned no essay';
      }
    }
  } catch (e) {
    aiError = e.message;
  }

  if (!result) {
    if (opts.mode === 'outline') result = fallbackOutline(opts);
    else if (opts.mode === 'thesis') result = fallbackThesis(opts);
    else result = fallbackEssay(opts);
  }

  const out = {
    tool: 'essay-writer',
    mode: opts.mode,
    essay_type: opts.essay_type,
    academic_level: opts.academic_level,
    citation_style: opts.citation_style,
    tone: opts.tone,
    length: opts.length,
    language: opts.language,
    parsed: result,
    ai_provider: aiProvider,
    ai_error: aiError
  };

  if (opts.mode === 'essay') {
    out.rendered = renderEssay(result);
    out.word_count = essayWordCount(result);
    out.humanized = humanized;
  }

  return new Response(JSON.stringify(out), { headers: CORS_HEADERS });
}
