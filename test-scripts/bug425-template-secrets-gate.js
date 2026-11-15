#!/usr/bin/env node
// BUG-425 gate: the DEPLOY must refuse to upload a template file that carries a value.
//
// The defect: `/.dev.vars.example` was published with SIX live third-party API keys
// (17TRACK, API-Football, Juhe x4) — the 17TRACK key was accepted by the vendor's live
// API. The file is a TEMPLATE (developers copy it to `.dev.vars` and fill it in), so every
// value in it must be EMPTY.
//
// The fix has two halves, and this gate owns both:
//   1. the DEPLOY GATE refuses to upload such a file (scripts/build.sh — pre-deploy.sh is now a
//      thin wrapper that calls it, so the rule lives in build.sh)
//   2. the shipped tree passes that gate
//
// The rule is a SHAPE, not a vendor list, so it cannot go stale when a new API key is
// added: a template is a template whatever it is a template of.
//
// The assertion runs the REAL awk program extracted from scripts/build.sh over real
// fixtures — not a re-implementation, which would prove nothing.
//
// ANTI-VACUITY: the exact pre-fix file (with the six live values) must be FLAGGED, and
// the current file must not be.
//
// Usage: node bug425-template-secrets-gate.js [rootDir]
//   rootDir defaults to the site tree (the parent of this directory)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFileSync: ex } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  PASS ' + m); };
const no = (m) => { fail++; console.log('  FAIL ' + m); };

// --- 0. the gate program exists in the build script --------------------------------------
let AWK_PROG = null;
const buildScript = path.join(ROOT, 'scripts', 'build.sh');
if (!fs.existsSync(buildScript)) {
  no('scripts/build.sh not found — the deploy gate is gone');
} else {
  const src = fs.readFileSync(buildScript, 'utf8');
  const m = src.match(/awk -v file="\$f" '([\s\S]*?)'\s+"\$\{?f\}?"/);
  if (!m) {
    no('scripts/build.sh no longer contains the template-secret awk program');
  } else {
    AWK_PROG = m[1];
    ok('scripts/build.sh contains the template-secret check');

    // The rule is only enforced on a real deploy if the deploy path actually runs build.sh.
    const preDeploy = path.join(ROOT, 'scripts', 'pre-deploy.sh');
    if (fs.existsSync(preDeploy)) {
      const pd = fs.readFileSync(preDeploy, 'utf8');
      if (/bash\s+scripts\/build\.sh/.test(pd)) ok('scripts/pre-deploy.sh runs scripts/build.sh, so the rule is enforced on a deploy');
      else no('scripts/pre-deploy.sh does NOT run scripts/build.sh — the deploy would skip the template-secret rule');
    }

    // --- the real program, extracted from the real file --------------------------------
    const prog = fs.mkdtempSync(path.join(os.tmpdir(), 'bug425-'));
    const progFile = path.join(prog, 'rule.awk');
    fs.writeFileSync(progFile, m[1]);

    const run = (file) => {
      try {
        const out = execFileSync('awk', ['-v', 'file=' + file, '-f', progFile, file], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim();
      } catch (e) {
        return '';
      }
    };

    // --- 1. the shipped tree passes ----------------------------------------------------
    for (const f of ['.dev.vars.example', '.env.example']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) { no(f + ' is missing from the tree'); continue; }
      const out = run(p);
      ok(`${f} ships with no value (${out === '' ? 'clean' : 'FLAGGED: ' + out})`);
      if (out !== '') no(`${f} still carries a value: ${out}`);
    }

    // --- 2. ANTI-VACUITY: the exact pre-fix file must be flagged ------------------------
    // Six lines in the SHAPE of the published file: uppercase var name + a value. The
    // values were the live third-party keys; they were scrubbed out of this tracked file
    // in BUG-452, so the fixtures below are synthetic values of the same shape (same
    // length/character classes). The test asserts the RULE flags them, not that these
    // strings are known — so nothing real is needed here.
    const preFix = [
      'DEVTOOLS_APIFOOTBALL_KEY=A1B2C3D4E5F60718293A4B5C6D7E8F90',
      'DEVTOOLS_17TRACK_KEY=1A2B3C4D5E6F708192A3B4C5D6E7F809',
      'DEVTOOLS_JUHE_SUDOKU_KEY=9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'DEVTOOLS_JUHE_FOOTBALL_KEY=0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'DEVTOOLS_JUHE_HOTSEARCH_KEY=1b2c3d4e5f60718293a4b5c6d7e8f901',
      'DEVTOOLS_JUHE_MCP_TOKEN=Q7wE9rT2yU4iO6pA8sD0fG1hJ3kL5zX7cV9bN2mQ4wE6rT8',
    ].join('\n') + '\n';
    const preFixFile = path.join(prog, 'pre-fix.dev.vars.example');
    fs.writeFileSync(preFixFile, preFix);
    const flagged = run(preFixFile);
    const lines = flagged ? flagged.split('\n') : [];
    if (lines.length === 6) ok('anti-vacuity: the pre-fix file with 6 live keys is flagged (6 lines)');
    else no(`anti-vacuity: the pre-fix file should flag 6 values, got ${lines.length}: ${flagged}`);

    // --- 3. the rule's own edges --------------------------------------------------------
    const cases = [
      ['an obvious placeholder is allowed', 'CLOUDFLARE_API_TOKEN="<your-token-here>"', false],
      ['an empty value is allowed', 'DEVTOOLS_X_KEY=', false],
      ['a quoted empty value is allowed', 'DEVTOOLS_X_KEY=""', false],
      ['a changeme placeholder is allowed', 'DEVTOOLS_X_KEY=changeme', false],
      ['a real-looking value is flagged', 'DEVTOOLS_X_KEY=8f3a91c2b7d4e6509a1c2b3d4e5f6071', true],
      ['a value after "export " is flagged', 'export DEVTOOLS_X_KEY=8f3a91c2b7d4e6509a1c2b3d4e5f6071', true],
    ];
    for (const [label, content, shouldFlag] of cases) {
      const f = path.join(prog, 'case.tmp.example');
      fs.writeFileSync(f, content + '\n');
      const out = run(f);
      const isFlagged = out !== '';
      if (isFlagged === shouldFlag) ok(`${label} (${isFlagged ? 'flagged' : 'allowed'})`);
      else no(`${label}: expected ${shouldFlag ? 'flagged' : 'allowed'}, got ${isFlagged ? 'flagged' : 'allowed'}`);
    }

    fs.rmSync(prog, { recursive: true, force: true });
  }
}

// --- 4. the shipped tree has no live key in ANY template file ---------------------------
// The rule above runs per file; this runs it over the whole tree the way the deploy does.
// It must FIND the files (a sweep that finds none proves nothing) and find no value in them.
if (!AWK_PROG) {
  no('the whole-tree sweep could not run (no awk program extracted)');
} else {
  const script = `cd ${JSON.stringify(ROOT)} && find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.wrangler -prune -o \\( -name '*.example' -o -name '*.template' -o -name '*.sample' -o -name '*.dist' \\) -type f -print | while read -r f; do awk -v file="$f" '${AWK_PROG}' "$f"; done`;
  try {
    const out = ex('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out === '') ok('the whole shipped tree has no template file carrying a value');
    else no('the shipped tree has template files with values:\n' + out);
  } catch (e) {
    no('the whole-tree sweep failed: ' + (e.stderr || e.message));
  }
  // anti-vacuity for the sweep itself: it must actually find the template files
  try {
    const found = ex('bash', ['-c',
      `cd ${JSON.stringify(ROOT)} && find . -path ./node_modules -prune -o -path ./.git -prune -o \\( -name '*.example' -o -name '*.template' \\) -type f -print | wc -l`],
      { encoding: 'utf8' }).trim();
    if (Number(found) >= 2) ok(`the sweep finds the ${found} template files in the tree (it is not vacuous)`);
    else no(`the sweep found only ${found} template files — expected at least 2`);
  } catch (e) {
    no('the sweep could not count the template files: ' + e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
