#!/usr/bin/env node
// BUG-410 gate — every tool page must ship a viewport meta.
//
// The defect: /tools/minecraft-circle-generator/ (added 2026-11-01) was the ONLY page of 367
// with no <meta name="viewport">. A mobile browser then lays the document out at ~980 CSS px
// and scales it down, so the whole tool — a canvas block grid with zoom, crosshair and export
// controls — becomes an unreadable zoomed-out page. It is the site's most mobile-hostile
// possible miss, and it survived a 28-assertion production suite because the SUITE set a
// 375px browser viewport, which the page ignores when it declares no viewport of its own
// (BUG-368's lesson: a context viewport is not a page viewport).
//
// Instrument: static source scan of every tools/<slug>/index.html. The viewport tag is a
// property of the authored head — the Function does not inject one for tool pages — so the
// source IS the shipped artifact. A source scan cannot see it inside a JS string, but no tool
// page builds its own <head>.
//
// ANTI-VACUITY: a tmp copy of the tree with the tag removed from one page MUST fail.
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
if (!fs.existsSync(TOOLS)) { console.error('no tools dir at ' + TOOLS); process.exit(2); }

const VIEWPORT = /<meta\s+name=["']viewport["']\s+content=["'][^"']*["']\s*\/?>/i;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const pages = fs.readdirSync(TOOLS).filter(d => fs.existsSync(path.join(TOOLS, d, 'index.html')));
console.log('BUG-410 viewport gate — root: ' + ROOT + ' (' + pages.length + ' tool pages)');

const missing = [], dupes = [];
for (const slug of pages) {
  const src = fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8');
  const head = src.slice(0, src.search(/<\/head>/i) === -1 ? src.length : src.search(/<\/head>/i));
  const n = (head.match(/<meta\s+name=["']viewport["']/gi) || []).length;
  if (n === 0) missing.push(slug);
  else if (n > 1) dupes.push(slug + ' x' + n);
}
ok(missing.length === 0, '[A] every tool page declares a viewport meta (missing: ' + (missing.join(', ') || 'none') + ')');
ok(dupes.length === 0, '[B] no tool page declares it twice (dupes: ' + (dupes.join(', ') || 'none') + ')');

// The declared value must actually be the responsive one — a bare `name="viewport"` with no
// width=device-width is decoration, not a viewport.
const wrong = [];
for (const slug of pages) {
  const src = fs.readFileSync(path.join(TOOLS, slug, 'index.html'), 'utf8');
  const m = src.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/i);
  if (m && !/width\s*=\s*device-width/i.test(m[1])) wrong.push(slug + ' -> ' + m[1]);
}
ok(wrong.length === 0, '[C] every declared viewport is width=device-width (wrong: ' + (wrong.slice(0, 3).join(' ;; ') || 'none') + ')');

// [D] anti-vacuity — remove the tag from one page in a tmp copy; the gate must go red.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bug410-'));
try {
  fs.cpSync(TOOLS, path.join(tmp, 'tools'), { recursive: true });
  const victim = path.join(tmp, 'tools', pages[0], 'index.html');
  const src = fs.readFileSync(victim, 'utf8');
  fs.writeFileSync(victim, src.replace(/<meta\s+name=["']viewport["'][^>]*>\s*\n?/i, ''));
  const probe = fs.readFileSync(victim, 'utf8');
  ok(!VIEWPORT.test(probe.slice(0, probe.search(/<\/head>/i))), '[D1] the stripped copy really lost its viewport tag (the removal matched exactly once)');
  ok(src.split(/name=["']viewport["']/i).length - 1 === 1, '[D2] the victim page had exactly one viewport tag to strip');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
