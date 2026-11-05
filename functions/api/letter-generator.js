import { resolveModelId } from '../../libs/ai-provider.js';
/**
 * AI Letter Generator API
 *
 * Generates letters for 8 common real-world situations: thank-you, cover,
 * apology, invitation, resignation, recommendation, complaint, congratulations.
 *
 * Multi-provider fallback: Groq -> NVIDIA -> Agnes -> deterministic template.
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
    maxTokens: 2200
  },
  {
    name: 'nvidia1',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    base: 'https://integrate.api.nvidia.com/v1',
    envKey: 'DEVTOOLS_NVIDIA_KEY_1',
    maxTokens: 2200
  },
  {
    name: 'agnes1',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_1',
    maxTokens: 2200
  },
  {
    name: 'agnes2',
    url: 'https://apihub.agnes-ai.com/v1/chat/completions',
    base: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.0-flash',
    envKey: 'DEVTOOLS_AGNES_KEY_2',
    maxTokens: 2200
  }
];

const LETTER_TYPES = {
  thankyou: {
    label: 'Thank You',
    hint: 'A genuine thank-you letter after help, support, referral, business, gift, hospitality, or a favor. Specific, not generic. Mention what the person did and why it mattered. Brief is fine.',
    greeting_default: 'Hi {recipient_name},',
    closing_default: 'With gratitude,\n{sender_name}'
  },
  cover: {
    label: 'Cover Letter',
    hint: 'A formal cover letter for a job application. Address the hiring manager, name the role, state why you fit (skills + experience), and close with a clear call to action. 3-4 paragraphs, ATS-friendly plain text.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Sincerely,\n{sender_name}'
  },
  apology: {
    label: 'Apology',
    hint: 'A sincere apology for a mistake, missed deadline, inconvenience, or harm. Acknowledge what happened, take responsibility without excuses, explain the fix, invite further dialogue. No defensiveness.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Sincerely,\n{sender_name}'
  },
  invitation: {
    label: 'Invitation',
    hint: 'An invitation to an event, meeting, party, wedding, or gathering. State what, when, where, why attend, and RSVP details. Match formality to the occasion.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Hope to see you there,\n{sender_name}'
  },
  resignation: {
    label: 'Resignation',
    hint: 'A professional resignation notice. State the decision clearly, give last working day (if known), express gratitude, offer a transition plan. Keep it short, factual, and gracious.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Best regards,\n{sender_name}'
  },
  recommendation: {
    label: 'Recommendation',
    hint: 'A letter of recommendation for a colleague, student, or employee. State how you know them, describe their key strengths with concrete examples, and affirm their fit for the role/program.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Sincerely,\n{sender_name}'
  },
  complaint: {
    label: 'Complaint',
    hint: 'A formal complaint about a product, service, billing, or behavior. State the issue, the impact on you, what evidence you have, and the resolution you seek. Calm, factual, no insults.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Regards,\n{sender_name}'
  },
  congratulations: {
    label: 'Congratulations',
    hint: 'A warm congratulations letter for a promotion, award, graduation, new baby, engagement, or other achievement. Specific praise, not flattery. Match your relationship to the recipient.',
    greeting_default: 'Dear {recipient_name},',
    closing_default: 'Warmly,\n{sender_name}'
  }
};

const TONES = {
  formal: 'Formal. Use full names, no contractions, traditional closings (Sincerely, Respectfully). Suitable for legal, executive, or official contexts.',
  professional: 'Professional. Warm but business-appropriate. Confident, clear, courteous. The default for most business letters.',
  friendly: 'Friendly. Warm and personable. Use contractions freely. Conversational but still appropriate. Suitable for thank-you, congratulations, and internal letters.'
};

const LENGTHS = {
  short:  '80-140 words. 2-3 short paragraphs. Skip extended pleasantries. Lead with the ask or core message.',
  medium: '180-280 words. 3-4 paragraphs. Standard business letter. Greeting, context, main message, sign-off.',
  long:   '320-450 words. Full structured letter. Greeting, context paragraph, main body with specifics, ask or next step, sign-off.'
};

const RECIPIENTS = {
  boss:        'Recipient is your direct boss or manager. Be respectful, action-oriented, brief.',
  client:      'Recipient is an external client. Be polished, value-oriented, solution-focused.',
  colleague:   'Recipient is a peer or teammate. Casual-professional, collaborative tone.',
  vendor:      'Recipient is a vendor or supplier. Business-formal, specific requirements.',
  team:        'Recipient is a team or group. Clear, action-oriented, list-based if helpful.',
  stranger:    'Recipient is someone you do not know. Polite, formal, self-identify in opening.',
  recruiter:    'Recipient is a recruiter or hiring manager. Professional, results-focused.',
  customer:    'Recipient is a customer or end user. Service-minded, helpful, brand-appropriate.',
  professor:   'Recipient is a professor or instructor. Respectful, formal, specific.',
  friend:      'Recipient is a friend or close contact. Warm, personal, less rigid structure.',
  family:      'Recipient is a family member. Personal, warm, conversational.'
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

function fillTemplate(tpl, sender, recipient) {
  return tpl
    .replace('{sender_name}', sender || '[Your Name]')
    .replace('{recipient_name}', recipient || 'Hiring Manager');
}

function buildSystemPrompt(opts) {
  const langName = LANGUAGES[opts.language] || 'English';
  const typeObj = LETTER_TYPES[opts.letter_type] || LETTER_TYPES.thankyou;
  const tone = TONES[opts.tone] || TONES.professional;
  const length = LENGTHS[opts.length] || LENGTHS.medium;
  const recipient = RECIPIENTS[opts.recipient] || RECIPIENTS.colleague;
  const recipientName = opts.recipient_name || '[Recipient Name]';
  const senderName = opts.sender_name || '[Your Name]';

  return `You are an expert letter writer with deep knowledge of professional correspondence conventions across industries.

LETTER TYPE: ${typeObj.label}
GUIDANCE: ${typeObj.hint}

RECIPIENT CONTEXT: ${recipient}

TONE: ${tone}

LENGTH: ${length}

LANGUAGE: Write everything in ${langName}. Do not mix languages.

NAMES:
- Sender (the user): ${senderName}. Use this in the sign-off, do NOT use a placeholder if a real name was given.
- Recipient: ${recipientName}. If the recipient name is a placeholder, keep it abstract (Dear Hiring Manager, Dear Sir or Madam, etc.) — do NOT keep "[Recipient Name]" verbatim.

STRUCTURE RULES — apply the conventions of an actual letter:
1. Greeting line (e.g., "Dear Ms. Chen," or "Hi Sam,"). End with a comma. No body text in the greeting line.
2. Body paragraphs: 2-4 short paragraphs separated by \\n\\n. No bullet characters, no markdown, no bold. Plain text only.
3. Sign-off line (e.g., "Sincerely," or "Best regards,"). End with a comma.
4. Sender name on its own line after the sign-off.

CONTENT RULES:
- Personalize. Reference the specific situation in the user's "situation" field verbatim or close to it. Do not invent facts, but you may reasonably expand on the situation with appropriate professional phrasing.
- If the situation involves a job, role, or program the recipient is offering, mention it by name.
- Match the tone exactly. Formal = no contractions. Friendly = contractions welcome.
- Do NOT start the body with "I am writing to" or other generic openers unless the tone is formal.
- Do NOT end the body with "Thank you for your time" unless the letter type warrants it.

OUTPUT FORMAT — return ONLY a JSON object with EXACTLY these 4 keys:
{
  "greeting": "one short greeting line ending with a comma",
  "body": "the body as a single string with \\n\\n between paragraphs",
  "signoff": "the closing phrase ending with a comma, then \\n then the sender name",
  "subject": "an optional short subject line if relevant (cover letter, recommendation, complaint, resignation, invitation) or empty string for personal letters (thank-you, congratulations, apology)"
}

CRITICAL: Return ONLY the JSON. No prose before it, no prose after it, no markdown code fences.`;
}

function buildUserPrompt(opts) {
  const lines = [
    `Letter type: ${(LETTER_TYPES[opts.letter_type] || LETTER_TYPES.thankyou).label}`,
    `Tone: ${opts.tone}`,
    `Length: ${opts.length}`,
    `Recipient context: ${opts.recipient}`,
    `Recipient name: ${opts.recipient_name || '(blank — use a generic but appropriate greeting like "Dear Hiring Manager" or "Dear Sir or Madam")'}`,
    `Sender name: ${opts.sender_name || '(blank — end sign-off with "[Your Name]" placeholder)'}`,
    `Company or organization (or blank): ${opts.company || ''}`,
    `Specific role / program / event (or blank): ${opts.role_or_event || ''}`,
    `Situation / key points to include (verbatim — do NOT drop any of these):`,
    opts.situation || ''
  ];
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

function fallbackLetter(opts) {
  const typeObj = LETTER_TYPES[opts.letter_type] || LETTER_TYPES.thankyou;
  const recipientName = opts.recipient_name || 'Hiring Manager';
  const senderName = opts.sender_name || '[Your Name]';
  const greeting = fillTemplate(typeObj.greeting_default, senderName, recipientName);
  const closing = fillTemplate(typeObj.closing_default, senderName, recipientName);

  const firstSentence = (opts.situation || '').split(/[.\n!?]/)[0].trim() || typeObj.hint;
  const secondSentence = (opts.role_or_event ? `Regarding ${opts.role_or_event}` : 'I appreciate your time and consideration.');

  let body = '';
  if (opts.letter_type === 'thankyou') {
    body = [
      firstSentence ? firstSentence + '.' : 'Thank you for your time and support.',
      'Your help made a real difference, and I am grateful for the care you put into it.',
      secondSentence
    ].join('\n\n');
  } else if (opts.letter_type === 'cover') {
    body = [
      'I am writing to apply for ' + (opts.role_or_event || 'the position') + (opts.company ? ' at ' + opts.company : '') + '.',
      firstSentence || 'My background aligns with the requirements of this role.',
      'I would welcome the chance to discuss how my experience can contribute to your team.',
      'Thank you for considering my application.'
    ].join('\n\n');
  } else if (opts.letter_type === 'apology') {
    body = [
      'I want to address ' + (firstSentence ? firstSentence.toLowerCase() : 'a recent issue') + '.',
      'I take full responsibility for what happened, and I understand the impact it caused.',
      'Here is what I am doing to fix it and to prevent it from happening again.',
      'I value our relationship and would like to make this right.'
    ].join('\n\n');
  } else if (opts.letter_type === 'invitation') {
    body = [
      'You are warmly invited to ' + (opts.role_or_event || 'our upcoming event') + (opts.company ? ' hosted by ' + opts.company : '') + '.',
      'It would mean a lot to have you there.',
      'Please let me know if you can make it, and I will share the full details.'
    ].join('\n\n');
  } else if (opts.letter_type === 'resignation') {
    body = [
      'I am writing to formally announce my resignation from my position' + (opts.company ? ' at ' + opts.company : '') + '.',
      firstSentence || 'This was a difficult decision, and I am grateful for the opportunities I have had here.',
      'I am committed to ensuring a smooth transition and will do everything I can to hand off my responsibilities in good order.',
      'Thank you for the support and guidance during my time here.'
    ].join('\n\n');
  } else if (opts.letter_type === 'recommendation') {
    body = [
      'I am pleased to recommend ' + (opts.role_or_event || 'this candidate') + ' based on my direct experience working with them.',
      firstSentence || 'They consistently demonstrated strong skills and a collaborative attitude.',
      'I am confident they will bring the same level of dedication and capability to the next opportunity.',
      'Please feel free to contact me if you would like additional context.'
    ].join('\n\n');
  } else if (opts.letter_type === 'complaint') {
    body = [
      'I am writing to formally raise an issue regarding ' + (firstSentence || 'a recent experience') + '.',
      'This has caused real inconvenience, and I would like to see it resolved.',
      'I have attached or documented the relevant details and would appreciate a timely response outlining how you intend to address this.',
      'I look forward to your reply.'
    ].join('\n\n');
  } else if (opts.letter_type === 'congratulations') {
    body = [
      'Congratulations on ' + (opts.role_or_event || 'your recent achievement') + '!',
      firstSentence || 'This is a well-deserved recognition of your hard work.',
      'I am thrilled to see you reach this milestone and excited for what comes next.'
    ].join('\n\n');
  } else {
    body = [
      firstSentence || typeObj.hint,
      'Please let me know if you have any questions.',
      'Thank you for your time.'
    ].join('\n\n');
  }

  const needsSubject = ['cover', 'recommendation', 'complaint', 'resignation', 'invitation'].includes(opts.letter_type);
  return {
    greeting,
    body,
    signoff: closing,
    subject: needsSubject ? (typeObj.label + (opts.role_or_event ? ': ' + opts.role_or_event : '')) : '',
    _meta: { source: 'fallback' }
  };
}

function renderLetter(parsed, opts) {
  const greeting = (parsed.greeting || 'Dear Sir or Madam,').trim();
  const body = (parsed.body || '').trim();
  const signoff = (parsed.signoff || '').trim();
  const subject = (parsed.subject || '').trim();

  const parts = [];
  if (subject) parts.push('Subject: ' + subject);
  parts.push('');
  parts.push(greeting);
  parts.push('');
  parts.push(body);
  parts.push('');
  parts.push(signoff);
  return parts.join('\n');
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      tool: 'letter-generator',
      version: '1.0.0',
      status: 'ready',
      letter_types: Object.keys(LETTER_TYPES),
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

  const opts = {
    letter_type: (body.letter_type || 'thankyou').toString(),
    tone: (body.tone || 'professional').toString(),
    length: (body.length || 'medium').toString(),
    recipient: (body.recipient || 'colleague').toString(),
    language: (body.language || 'en').toString(),
    sender_name: (body.sender_name || '').toString().trim(),
    recipient_name: (body.recipient_name || '').toString().trim(),
    company: (body.company || '').toString().trim(),
    role_or_event: (body.role_or_event || '').toString().trim(),
    situation: (body.situation || '').toString().trim()
  };

  if (!LETTER_TYPES[opts.letter_type]) {
    return new Response(JSON.stringify({ error: 'invalid letter_type' }), { status: 422, headers: CORS_HEADERS });
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

  if (opts.situation.length < 5) {
    return new Response(JSON.stringify({ error: 'situation is required (at least 5 characters)' }), { status: 422, headers: CORS_HEADERS });
  }
  if (opts.situation.length > 4000) {
    return new Response(JSON.stringify({ error: 'situation is too long (max 4000 chars)' }), { status: 422, headers: CORS_HEADERS });
  }

  let result = null;
  let aiProvider = null;
  let aiError = null;
  try {
    const systemPrompt = buildSystemPrompt(opts);
    const userPrompt = buildUserPrompt(opts);
    const ai = await callAI(env, systemPrompt, userPrompt);
    aiProvider = ai.provider;
    const parsed = extractJson(ai.content);
    if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
      result = {
        greeting: (parsed.greeting || '').toString().trim() || fillTemplate((LETTER_TYPES[opts.letter_type].greeting_default), opts.sender_name, opts.recipient_name || 'Hiring Manager'),
        body: parsed.body.toString().trim(),
        signoff: (parsed.signoff || '').toString().trim() || fillTemplate((LETTER_TYPES[opts.letter_type].closing_default), opts.sender_name, opts.recipient_name || 'Hiring Manager'),
        subject: (parsed.subject || '').toString().trim()
      };
    } else {
      aiError = 'AI returned no body';
    }
  } catch (e) {
    aiError = e.message;
  }

  if (!result) {
    result = fallbackLetter(opts);
  }

  const rendered = renderLetter(result, opts);

  return new Response(JSON.stringify({
    letter_type: opts.letter_type,
    tone: opts.tone,
    length: opts.length,
    recipient: opts.recipient,
    language: opts.language,
    parsed: result,
    rendered,
    ai_provider: aiProvider,
    ai_error: aiError,
    meta: {
      body_chars: (result.body || '').length,
      rendered_chars: rendered.length
    }
  }), { headers: CORS_HEADERS });
}
