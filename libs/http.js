// Shared helpers for the Functions that call a third-party AI/API endpoint.
//
// BUG-544: fetchWithTimeout, extractJson and getLanguageName were copy-pasted
// into 12 / 8 / 3 API handlers. Each copy drifted (one lost the default
// timeout, one lost the `(text || '')` guard, one grew a JSON-repair path that
// only one handler had). One implementation, one behaviour.

// Abort a fetch that hangs. The timer is always cleared, so a slow but
// successful response does not keep the isolate alive.
export async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Pull JSON out of an AI answer: strip a ``` fence, cut to the first {...} pair,
// and repair the curly quotes / stray backslashes models emit.
export function extractJson(text) {
  let cleaned = (text || '').trim();
  if (!cleaned) throw new Error('Empty AI response');
  if (cleaned.startsWith('```')) {
    const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) cleaned = m[1];
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    cleaned = cleaned.substring(first, last + 1);
  }
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

const LANGUAGES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)',
  hi: 'Hindi', ar: 'Arabic', ru: 'Russian'
};

export function getLanguageName(code) {
  return LANGUAGES[code] || 'English';
}
