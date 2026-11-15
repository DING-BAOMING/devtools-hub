#!/usr/bin/env node
// Logic gate for /tools/blood-type-calculator/.
//
// Runs the tool's PURE core script (no DOM access) against closed-form Mendelian
// answers, so a regression in the inheritance maths fails here instead of shipping.
//
//   node blood-type-calculator-logic-gate.js                      # default: reads the tool HTML
//   node blood-type-calculator-logic-gate.js /path/to/core.js     # read a standalone core file
//
// The core is extracted from the HTML by its <script id="bt-core"> marker, so this
// gate tests the shipped file rather than a copy that can drift.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DEFAULT_HTML = path.resolve(
  __dirname, '../tools/blood-type-calculator/index.html');

function loadCore(target) {
  const ext = path.extname(target);
  let src;
  if (ext === '.html') {
    const html = fs.readFileSync(target, 'utf8');
    const m = html.match(/<script id="bt-core">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no <script id="bt-core"> block found in ' + target);
    src = m[1];
  } else {
    src = fs.readFileSync(target, 'utf8');
  }
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: target });
  if (!ctx.BT) throw new Error('core script did not expose window.BT');
  return ctx.BT;
}

const target = process.argv[2] || DEFAULT_HTML;
const BT = loadCore(target);
const ABO = BT.ABO, RH = BT.RH;

let fails = 0, ran = 0;
function eq(label, got, want, tol = 1e-9) {
  ran++;
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label +
    '  got=' + Number(got).toFixed(6) + ' want=' + Number(want).toFixed(6));
}
function ok(label, cond) {
  ran++;
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
}

// ---------------------------------------------------------------- 1. Mendelian
// Closed-form 2x2 expectations, independent of any population prior.
eq('AO x AO -> AA 1/4', BT.offspring(BT.pointAbo('AO'), BT.pointAbo('AO'), BT.ABO_OFF, ABO).AA, 0.25);
eq('AO x AO -> AO 1/2', BT.offspring(BT.pointAbo('AO'), BT.pointAbo('AO'), BT.ABO_OFF, ABO).AO, 0.5);
eq('AO x AO -> OO 1/4', BT.offspring(BT.pointAbo('AO'), BT.pointAbo('AO'), BT.ABO_OFF, ABO).OO, 0.25);
eq('AA x AO -> OO impossible', BT.offspring(BT.pointAbo('AA'), BT.pointAbo('AO'), BT.ABO_OFF, ABO).OO, 0);
eq('AB x AB -> AB 1/2', BT.offspring(BT.pointAbo('AB'), BT.pointAbo('AB'), BT.ABO_OFF, ABO).AB, 0.5);
eq('AB x AB -> AA 1/4', BT.offspring(BT.pointAbo('AB'), BT.pointAbo('AB'), BT.ABO_OFF, ABO).AA, 0.25);
eq('OO x OO -> OO 1', BT.offspring(BT.pointAbo('OO'), BT.pointAbo('OO'), BT.ABO_OFF, ABO).OO, 1);
eq('Dd x Dd -> dd 1/4', BT.offspring(BT.pointRh('Dd'), BT.pointRh('Dd'), BT.RH_OFF, RH).dd, 0.25);
eq('Dd x Dd -> DD 1/4', BT.offspring(BT.pointRh('Dd'), BT.pointRh('Dd'), BT.RH_OFF, RH).DD, 0.25);
// The single most-misapplied fact on this topic: a dominant DD parent MASKS the
// recessive d allele, so DD x Dd cannot produce an Rh-negative child.
eq('DD x Dd -> dd impossible', BT.offspring(BT.pointRh('DD'), BT.pointRh('Dd'), BT.RH_OFF, RH).dd, 0);
eq('dd x DD -> dd impossible', BT.offspring(BT.pointRh('dd'), BT.pointRh('DD'), BT.RH_OFF, RH).dd, 0);
eq('dd x dd -> dd 1', BT.offspring(BT.pointRh('dd'), BT.pointRh('dd'), BT.RH_OFF, RH).dd, 1);

// ------------------------------------------------------------ 2. priors proper
const pa = BT.priorAbo('A');
const zA = 0.2605 ** 2 + 2 * 0.2605 * 0.6691;
eq('P(AO | phenotype A)', pa.AO, 2 * 0.2605 * 0.6691 / zA, 1e-12);
eq('P(AA | phenotype A)', pa.AA, 0.2605 ** 2 / zA, 1e-12);
eq('P(AA | phenotype A) + P(AO | A) == 1', pa.AA + pa.AO, 1);
const pr = BT.priorRh('+');
const zP = 0.882 ** 2 + 2 * 0.882 * 0.118;
eq('P(dd | phenotype Rh+) == 0', pr.dd, 0);
eq('P(Dd | phenotype Rh+)', pr.Dd, 2 * 0.882 * 0.118 / zP, 1e-12);
eq('P(dd | phenotype Rh-) == 1', BT.priorRh('-').dd, 1);

// ----------------------------------------------- 3. phenotype-only end to end
function full(p1, p2) {
  const abo = BT.phenosFrom(BT.offspring(p1.a, p2.a, BT.ABO_OFF, ABO), BT.ABO_PHENO, ABO);
  const rh = BT.phenosFrom(BT.offspring(p1.r, p2.r, BT.RH_OFF, RH), BT.RH_PHENO, RH);
  const out = {};
  for (const k in abo) for (const j in rh) out[k + j] = abo[k] * rh[j];
  return out;
}
const P = (abo, rh) => ({ a: BT.priorAbo(abo), r: BT.priorRh(rh) });
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

// A+ x A+ : an ABO-unaware guess of "100% A+" is only right if BOTH parents are
// AA and BOTH are DD. Exact answer from the documented allele model.
const apap = full(P('A', '+'), P('A', '+'));
console.log('   A+ x A+ -> ' + Object.keys(apap).filter(k => apap[k] > 1e-9)
  .map(k => k + ' ' + (apap[k] * 100).toFixed(2) + '%').join('  '));
eq('A+ x A+ : probabilities sum to 1', sum(apap), 1);
ok('A+ x A+ : not 100% A+ (the guess is falsified)', apap['A+'] < 1);
const hz = BT.priorRh('+');
const expectedNegRh = (hz.Dd * hz.Dd) * 0.25;   // only Dd x Dd can give dd
const apo = apap['A+'] + apap['A-'] + apap['O+'] + apap['O-'];
eq('A+ x A+ : P(Rh-) == P(Dd|^2)*1/4', (apap['A-'] + apap['O-']) / apo, expectedNegRh, 1e-12);
eq('A+ x A+ : P(AB) == 0', (apap['AB+'] || 0) + (apap['AB-'] || 0), 0);

// Two O parents are both OO, so the ABO half is certain even though Rh is not.
const opap = full(P('O', '+'), P('O', '+'));
eq('O+ x O+ : P(O) == 1', opap['O+'] + opap['O-'], 1);
eq('O+ x O+ : P(O-) == P(Dd|^2)*1/4', opap['O-'], expectedNegRh, 1e-12);
eq('O- x O- : deterministic O-', full(P('O', '-'), P('O', '-'))['O-'], 1);
const abm = full(P('AB', '-'), P('AB', '-'));
eq('AB- x AB- : P(AB) == 1/2', abm['AB-'], 0.5);
ok('AB- x AB- : never O', (abm['O-'] || 0) === 0);
eq('AB+ x O+ : P(A)+P(B)+P(O) == 1', sum(full(P('AB', '+'), P('O', '+'))), 1);

// every one of the 64 phenotype pairings must yield a valid distribution
let allValid = true;
for (const a1 of ['A', 'B', 'AB', 'O']) for (const r1 of ['+', '-'])
  for (const a2 of ['A', 'B', 'AB', 'O']) for (const r2 of ['+', '-']) {
    const d = full(P(a1, r1), P(a2, r2));
    if (Math.abs(sum(d) - 1) > 1e-9) allValid = false;
  }
ok('all 64 parent-phenotype pairings sum to 1', allValid);

// ------------------------------------------------ 4. reverse inference (Bayes)
// An O child rules out every parental genotype with no O allele.
const postO = BT.posteriorPairs(BT.priorAbo('A'), BT.priorAbo('B'), BT.ABO_OFF, ABO, BT.ABO_PHENO, ['O']);
eq('A x B with O child: posterior sums to 1', postO.reduce((a, p) => a + p.p, 0), 1);
ok('A x B with O child: only AO x BO survives',
  postO.every(p => p.g1 === 'AO' && p.g2 === 'BO'));
// ...and the survival pair is certain, so the answer is a certainty, not a hedge.
const mO = BT.marginals(postO, ABO);
eq('A x B with O child: the A parent is certain AO', mO.m1.AO, 1);
eq('A x B with O child: the B parent is certain BO', mO.m2.BO, 1);
ok('A x B with O child: the two parents are not the same belief', mO.m1.BO === 0 && mO.m2.AO === 0);

// An AB child forces BOTH parents to carry a non-O allele.
const postAB = BT.posteriorPairs(BT.priorAbo('A'), BT.priorAbo('B'), BT.ABO_OFF, ABO, BT.ABO_PHENO, ['AB']);
ok('A x B with AB child: no OO anywhere',
  postAB.every(p => p.g1 !== 'OO' && p.g2 !== 'OO'));
ok('A x B with AB child: AB parent impossible',
  postAB.every(p => p.g1 !== 'AB' && p.g2 !== 'AB'));

// An Rh-negative child forces BOTH Rh-positive parents to be Dd. Then the next
// child is Rh-negative with probability exactly 1/4 - the classic textbook answer.
const rhPost = BT.posteriorPairs(BT.priorRh('+'), BT.priorRh('+'), BT.RH_OFF, RH, BT.RH_PHENO, ['-']);
eq('Rh+ x Rh+ with Rh- child: both parents Dd',
  rhPost.length, 1);
ok('Rh+ x Rh+ with Rh- child: Dd x Dd', rhPost[0].g1 === 'Dd' && rhPost[0].g2 === 'Dd');
const rhMarg = BT.marginals(rhPost, RH);
ok('Rh negative child collapses both Rh parents to Dd',
  rhMarg.m1.Dd === 1 && rhMarg.m2.Dd === 1);
eq('next child Rh-negative after one Rh-negative child', BT.offspring(rhMarg.m1, rhMarg.m2, BT.RH_OFF, RH).dd, 0.25);
// An Rh POSITIVE child is uninformative about a recessive allele, so the Dd mass
// must not be wiped out - a regression here would be "always answer 100%".
const rhPos = BT.marginals(BT.posteriorPairs(BT.priorRh('+'), BT.priorRh('+'), BT.RH_OFF, RH, BT.RH_PHENO, ['+']), RH);
ok('Rh positive child does NOT make either parent certain DD',
  rhPos.m1.Dd > 0.1 && rhPos.m2.Dd > 0.1,
  'Dd=' + rhPos.m1.Dd.toFixed(4));

// Contradictory observation must return null, not a fabricated distribution.
ok('Rh- x Rh- with Rh+ child: no consistent pair',
  !BT.posteriorPairs(BT.priorRh('-'), BT.priorRh('-'), BT.RH_OFF, RH, BT.RH_PHENO, ['+']));
// Independent draws => likelihood is the product. Two Rh- children is 1/4, not 1/2.
const rh2 = BT.posteriorPairs(BT.priorRh('+'), BT.priorRh('+'), BT.RH_OFF, RH, BT.RH_PHENO, ['-', '-']);
eq('two Rh- children also collapse to Dd x Dd', rh2.length, 1);

// ------------------------------------------------- 5. grandparents (exactness)
const twoOParents = BT.posteriorFromParents(BT.priorAbo('O'), BT.priorAbo('O'), 'A', ABO, BT.ABO_PHENO, BT.ABO_OFF);
ok('two type O parents cannot have a type A child', twoOParents === null);
// A type A child of O x AB is certain: the O parent is OO and must pass O, the AB
// parent must pass A, so the CHILD is always AO. Asserting the CHILD here is the
// point: returning the grandparents' distribution instead is the bug this catches.
const gpAB = BT.posteriorFromParents(BT.priorAbo('O'), BT.priorAbo('AB'), 'A', ABO, BT.ABO_PHENO, BT.ABO_OFF);
// AB is heterozygous and passed its A allele (the child is typed A), and the O
// parent always passes O, so the child's genotype is certain AO.
eq('O x AB with A child: child is certain AO', gpAB.AO, 1);
ok('O x AB with A child: nothing else survives', gpAB.BO + gpAB.OO + gpAB.AB + gpAB.AA + gpAB.BB === 0);
ok('O x AB with A child: no grandparent genotype leaks into the answer',
  gpAB.OO === 0 && gpAB.AB === 0 && gpAB.BB === 0);
// A type B child of two type A parents is impossible - no A parent carries a B allele.
ok('A x A parents cannot have a B child',
  BT.posteriorFromParents(BT.priorAbo('A'), BT.priorAbo('A'), 'B', ABO, BT.ABO_PHENO, BT.ABO_OFF) === null);
// Grandparents resolve what priors cannot: an O child of two type A parents proves
// that person is heterozygous AO, wiping out the 16.3% AA mass the prior allowed.
const gpAB2 = BT.posteriorFromParents(BT.priorAbo('A'), BT.priorAbo('A'), 'O', ABO, BT.ABO_PHENO, BT.ABO_OFF);
// Each A parent proved it carried O, so the person is AO or OO at 1/2. AA is gone,
// which is the tightening: the prior put 16.3% on AA for a type A person.
eq('A x A with O child: certain OO', gpAB2.OO, 1);
eq('A x A with O child: no incompatible genotype leaks in',
  gpAB2.AA + gpAB2.AO + gpAB2.AB + gpAB2.BB + gpAB2.BO, 0);
// A type A person whose parents are O x AB is AO or BO, never OO.
eq('O x AB with A child: no OO leak', gpAB.OO, 0);
// ABO evidence must not contaminate the Rh answer.
const gpAA = BT.posteriorFromParents(BT.pointAbo('AA'), BT.pointAbo('AA'), 'A', ABO, BT.ABO_PHENO, BT.ABO_OFF);
eq('AA x AA with A child: still AA', gpAA.AA, 1);
// An Rh negative child of an Rh positive and an Rh negative parent is certain,
// because the Rh positive parent must carry d.
const gpNeg = BT.posteriorFromParents(BT.priorRh('+'), BT.priorRh('-'), '-', RH, BT.RH_PHENO, BT.RH_OFF);
// The + parent must have been Dd (only Dd x dd can give a negative child), and it
// passed d, so the person is Dd or dd at 1/2. DD is impossible.
eq('Rh+ x Rh- parent, Rh- child: certain dd', gpNeg.dd, 1);
eq('Rh+ x Rh- parent, Rh- child: no Dd or DD leak', gpNeg.Dd + gpNeg.DD, 0);
// ...but an Rh POSITIVE child of that pair is NOT certain, and must not look like it.
const gpPos = BT.posteriorFromParents(BT.priorRh('+'), BT.priorRh('-'), '+', RH, BT.RH_PHENO, BT.RH_OFF);
// A + child tells you nothing about the recessive allele: DD x dd always gives Dd,
// so the person's posterior equals the + parent's prior (Dd 0.2111) re-weighted.
// A + child of Rh+ x Rh- is certain Dd: the Rh negative parent always passes d,
// and a Dd phenotype cannot be DD.
eq('Rh+ x Rh- parent, Rh+ child: certain Dd', gpPos.Dd, 1);
eq('Rh+ x Rh- parent, Rh+ child: no dd or DD leak', gpPos.dd + gpPos.DD, 0);

console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' of ' + ran + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);