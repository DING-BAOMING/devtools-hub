#!/usr/bin/env node
// The single source of truth for "which gates exist" and "did a gate change".
//
// scripts/gates.json lists the gates and carries a `fingerprint`: a sha256 over
// the CONTENT of every listed gate file. Edit one assertion in one gate and the
// fingerprint no longer matches -> this exits non-zero BEFORE running anything.
// scripts/gates.sig is the site owner's signature over that fingerprint, so a
// manifest nobody signed is visibly unsigned.
//
// The same file is used by the GitHub Actions job (.github/workflows/gates.yml)
// and by the Cloudflare build (scripts/build.sh), so CI and the build can never
// disagree about which gates exist (plan step C5).
//
// Usage:
//   node scripts/verify-gates.js              verify fingerprint + signature, then run every gate
//   node scripts/verify-gates.js --list       print the gate list
//   node scripts/verify-gates.js --fingerprint  print the computed fingerprint
//   node scripts/verify-gates.js --no-run     verify fingerprint + signature only
//   node scripts/verify-gates.js --stamp      write the computed fingerprint into gates.json
//   node scripts/verify-gates.js --sign       sign the fingerprint in gates.json
import { createHash, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'scripts', 'gates.json');
const PUBKEY = path.join(ROOT, 'scripts', 'gates.pub');
const SIGFILE = path.join(ROOT, 'scripts', 'gates.sig');
const SIGNING_KEY = process.env.GATES_SIGNING_KEY || '/home/ubuntu/.secrets/gates-ed25519.pem';
const GATE_TIMEOUT_MS = 300000;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const gates = manifest.gates;

// sha256 over "name sha256(content)\n" for every listed gate, in list order.
function fingerprint() {
  const h = createHash('sha256');
  for (const name of gates) {
    const file = path.join(ROOT, 'test-scripts', name);
    if (!existsSync(file)) {
      console.error(`[gates] MISSING gate file: test-scripts/${name}`);
      process.exit(1);
    }
    h.update(name + ' ' + createHash('sha256').update(readFileSync(file)).digest('hex') + '\n');
  }
  return h.digest('hex');
}

function checkFingerprint() {
  const actual = fingerprint();
  if (actual !== manifest.fingerprint) {
    console.error('[gates] FAIL the gate list fingerprint does not match the manifest');
    console.error(`  manifest : ${manifest.fingerprint}`);
    console.error(`  computed : ${actual}`);
    console.error('  A gate file changed without the manifest being re-stamped.');
    console.error('  Re-stamp with: node scripts/verify-gates.js --stamp');
    return false;
  }
  console.log(`[gates] fingerprint ok (${actual.slice(0, 12)})`);
  return true;
}

function checkSignature() {
  if (!existsSync(SIGFILE) || !existsSync(PUBKEY)) {
    console.error('[gates] FAIL the gate list is not signed (scripts/gates.sig or scripts/gates.pub missing)');
    return false;
  }
  const pub = createPublicKey(readFileSync(PUBKEY));
  const sig = Buffer.from(readFileSync(SIGFILE, 'utf8').trim(), 'base64');
  const okSig = verify(null, Buffer.from(manifest.fingerprint), pub, sig);
  if (!okSig) {
    console.error('[gates] FAIL the signature does not match the fingerprint in gates.json');
    return false;
  }
  console.log('[gates] signature ok');
  return true;
}

function stamp() {
  const actual = fingerprint();
  manifest.fingerprint = actual;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[gates] stamped ' + actual);
}

function signManifest() {
  if (!existsSync(SIGNING_KEY)) {
    console.error('[gates] no signing key at ' + SIGNING_KEY + ' (set GATES_SIGNING_KEY)');
    process.exit(1);
  }
  const key = createPrivateKey(readFileSync(SIGNING_KEY));
  const sig = sign(null, Buffer.from(manifest.fingerprint), key);
  writeFileSync(SIGFILE, sig.toString('base64') + '\n');
  console.log('[gates] signed ' + manifest.fingerprint);
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const g of gates) console.log(g);
  process.exit(0);
}
if (args.includes('--fingerprint')) {
  console.log(fingerprint());
  process.exit(0);
}
if (args.includes('--stamp')) {
  stamp();
  process.exit(0);
}
if (args.includes('--sign')) {
  signManifest();
  process.exit(0);
}

const fpOk = checkFingerprint();
const sigOk = checkSignature();
if (!fpOk || !sigOk) {
  console.error('[gates] FAIL manifest check');
  process.exit(1);
}
if (args.includes('--no-run')) {
  console.log(`[gates] ${gates.length} gates listed, manifest ok`);
  process.exit(0);
}

let pass = 0;
const failed = [];
for (const name of gates) {
  const r = spawnSync(process.execPath, [path.join('test-scripts', name)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failed.push(name);
    console.log(`  FAIL ${name} (exit ${r.status})`);
    console.log(out.split('\n').slice(-12).map(l => '       ' + l).join('\n'));
  }
}

console.log('');
console.log(`[gates] ${gates.length} 项 · PASS ${pass} · FAIL ${failed.length} · 指纹 ${manifest.fingerprint.slice(0, 12)}`);
if (failed.length) {
  console.log('[gates] failed: ' + failed.join(', '));
  process.exit(1);
}
