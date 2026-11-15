// Self-check for tools/cron-evaluator/index.html pure logic.
// Extracts the inline <script> and runs it in a vm with a document stub, so boot()
// never fires and only the pure functions run. Also runs the assertions against a
// set of known-broken variants of the page, so a gate that passes for the wrong
// reason cannot pass here.
//
//   node devtools-hub-docs/test-scripts/cron-evaluator-selftest.js
//   node devtools-hub-docs/test-scripts/cron-evaluator-selftest.js <path-to-index.html>
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const PAGE = process.argv[2] || require('path').resolve(__dirname, '../tools/cron-evaluator/index.html');
const html = fs.readFileSync(PAGE, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert(scripts.length >= 1, 'no inline script found');
const code = scripts[scripts.length - 1];

const sandbox = { document: { readyState: 'loading', addEventListener() {} }, Intl, Date, Math, JSON, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'cron-evaluator.inline.js' });

const { parseCron, nextRuns, compress } = sandbox;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + e.message); }
}
// Deterministic clock: 2026-01-15 12:00:00 UTC, a Thursday.
const REAL_NOW = Date.now;
function freeze(iso) { Date.now = () => REAL_NOW.call(null) && new Date(iso).getTime(); }
const NOW = '2026-01-15T12:00:00Z'; // Thursday

t('5 fields parses as Unix', () => {
  const c = parseCron('0 9 * * 1-5');
  assert.strictEqual(c.fields.length, 5);
  assert.strictEqual(c.quartz, false);
  assert(/Unix/.test(c.dialect));
});

t('6 fields parses as Quartz', () => {
  const c = parseCron('0 30 9 * * *');
  assert.strictEqual(c.quartz, true);
  assert.strictEqual(c.parts[0].spec.key, 'second');
});

t('7 fields parses with a year', () => {
  const c = parseCron('0 0 12 1 1 ? 2027');
  assert.strictEqual(c.byKey.year.set[2027], true);
});

t('4 fields is rejected', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 fields|4/);
});

t('@daily macro expands to midnight', () => {
  const c = parseCron('@daily');
  assert.strictEqual(c.fields.join(' '), '0 0 * * *');
});

t('@every is rejected by name', () => {
  assert.throws(() => parseCron('@every 5m'), /not a macro/);
});

t('minute 61 is rejected', () => {
  assert.throws(() => parseCron('61 * * * *'), /outside/);
});

t('weekday 7 is Sunday on Unix', () => {
  assert.strictEqual(parseCron('0 0 * * 7').byKey.dow.set[0], true);
});

t('weekday 1 is Monday on Unix but Sunday in a 6 field Quartz', () => {
  assert.strictEqual(parseCron('0 0 * * 1').byKey.dow.set[1], true);
  assert.strictEqual(parseCron('0 0 * * 1').byKey.dow.set[0], undefined);
  assert.strictEqual(parseCron('0 0 9 * * 1').byKey.dow.set[0], true, 'Quartz 1 is Sunday');
  assert.strictEqual(parseCron('0 0 9 * * 1').byKey.dow.set[1], undefined);
  assert.strictEqual(parseCron('0 0 9 * * 7').byKey.dow.set[6], true, 'Quartz 7 is Saturday');
  assert.strictEqual(parseCron('0 0 * * 7').byKey.dow.set[0], true, 'Unix 7 is Sunday too');
});

t('L and # are rejected in the day of month field', () => {
  assert.throws(() => parseCron('0 0 6#3 * *'), /not a value this field understands/);
});

t('? is accepted in dom and dow only', () => {
  assert.strictEqual(parseCron('0 30 9 ? * MON-FRI').byKey.dom.restricted, false);
  assert.throws(() => parseCron('? 30 9 ? * MON-FRI'), /only legal/);
});

t('month and day names resolve', () => {
  const c = parseCron('0 0 1 JAN-mar MON');
  assert.strictEqual(c.byKey.month.set[1], true);
  assert.strictEqual(c.byKey.month.set[3], true);
  assert.strictEqual(c.byKey.dow.set[1], true);
});

t('next runs for weekdays at 09:00 UTC are Mon-Fri 09:00', () => {
  freeze(NOW);
  const c = parseCron('0 9 * * 1-5');
  const r = nextRuns(c, 'UTC', 5);
  assert.strictEqual(r.runs.length, 5);
  assert.deepStrictEqual(Array.from(r.runs, x => new Date(x.wall).toUTCString().slice(0, 3)), ['Fri', 'Mon', 'Tue', 'Wed', 'Thu']);
  assert(r.runs.every(x => new Date(x.wall).getUTCHours() === 9));
});

t('*/15 produces quarter hours', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('*/15 * * * *'), 'UTC', 4);
  assert.deepStrictEqual(Array.from(r.runs, x => new Date(x.wall).getUTCMinutes()), [15, 30, 45, 0]);
});

t('5/15 anchors at 5', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('5/15 * * * *'), 'UTC', 4);
  assert.deepStrictEqual(Array.from(r.runs, x => new Date(x.wall).getUTCMinutes()), [5, 20, 35, 50]);
});

t('dom+dow restricted uses OR, not AND', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('0 0 13 * 5'), 'UTC', 6);
  const got = Array.from(r.runs, x => new Date(x.wall).getUTCDate());
  // From 2026-01-15: Fridays are 16, 23, 30, then Feb 6, 13, 20. The 13th of Feb is a Friday.
  assert.deepStrictEqual(got, [16, 23, 30, 6, 13, 20]);
  assert(got.includes(13), 'OR must include the 13th, not just Fridays');
  assert(got.includes(16), 'OR must include Fridays, not just the 13th');
});

t('February 30th never fires', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('0 0 30 2 *'), 'UTC', 10);
  assert.strictEqual(r.runs.length, 0);
  assert.strictEqual(r.exhausted, true);
});

t('Feb 29 fires only in a leap year', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('0 0 29 2 *'), 'UTC', 3);
  const years = Array.from(r.runs, x => new Date(x.wall).getUTCFullYear());
  assert.deepStrictEqual(years, [2028, 2032, 2036]);
});

t('L in the day of month field means the last day', () => {
  freeze('2026-01-15T12:00:00Z');
  const r = nextRuns(parseCron('0 0 L * *'), 'UTC', 3);
  assert.deepStrictEqual(Array.from(r.runs, x => new Date(x.wall).getUTCDate()), [31, 28, 31]);
});

t('Quartz W = weekday nearest the 15th', () => {
  freeze('2026-01-15T12:00:00Z');
  const r = nextRuns(parseCron('0 0 15W * *'), 'UTC', 1);
  // 2026-02-15 is a Sunday -> moves to Monday the 16th.
  assert.strictEqual(new Date(r.runs[0].wall).getUTCMonth(), 1);
  assert.strictEqual(new Date(r.runs[0].wall).getUTCDate(), 16);
});

t('Quartz # = nth weekday of month', () => {
  freeze('2026-01-15T12:00:00Z');
  const r = nextRuns(parseCron('0 0 * * 5#3'), 'UTC', 1); // 3rd Friday, Unix numbering
  const d = new Date(r.runs[0].wall);
  assert.strictEqual(d.getUTCDay(), 5);
  assert.strictEqual(Math.floor((d.getUTCDate() - 1) / 7) + 1, 3);
  // Same job in Quartz numbering, where Friday is 6.
  assert.strictEqual(nextRuns(parseCron('0 0 0 * * 6#3'), 'UTC', 1).runs[0].wall, r.runs[0].wall);
});

t('Quartz 6L = last Friday of month', () => {
  freeze('2026-01-15T12:00:00Z');
  const r = nextRuns(parseCron('0 0 * * 5L'), 'UTC', 1);
  const d = new Date(r.runs[0].wall);
  assert.strictEqual(d.getUTCDay(), 5, 'Unix 5 is Friday');
  assert(d.getUTCDate() > 20, 'must be in the last week');
  assert.strictEqual(nextRuns(parseCron('0 0 0 * * 6L'), 'UTC', 1).runs[0].wall, r.runs[0].wall, 'Quartz 6 is the same Friday');
});

t('a restricted year field fires only in that year', () => {
  freeze(NOW);
  const r = nextRuns(parseCron('0 0 12 1 1 ? 2030'), 'UTC', 10); // Quartz, year 2030 only
  assert.strictEqual(r.runs.length, 1);
  assert.strictEqual(new Date(r.runs[0].wall).toISOString(), '2030-01-01T12:00:00.000Z');
  const past = nextRuns(parseCron('0 0 12 1 1 ? 2019'), 'UTC', 10);
  assert.strictEqual(past.runs.length, 0);
});

t('seconds field is honoured', () => {
  freeze('2026-01-15T12:00:00Z');
  const r = nextRuns(parseCron('*/10 * * * * *'), 'UTC', 3);
  // The scan starts one minute after "now", so 12:01:00 is already a match.
  assert.deepStrictEqual(Array.from(r.runs, x => new Date(x.wall).getUTCSeconds()), [0, 10, 20]);
});

t('the timezone decides what 12:00 means', () => {
  freeze(NOW);
  const c = parseCron('0 12 * * *');
  const utc = nextRuns(c, 'UTC', 1);
  const ny = nextRuns(c, 'America/New_York', 1);
  // The wall clock field stays 12:00 in both, the instant moves: 12:00Z vs 17:00Z.
  assert.strictEqual(new Date(utc.runs[0].wall).getUTCHours(), 12);
  assert.strictEqual(new Date(ny.runs[0].wall).getUTCHours(), 12);
  assert.strictEqual(new Date(utc.runs[0].instant).getUTCHours(), 12);
  assert.strictEqual(new Date(ny.runs[0].instant).getUTCHours(), 17, '12:00 in New York in January is 17:00 UTC');
});

t('a daylight saving gap is reported as a non-existent local time', () => {
  freeze('2026-03-01T12:00:00Z');
  const r = nextRuns(parseCron('30 2 * * *'), 'America/New_York', 10);
  const gap = r.runs.filter(x => x.nonexistent);
  // 2026-03-08 02:30 does not exist in New York; 2026-03-09 02:30 does.
  assert.strictEqual(gap.length, 1);
  assert.strictEqual(new Date(gap[0].wall).toISOString().slice(0, 10), '2026-03-08');
  const walls = Array.from(r.runs, x => new Date(x.wall).toISOString().slice(0, 10));
  assert.strictEqual(walls[0], '2026-03-02', 'March 2 is the next normal run');
  assert(walls.indexOf('2026-03-08') > -1, 'the gap day is listed');
  assert.strictEqual(gap[0].wall, Date.UTC(2026, 2, 8, 2, 30), 'and it is the one flagged as non-existent');
  assert.strictEqual(gap[0].instant, Date.parse('2026-03-08T06:30:00Z'), 'which resolves to 01:30 EST, an hour earlier');
  assert.strictEqual(walls[8], '2026-03-10', 'and the schedule carries on the next day');
});

t('compress round-trips */15 and plain ranges', () => {
  const set = {}; [0, 15, 30, 45].forEach(v => set[v] = true);
  assert.strictEqual(compress(set, 0, 59), '*/15');
  const r2 = {}; [9, 10, 11, 12, 13, 14, 15, 16, 17].forEach(v => r2[v] = true);
  assert.strictEqual(compress(r2, 0, 23), '9-17');
  const all = {}; for (let i = 0; i < 60; i++) all[i] = true;
  assert.strictEqual(compress(all, 0, 59), '*');
});

t('platforms() never throws, with or without a seconds field', () => {
  ['0 9 * * 1-5', '0 30 9 * * *', '0 0 12 1 1 ? 2030', '0 0 0 * * 6L', '0 0 30 2 *', '@daily'].forEach(function (e) {
    const out = sandbox.platforms(sandbox.parseCron(e));
    assert.strictEqual(out.length, 5, e);
    assert(out.every(p => p.code && p.code.length > 1), e);
  });
});

Date.now = REAL_NOW;

// --- anti-vacuity tier ----------------------------------------------------
// A gate that has never been seen red measures nothing. Each mutation below is a
// real bug this tool could ship; the named assertion must go red when it is present.
const fs2 = require('fs'), os = require('os'), path2 = require('path');
function loadPage(src) {
  const inline = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
  const s2 = { document: { readyState: 'loading', addEventListener() {} }, Intl, Date, Math, JSON, console };
  vm.createContext(s2);
  vm.runInContext(inline, s2, { filename: 'mutated.js' });
  return s2;
}
function probe(mutate, expectFail, label) {
  const tmp = path2.join(os.tmpdir(), 'cron-evaluator-mutant.html');
  fs2.writeFileSync(tmp, mutate(html));
  const s2 = loadPage(fs2.readFileSync(tmp, 'utf8'));
  fs2.unlinkSync(tmp);
  let threw = false, ok = false;
  try {
    // Five independent properties. A mutation that only touches one of them has to
    // be caught by one of the four, so the probe is not narrow enough to pass blind.
    const a = s2.nextRuns(s2.parseCron('0 0 * * 5L'), 'UTC', 1).runs[0];
    const ad = new Date(a.wall);
    const lastFri = ad.getUTCDay() === 5 && ad.getUTCDate() > 20;            // Unix L
    const sameDay = s2.nextRuns(s2.parseCron('0 0 0 * * 6L'), 'UTC', 1).runs[0].wall === a.wall; // Quartz L
    const or = Array.from(s2.nextRuns(s2.parseCron('0 0 13 * 5'), 'UTC', 10).runs, x => new Date(x.wall));
    // AND would only ever return days that are both, so almost none of them would
    // carry a date other than 13. That is the cheapest way to tell the two apart.
    const orOk = or.length === 10
      && or.some(x => x.getUTCDate() === 13)
      && or.some(x => x.getUTCDate() !== 13)
      && or.some(x => x.getUTCDay() === 5);
    const secs = s2.nextRuns(s2.parseCron('*/10 * * * * *'), 'UTC', 1).runs.length === 1; // seconds field
    const star = s2.nextRuns(s2.parseCron('* * * * *'), 'UTC', 1).runs.length === 1;       // whole range
    const plat = s2.platforms(s2.parseCron('0 30 9 * * *')).length === 5;                   // six field rendering
    ok = lastFri && sameDay && orOk && secs && star && plat;
  } catch (e) { threw = true; }
  const green = ok && !threw;
  // expectFail=true: the page carries a real bug, so staying green is the failure.
  const problem = expectFail ? green : !green;
  pass++; fail += problem ? 1 : 0;
  console.log((problem ? '  FAIL ' : '  ok   ') + 'anti-vacuity: ' + label);
}
console.log('');
probe(h => h, false, 'unmutated page is green (the probe can pass)');
probe(h => h.replace('return quartz ? (((v - 1) % 7) + 7) % 7 : (((v % 7) + 7) % 7);', 'return (((v % 7) + 7) % 7);'), true, 'Quartz weekday numbering reverted to Unix');
probe(h => h.replace('return domOK || dowOK;', 'return domOK && dowOK;'), true, 'day-of-month AND day-of-week intersection instead of OR');
probe(h => h.replace('var sec = r.second,', 'var sec = !!r.second,'), true, 'seconds field stored as a boolean instead of the parsed field');
probe(h => h.replace("if (base === '*') { from = min; to = max; }", "if (base === 'nope') { from = min; to = max; }"), true, 'the star no longer means the whole range');
probe(h => h.replace('var horizon = Date.UTC(new Date().getUTCFullYear() + 12, 0, 1);', 'var horizon = Date.now();'), true, 'the search horizon collapses');
probe(h => h.replace("dowOK = dow === t.dow && da + 7 > last;", "dowOK = dow === t.dow;"), true, 'the last weekday of the month is no longer restricted to the last week');
probe(h => h.replace('listValues(g.second)', 'listValues(g.second.set)'), true, 'platforms() throws on a six field expression');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);