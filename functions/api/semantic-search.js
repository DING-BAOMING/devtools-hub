/**
 * GET /api/semantic-search?q=<user query>
 *
 * Semantic tool search: given a natural-language query, return the top 3 matching
 * tool slugs from the manifest. Falls back gracefully when the LLM is unavailable.
 *
 * Architecture:
 *   1. Alias table (local, instant) — covers common intent synonyms
 *   2. Local rank (local, instant) — every tool scored against the query; the top of
 *      that list is the candidate set the LLM is shown AND the fallback answer
 *   3. LLM intent classification (network) — Groq → Agnes → graceful empty result
 *
 * LLM failure is NON-FATAL: the ranked list is always returned even if both
 * Groq and Agnes fail. The 'source' field tells the caller what succeeded.
 *
 * Cloudflare Pages Function — free tier.
 */

import { discoverChatModels } from '../../libs/ai-provider.js';

// ---- Module-level cache (survives across warm invocations) ----
var _toolList = null;   // [{slug, name, desc, tags, hay}, ...]
var _toolListTs = 0;
const TOOL_LIST_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

// ---- Alias table (extend as needed — add new entries here, not in prompts) ----
// Key: lower-case phrase. Value: preferred slug(s) or null (no-match marker).
// Keys are matched with .includes() — no stemming needed.
const ALIASES = {
  // Presentation / slides
  'ppt':              ['ai-ppt-maker'],
  'powerpoint':       ['ai-ppt-maker'],
  'slideshow':        ['ai-ppt-maker'],
  'presentation':     ['ai-ppt-maker'],
  '幻灯片':           ['ai-ppt-maker'],
  '创建幻灯片':       ['ai-ppt-maker'],

  // Lyrics / music
  '歌词':             ['song-lyrics-finder'],
  'lyrics':           ['song-lyrics-finder'],
  'find lyrics':      ['song-lyrics-finder'],
  'song words':       ['song-lyrics-finder'],

  // Image manipulation
  '压缩图片':         ['image-compressor'],
  'shrink photo':     ['image-compressor'],
  'shrink image':     ['image-compressor'],
  'make image smaller': ['image-compressor'],
  'reduce photo size': ['image-compressor'],
  'optimize image':   ['image-compressor'],

  'remove background':  ['background-remover'],
  'remove bg':        ['background-remover'],
  'cutout':           ['background-remover'],
  '透明背景':         ['background-remover'],
  '抠图':             ['background-remover'],

  'upscale':          ['image-upscaler'],
  'enlarge photo':    ['image-upscaler'],
  'enhance photo':   ['image-upscaler'],
  '放大图片':         ['image-upscaler'],

  // PDF tools
  'pdf 转 word':      ['pdf-to-word'],
  'pdf to doc':       ['pdf-to-word'],
  'pdf转word':        ['pdf-to-word'],

  'word 转 pdf':      ['word-to-pdf'],
  'doc to pdf':       ['word-to-pdf'],

  'merge pdf':        ['pdf-merger'],
  'combine pdf':      ['pdf-merger'],
  '合并pdf':          ['pdf-merger'],

  'split pdf':        ['pdf-splitter'],
  'separate pdf':     ['pdf-splitter'],

  // Calculator / math
  'bmi':              ['bmi-calculator'],
  'body mass':        ['bmi-calculator'],
  '体重指数':         ['bmi-calculator'],

  // AI text
  'paraphrase':       ['paraphrasing-tool'],
  '改写':             ['paraphrasing-tool'],
  'rewrite sentence': ['sentence-rewriter'],
  '句子改写':         ['sentence-rewriter'],

  'summarize':        ['text-summarizer'],
  '总结':             ['text-summarizer'],
  '摘要':             ['text-summarizer'],

  'translate language': ['translator'],
  '翻译语言':         ['translator'],
  '中英翻译':         ['translator'],
  '翻译器':           ['translator'],

  'grammar check':    ['grammar-checker'],
  '语法检查':         ['grammar-checker'],

  'detect ai':        ['ai-detector'],
  'ai 检测':          ['ai-detector'],
  'ai detector':      ['ai-detector'],

  // Code
  'format json':      ['json-formatter'],
  'json 格式化':      ['json-formatter'],
  'beautify json':    ['json-formatter'],

  'minify js':        ['code-minifier'],
  'compress js':      ['code-minifier'],

  'validate json':    ['json-schema-validator'],
  'json schema':      ['json-schema-validator'],

  // QR / barcode
  '生成二维码':        ['qr-code-generator'],
  'create qr':        ['qr-code-generator'],
  'make qr':          ['qr-code-generator'],

  // Password / security
  '密码生成':         ['password-generator'],
  'generate password': ['password-generator'],
  'strong password':  ['password-generator'],

  // Email
  'email signature':   ['email-signature-generator'],
  '邮件签名':         ['email-signature-generator'],

  // Generic verbs that should NOT match everything
  // These are handled by keyword match (haystack search)
};

// BUG-390: the alias table was matched against the RAW query, so a natural phrasing with an
// article never reached the curated phrase — "make an image smaller" does not contain
// "make image smaller". Every such query fell through to the LLM, whose guess was worse than
// the owner's own answer (measured: audio-cutter / base64-to-image / color-palette-extractor).
//
// Both sides are normalised the SAME way, so the table stays readable and a natural phrasing
// lands on it: standalone articles and possessives are dropped, punctuation becomes a space,
// whitespace is collapsed. Only articles/possessives are dropped — prepositions and verbs are
// part of the intent ("pdf to word" must stay "pdf to word").
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its', 'this', 'that', 'some', 'any'
]);
function normalizePhrase(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .filter(w => !FILLER_WORDS.has(w))
    .join(' ');
}

// The alias phrases, normalised once at load. Same normaliser as the query — that symmetry is
// the whole point.
const ALIAS_PHRASES = Object.entries(ALIASES).map(([phrase, slugs]) => [normalizePhrase(phrase), slugs]);

// ---- Fetch + cache tool list from manifest ----
async function getToolList(env, baseUrl) {
  const now = Date.now();
  if (_toolList && (now - _toolListTs) < TOOL_LIST_TTL_MS) {
    return _toolList;
  }
  // Re-fetch manifest from ASSETS (Cloudflare Pages handles caching: 5 min edge)
  let text;
  try {
    if (env.ASSETS) {
      const r = await env.ASSETS.fetch(new URL('/manifest.txt', baseUrl));
      text = await r.text();
    } else {
      // Fallback: fetch from public URL
      const r = await fetch('https://tools.scoreroute.com/manifest.txt');
      text = await r.text();
    }
  } catch (e) {
    // If fetch fails, fall back to last cached list
    if (_toolList) return _toolList;
    throw e;
  }
  _toolList = parseManifest(text);
  _toolListTs = now;
  return _toolList;
}

// Manifest text -> the tool list the ranker scores. Split out of getToolList so a
// test can assert the ranking without a network call.
export function parseManifest(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const parts = l.split('|');
    if (parts.length < 7) continue;
    const slug = parts[0].trim();
    const name = parts[4].trim();
    const desc = parts[5].trim();
    const tags = (parts[6] || '').split(',').map(t => t.trim()).filter(Boolean);
    const hay = (slug + ' ' + name + ' ' + desc + ' ' + tags.join(' ')).toLowerCase();
    // Pre-tokenised once per cache refresh: the ranker below runs on every request and
    // re-splitting 371 descriptions each time is the only thing it would have done.
    out.push({
      slug, name, desc, tags, hay,
      nt: tokenize(name),
      st: tokenize(slug),
      tt: tags.reduce((acc, tag) => acc.concat(tokenize(tag)), []),
      dt: tokenize(desc)
    });
  }
  return out;
}

// ---- Deterministic ranking -------------------------------------------------------
// BUG-390 follow-up. The LLM used to be handed `tools.slice(0, 20)` — the FIRST 20
// rows of the manifest — so for 351 of the 371 tools it could not see the right
// answer even in principle. The model it was talking to is a 7B one that answers in
// prose, so it filled the gap with whatever it saw, and parseLlslugs mined that prose
// for slugs. Measured on production before the fix:
//   "make a logo"                  -> audio-to-text, text-to-speech, logo-maker
//   "calculate area of a circle"   -> audio-to-text, blood-type-calculator, ...
//   "write a resume"               -> audio-to-text, blood-type-calculator, ...
//
// The fix is not a better model, it is a better candidate set. Every tool is scored
// against the query locally, the LLM is handed that shortlist, and only slugs that
// are ON the shortlist are accepted back. The score doubles as the fallback tier, so
// the endpoint still answers correctly when both providers are down.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its', 'this', 'that', 'some', 'any',
  'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'is', 'it', 'as', 'by', 'at',
  'from', 'into', 'me', 'i', 'we', 'do', 'be', 'how', 'what', 'need', 'want', 'can'
]);

// Generic verbs carry the intent but not the identity: every converter description
// contains "convert", so a verb match must not outrank a noun match.
const WEAK_TERMS = new Set([
  'make', 'create', 'generate', 'convert', 'check', 'find', 'get', 'calculate', 'compute',
  'write', 'edit', 'change', 'build', 'add', 'remove', 'download', 'upload', 'test',
  'use', 'using', 'show', 'view', 'play', 'extract', 'analyze', 'analyse', 'turn',
  'help', 'need', 'want', 'best', 'free', 'online', 'tool', 'tool', 'thing'
]);

function tokenize(s) {
  return String(s == null ? '' : s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

// "compress" must reach "compressor", "area" must not reach "ratio".
function stem(t) {
  for (const suf of ['ing', 'ers', 'er', 's']) {
    if (t.length > 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

// "whats" is "what", "converting" is "convert". Matching the stopword and weak-word
// lists on the stem is what keeps "whats the weather" from ranking on "whats".
function isStop(t) { return STOPWORDS.has(t) || STOPWORDS.has(stem(t)); }
function isWeak(t) { return WEAK_TERMS.has(t) || WEAK_TERMS.has(stem(t)); }

function termHits(term, tokens) {
  for (const tok of tokens) {
    if (tok === term) return true;
    const st = stem(term);
    if (st === stem(tok)) return true;
    if (st.length >= 3 && tok.length >= 3 && (tok.startsWith(st) || st.startsWith(tok))) return true;
    // "conversion" and "converter" share no prefix-and-suffix relation, but they are
    // the same word. Six shared leading characters is the point where the match is
    // the meaning and not the accident.
    if (st.length >= 6 && stem(tok).length >= 6) {
      const tk = stem(tok);
      let n = 0;
      while (n < st.length && n < tk.length && st[n] === tk[n]) n++;
      if (n >= 6) return true;
    }
  }
  return false;
}

// One tool's score against one query. Field order encodes specificity: a name hit is
// the tool saying what it is, a desc hit is a word in a paragraph.
function scoreTool(tool, terms, weak) {
  let score = 0;
  let contentHits = 0;
  let contentTotal = 0;
  for (const term of terms) {
    const isWeakTerm = weak.has(term);
    if (!isWeakTerm) contentTotal++;
    let best = 0;
    if (termHits(term, tool.nt)) best = Math.max(best, 12);
    if (termHits(term, tool.st)) best = Math.max(best, 10);
    if (termHits(term, tool.tt)) best = Math.max(best, 8);
    if (termHits(term, tool.dt)) best = Math.max(best, 5);
    if (!best) continue;
    if (isWeakTerm) {
      // A verb only ever earns desc-level credit — otherwise "convert" would float
      // every tool whose name happens to contain "converter".
      best = Math.min(best, 5);
    } else {
      contentHits++;
    }
    score += best;
  }
  if (contentTotal > 0 && contentHits === contentTotal) score += 25;
  const content = terms.filter(t => !weak.has(t));
  const phrase = content.join(' ');
  if (phrase && tool.nt.indexOf(phrase) !== -1) score += 60;
  // The direction of a conversion is in the order of the words: "pdf to jpg" wants
  // pdf-to-image, not image-to-pdf. A slug that STARTS with the query's first content
  // term is the one whose direction matches.
  const first = content[0] || terms[0];
  if (first && tool.st.length && termHits(first, [tool.st[0]])) score += 12;
  // And the same order inside the tool's own NAME: "Image Format Converter - Free
  // Online JPG PNG WebP" is a jpg-to-png tool, "HTML to Image Converter - Free HTML to
  // PNG, JPG" is a png-to-jpg one.
  if (content.length >= 2 && orderedIn(tool.nt, content)) score += 15;
  return score;
}

// Do the terms appear in this token list, in this order?
function orderedIn(tokens, terms) {
  let i = 0;
  for (const tok of tokens) {
    if (i < terms.length && termHits(terms[i], [tok])) i++;
  }
  return i === terms.length;
}

// Rank every tool against the query. Returns [{slug, score}] best first.
// Exported so test-scripts/ can assert the ranking without going through the network.
export function rankTools(tools, query) {
  const all = tokenize(query);
  const terms = all.filter(t => !isStop(t));
  const weak = new Set(terms.filter(t => isWeak(t)));
  const use = terms.length ? terms : all;
  const scored = [];
  for (const t of tools) {
    const score = scoreTool(t, use, weak);
    if (score > 0) scored.push({ slug: t.slug, score });
  }
  scored.sort((a, b) => (b.score - a.score) || a.slug.localeCompare(b.slug));
  return scored;
}

// How many tools the LLM is shown. Small enough that a 7B model picks sensibly,
// large enough that the right answer is always in it.
const CANDIDATE_LIMIT = 24;

// ---- LLM call with timeout ----
async function llmCall(url, key, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100));
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- Parse LLM response, validate slugs ----
// The LLM answers in prose, so the slugs have to be read out of the sentence. The
// candidate set is the shortlist the prompt offered: a slug that is not on it is
// rejected, which is what stops a rambling answer from injecting an unrelated tool.
//
// Longer slugs are tried first so that "area-calculator" is read as one slug and not
// as "area" plus "calculator".
function parseLlslugs(text, validSlugs) {
  const slugs = [...validSlugs].sort((a, b) => b.length - a.length);
  if (!slugs.length) return [];
  const re = new RegExp('\\b(' + slugs.join('|') + ')\\b', 'g');
  const found = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1];
    if (!seen.has(slug)) {
      seen.add(slug);
      found.push(slug);
    }
    if (found.length >= 3) break;
  }
  return found.slice(0, 3);
}

// ---- Provider chain: the model id is resolved live, never pinned -------------------
// BUG-327 / BUG-328. Groq decommissioned `llama-3.3-70b-versatile` and every endpoint
// that wrote a model id down went dark while still answering HTTP 200. This endpoint
// had the same defect — `model: 'allam-2-7b'` and `model: 'agnes-2.0-flash'` were
// written down — and it would have failed SILENTLY: the keyword fallback always
// answers 200, so a retired id shows up only as worse search results, never as an
// error. The gate that says so is test-scripts/bug328-no-pinned-model-id-gate.js.
//
// The id now comes from the provider's own /models list (libs/ai-provider.js, cached
// per isolate). `model` is a preference while the provider still serves it, and the
// last resort for a provider that offers no catalogue — the same shape
// translator.js and ai-detector.js use.
const PROVIDERS = [
  { name: 'groq', base: 'https://api.groq.com/openai/v1', keyEnv: 'DEVTOOLS_GROQ_API_KEY', model: 'allam-2-7b' },
  { name: 'agnes', base: 'https://apihub.agnes-ai.com/v1', keyEnv: 'DEVTOOLS_AGNES_KEY_1', model: 'agnes-2.0-flash' }
];
const MAX_MODELS_PER_PROVIDER = 3;

// The ids to try, in order: the preferred one first while the provider still serves it,
// then the rest of the live list. A provider with no /models list keeps its declared id.
async function candidateModels(entry, key) {
  const live = await discoverChatModels(entry.base, key);
  if (!live.length) return entry.model ? [entry.model] : [];
  if (live.indexOf(entry.model) === -1) return live;
  return [entry.model].concat(live.filter((m) => m !== entry.model));
}

// ---- Prompts (per provider: Groq gets descriptions, Agnes gets slugs only) --------
// Both prompts are given the SHORTLIST, not the whole manifest and not its head.
// The model is small and answers in prose; a short list of relevant tools is what
// lets it answer at all.
function groqPrompt(query, candidates, slugsOnly) {
  const list = slugsOnly
    ? candidates.map(t => t.slug).join(', ')
    : candidates.map(t => `- ${t.slug}: ${t.name}`).join('\n');
  return `User query: "${query}"
Candidate tools:
${list}
Answer with the 1 or 2 slugs from the candidate list that best match the query, comma separated, nothing else. If none of them fit, answer none.`;
}

function agnesPrompt(query, candidates) {
  const list = candidates.map(t => t.slug).join(', ');
  return `User query: "${query}"
Return 1-3 comma-separated tool slugs that best match this intent from the list.
Available slugs: ${list}
Rules: Slugs only, comma-separated, nothing else. If none match return "none".`;
}

// ---- Try one provider: walk its live models until one answers with usable slugs ----
async function tryProvider(entry, key, prompt, slugs) {
  if (!key) return null;
  const models = await candidateModels(entry, key);
  const tries = Math.min(MAX_MODELS_PER_PROVIDER, models.length);
  for (let n = 0; n < tries; n++) {
    try {
      const d = await llmCall(
        entry.base + '/chat/completions',
        key,
        {
          model: models[n],
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 0.1
        },
        4000 // 4s timeout
      );
      const text = d.choices?.[0]?.message?.content || '';
      const result = parseLlslugs(text, new Set(slugs));
      if (result.length > 0) return result;
    } catch (e) {
      // this model is out of quota or retired — walk to the next one the provider offers
    }
  }
  return null; // no model answered with usable slugs, try the next provider
}

// ---- KV cache disabled (removed to avoid env binding issues; LLM calls are cheap) ----

// ---- Main handler ----
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const lang = url.searchParams.get('lang') || 'en';

  // Always return CORS + JSON
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  };

  if (!query) {
    return new Response(JSON.stringify({ error: 'q parameter required', example: '/api/semantic-search?q=make+image+smaller' }), {
      status: 400, headers
    });
  }

  // 1. Alias lookup (instant)
  // BUG-390: matched against the NORMALISED query, so "make an image smaller" reaches the
  // curated phrase "make image smaller" instead of missing it and being handed to the LLM.
  const qNorm = normalizePhrase(query);
  const aliasSlugs = [];
  for (const [phrase, slugs] of ALIAS_PHRASES) {
    if (phrase && qNorm.includes(phrase)) {
      aliasSlugs.push(...(slugs || []));
    }
  }
  const uniqueAliases = [...new Set(aliasSlugs)].slice(0, 3);

  // 2. Rank every tool against the query (local, instant). This is both the candidate
  // list the LLM is shown and the tier that answers when the LLM cannot.
  const tools = await getToolList(context.env, url);
  const ranked = rankTools(tools, query);
  let candidateSlugs = ranked.slice(0, CANDIDATE_LIMIT).map(r => r.slug);
  let candidates = candidateSlugs.map(slug => tools.find(t => t.slug === slug)).filter(Boolean);

  // A query the local rank cannot narrow — a Chinese one, mostly — would leave the LLM
  // with nothing to choose from, and the endpoint used to answer with SOMETHING for
  // those. So the shortlist falls back to the whole catalogue, slugs only.
  const wholeCatalogue = candidates.length === 0;
  if (wholeCatalogue) {
    candidateSlugs = tools.map(t => t.slug);
    candidates = tools;
  }

  // 3. The alias + keyword list is the never-blocked baseline. BUG-390: it is no longer sliced
  // to 3 here — the final merge owns the order (alias -> LLM -> keyword), and slicing before
  // the merge is what used to drop the alias.

  // 4. Try LLM (only if alias didn't already give good results)
  let llmSlugs = null;
  let llmProvider = null;
  if (uniqueAliases.length < 3 && candidates.length) {
    for (const entry of PROVIDERS) {
      const key = context.env[entry.keyEnv];
      if (!key) continue;
      const prompt = entry.name === 'groq'
        ? groqPrompt(query, candidates, wholeCatalogue)
        : agnesPrompt(query, candidates);
      llmSlugs = await tryProvider(entry, key, prompt, candidateSlugs);
      if (llmSlugs && llmSlugs.length > 0) { llmProvider = entry.name; break; }
    }
  }

  // 5. Merge.
  //
  // BUG-390: the LLM's picks were PREPENDED and `slice(0, 3)` then cut the alias off entirely.
  // The alias table is the owner's hand-written answer for an exact intent phrase, so it is
  // ground truth — but the LLM's fuzzy guess was ranked above it and displaced it. Measured on
  // production before the fix: "shrink photo", "make an image smaller", "merge my pdf files"
  // and "format json" all answered with three tools of which the curated one was absent.
  //
  // The order is now: alias (curated) first, and then the LOCAL RANK decides. The LLM's
  // picks get a bonus instead of the top slot, because the LLM is a 7B model that answers
  // in prose and it does get things wrong: with the LLM's picks simply prepended,
  // "convert video to mp3" answered audio-converter, audio-cutter, video-to-audio — the
  // right tool last. A bonus of one rank-step moves it up without letting a bad guess
  // outrank a good local match.
  const LLM_BONUS = [18, 10, 10];
  const bonus = new Map();
  (llmSlugs || []).forEach((slug, i) => bonus.set(slug, LLM_BONUS[i] != null ? LLM_BONUS[i] : 10));
  const rankedSet = new Set(ranked.map(r => r.slug));
  // A pick the local rank never made is only possible in the whole-catalogue case
  // (a query the local rank could not narrow), where it IS the answer.
  const extra = (llmSlugs || []).filter(slug => !rankedSet.has(slug));
  const ordered = extra.map((slug, i) => ({ slug, score: 1000 - i * 10 }))
    .concat(ranked.map(r => ({ slug: r.slug, score: r.score + (bonus.get(r.slug) || 0) })));
  ordered.sort((a, b) => (b.score - a.score) || a.slug.localeCompare(b.slug));
  const combined = [...new Set([...uniqueAliases, ...ordered.map(o => o.slug)])];
  const matches = combined.slice(0, 3);

  // BUG-390: per-result provenance, so the caller can label each row for what it actually is
  // instead of stamping "AI" on everything. 'alias' = the curated table, 'ai' = the LLM's
  // pick, 'keyword' = the substring matcher. The alias wins when a slug is in both, because
  // the alias is what ranked it first.
  const aliasSet = new Set(uniqueAliases);
  const llmSet = new Set(llmSlugs || []);
  const viaOf = (slug) => (aliasSet.has(slug) ? 'alias' : (llmSet.has(slug) ? 'ai' : 'keyword'));

  const response = {
    query,
    matches,
    source: llmSlugs ? (llmProvider || 'alias+keyword') : (uniqueAliases.length > 0 ? 'alias' : 'keyword'),
    llmProvider,
    // Include names for the caller to display
    tools: matches.map(slug => {
      const t = tools.find(x => x.slug === slug);
      return { slug, name: t ? t.name : slug, via: viaOf(slug) };
    })
  };

  return new Response(JSON.stringify(response, null, 2), { status: 200, headers });
}
