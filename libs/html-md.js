// BUG-351: ONE html→markdown body converter, shared by every .md mirror on the site.
//
// Before this file there were two converters that had drifted apart: htmlToMarkdown() in
// functions/tools/[[catchall]].js (tools + category pages) and pageToMarkdown() in
// libs/page-md.js (top-level pages). Each knew how to emit exactly three things — <p>,
// <ul>/<ol>, and <details> *when the section heading happened to contain the word "FAQ"* —
// and silently dropped everything else. That is `agentimization/markdown-content-parity`
// Error 1/2 ("Markdown versions are missing ~28% of HTML content on average"), measured
// over all 346 tool pages as **26.4% of sentences / 12.5% of characters** missing.
//
// What was actually being dropped, by element (see test-scripts/bug351-md-content-parity-gate.js):
//   <details class="faq-item">   5 of dns-lookup's Q&As — the page files them under a heading
//                               called "Common Use Cases", so the /faq|frequently asked/ test
//                               on the HEADING TEXT missed them. The rule is structural
//                               ("does this section hold a <details>"), not lexical.
//   <div class="faq-answer">     the same defect on days-until-calculator and 100+ other pages
//   <table>/<td>/<caption>       61 pages carry a table; not one cell reached the mirror
//   <div class="premium-notice"> prose in a bare <div> — there was no <p> to match
//   related-tool cards          <a><strong>name</strong><span>desc</span></a> — no block tag
//
// One linear scan in document order, extract-and-consume: each block element is matched
// once and turned into markdown, and whatever text is left between blocks (prose in bare
// <div>s, card text, stray labels) becomes a paragraph. Nothing can be emitted twice,
// because nothing is re-scanned.

const BLANK = /<(script|style|noscript|template|textarea|svg|select)\b[\s\S]*?<\/\1\s*>/gi;

// BUG-382: an HTML comment is never rendered, so it is never content — but the mirror
// published it. Four pages emitted a literal `<!--` (audio-converter, snake-game,
// video-cutter, 2fa-authenticator) and one was destroyed: 2fa-authenticator's comment
// contains `<div>`, `<details>` and `<summary>`, so the structural walk treated those as
// real markup and the whole page after the comment collapsed into ONE run-on paragraph —
// its table, its headings and its whole FAQ, gone. Stripped BEFORE BLANK so a comment's
// own tags can never be mistaken for markup by either regex.
const COMMENTS = /<!--[\s\S]*?-->/g;

// BUG-301: a named map for the entities this repo actually emits + a numeric/hex decoder.
// Applied to markdown output only, so served HTML is untouched.
const HTML_ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', bull: '\u2022',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', euro: '\u20ac',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', minus: '\u2212', ne: '\u2260',
  le: '\u2264', ge: '\u2265', radic: '\u221a', sum: '\u2211', prod: '\u220f', int: '\u222b',
  infin: '\u221e', larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193',
  harr: '\u2194', lArr: '\u21d0', rArr: '\u21d2', hArr: '\u21d4', prime: '\u2032', Prime: '\u2033',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5',
  theta: '\u03b8', lambda: '\u03bb', mu: '\u03bc', pi: '\u03c0', sigma: '\u03c3',
  Sigma: '\u03a3', tau: '\u03c4', phi: '\u03c6', omega: '\u03c9',
  Omega: '\u03a9', Delta: '\u0394', Alpha: '\u0391', Gamma: '\u0393', Lambda: '\u039b', Pi: '\u03a0', Phi: '\u03a6', Theta: '\u0398', Upsilon: '\u03a5'
};

export function decodeEntities(s) {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (full, body) => {
    if (body.charAt(0) === '#') {
      const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code < 1 || code > 0x10ffff) return full;
      try { return String.fromCodePoint(code); } catch (e) { return full; }
    }
    const mapped = HTML_ENTITY_MAP[body];
    return mapped === undefined ? full : mapped;
  });
}

export function stripHtml(s) {
  // A tag becomes a SPACE, not nothing: `</strong><span>` between a card's name and its
  // description would otherwise glue them into "NameDescription" in the mirror.
  //
  // `<` only starts a tag when a letter or `/` follows it. mortgage-calculator writes
  // "down payment < 20%" unencoded, and the looser /<[^>]+>/ swallowed everything up to the
  // next `>` — four sentences of the page, in the mirror only.
  return decodeEntities(s.replace(/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function inlineMd(s) {
  let t = s;
  t = t.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(?:\1)>/gi, '**$2**');
  t = t.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(?:\1)>/gi, '*$2*');
  // stripHtml (not the raw inner html) so the link text has no leftover tag padding:
  // `</strong><span>` must read "**Name** desc", not "**Name**  desc ".
  t = t.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (full, href, inner) => '[' + stripHtml(inner) + '](' + href + ')');
  t = t.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  return stripHtml(t);
}

function headingMd(m) {
  const text = inlineMd(m[2]);
  if (!text) return '';
  // The injected comments widget is not page content (it is injected outside <main> too).
  if (/^comments?\s*(&|and)?\s*ratings?$/i.test(text)) return '';
  // BUG-403: an <h1> inside <main> is the PAGE'S TITLE, and both callers of this converter
  // already emit it as the mirror's document title (functions/tools/[[catchall]].js
  // `htmlToMarkdown`, libs/page-md.js `pageToMarkdown`). On a hero-layout page the <h1>
  // lives inside <main> — which is the region this converter mirrors — so the title was
  // published twice and 27 of the 378 mirrors carried two H1s: a broken outline for an
  // agent and "multiple H1s" for every checker that counts them. The text is not lost:
  // it is the mirror's first line, which is where a title belongs.
  if (Number(m[1]) === 1) return '';
  return '#'.repeat(Number(m[1])) + ' ' + text + '\n\n';
}

// a pipe inside a cell would end the markdown table row
function cellMd(s) {
  return inlineMd(s).replace(/\|/g, '\\|');
}

function tableMd(m) {
  const html = m[0];
  const rows = [];
  let firstIsHeader = false;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let t;
  while ((t = trRe.exec(html)) !== null) {
    const cells = [];
    let isTh = false;
    const tdRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = tdRe.exec(t[1])) !== null) {
      if (c[1].toLowerCase() === 'th') isTh = true;
      cells.push(cellMd(c[2]));
    }
    if (cells.length) {
      if (rows.length === 0) firstIsHeader = isTh;
      rows.push(cells);
    }
  }
  if (!rows.length) {
    // BUG-378: a caption-only table (e.g. zodiac-compatibility's 12x12 matrix, whose cells the
    // page JS builds later) must still emit its caption — the caption is visible content.
    const emptyCap = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const emptyCapText = emptyCap && emptyCap[1] ? inlineMd(emptyCap[1]) : '';
    return emptyCapText ? captionMd({ 6: emptyCap[1] }) : '';
  }
  const width = Math.max.apply(null, rows.map((r) => r.length));
  const pad = (r) => '| ' + r.concat(new Array(Math.max(0, width - r.length)).fill('')).join(' | ') + ' |';
  const cap = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  let out = cap ? '*' + inlineMd(cap[1]) + '*\n\n' : '';
  // BUG-380: a row is the table's COLUMN-NAMES row only if it is made of <th>. A table the
  // page JS fills later ships an empty <thead> and puts its empty-state message in the
  // <tbody> — so rows[0] was that message, and the mirror published it as the column name
  // ("| Run the analyzer to see rows here. |"). A markdown table always has a header row,
  // so a table with no <th> gets an EMPTY one: the empty-state copy stays a data cell
  // (BUG-333's rule: the copy belongs in the <tbody>) and no cell is read as a column name.
  if (firstIsHeader) {
    out += pad(rows[0]) + '\n| ' + new Array(width).fill('---').join(' | ') + ' |\n';
    for (let i = 1; i < rows.length; i++) out += pad(rows[i]) + '\n';
  } else {
    out += pad(new Array(width).fill('')) + '\n| ' + new Array(width).fill('---').join(' | ') + ' |\n';
    for (const r of rows) out += pad(r) + '\n';
  }
  return out + '\n';
}

function detailsMd(m, level) {
  const q = m[0].match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  // Recurse on the ANSWER only: the <details> shell has to come off, or the walker
  // matches the very same element again and the recursion walks itself down to the
  // depth guard, returning nothing.
  const inner = m[0]
    .replace(/^<details\b[^>]*>/i, '')
    .replace(/<\/details>\s*$/i, '')
    .replace(/<summary[\s\S]*?<\/summary>/i, '');
  const body = htmlToMarkdownBody(inner, level + 1);
  const question = q ? inlineMd(q[1]) : '';
  return (question ? '**' + question + '**\n\n' : '') + body;
}

function listMd(m, ordered, level) {
  // Items first, nested lists second — stripping nested lists from m[0] instead would match
  // the OUTER <ul> (same tag, non-greedy, first </ul> wins) and delete the whole list.
  const items = [];
  const nested = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let l;
  while ((l = liRe.exec(m[0])) !== null) {
    const inner = l[1].replace(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi, (n) => { nested.push(n); return ' '; });
    const text = inlineMd(inner);
    if (text) items.push((ordered ? (items.length + 1) + '. ' : '- ') + text);
  }
  if (!items.length) return '';
  let out = items.join('\n') + '\n\n';
  for (const n of nested) out += listMd({ 0: n }, /^<ol\b/i.test(n), level + 1).replace(/^(\s*)([-0-9])/gm, '$1  $2');
  return out;
}

function dlMd(m) {
  const rows = [];
  const pairRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*(?:<dd\b[^>]*>([\s\S]*?)<\/dd>)?/gi;
  let d;
  while ((d = pairRe.exec(m[0])) !== null) {
    const term = inlineMd(d[1]);
    const def = d[2] ? inlineMd(d[2]) : '';
    if (term || def) rows.push('- ' + (term ? '**' + term + '**' : '') + (term && def ? ' — ' : '') + def);
  }
  return rows.length ? rows.join('\n') + '\n\n' : '';
}

function paraMd(m) { const t = inlineMd(m[5]); return t ? t + '\n\n' : ''; }
function preMd(m) {
  const t = stripHtml(m[4]).replace(/^[ \t]+|[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  return t ? '```\n' + t + '\n```\n\n' : '';
}
function quoteMd(m) {
  const t = inlineMd(m[3]);
  return t ? t.split(/\n{2,}/).map((l) => '> ' + l).join('\n\n') + '\n\n' : '';
}
function captionMd(m) { const t = inlineMd(m[6]); return t ? '*' + t + '*\n\n' : ''; }
// <dt>/<dd>/<summary>/<label>/<legend> reached on their own — one line each, so a form's
// field names ("Weight (kg)", "Height (cm)") reach an agent reading the mirror.
function lineMd(m) { const t = inlineMd(m[7] || m[8] || m[9] || m[10] || m[11]); return t ? t + '\n\n' : ''; }
// A top-level <a> is a card (the related-tools grid), never a link inside prose.
function cardMd(m) { const t = inlineMd(m[0]); return t ? '- ' + t + '\n' : ''; }

// Every alternative is tried left to right at each position, so a block nested inside
// another block (a <p> inside a <details>) is reached through the outer handler's
// recursion and can never be emitted twice. The last alternative carries no text: it is a
// break-only tag, so two sibling cards or two sibling <td>s — which have no block tag
// between them — do not merge into one paragraph.
const BLOCK_SRC = [
  // 1 = heading level, 2 = heading text. This is the ONLY alternative allowed a
  // backreference, because it is the only group that precedes it: `\1` in the ul/ol/term
  // alternatives used to point at the HEADING group, so every list silently failed to
  // match and its items fell through as unlabelled paragraphs.
  '<h([1-6])\\b[^>]*>([\\s\\S]*?)<\\/h\\1>',
  '<table\\b[^>]*>[\\s\\S]*?<\\/table>',
  '<details\\b[^>]*>[\\s\\S]*?<\\/details>',
  '<ul\\b[^>]*>[\\s\\S]*?<\\/ul>',
  '<ol\\b[^>]*>[\\s\\S]*?<\\/ol>',
  '<dl\\b[^>]*>[\\s\\S]*?<\\/dl>',
  '<blockquote\\b[^>]*>([\\s\\S]*?)<\\/blockquote>',   // 3
  '<pre\\b[^>]*>([\\s\\S]*?)<\\/pre>',                 // 4
  '<p\\b[^>]*>([\\s\\S]*?)<\\/p>',                     // 5
  '<caption\\b[^>]*>([\\s\\S]*?)<\\/caption>',         // 6
  '<dt\\b[^>]*>([\\s\\S]*?)<\\/dt>',                   // 7
  '<dd\\b[^>]*>([\\s\\S]*?)<\\/dd>',                   // 8
  '<summary\\b[^>]*>([\\s\\S]*?)<\\/summary>',         // 9
  '<label\\b[^>]*>([\\s\\S]*?)<\\/label>',             // 10
  '<legend\\b[^>]*>([\\s\\S]*?)<\\/legend>',           // 11
  '<a\\b[^>]*>[\\s\\S]*?<\\/a>',
  '<(?:div|section|article|header|footer|nav|aside|main|form|fieldset|figure|figcaption|tr|td|th|li|button)\\b[^>]*>'
].join('|');

// Text that is not inside any block element: prose in a bare <div>, a card's name +
// description, an unwrapped field label. 12 chars is the floor because the tool UI's own
// verbs ("Lookup", "Convert", "Clear") are shorter than any sentence, and they are the
// one thing the mirror should not carry.
const LEFTOVER_MIN = 12;

// BUG-358: a tab label is page content, not UI chrome, and the floor above was deleting
// them. The tab strip is the ONLY place a panel's name appears (`size-converter` ships
// `<div class="s-panel" id="panel-shoe">` with an `<h3>Input</h3>` inside and nothing that
// says "shoe"; the identity lives in the sibling tab), so dropping it left the .md mirror
// as N identical unlabelled blocks — 76 of 219 labels across 32 pages measured.
// Measured cost of the naive fix (LEFTOVER_MIN = 0): 71 of the 76 come back, but the
// mirror also starts carrying every button verb, which is what the floor is for.
//
// So the floor is not lowered: a tab trigger's text is promoted to a <p> BEFORE the walk,
// which sends it down the paraMd path where LEFTOVER_MIN does not apply. No floor change,
// no behaviour change for anything that is not a tab label.
//
// The trigger test is a LOOKAHEAD, not a post-filter, and that is load-bearing: a plain
// filter still consumes the element it rejects, and the first `<div>` in the document is
// usually the tab CONTAINER (`.s-tabs`), so "reject and skip" swallowed the whole strip and
// lost the first tab — `size-converter` recovered 4 of 5 labels that way, and the fifth was
// the one inside the consumed range.
const TAB_LOOKAHEAD = '(?=[^>]*(?:\\brole\\s*=\\s*["\']?tab["\'\\s>]' +
  '|\\bclass\\s*=\\s*["\'][^"\']*(?:^|[\\s_-])tab(?!s(?![a-z0-9]))[^"\']*["\']))';
const TAB_TRIGGER = new RegExp(
  '<(button|div|a|li)\\b' + TAB_LOOKAHEAD + '([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>', 'gi');
// A trigger that wraps a panel (a tab container, a panel holder) is not a label — leave it
// alone rather than turn the panel into a paragraph. `button` is here because a container
// named `pe-tab-row` holding four `<button class="pe-tab">` labels otherwise promoted the
// whole row as one label: `ai-prompt-engineer`'s four tabs came out as a single run-on line.
// `span` must NOT be listed: the common trigger is `<button class="tab"><span class="tab-icon">…</span>Label</button>`.
const NOT_A_LABEL = /<(?:div|table|form|section|article|textarea|select|details|p|ul|ol|dl|button|nav|header)\b/i;

// A promoted label carries this attribute so the two halves of BUG-358 can tell a label
// apart from ordinary page prose when the strip sits outside <main>.
const TAB_LABEL_ATTR = ' data-md-tab';

function promoteTabLabels(src) {
  return src.replace(TAB_TRIGGER, (full, tag, attrs, inner) => {
    if (NOT_A_LABEL.test(inner) || !stripHtml(inner)) return full;
    return '<' + tag + attrs + '><p' + TAB_LABEL_ATTR + '>' + inner + '</p></' + tag + '>';
  });
}

// The converter mirrors <main> and nothing else, which is right — a mirror that also carried
// breadcrumbs, the "Report Problem" link and the footer would be a parity bug of its own.
// But 12 of the 79 tab strips sit OUTSIDE <main> (`workout-planner` puts its tabs in a
// `<nav role="tablist">` above it), and there the labels were not floored, they were
// discarded wholesale. Keep the labels and nothing else: `data-md-tab` is the marker that
// makes "only the labels" decidable instead of a guess.
// The markup is moved, not rendered to text — rendering here put the three labels into one
// leftover paragraph, because the text went back through the walk and three adjacent bare
// strings are one paragraph by construction.
function tabLabelsOutside(chunk) {
  let out = '';
  const re = new RegExp('<p' + TAB_LABEL_ATTR + '>[\\s\\S]*?<\\/p>', 'gi');
  let m;
  while ((m = re.exec(chunk)) !== null) out += m[0];
  return out;
}

function leftoverMd(raw) {
  const t = inlineMd(raw);
  return t.length >= LEFTOVER_MIN ? t + '\n\n' : '';
}

function blockMd(m, level) {
  if (m[1] !== undefined) return headingMd(m);                 // h1-h6
  if (/^<table/i.test(m[0])) return tableMd(m);
  if (/^<details/i.test(m[0])) return detailsMd(m, level);
  if (/^<ul/i.test(m[0])) return listMd(m, false, level);
  if (/^<ol/i.test(m[0])) return listMd(m, true, level);
  if (/^<dl/i.test(m[0])) return dlMd(m);
  if (m[3] !== undefined) return quoteMd(m);
  if (m[4] !== undefined) return preMd(m);
  if (m[5] !== undefined) return paraMd(m);
  if (m[6] !== undefined) return captionMd(m);
  if (m[7] !== undefined || m[8] !== undefined || m[9] !== undefined ||
      m[10] !== undefined || m[11] !== undefined) return lineMd(m);
  if (/^<a[ >]/i.test(m[0])) return cardMd(m);
  return '';                                                   // break-only tag
}

export function htmlToMarkdownBody(input, depth) {
  const level = depth || 0;
  // The recursion only descends one level per <details>; past that a pathological nesting
  // is a page bug, not a converter bug.
  if (level > 6) return '';
  let src = promoteTabLabels(String(input).replace(COMMENTS, ' ').replace(BLANK, ' '));
  // Mirror <main> and nothing else — but carry the tab labels that sit outside it (see
  // tabLabelsOutside). `indexOf` rather than a capture group so the two out-of-main
  // slices and the inner slice are all addressable without re-matching.
  const open = src.match(/<main\b[^>]*>/i);
  if (open) {
    const start = open.index + open[0].length;
    const end = src.indexOf('</main>', start);
    const inner = end === -1 ? src.slice(start) : src.slice(start, end);
    src = tabLabelsOutside(src.slice(0, open.index)) + inner +
      (end === -1 ? '' : tabLabelsOutside(src.slice(end)));
  }

  let out = '';
  let pending = '';
  let last = 0;
  let m;
  // A per-call instance, NOT a shared one: htmlToMarkdownBody recurses into <details>,
  // and a module-level /g regex carries lastIndex across the nested scan — the outer loop
  // then restarts at the nested loop's index and spins forever.
  const blockRe = new RegExp(BLOCK_SRC, 'gi');
  while ((m = blockRe.exec(src)) !== null) {
    pending += src.slice(last, m.index);
    last = blockRe.lastIndex;
    out += leftoverMd(pending) + blockMd(m, level);
    pending = '';
  }
  return out + leftoverMd(pending + src.slice(last));
}

export { BLANK as BLANK_SUBTREES, LEFTOVER_MIN };
