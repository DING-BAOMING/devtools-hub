#!/usr/bin/env node
/**
 * BUG-406 gate — a "New" badge must mean NEW, and only the newest tools may carry one.
 *
 * WHY
 * `manifest.txt` field 4 (`isnew`) drives the "New" badge on the homepage, on every
 * category page, on /whats-new/ and in llms.txt. It is set by hand, and nothing ever
 * took it back off. Measured on production 2026-11-03: 113 of 371 tools (30%) carried
 * `isnew=yes`, scattered over the whole file:
 *
 *     pos   1- 50:  13        pos 251-300:   1
 *     pos  51-100:   8        pos 301-350:  30
 *     pos 101-150:  41        pos 351-371:  19
 *
 * The production homepage rendered 32 "New" badges on its 64 cards, including
 * `ai-chat`, `ai-detector` and `essay-writer` — tools that have existed since June.
 * Worse, the badge and the "Popular" badge share one slot:
 *
 *     (t.isnew ? 'New' : (t.featured ? 'Popular' : ''))
 *
 * so 51 of the 57 FEATURED tools showed "New" and the "Popular" badge appeared
 * ZERO times on the homepage. A badge that is on 30% of the site is not a badge.
 *
 * WHAT THE GATE ASSERTS (the honest, one-directional rule)
 *   A tool may carry `isnew=yes` only if it is genuinely recent, where "recent" is
 *   read from EVIDENCE, not from the flag:
 *     1. it has no dated evidence at all (a brand-new page that has never been
 *        edited since it was written) and it sits in the tail of the manifest
 *        (manifest.txt is append-only — the tail IS the add order), or
 *     2. its real last-edit date (tool-dates.json, which scripts/gen-tool-dates.js
 *        derives from the page's own authored `dateModified`, else from git) is
 *        within 30 days of the newest date in the catalogue.
 *
 *   It deliberately does NOT assert the converse. A tool added today with
 *   `isnew=no` is not a defect — the flag is optional and the site's own
 *   MANIFEST-SOURCE-OF-TRUTH.md documents appending `no|no`. This gate exists to
 *   stop STALE badges, not to police the adding workflow.
 *
 * ANTI-VACUITY
 *   Run it against a copy of manifest.txt with one stale `isnew=yes` re-injected:
 *   it must go red and name the offending slug.
 *
 *   node test-scripts/bug406-isnew-window-gate.js [--root <devtools-hub dir>]
 */

const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', HUB));

// How long a "New" badge survives. 30 days is the site's own cadence: /whats-new/
// claims "2-3 new tools every week", so a month is roughly a release cycle.
const WINDOW_DAYS = 30;
// How far back in the manifest an undated tool may sit and still count as new.
const TAIL_ROWS = 45;

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

function readManifest(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const f = t.split('|');
    if (f.length < 7) continue;
    rows.push({ slug: f[0].trim(), featured: f[2].trim(), isnew: f[3].trim(), name: f[4].trim() });
  }
  return rows;
}

function readDates(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

function newestDate(dates) {
  let max = null;
  for (const v of Object.values(dates)) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    if (max === null || v > max) max = v;
  }
  return max;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns the list of failures it found, so the anti-vacuity copy can be checked
// WITHOUT polluting the real tree's failure list.
function check(file, dates, label) {
  const found = [];
  const t = (cond, l, detail) => { if (!cond) found.push(detail ? `${l}\n      ${detail}` : l); };
  const rows = readManifest(file);
  t(rows.length > 300, `${label}: the manifest parsed`, `got ${rows.length}`);
  const newest = newestDate(dates);
  t(newest !== null, `${label}: tool-dates.json has dated evidence`);
  if (newest === null) return found;
  const cut = addDays(newest, -WINDOW_DAYS);

  const stale = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.isnew !== 'yes') continue;
    const dt = dates[r.slug];
    const undatedTail = (dt === undefined || dt === null) && i > rows.length - TAIL_ROWS;
    const datedRecent = typeof dt === 'string' && dt >= cut;
    if (!undatedTail && !datedRecent) {
      stale.push(`${r.slug} (position ${i + 1}, evidence: ${dt === undefined ? 'none' : dt})`);
    }
  }
  t(stale.length === 0,
    `${label}: no stale "New" badge on an old tool`,
    `${stale.length} stale: ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ' …' : ''}`);

  const flagged = rows.filter(r => r.isnew === 'yes').length;
  t(flagged > 0 && flagged <= 90,
    `${label}: the number of "New" badges is plausible`,
    `got ${flagged} of ${rows.length}`);
  return found;
}

// ---- the real tree ------------------------------------------------------
const manifestFile = path.join(ROOT, 'manifest.txt');
const datesFile = path.join(ROOT, 'tool-dates.json');
if (!fs.existsSync(manifestFile)) {
  console.log('FAIL — manifest.txt not found at ' + manifestFile);
  process.exit(1);
}
{
  const found = check(manifestFile, readDates(datesFile), 'manifest.txt');
  for (const f of found) failures.push(f);
  pass += 3 - found.length;
}

// ---- anti-vacuity: re-inject one stale flag ------------------------------
{
  const src = fs.readFileSync(manifestFile, 'utf8').split('\n');
  const dates = readDates(datesFile);
  const newest = newestDate(dates);
  const cut = addDays(newest, -WINDOW_DAYS);
  // The target must be a row that would be STALE if it carried the flag — i.e. one whose own
  // evidence puts it outside the window and outside the undated tail. Picking "the first row
  // that is not flagged" (the old rule) is not enough: that row is `age-calculator`, whose git
  // date moved to 2026-11-03 when the site snapshot commit touched its index.html, so it is
  // legitimately recent and the re-injected flag is correctly ACCEPTED — the fixture then
  // measured nothing. The target is now chosen by the rule itself: a row that the rule would
  // reject.
  let target = -1;
  let targetSlug = '';
  const rowCount = readManifest(manifestFile).length;
  let rowPos = 0;
  for (let i = 0; i < src.length; i++) {
    const t = src[i].trim();
    if (!t || t.startsWith('#')) continue;
    const f = t.split('|');
    if (f.length < 7) continue;
    rowPos++;                                   // position among ROWS, as check() counts them
    if (f[3].trim() === 'yes') continue;
    const slug = f[0].trim();
    const dt = dates[slug];
    const undatedTail = (dt === undefined || dt === null) && rowPos > rowCount - TAIL_ROWS;
    const datedRecent = typeof dt === 'string' && dt >= cut;
    if (undatedTail || datedRecent) continue;   // legitimately recent — not a valid target
    target = i;
    targetSlug = slug;
    break;
  }
  if (target === -1) {
    failures.push('anti-vacuity: could not find a row whose own evidence makes a "New" badge stale');
  } else {
    const f = src[target].split('|');
    f[3] = 'yes';
    src[target] = f.join('|');
    const tmp = path.join(require('os').tmpdir(), 'bug406-manifest.txt');
    fs.writeFileSync(tmp, src.join('\n'));
    const found = check(tmp, readDates(datesFile), 'anti-vacuity copy');
    ok(found.length > 0,
      'ANTI-VACUITY: a re-injected stale "New" flag makes the gate go red',
      `slug "${targetSlug}" was accepted`);
    fs.unlinkSync(tmp);
  }
}

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log('FAIL:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS — only genuinely recent tools carry a "New" badge.');
