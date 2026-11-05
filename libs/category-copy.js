// One hand-written blurb per category, published in two places:
//   functions/tools/[[catchall]].js — the category page's meta/og/twitter description
//                                     and the visible <p> + .md lead under it
//   functions/llms.txt.js           — the "## Categories" line in llms.txt
//
// BUG-359: this data lived as a const in BOTH functions, and the two copies had already
// drifted (`code-testing` read "Built for everyday coding workflows." in one and "Free
// developer tools for everyday coding tasks." in the other). Two published surfaces,
// two owners — the BUG-114 shape, fourth instance.
//
// The first sentence of each blurb is deliberately short. `sentenceTruncate()` cuts a
// blurb at its last sentence boundary inside a character budget, and the budget here is
// `155 - len(" Browse all N free online X.") - 1`, i.e. 111-117 chars depending on the
// category's tool count. A first sentence over the budget has no boundary to land on and
// degrades to a word cut — which is how `/tools/code-testing/` came to publish
// "... and typing. Built for." as its meta description for months (audit 2026-10-15
// named that one page; the class was all 11).

export const CAT_DESCRIPTIONS = {
  'formatters': 'Format, validate and beautify JSON, HTML, SQL, CSS, YAML and XML with exact error positions. Everything runs in your browser, so your code never leaves your device.',
  'calculators': 'Free online calculators for arithmetic, percentages, BMI, age, dates, tips and tiling. No signup, no ads, every result computed locally in your browser.',
  'generators': 'Generate passwords, QR codes, UUIDs, hashes, random numbers and citations in one click. Secure, deterministic and standards-compliant, with nothing sent to a server.',
  // BUG-361: the first sentence is the one that gets published, so its length IS the description's
  // length. These three were below 120 (media 114 / converters 119 / pdf-tools 111) and
  // `core/meta-description` warns under 120 — the audit named `/tools/converters/`, the class was
  // 3. Lengthened to 124 / 133 / 124; every verb below is a tool that actually exists in the
  // category (image-resizer, photo-editor, pdf-redactor, …).
  //
  // TWO ceilings, and the tighter one is llms.txt, not the category page. Each first sentence must
  // satisfy BOTH, or the surface with the smaller budget word-cuts it back into a fragment:
  //   - `155 - len(" Browse all N free online X.") - 1`  → functions/tools/[[catchall]].js
  //   - `100` flat                                     → functions/llms.txt.js sentenceTruncate(d, 100)
  // Lengthening `converters` to 107 passed the first check and failed the second: llms.txt came back
  // "Convert units, currencies, time zones, file formats and text encodings in one click, right"
  // — the exact BUG-359 fragment, one surface over. `100` is the binding constraint. Both bounds
  // are asserted by test-scripts/bug359-category-desc-gate.js, so neither can be broken by editing
  // a blurb again.
  'converters': 'Convert units, currencies, time zones, file formats and text encodings in a single click. Deterministic formulas run locally, with no server roundtrip.',
  'media': 'Compress, convert, crop, resize, transcribe and edit images, video and audio files in seconds. Browser-based processing means no upload and 100% private.',
  'network': 'Diagnose DNS, WHOIS, SSL, IP, email, proxies and internet speed from your browser. Every lookup runs client-side against live public endpoints.',
  'code-testing': 'Test regex patterns, JWT tokens, grammar, text diffs, math and typing speed. Built for everyday coding workflows, with instant feedback.',
  'pdf-tools': 'Merge, split, compress, sign, redact and convert PDF files without ever uploading them. Browser-based processing means your documents never leave your device.',
  'life': 'Everyday utilities for weather, world clock, stopwatch, timer, holidays and astronomy. Real planetary and local-time data, no signup, no ads.',
  'finance': 'Live stock, crypto, gold and currency prices plus loan and mortgage calculators. Real-time market data refreshed while you read the page.',
  'ai-language': 'Translate, paraphrase, detect AI-written text, cite sources and build resumes with AI. Multi-model fallback keeps every tool answering.'
};

// The plural NOUN PHRASE each category's meta description ends on. It was
// `displayName.toLowerCase()`, which is a *label*, not a noun phrase, and the last sentence
// is the one BUG-352's fragment rule judges — so 5 of 11 published
// "Browse all N free online money & markets.", "… daily life.", "… ai language.",
// "… code testing." An ampersand and a bare adjective are exactly the mid-sentence cuts
// sentenceTruncate() exists to prevent, arriving from the other end of the same sentence.
// BUG-352's gate rejects `life.`/`language.`/`markets.` as fragment tails; this is the fix.
// The DISPLAY NAME of each category — the label on the category page, in the category
// breadcrumb on every tool page, and in the tool pages' BreadcrumbList JSON-LD.
// It lived as a local `const` inside functions/tools/[[catchall]].js (and as a second
// inline copy in the hub branch), so anything outside that Function could not name a
// category without copying the list again — the BUG-114 shape. One owner, imported
// where it is needed.
export const CAT_LABELS = {
  'formatters': 'Code Formatters',
  'calculators': 'Calculators',
  'generators': 'Generators',
  'converters': 'Converters',
  'media': 'Media Tools',
  'network': 'Network Tools',
  'code-testing': 'Code Testing',
  'pdf-tools': 'PDF Tools',
  'life': 'Daily Life',
  'finance': 'Money & Markets',
  'ai-language': 'AI Language'
};

export const CAT_NOUNS = {
  'formatters': 'code formatters',
  'calculators': 'calculators',
  'generators': 'generators',
  'converters': 'converters',
  'media': 'media tools',
  'network': 'network tools',
  'code-testing': 'code testing tools',
  'pdf-tools': 'PDF tools',
  'life': 'everyday utilities',
  'finance': 'finance tools',
  'ai-language': 'AI writing tools'
};

// BUG-359: cut at the last SENTENCE boundary inside `max`, not the last word.
// The word cut (`smartTruncate`, which this replaces) published sentence fragments:
// 11 of 11 category pages shipped a meta description whose last sentence was a
// fragment — "... and typing. Built for.", "... YAML, and more - your code never",
// "... currency exchange." — because a fragment is what a word boundary produces.
// Falls back to the word cut only when no sentence ends in time, so a blurb that is
// one over-long sentence degrades the old way instead of losing everything.
export function sentenceTruncate(s, max) {
  if (s.length <= max) return s;
  // lastIndexOf matches whose START index is <= max-1, so the returned prefix is <= max-1+1.
  const sentence = s.lastIndexOf('. ', Math.max(0, max - 1));
  if (sentence > max * 0.5) return s.substring(0, sentence + 1);
  const cut = s.substring(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.substring(0, sp) : cut).replace(/[,;:.]$/, '') + '.';
}
