/* ReDoS engine: parse -> locate ambiguity -> synthesize attack -> measure -> fix.
   Shared between the tool page and the Node test harness. No dependencies. */
(function (root) {
  'use strict';

  /* ---------- 1. Parser (keeps source spans so findings can quote the fragment) ---------- */
  function parse(src) {
    var i = 0;
    function peek(k) { return src[i + (k || 0)]; }
    function alt() {
      var start = i, branches = [seq()];
      while (peek() === '|') { i++; branches.push(seq()); }
      return branches.length === 1 ? branches[0] : { t: 'alt', branches: branches, start: start, end: i };
    }
    function seq() {
      var start = i, items = [];
      while (i < src.length && peek() !== '|' && peek() !== ')') {
        var atom = atom_();
        if (!atom) break;
        var q = quant();
        items.push(q ? { t: 'rep', body: atom, min: q.min, max: q.max, start: atom.start, end: i } : atom);
      }
      return items.length === 1 ? items[0] : { t: 'seq', items: items, start: start, end: i };
    }
    function atom_() {
      var start = i, c = peek();
      if (c === '(') {
        i++;
        if (peek() === '?') {
          var k = peek(1);
          if (k === '<') {
            var m = src.slice(i + 2).match(/^(=)!|<([A-Za-z_$][\w$]*)>/);
            if (m && m[2]) { i += 2 + m[2].length + 1; return { t: 'grp', kind: 'named', name: m[2], start: start, end: i }; }
            i += 3; return { t: 'grp', kind: peek(-1) === '!' ? 'nlook' : 'look', start: start, end: i };
          }
          i += 2; return { t: 'grp', kind: 'ncap', start: start, end: i };
        }
        var inner = alt();
        if (peek() === ')') i++;
        return { t: 'grp', kind: 'cap', body: inner, start: start, end: i };
      }
      if (c === '[') {
        i++;
        if (peek() === '^') i++;
        if (peek() === ']') i++;
        while (i < src.length && peek() !== ']') { if (peek() === '\\') i++; i++; }
        i++;
        return { t: 'cls', start: start, end: i };
      }
      if (c === '\\') { i += 2; return { t: 'esc', text: src.slice(start, i), start: start, end: i }; }
      if (c === '.') { i++; return { t: 'any', start: start, end: i }; }
      if (c === '^' || c === '$') { i++; return { t: 'anchor', start: start, end: i }; }
      i++;
      return { t: 'lit', c: c, start: start, end: i };
    }
    function quant() {
      var c = peek();
      if (c === '*') { i++; return { min: 0, max: Infinity }; }
      if (c === '+') { i++; return { min: 1, max: Infinity }; }
      if (c === '?') { i++; return { min: 0, max: 1 }; }
      if (c === '{') {
        var m = src.slice(i).match(/^\{(\d+)(,(\d*))?\}/);
        if (m) {
          i += m[0].length;
          return m[2] === undefined ? { min: +m[1], max: +m[1] } : { min: +m[1], max: m[3] === '' ? Infinity : +m[3] };
        }
      }
      if (c === '+' || c === '*') { if (peek(1) === '?') { i += 2; return { min: -1, max: -1 }; } }
      return null;
    }
    var ast = alt();
    return { ast: ast, pos: i, len: src.length, trailing: src.slice(i) };
  }

  /* ---------- 2. first-set / nullable (approximate: classes collapse to a marker set) ---------- */
  var WIDE = { '\u0001': 1 };
  function firstSet(n) {
    var s = {};
    switch (n.t) {
      case 'lit': s[n.c] = 1; return s;
      case 'cls': case 'any': case 'esc': s['\u0001'] = 1; return s;
      case 'anchor': return s;
      case 'alt': n.branches.forEach(function (b) { var f = firstSet(b); for (var k in f) s[k] = 1; }); return s;
      case 'seq':
        for (var j = 0; j < n.items.length; j++) {
          var f2 = firstSet(n.items[j]); for (var k2 in f2) s[k2] = 1;
          if (!nullable(n.items[j])) break;
        }
        return s;
      case 'grp': return n.body ? firstSet(n.body) : s;
      case 'rep': return firstSet(n.body);
    }
    return s;
  }
  function nullable(n) {
    switch (n.t) {
      case 'lit': case 'cls': case 'any': case 'esc': case 'anchor': return false;
      case 'alt': return n.branches.some(nullable);
      case 'seq': return n.items.every(nullable);
      case 'grp': return n.body ? nullable(n.body) : true;
      case 'rep': return n.min === 0 || nullable(n.body);
    }
    return false;
  }
  function overlaps(a, b) {
    for (var k in a) { if (b[k]) return true; }
    if (a['\u0001'] || b['\u0001']) return true;   // a class/wildcard can stand for anything
    return false;
  }
  /* A single "one character wide" atom: the case where collapsing a nested
     quantifier provably preserves the language. */
  function singleCharAtom(n) {
    return n.t === 'lit' || n.t === 'cls' || n.t === 'any' ||
      (n.t === 'esc' && /^\\[dwsDSW]/.test(n.text || ''));
  }

  /* ---------- 3. Locate ambiguous regions ----------
     Four independent ways a pattern becomes ambiguous. All of them are the same
     underlying problem: the engine has more than one way to divide the same run
     of input characters, so it must try every division before admitting failure.

     R1 nested-quantifier     an unbounded repetition directly inside another
     R2 ambiguous-alternation overlapping alternatives under an unbounded repetition
     R3 adjacent-overlap      two adjacent unbounded repetitions that can match the
                              same characters, inside a repeated group
     R4 nullable-in-repeat    a repeated group holding something that can match
                              nothing, so the outer repetition can split one run
                              between its iterations in every possible way        */
  function findAmbiguities(ast) {
    var found = [];
    function add(type, n, why) {
      found.push({ type: type, start: n.start, end: n.end, node: n, why: why });
    }
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.t === 'rep') {
        var b = n.body;
        var grp = b.t === 'grp' ? b : null;
        var inner = grp && grp.body ? grp.body : null;

        // R1: rep directly inside rep, both unbounded
        if (b.t === 'rep' && b.max === Infinity && n.max === Infinity) {
          add('nested-quantifier', n, 'A repetition sits directly inside another unbounded repetition, so the engine can split the same run of characters every way it can.');
        } else if (inner && inner.t === 'rep' && inner.max === Infinity && n.max === Infinity) {
          add('nested-quantifier', n, 'A repeated group holds another unbounded repetition, so each outer iteration can itself be divided several ways.');
        }

        if (n.max === Infinity && inner) {
          // R2: overlapping alternatives under an unbounded repetition
          if (inner.t === 'alt') {
            for (var x = 0; x < inner.branches.length && x < 12; x++) {
              for (var y = x + 1; y < inner.branches.length; y++) {
                if (overlaps(firstSet(inner.branches[x]), firstSet(inner.branches[y]))) {
                  add('ambiguous-alternation', n, 'Two alternatives inside this group can match the same text, and the group repeats, so every possible split has to be tried.');
                  x = inner.branches.length; break;
                }
              }
            }
          }
          // R3: adjacent unbounded repetitions that overlap, inside a repeated group
          if (inner.t === 'seq') {
            var its = inner.items;
            for (var a = 0; a + 1 < its.length; a++) {
              var A = its[a], B = its[a + 1];
              if (A.t === 'rep' && B.t === 'rep' && A.max === Infinity && B.max === Infinity &&
                overlaps(firstSet(A), firstSet(B))) {
                add('adjacent-overlap', n, 'Two adjacent unbounded repetitions here match the same characters, so the run between them can be divided in exponentially many ways.');
                break;
              }
            }
          }
          // R4: a nullable element inside a repeated group
          if (inner.t === 'seq') {
            for (var s = 0; s < inner.items.length; s++) {
              if (nullable(inner.items[s])) {
                add('nullable-in-repeat', n, 'Part of this repeated group can match nothing, so one continuous run of input can be split between the iterations in every possible way.');
                break;
              }
            }
          }
        }
        walk(n.body);
      } else if (n.t === 'seq') { n.items.forEach(walk); }
      else if (n.t === 'alt') { n.branches.forEach(walk); }
      else if (n.t === 'grp' && n.body) { walk(n.body); }
    })(ast);
    return found;
  }

  /* ---------- 4. Attack string synthesis ---------- */
  function pickPump(set, src, node) {
    // A concrete character that the ambiguous region actually consumes.
    for (var k in set) { if (k !== '\u0001') return k; }
    // Wide set: read a literal out of the fragment, else probe the engine.
    var frag = src.slice(node.start, node.end);
    var m = frag.match(/[A-Za-z0-9]/);
    if (m) return m[0];
    return 'a';
  }
  function poison(set) {
    var cands = ['X', '!', '#', '@', '~', '|', '\n', '\u0001'];
    for (var j = 0; j < cands.length; j++) { if (!set[cands[j]]) return cands[j]; }
    return '\n';
  }
  function synthAttack(src, amb) {
    var node = amb.node;
    var target = node;
    // descend to the innermost ambiguous group so the pumped character is the one it consumes
    (function deepest(n) {
      if (n.t === 'rep') { if (n.body && (n.body.t === 'grp' || n.body.t === 'rep')) { target = n; deepest(n.body); } }
      else if (n.t === 'grp' && n.body) { target = n; deepest(n.body); }
    })(node);
    var set = firstSet(target.t === 'rep' ? target.body : target);
    var pump = pickPump(set, src, node);
    return { pump: pump, poison: poison(set) };
  }
  function attackString(src, amb, n) {
    var a = synthAttack(src, amb);
    return a.pump.repeat(n) + a.poison;
  }

  /* ---------- 5. Measurement + growth classification ----------
     A single match of a linear pattern finishes in well under a millisecond, which
     is inside the noise of the timer, and noise in both numerator and denominator
     turns a slope of 1 into whatever the scheduler happened to do. So a probe is
     repeated until enough time has actually accumulated to divide, and the reported
     figure is the per-match average. Without this the curve is not a measurement. */
  /* Minimum-of-N trials. Scheduling jitter and GC only ever add time, never take
     it away, so the fastest of several trials is the cleanest estimate of the
     actual cost. A single timed run is not a measurement at any length. */
  function measure(re, s, budgetMs, trials) {
    budgetMs = budgetMs || 12;
    trials = trials || 3;
    var best = Infinity, bestReps = 1;
    for (var t = 0; t < trials; t++) {
      var reps = 1, total = 0, t0;
      t0 = now();
      try { re.test(s); } catch (e) { return { ms: 0, reps: reps, error: e.message }; }
      total = now() - t0;
      if (total <= 0) {
        reps = 20000;
      } else if (total < budgetMs) {
        reps = Math.min(200000, Math.max(2, Math.ceil(budgetMs / total)));
      }
      if (reps > 1) {
        t0 = now();
        for (var i = 0; i < reps; i++) { try { re.test(s); } catch (e) { return { ms: 0, reps: reps, error: e.message }; } }
        total = now() - t0;
      }
      var per = total / reps;
      if (per < best) { best = per; bestReps = reps; }
    }
    return { ms: best === Infinity ? 0 : best, reps: bestReps };
  }
  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }
  function classify(points) {
    var p = points.filter(function (x) { return x && x.ms > 0; });
    if (p.length < 2) return { slope: null, cls: 'unknown' };
    var a = p[p.length - 2], b = p[p.length - 1];
    if (b.n <= a.n) return { slope: null, cls: 'unknown' };
    var slope = Math.log(b.ms / a.ms) / Math.log(b.n / a.n);
    var cls = slope >= 3.5 ? 'exponential' : slope >= 1.6 ? 'polynomial' : 'linear';
    return { slope: slope, cls: cls };
  }

  /* An adaptive length ladder. A single fixed ladder cannot serve both cases: an
     exponential pattern blows up within a few dozen characters, while a linear one
     costs so little at that size that per-call overhead swamps the signal. So walk
     n upward while the measurement stays inside the noise floor, and stop as soon as
     it does not. The ladder that gets used is reported, so the curve is auditable. */
  function ladder(makeInput, opts) {
    opts = opts || {};
    var maxN = opts.maxN || 200000;
    var maxSteps = opts.maxSteps || 16;
    var stopMs = opts.stopMs || 1.5;     // a match this slow already tells the story
    var n = opts.startN || 4;
    var factor = 2;
    var points = [];
    for (var s = 0; s < maxSteps && n <= maxN; s++) {
      var m = measure(opts.re, makeInput(n));
      points.push({ n: n, ms: m.ms, reps: m.reps });
      // Stop as soon as the growth is self-evident, the ladder is long enough for
      // the ratio between the last two steps to mean something, or n is maxed out
      // (re-measuring the same n would leave the slope undefined).
      if ((m.ms >= stopMs && points.length >= 3) || n >= maxN) break;
      n = Math.min(maxN, Math.ceil(n * factor));
      factor = factor < 4 ? factor + 0.5 : 4;
    }
    return points;
  }

  /* ---------- 6. Fix proposal ---------- */
  /* Only the single-character-atom collapse is automatic: repeating one character
     class once accepts exactly the text that repeating it many times accepts.
     Anything richer needs a decision about which alternative should win. */
  function proposeFix(src, amb) {
    var n = amb.node;
    if (!n || n.t !== 'rep' || n.max !== Infinity) return null;

    var grp = n.body;
    var inner = grp.t === 'grp' && grp.body ? grp.body : null;
    var innerRep = inner && inner.t === 'rep' && inner.max === Infinity ? inner : null;

    if (innerRep && singleCharAtom(innerRep.body)) {
      var atomSrc = src.slice(innerRep.body.start, innerRep.body.end);
      var q = n.min === 0 ? '*' : '+';
      var collapsed = atomSrc + q;
      var out = {
        fixed: src.slice(0, n.start) + collapsed + src.slice(n.end),
        rationale: 'Repeating one character atom once accepts exactly the text that repeating it many times accepts, so the outer loop can be dropped without changing what matches.',
        caveat: null
      };
      if (grp.kind === 'cap') {
        out.caveat = 'This removes a capturing group. If anything reads a numbered or named backreference from this pattern, it has to be updated.';
      } else if (grp.kind === 'named') {
        out.caveat = 'This removes a named capturing group. Anything reading that name has to be updated.';
      }
      return out;
    }
    return null;
  }

  /* ---------- 7. Differential equivalence probe ---------- */
  function corpusFor(src, amb) {
    var a = synthAttack(src, amb);
    var chars = 'aA1 _-.@';
    var out = ['', 'a', 'aaaa', 'aaaaaaaa', a.pump, a.pump + a.pump, a.poison,
      a.pump + a.poison, 'abc123', 'a.b@c', '  a  ', 'aaaaX', 'aXaXaX', 'zzzzzzzzzzzzzzzz'];
    var seed = 12345;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var k = 0; k < 400; k++) {
      var len = 1 + Math.floor(rnd() * 6), s = '';
      for (var j = 0; j < len; j++) s += chars[Math.floor(rnd() * chars.length)];
      out.push(s);
    }
    for (var m = 1; m <= 6; m++) out.push(a.pump.repeat(m) + a.poison);
    return out;
  }
  function equivalent(srcA, srcB, flags, corpus) {
    var A, B;
    try { A = new RegExp(srcA, flags); B = new RegExp(srcB, flags); }
    catch (e) { return { ok: false, reason: 'one of the two patterns does not compile: ' + e.message }; }
    for (var k = 0; k < corpus.length; k++) {
      var ra, rb;
      try { ra = A.test(corpus[k]); } catch (e) { return { ok: false, reason: 'original threw on probe ' + JSON.stringify(corpus[k]) }; }
      try { rb = B.test(corpus[k]); } catch (e) { return { ok: false, reason: 'rewrite threw on probe ' + JSON.stringify(corpus[k]) }; }
      if (ra !== rb) {
        return { ok: false, reason: 'the rewrite disagrees on ' + JSON.stringify(corpus[k]) + ' (original ' + ra + ', rewrite ' + rb + ')', probe: corpus[k] };
      }
    }
    return { ok: true, probes: corpus.length };
  }

  /* ---------- 8. Static-only report ---------- */
  function analyze(src, flags) {
    var res = { ok: false, error: null, findings: [], fixes: [], attack: null };
    if (!src) { res.error = 'Enter a regular expression first.'; return res; }
    var p;
    try { p = parse(src); }
    catch (e) { res.error = 'This pattern could not be parsed: ' + e.message; return res; }
    if (p.trailing.trim()) {
      res.error = 'Unexpected ' + JSON.stringify(p.trailing) + ' after the end of the pattern. Check for an unbalanced bracket or brace.';
      return res;
    }
    try { new RegExp(src, flags || ''); }
    catch (e) { res.error = 'The browser rejected this pattern: ' + e.message; return res; }

    res.ok = true;
    var amb = findAmbiguities(p.ast);
    /* de-duplicate overlapping findings, keeping the most severe */
    var order = { 'nested-quantifier': 0, 'adjacent-overlap': 1, 'ambiguous-alternation': 2 };
    amb.sort(function (x, y) { return order[x.type] - order[y.type] || x.start - y.start; });
    var kept = [];
    for (var k = 0; k < amb.length; k++) {
      var dup = kept.some(function (q) { return q.start === amb[k].start && q.end === amb[k].end; });
      if (!dup) kept.push(amb[k]);
    }
    res.findings = kept.map(function (a) {
      return {
        type: a.type, start: a.start, end: a.end,
        fragment: src.slice(a.start, a.end), why: a.why
      };
    });
    if (kept.length) {
      var a0 = kept[0];
      var at = synthAttack(src, a0);
      res.attack = { pump: at.pump, poison: at.poison };
      var corpus = corpusFor(src, a0);
      kept.forEach(function (a) {
        var fix = proposeFix(src, a);
        if (fix) {
          var eq = equivalent(src, fix.fixed, flags, corpus);
          fix.start = a.start; fix.end = a.end;
          fix.equivalent = eq.ok;
          fix.eqReason = eq.reason || null;
          fix.probes = eq.probes || null;
          if (eq.ok) res.fixes.push(fix);
        } else {
          res.fixes.push({
            start: a.start, end: a.end, fixed: null, needsHuman: true,
            rationale: 'This repeated group holds more than one sub-pattern, so collapsing it would change what the expression accepts. Someone who knows the intent has to decide which alternative should win.'
          });
        }
      });
      if (!res.fixes.length) res.fixes.push({ start: a0.start, end: a0.end, fixed: null, needsHuman: true, rationale: 'No automatic rewrite is safe for this pattern. Tighten the quantifiers by hand or move to a linear-time engine.' });
    }
    return res;
  }

  root.RedosEngine = {
    parse: parse, firstSet: firstSet, nullable: nullable, overlaps: overlaps,
    findAmbiguities: findAmbiguities, synthAttack: synthAttack, attackString: attackString,
    classify: classify, measure: measure, ladder: ladder, proposeFix: proposeFix, equivalent: equivalent, analyze: analyze
  };
})(window);
