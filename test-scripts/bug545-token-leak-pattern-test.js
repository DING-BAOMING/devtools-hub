// BUG-545: the build-time token-leak gate only matched the `cfat_` (scoped
// token) prefix. Since 2026-11-15 the token actually in use is a `cfut_`
// (user) token, so a leaked one passed the gate untouched.
//
// This test reads the real pattern out of scripts/build.sh and proves it
// matches BOTH prefixes, so the gate cannot silently regress again.
//
// Run: node test-scripts/bug545-token-leak-pattern-test.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error('  FAIL ' + msg); failed++; }
  else console.log('  ok   ' + msg);
};

const buildSh = readFileSync(join(ROOT, 'scripts', 'build.sh'), 'utf8');
const m = /LEAKED=\$\(grep -rlE '([^']+)'/.exec(buildSh);
ok(!!m, 'build.sh still has the LEAKED grep with an inline pattern');
if (!m) process.exit(1);

const pattern = m[1];
const re = new RegExp(pattern);
ok(re.test('CLOUDFLARE_API_TOKEN=cfat_' + 'A'.repeat(40)), 'the pattern matches a scoped (cfat_) token');
ok(re.test('CLOUDFLARE_API_TOKEN=cfut_' + 'A'.repeat(40)), 'the pattern matches a user (cfut_) token');
ok(re.test('token cfut_' + 'b'.repeat(40) + ' here'), 'the pattern matches a cfut_ token anywhere in a line');
ok(!re.test('cfut_short'), 'the pattern does not match a short cfut_ string');
ok(!re.test('nothing to see here'), 'the pattern does not match ordinary text');

console.log(failed ? `\n[bug545] FAIL ${failed}` : '\n[bug545] PASS');
process.exit(failed ? 1 : 0);
