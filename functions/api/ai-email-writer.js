import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Email Writer & Reply Generator API
 *
 * Modes:
 *   - compose: generate a new email from type + key points
 *   - reply:   generate a reply to a pasted email
 *   - subject: standalone subject-line generator (3 variants)
 *
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes -> deterministic template
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
    maxTokens: 1800
  },
  {
    name: 'nvidia1',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    maxTokens: 1800
  },
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1',
    maxTokens: 1800
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2',
    maxTokens: 1800
  }
];

const EMAIL_TYPES = {
  apology:        { label: 'Apology',          hint: 'A sincere apology for a mistake or inconvenience. Acknowledge, take responsibility, fix, follow-up.' },
  followup:       { label: 'Follow-up',        hint: 'A polite follow-up after a meeting, interview, or no-response. Reference prior context, restate next step, set a deadline.' },
  thankyou:       { label: 'Thank You',        hint: 'A genuine thank-you after help, support, referral, business, or a favor. Specific, not generic.' },
  introduction:   { label: 'Introduction',     hint: 'Self-introduction to a new contact: who, why, what you want, mutual value.' },
  request:        { label: 'Request',          hint: 'A direct request: ask for a meeting, info, intro, or favor. Polite, clear, low-friction.' },
  inquiry:        { label: 'Inquiry',          hint: 'A neutral product / service / pricing / availability inquiry. Specific questions.' },
  complaint:      { label: 'Complaint',        hint: 'A formal complaint: state the issue, impact, evidence, and desired resolution. Calm, factual.' },
  resignation:    { label: 'Resignation',      hint: 'A professional resignation notice: gratitude, transition plan, last day.' },
  sales:          { label: 'Sales Outreach',   hint: 'Cold or warm sales outreach: hook, value, social proof, soft CTA.' },
  networking:     { label: 'Networking',       hint: 'A networking ask: who you are, mutual connection, specific ask, easy yes.' },
  reminder:       { label: 'Reminder',         hint: 'A friendly payment / deadline / appointment reminder. Brief, factual, with options.' },
  invitation:     { label: 'Invitation',       hint: 'An event / meeting invitation: what, when, where, why attend, RSVP.' },
  decline:        { label: 'Decline',          hint: 'A graceful decline (meeting, offer, invite, request). Reason, gratitude, alternative if any.' },
  acceptance:     { label: 'Acceptance',       hint: 'A clear acceptance (offer, invite, meeting). Confirm details, express enthusiasm, next step.' },
  feedback:       { label: 'Feedback Request', hint: 'A request for feedback on a draft, plan, or product. Specific asks, easy reply.' }
};

const TONES = {
  formal:       'Formal. Use full names, no contractions, traditional closings (Sincerely, Respectfully). No slang. Suitable for legal, executive, or official contexts.',
  professional: 'Professional. Warm but business-appropriate. Use contractions sparingly. Confident, clear, courteous.',
  friendly:     'Friendly. Warm and personable. Use contractions freely. Conversational but still appropriate for work. Include a light personal touch.',
  casual:       'Casual. Like texting a colleague you know well. Short sentences, contractions, relaxed punctuation. Still respectful.',
  persuasive:   'Persuasive. Compelling and benefit-driven. Use active verbs, concrete numbers, social proof. Soft CTA.',
  apologetic:   'Apologetic. Sincere, accountable, no excuses. Acknowledge impact, propose concrete fix, invite further dialogue.'
};

const LENGTHS = {
  short:  '50-90 words. 2-3 sentences in the body. Skip pleasantries. Lead with the ask or apology. Suitable for quick chat-style replies.',
  medium: '120-200 words. 3-5 short paragraphs. Standard business email. Greeting, context, ask, sign-off.',
  long:   '250-400 words. Full professional structure. Greeting, context paragraph, details, ask, sign-off. Use for formal or sensitive topics.'
};

const RECIPIENTS = {
  boss:        'Recipient is your direct boss or manager. Be respectful, concise, action-oriented.',
  client:      'Recipient is an external client. Be polished, value-oriented, solution-focused.',
  colleague:   'Recipient is a peer or teammate. Casual-professional, collaborative tone.',
  vendor:      'Recipient is a vendor / supplier. Business-formal, specific requirements.',
  team:        'Recipient is a team / group. Clear, action-oriented, list-based if helpful.',
  stranger:    'Recipient is someone you do not know. Polite, formal, self-identify in opening.',
  recruiter:    'Recipient is a recruiter or hiring manager. Professional, results-focused.',
  customer:    'Recipient is a customer or end user. Service-minded, helpful, brand-appropriate.',
  professor:   'Recipient is a professor or instructor. Respectful, formal, specific.'
};

const LANGUAGES = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
  it: 'Italian (Italiano)',
  zh: 'Chinese (中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
  ru: 'Russian (Русский)'
};

function buildSystemPrompt(mode, opts) {
  const langName = LANGUAGES[opts.language] || 'English';
  const typeObj = EMAIL_TYPES[opts.email_type] || EMAIL_TYPES.request;
  const tone = TONES[opts.tone] || TONES.professional;
  const length = LENGTHS[opts.length] || LENGTHS.medium;
  const recipient = RECIPIENTS[opts.recipient] || RECIPIENTS.colleague;

  let modeRules = '';
  let outputShape = '';

  if (mode === 'compose') {
    modeRules = `You are writing a NEW email from scratch.
- The sender is the user. Do NOT invent sender name, sender company, or sender email. Leave placeholders like [Your Name] when needed.
- The recipient context is: ${recipient}
- Email type guidance: ${typeObj.hint}
- Key points the user provided must ALL appear in the email. Do not drop any.
- Subject line must be specific, lowercase-by-default unless proper noun, no emoji, no ALL CAPS, no clickbait.`;
    outputShape = `Return ONLY a JSON object with EXACTLY these 4 keys: "subject", "greeting", "body", "signoff".
- "subject": one crisp subject (no "Subject:" prefix).
- "greeting": one short greeting line ending with a comma or colon (e.g. "Hi Sarah," or "Dear Hiring Manager,"). No body content.
- "body": the email body as a single string. Use \\n\\n between paragraphs. No markdown formatting, no bold, no bullet characters. Plain text only.
- "signoff": one closing line, e.g. "Best regards," then newline then "[Your Name]". Include [Your Name] placeholder if a name is not given.`;
  } else if (mode === 'reply') {
    modeRules = `You are drafting a REPLY to the email the user pasted.
- Read the pasted email carefully. Address every concrete question or request in it.
- The user's reply intent must be honored exactly: ${opts.intent || 'professional, on-topic reply'}.
- Recipient context: ${recipient}
- If the original email was informal, match the register; if formal, stay formal.
- The body must contain ONLY your reply. Do NOT quote, paraphrase, echo, or summarize the original email.
- Do NOT start the body with the original sender's greeting or sign-off.
- Do NOT copy "Hi [name]," "Thanks for sending," or any other line from the original into your reply.
- Begin the body with a direct, fresh sentence that advances the user's stated intent.`;
    outputShape = `Return ONLY a JSON object with EXACTLY these 4 keys: "subject", "greeting", "body", "signoff".
- "subject": reply subject line. If you can identify a subject in the original (look for "Subject:" at the top, otherwise infer from the first line), prefix with "Re: ". Otherwise write a fresh concise subject.
- "greeting": one short greeting line ending with a comma or colon. Do NOT copy the original greeting verbatim; either match the register or write a generic greeting.
- "body": the reply body, 1-4 short paragraphs. Use \\n\\n between paragraphs. Plain text only, no markdown, no quoted text from the original.
- "signoff": one closing line, then newline then sender placeholder.`;
  } else if (mode === 'subject') {
    modeRules = `You are a subject line specialist.
Given the email type, tone, key points, and recipient context, generate exactly 3 distinct subject lines.
- Each subject: 4-10 words, specific, concrete, no emoji, no all-caps, no clickbait.
- All three must be appropriate for ${recipient}.
- Avoid repeating the same word as the leading word across the three.`;
    outputShape = `Return ONLY a JSON object with EXACTLY one key: "subjects" whose value is an array of exactly 3 strings, in order from most-direct to most-creative.`;
  } else {
    throw new Error('invalid mode');
  }

  return `${modeRules}

TONE: ${tone}

LENGTH: ${length}

LANGUAGE: Write everything in ${langName}. Do not mix languages.

OUTPUT FORMAT: ${outputShape}

CRITICAL: Return ONLY the JSON. No prose before it, no prose after it, no markdown code fences.`;
}

function buildUserPrompt(mode, opts) {
  if (mode === 'compose') {
    const lines = [
      `Email type: ${(EMAIL_TYPES[opts.email_type] || EMAIL_TYPES.request).label}`,
      `Tone: ${opts.tone}`,
      `Length: ${opts.length}`,
      `Recipient context: ${opts.recipient}`,
      `Recipient name (or blank): ${opts.recipient_name || ''}`,
      `Sender name (or blank, leave [Your Name] if empty): ${opts.sender_name || ''}`,
      `Company / product (or blank): ${opts.company || ''}`,
      `Key points to include (verbatim, do not drop any):`,
      opts.key_points || ''
    ];
    return lines.join('\n');
  }
  if (mode === 'reply') {
    const lines = [
      `Reply intent: ${opts.intent || 'professional, on-topic reply'}`,
      `Tone: ${opts.tone}`,
      `Length: ${opts.length}`,
      `Recipient context: ${opts.recipient}`,
      `Sender name (or blank, leave [Your Name] if empty): ${opts.sender_name || ''}`,
      `Additional context (or blank): ${opts.extra || ''}`,
      `Original email to reply to:`,
      '"""',
      (opts.original_email || '').trim(),
      '"""'
    ];
    return lines.join('\n');
  }
  if (mode === 'subject') {
    const lines = [
      `Email type: ${(EMAIL_TYPES[opts.email_type] || EMAIL_TYPES.request).label}`,
      `Tone: ${opts.tone}`,
      `Recipient context: ${opts.recipient}`,
      `Key points:`,
      opts.key_points || ''
    ];
    return lines.join('\n');
  }
  return '';
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

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAI(env, systemPrompt, userPrompt) {
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
        temperature: 0.7,
        max_tokens: provider.maxTokens
      };
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

function renderEmailText(parsed, senderName) {
  const subj = (parsed.subject || '(no subject)').trim();
  const greet = (parsed.greeting || 'Hi,').trim();
  let body = (parsed.body || '').trim();
  let sign = (parsed.signoff || '').trim();
  if (senderName && sign && !sign.includes(senderName)) {
    sign = sign + '\n' + senderName;
  }
  return [
    'Subject: ' + subj,
    '',
    greet,
    '',
    body,
    '',
    sign
  ].join('\n');
}

function fallbackCompose(opts) {
  const typeObj = EMAIL_TYPES[opts.email_type] || EMAIL_TYPES.request;
  const subject = opts.subject_hint
    ? opts.subject_hint.substring(0, 60)
    : (typeObj.label + (opts.company ? ' - ' + opts.company : ''));
  const greet = opts.recipient_name ? ('Hi ' + opts.recipient_name + ',') : 'Hi,';
  const firstPoint = (opts.key_points || '').split('\n').filter(Boolean)[0] || typeObj.hint;
  const body = [
    firstPoint,
    '',
    'Please let me know if you have any questions or if there is anything else I can help with.',
    '',
    'Thank you for your time.'
  ].join('\n');
  const sign = 'Best regards,\n' + (opts.sender_name || '[Your Name]');
  return {
    subject,
    greeting: greet,
    body,
    signoff: sign,
    _meta: { source: 'fallback' }
  };
}

function fallbackReply(opts) {
  const greet = 'Hi,';
  const firstLine = (opts.intent || 'Thank you for your email.').trim();
  const body = [
    firstLine,
    '',
    (opts.original_email || '').substring(0, 200),
    '',
    'Best regards,'
  ].filter(Boolean).join('\n');
  return {
    subject: 'Re: ' + ((opts.original_email || '').split('\n')[0] || 'Your email').substring(0, 60),
    greeting: greet,
    body,
    signoff: (opts.sender_name || '[Your Name]'),
    _meta: { source: 'fallback' }
  };
}

function fallbackSubjects(opts) {
  const typeObj = EMAIL_TYPES[opts.email_type] || EMAIL_TYPES.request;
  const kw = (opts.key_points || '').split('\n').filter(Boolean)[0] || '';
  const trimmed = kw.substring(0, 40);
  return {
    subjects: [
      typeObj.label + (trimmed ? ': ' + trimmed : ''),
      'Quick ' + typeObj.label.toLowerCase() + (trimmed ? ' regarding ' + trimmed : ''),
      'Following up on ' + (trimmed || 'our conversation')
    ],
    _meta: { source: 'fallback' }
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'ai-email-writer',
      version: '1.0.0',
      status: 'ready',
      modes: ['compose', 'reply', 'subject'],
      email_types: Object.keys(EMAIL_TYPES),
      tones: Object.keys(TONES),
      lengths: Object.keys(LENGTHS),
      recipients: Object.keys(RECIPIENTS),
      languages: Object.keys(LANGUAGES),
      providers: PROVIDERS.map(p => p.name)
    }), { headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const mode = (body.mode || 'compose').toString();
  if (!['compose', 'reply', 'subject'].includes(mode)) {
    return new Response(JSON.stringify({ error: 'invalid mode (must be compose|reply|subject)' }), { status: 422, headers: CORS_HEADERS });
  }

  const opts = {
    mode,
    email_type: (body.email_type || 'request').toString(),
    tone: (body.tone || 'professional').toString(),
    length: (body.length || 'medium').toString(),
    recipient: (body.recipient || 'colleague').toString(),
    language: (body.language || 'en').toString(),
    sender_name: (body.sender_name || '').toString().trim(),
    recipient_name: (body.recipient_name || '').toString().trim(),
    company: (body.company || '').toString().trim(),
    key_points: (body.key_points || '').toString().trim(),
    intent: (body.intent || '').toString().trim(),
    original_email: (body.original_email || '').toString(),
    extra: (body.extra || '').toString().trim(),
    subject_hint: (body.subject_hint || '').toString().trim()
  };

  if (!EMAIL_TYPES[opts.email_type]) {
    return new Response(JSON.stringify({ error: 'invalid email_type' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!TONES[opts.tone]) {
    return new Response(JSON.stringify({ error: 'invalid tone' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!LENGTHS[opts.length]) {
    return new Response(JSON.stringify({ error: 'invalid length' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!RECIPIENTS[opts.recipient]) {
    return new Response(JSON.stringify({ error: 'invalid recipient' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!LANGUAGES[opts.language]) {
    return new Response(JSON.stringify({ error: 'invalid language' }), { status: 422, headers: CORS_HEADERS });
  }

  if (mode === 'compose' && opts.key_points.length < 5) {
    return new Response(JSON.stringify({ error: 'key_points must be at least 5 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (mode === 'reply' && opts.original_email.length < 5) {
    return new Response(JSON.stringify({ error: 'original_email is required for reply mode' }), { status: 422, headers: CORS_HEADERS });
  }
  if (mode === 'subject' && opts.key_points.length < 5) {
    return new Response(JSON.stringify({ error: 'key_points must be at least 5 characters' }), { status: 422, headers: CORS_HEADERS });
  }
  if (opts.key_points.length > 4000 || opts.original_email.length > 20000) {
    return new Response(JSON.stringify({ error: 'input too long' }), { status: 422, headers: CORS_HEADERS });
  }

  let result = null;
  let aiProvider = null;
  let aiError = null;
  try {
    const systemPrompt = buildSystemPrompt(mode, opts);
    const userPrompt = buildUserPrompt(mode, opts);
    const ai = await callAI(env, systemPrompt, userPrompt);
    aiProvider = ai.provider;
    const parsed = extractJson(ai.content);
    if (mode === 'subject') {
      if (parsed && Array.isArray(parsed.subjects) && parsed.subjects.length >= 1) {
        const cleaned = parsed.subjects
          .filter(s => typeof s === 'string' && s.trim())
          .map(s => s.trim())
          .slice(0, 3);
        if (cleaned.length > 0) {
          result = { subjects: cleaned };
        } else {
          aiError = 'AI returned empty subjects array';
        }
      } else {
        aiError = 'AI returned no subjects array';
      }
    } else {
      if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
        result = {
          subject: (parsed.subject || '').toString().trim() || (EMAIL_TYPES[opts.email_type].label),
          greeting: (parsed.greeting || '').toString().trim() || (opts.recipient_name ? ('Hi ' + opts.recipient_name + ',') : 'Hi,'),
          body: parsed.body.toString().trim(),
          signoff: (parsed.signoff || '').toString().trim() || ('Best regards,\n' + (opts.sender_name || '[Your Name]'))
        };
      } else {
        aiError = 'AI returned no body';
      }
    }
  } catch (e) {
    aiError = e.message;
  }

  if (!result) {
    if (mode === 'compose') result = fallbackCompose(opts);
    else if (mode === 'reply') result = fallbackReply(opts);
    else result = fallbackSubjects(opts);
  }

  let rendered = null;
  if (mode !== 'subject') {
    rendered = renderEmailText(result, opts.sender_name);
  }

  return new Response(JSON.stringify({
    mode,
    email_type: opts.email_type,
    tone: opts.tone,
    length: opts.length,
    recipient: opts.recipient,
    language: opts.language,
    parsed: result,
    rendered,
    ai_provider: aiProvider,
    ai_error: aiError,
    meta: {
      subject_chars: (result.subject || (result.subjects && result.subjects[0]) || '').length,
      body_chars: (result.body || '').length
    }
  }), { headers: CORS_HEADERS });
}