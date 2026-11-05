/* ReDoS measurement worker.
   Runs the timing ladder off the main thread so a pattern bad enough to hang the
   engine hangs a worker the page can discard, instead of freezing the tab. */
self.onmessage = function (e) {
  var d = e.data || {};
  var re;
  try { re = new RegExp(d.src, d.flags || ''); }
  catch (err) { self.postMessage({ type: 'error', error: 'pattern rejected: ' + err.message }); return; }

  var now = function () { return performance.now(); };

  function measure(s, budgetMs, trials) {
    budgetMs = budgetMs || 12; trials = trials || 3;
    var best = Infinity, bestReps = 1;
    for (var t = 0; t < trials; t++) {
      var reps = 1, total = 0, t0;
      t0 = now();
      try { re.test(s); } catch (err2) { return { ms: 0, reps: 1, error: err2.message }; }
      total = now() - t0;
      if (total <= 0) reps = 20000;
      else if (total < budgetMs) reps = Math.min(200000, Math.max(2, Math.ceil(budgetMs / total)));
      if (reps > 1) {
        t0 = now();
        for (var i = 0; i < reps; i++) { try { re.test(s); } catch (err3) { return { ms: 0, reps: reps, error: err3.message }; } }
        total = now() - t0;
      }
      var per = total / reps;
      if (per < best) { best = per; bestReps = reps; }
    }
    return { ms: best === Infinity ? 0 : best, reps: bestReps };
  }

  /* Same adaptive ladder as the engine: grow n geometrically until a match costs
     enough that the ratio between the last two steps means something. A fixed
     ladder would under-measure every linear pattern, because at a few dozen
     characters a linear match is far below the clock. */
  function ladder(build, maxN, maxSteps, stopMs) {
    var points = [], n = 4, factor = 2;
    for (var s = 0; s < maxSteps && n <= maxN; s++) {
      var m = measure(build(n));
      points.push({ n: n, ms: m.ms, reps: m.reps });
      if ((m.ms >= stopMs && points.length >= 3) || n >= maxN) break;
      n = Math.min(maxN, Math.ceil(n * factor));
      factor = factor < 4 ? factor + 0.5 : 4;
    }
    return points;
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

  var a = d.attack || { pump: 'a', poison: 'X' };
  var build = function (n) { return a.pump.repeat(n) + a.poison; };

  var points = ladder(build, d.maxN || 200000, d.maxSteps || 16, d.stopMs || 1.5);
  self.postMessage({ type: 'done', points: points, verdict: classify(points) });
};
