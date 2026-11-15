// DeAI pass for tools/prayer-times/index.html.
// Every element carrying data-deai is rewritten in place. If DeAI fails, times out, returns
// nothing usable, or mangles the markup, the ORIGINAL text is kept. The de-AI'd FAQ answers
// are also written back into the FAQPage JSON-LD matched BY NAME (both questions are static,
// same order on page and in the schema).
//
// Run: node test-scripts/deai-prayer-times.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, '..', 'tools', 'prayer-times', 'index.html');
// The key is not in this file: env first, then the untracked credential store.
function readSecret(name) {
  const txt = readFileSync(process.env.DEVTOOLS_SECRET_STORE || '/home/ubuntu/.secrets/devtools-hub.env', 'utf8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0 || line.slice(0, i).trim() !== name) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }
  throw new Error('missing credential ' + name);
}
const KEY = process.env.DEVTOOLS_DEAI_KEY || process.env.DEAI_API_KEY || readSecret('DEAI_API_KEY');
const ENDPOINT = 'https://deai.029101.xyz/humanize';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function humanize(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'balanced', wait: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, why: 'HTTP ' + res.status };
    const j = await res.json();
    if (j.error) return { ok: false, why: j.error };
    if (typeof j.result !== 'string' || j.result.trim().length < 20) return { ok: false, why: 'empty result' };
    return { ok: true, text: j.result.trim(), score: j.original_score + ' -> ' + j.new_score, skipped: !!j.skipped };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function blocks(html) {
  const out = [];
  const re = /<(\w+)([^>]*\bdata-deai\b[^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ start: m.index, end: re.lastIndex, tag: m[1], attrs: m[2], inner: m[3] });
  return out;
}

let html = readFileSync(FILE, 'utf8');
const targets = blocks(html);
console.log('data-deai blocks: ' + targets.length);

const results = [];
for (const b of targets) {
  const plain = b.inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length < 20) { console.log('skip (<20 chars): ' + plain.slice(0, 40)); results.push(null); continue; }
  process.stdout.write('  humanize ' + plain.length + ' chars: ' + plain.slice(0, 44).replace(/\n/g, ' ') + ' ... ');
  const r = await humanize(plain);
  if (r.ok) console.log('OK ' + r.score + (r.skipped ? ' (already human, unchanged)' : ''));
  else console.log('FAILED (' + r.why + ') - keeping original');
  results.push(r.ok ? r.text : null);
  await sleep(1200);
}

let applied = 0;
for (let i = targets.length - 1; i >= 0; i--) {
  const b = targets[i];
  const clean = b.attrs.replace(/\s*data-deai\b/, '');
  if (results[i] === null) {
    html = html.slice(0, b.start) + '<' + b.tag + clean + '>' + b.inner + '</' + b.tag + '>' + html.slice(b.end);
    continue;
  }
  applied++;
  const out = '<' + b.tag + clean + '>' + results[i] + '</' + b.tag + '>';
  html = html.slice(0, b.start) + out + html.slice(b.end);
}
console.log('rewritten: ' + applied + '/' + targets.length);

// Sync FAQPage JSON-LD answers BY NAME (documented order both sides).
const faqTargets = targets.filter((b) => b.inner.includes('<summary>'));
const jsonStart = html.indexOf('"@type":"FAQPage"');
if (jsonStart === -1) { console.log('FAQPage JSON-LD not found, skipping sync'); }
else {
  const tagOpen = html.lastIndexOf('<script type="application/ld+json">', jsonStart);
  const tagClose = html.indexOf('</script>', jsonStart);
  let obj;
  try { obj = JSON.parse(html.slice(tagOpen + '<script type="application/ld+json">'.length, tagClose)); }
  catch (e) { console.log('JSON-LD parse failed after DeAI: ' + e.message); obj = null; }
  if (obj) {
    let changed = 0;
    const graph = obj['@graph'] || [obj];
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    for (const q of faq.mainEntity) {
      const idx = faqTargets.findIndex((b) => b.inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').includes(q.name));
      if (idx === -1) continue;
      const fresh = results[targets.indexOf(faqTargets[idx])];
      if (fresh && fresh !== q.acceptedAnswer.text) {
        q.acceptedAnswer.text = fresh.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); changed++;
      }
    }
    if (changed) html = html.slice(0, tagOpen) + '<script type="application/ld+json">' + JSON.stringify(obj) + '</script>' + html.slice(tagClose);
    console.log('FAQPage JSON-LD answers synced: ' + changed);
  }
}

writeFileSync(FILE, html);
console.log('written ' + FILE);
