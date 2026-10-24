/*
 * WaveSync core: audio-waveform sync math. Pure JavaScript, no dependencies.
 *
 * Input is mono Float32 PCM at SyncCore.SR (8 kHz) — the panel gets this from ffmpeg.
 * Convention: offset(clip) = time in the REFERENCE file's media at which the clip's
 * media time 0 happens. So "clip starts 12 s into the recorder" => offset = 12.
 *
 * Two passes per clip:
 *   1. Coarse — normalized cross-correlation of 100 Hz log-energy envelopes over the
 *      whole file. Robust to different mics, EQ, gain and room sound.
 *   2. Fine   — GCC-PHAT on the raw 8 kHz waveform in a ±0.5 s window around the
 *      coarse answer, with sub-sample interpolation.
 */
(function (root) {
  'use strict';

  var SR = 8000;
  var HOP = 80;                 // 10 ms envelope frames
  var ENV_RATE = SR / HOP;      // 100 frames per second

  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  var twiddleCache = {};
  function twiddles(n) {
    if (twiddleCache[n]) return twiddleCache[n];
    var h = n >> 1, c = new Float64Array(h), s = new Float64Array(h);
    for (var k = 0; k < h; k++) { c[k] = Math.cos(2 * Math.PI * k / n); s[k] = Math.sin(2 * Math.PI * k / n); }
    twiddleCache = {}; twiddleCache[n] = { c: c, s: s };
    return twiddleCache[n];
  }

  // In-place radix-2 complex FFT. inverse=true gives the unscaled inverse.
  function fft(re, im, inverse) {
    var n = re.length, i, j, bit, t;
    for (i = 1, j = 0; i < n; i++) {
      for (bit = n >> 1; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    var tw = twiddles(n), sign = inverse ? 1 : -1;
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, step = n / len;
      for (i = 0; i < n; i += len) {
        for (var k = 0; k < half; k++) {
          var wr = tw.c[k * step], wi = sign * tw.s[k * step];
          var a = i + k, b = a + half;
          var tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // Spectra of two real signals zero-padded to n.
  function spectra(a, b, n) {
    var ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(a); br.set(b);
    fft(ar, ai, false); fft(br, bi, false);
    return { ar: ar, ai: ai, br: br, bi: bi };
  }

  // c[L mod n] = sum_i a[i+L] * b[i]
  function xcorr(a, b, n) {
    var S = spectra(a, b, n), ar = S.ar, ai = S.ai, br = S.br, bi = S.bi;
    for (var k = 0; k < n; k++) {
      var r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k];
      ar[k] = r; ai[k] = i;
    }
    fft(ar, ai, true);
    for (k = 0; k < n; k++) ar[k] /= n;
    return ar;
  }

  // 100 Hz feature: log energy with the slow trend removed, standardized.
  function envelope(pcm) {
    var n = Math.floor(pcm.length / HOP), e = new Float64Array(n), f, i, mean = 0;
    for (f = 0; f < n; f++) {
      var s = 0, o = f * HOP;
      for (i = 0; i < HOP; i++) s += pcm[o + i] * pcm[o + i];
      e[f] = s / HOP; mean += e[f];
    }
    mean = mean / Math.max(n, 1);
    var floor = mean * 1e-4 + 1e-12;
    for (f = 0; f < n; f++) e[f] = Math.log(Math.max(e[f], floor));

    // subtract a ~1 s moving average
    var cum = new Float64Array(n + 1), W = 50, out = new Float32Array(n);
    for (f = 0; f < n; f++) cum[f + 1] = cum[f] + e[f];
    var m = 0, v = 0;
    for (f = 0; f < n; f++) {
      var lo = Math.max(0, f - W), hi = Math.min(n, f + W + 1);
      out[f] = e[f] - (cum[hi] - cum[lo]) / (hi - lo);
      m += out[f];
    }
    m /= Math.max(n, 1);
    for (f = 0; f < n; f++) { out[f] -= m; v += out[f] * out[f]; }
    var sd = Math.sqrt(v / Math.max(n, 1)) || 1;
    for (f = 0; f < n; f++) {
      var z = out[f] / sd;
      out[f] = z > 4 ? 4 : (z < -4 ? -4 : z);   // clip outliers (bangs, dropouts)
    }
    return out;
  }

  /*
   * Coarse offset between two envelopes.
   * Returns { lag (frames; clip frame i <-> ref frame i+lag), score (NCC 0..1),
   *           ratio (best peak / best peak more than 1 s away), overlap (s) }
   */
  function coarseOffset(refEnv, clipEnv, opts) {
    opts = opts || {};
    var nr = refEnv.length, nc = clipEnv.length;
    if (nr < 50 || nc < 50) return null;
    var n = nextPow2(nr + nc);
    var c = xcorr(refEnv, clipEnv, n);

    var cr = new Float64Array(nr + 1), cc = new Float64Array(nc + 1), i;
    for (i = 0; i < nr; i++) cr[i + 1] = cr[i] + refEnv[i] * refEnv[i];
    for (i = 0; i < nc; i++) cc[i + 1] = cc[i] + clipEnv[i] * clipEnv[i];

    var minOv = Math.min((opts.minOverlapSec || 15) * ENV_RATE, Math.floor(0.6 * Math.min(nr, nc)));
    var Lmin = -(nc - minOv), Lmax = nr - minOv;
    if (Lmax < Lmin) return null;
    var scores = new Float32Array(Lmax - Lmin + 1);
    var best = -Infinity, bestL = 0;
    for (var L = Lmin; L <= Lmax; L++) {
      var lo = Math.max(0, -L), hi = Math.min(nc, nr - L);
      var ec = cc[hi] - cc[lo], er = cr[hi + L] - cr[lo + L];
      var s = c[(L + n) % n] / Math.sqrt(ec * er + 1e-9);
      scores[L - Lmin] = s;
      if (s > best) { best = s; bestL = L; }
    }
    var excl = ENV_RATE, second = 0;
    for (L = Lmin; L <= Lmax; L++) {
      if (Math.abs(L - bestL) <= excl) continue;
      if (scores[L - Lmin] > second) second = scores[L - Lmin];
    }
    var ovFrames = Math.min(nc, nr - bestL) - Math.max(0, -bestL);
    return {
      lag: bestL,
      score: best,
      ratio: second > 0 ? best / second : 99,
      overlap: ovFrames / ENV_RATE
    };
  }

  // Pick the loudest window of winLen samples inside [lo, hi) of pcm.
  function loudestWindow(pcm, lo, hi, winLen) {
    var blk = SR / 2, nb = Math.floor((hi - lo) / blk), wb = Math.max(1, Math.floor(winLen / blk));
    if (nb <= wb) return lo;
    var e = new Float64Array(nb), b, i;
    for (b = 0; b < nb; b++) {
      var s = 0, o = lo + b * blk;
      for (i = 0; i < blk; i++) s += pcm[o + i] * pcm[o + i];
      e[b] = s;
    }
    var run = 0, best = -1, bestB = 0;
    for (b = 0; b < nb; b++) {
      run += e[b];
      if (b >= wb) run -= e[b - wb];
      if (b >= wb - 1 && run > best) { best = run; bestB = b - wb + 1; }
    }
    return lo + bestB * blk;
  }

  /*
   * Fine offset with GCC-PHAT around a coarse sample lag L0.
   * center: optional clip sample position to analyse (for drift checks); default = loudest part.
   * Returns { lag (samples, fractional), sharpness, at (clip seconds analysed) } or null.
   */
  function refineOffset(refPcm, clipPcm, L0, center, opts) {
    opts = opts || {};
    var nr = refPcm.length, nc = clipPcm.length;
    var margin = Math.round((opts.marginSec || 0.5) * SR);
    var lo = Math.max(0, -L0), hi = Math.min(nc, nr - L0);
    if (hi - lo < SR) return null;
    var winLen = Math.min(Math.round((opts.windowSec || 30) * SR), hi - lo);
    var s;
    if (center == null) s = loudestWindow(clipPcm, lo, hi, winLen);
    else s = Math.max(lo, Math.min(hi - winLen, Math.round(center - winLen / 2)));

    var refStart = Math.max(0, s + L0 - margin), refEnd = Math.min(nr, s + L0 + winLen + margin);
    var refSeg = refPcm.subarray(refStart, refEnd), clipSeg = clipPcm.subarray(s, s + winLen);
    var n = nextPow2(refSeg.length + clipSeg.length);
    var S = spectra(refSeg, clipSeg, n), ar = S.ar, ai = S.ai, br = S.br, bi = S.bi;
    var kLo = Math.floor(80 * n / SR), kHi = Math.ceil(3800 * n / SR);
    for (var k = 0; k < n; k++) {
      var kk = k <= n / 2 ? k : n - k;
      if (kk < kLo || kk > kHi) { ar[k] = 0; ai[k] = 0; continue; }
      var r = ar[k] * br[k] + ai[k] * bi[k], im = ai[k] * br[k] - ar[k] * bi[k];
      var mag = Math.sqrt(r * r + im * im) + 1e-12;
      ar[k] = r / mag; ai[k] = im / mag;
    }
    fft(ar, ai, true);

    // refSeg[j + l] ~ clipSeg[j]  =>  L = l + refStart - s
    var lMin = Math.max(0, L0 - margin - refStart + s), lMax = Math.min(n - 1, L0 + margin - refStart + s);
    var best = -1, bestl = lMin, sum = 0, cnt = 0, l;
    for (l = lMin; l <= lMax; l++) {
      var v = Math.abs(ar[l]);
      sum += v; cnt++;
      if (v > best) { best = v; bestl = l; }
    }
    var frac = 0;
    if (bestl > 0 && bestl < n - 1) {
      var ym = Math.abs(ar[bestl - 1]), yp = Math.abs(ar[bestl + 1]), d = ym - 2 * best + yp;
      if (d < 0) frac = 0.5 * (ym - yp) / d;
    }
    return {
      lag: bestl + frac + refStart - s,
      sharpness: best / (sum / Math.max(cnt, 1) + 1e-12),
      at: (s + winLen / 2) / SR
    };
  }

  function classify(c) {
    if (!c) return 'fail';
    if (c.ratio >= 1.3 && c.score >= 0.12) return 'ok';
    if (c.ratio >= 1.12 && c.score >= 0.08) return 'low';
    return 'fail';
  }

  // Full offset of one clip against one reference (both {pcm, env}).
  function syncPair(ref, clip, opts) {
    var c = coarseOffset(ref.env, clip.env, opts);
    var status = classify(c);
    if (status === 'fail') return { status: 'fail', coarse: c };
    var L0 = c.lag * HOP;
    var f = refineOffset(ref.pcm, clip.pcm, L0, null, opts);
    // A real match gives a needle-sharp GCC-PHAT peak (35+ in tests). Unrelated audio sits
    // at 3-6, and retakes of the same script can reach ~9 because the words line up loosely.
    if (!f || f.sharpness < 12) return { status: 'fail', coarse: c, sharpness: f ? f.sharpness : 0 };
    if (f.sharpness < 20) status = 'low';
    var lag = f.lag;
    var out = { status: status, offset: lag / SR, score: c.score, ratio: c.ratio, overlap: c.overlap,
                sharpness: f ? f.sharpness : 0, driftPpm: null };

    // Drift check on long overlaps: measure near both ends of the overlap.
    if (f && c.overlap > 120) {
      var lo = Math.max(0, -L0), hi = Math.min(clip.pcm.length, ref.pcm.length - L0);
      var p1 = lo + 0.1 * (hi - lo), p2 = lo + 0.9 * (hi - lo);
      var w = { windowSec: 10, marginSec: 0.05 };
      var a = refineOffset(ref.pcm, clip.pcm, Math.round(lag), p1, w);
      var b = refineOffset(ref.pcm, clip.pcm, Math.round(lag), p2, w);
      if (a && b && a.sharpness > 4 && b.sharpness > 4 && b.at > a.at)
        out.driftPpm = (b.lag - a.lag) / ((b.at - a.at) * SR) * 1e6;
    }
    return out;
  }

  /*
   * Multi-take sync, PluralEyes style: every file is matched against every other file and
   * the matches are joined into groups ("scenes") — e.g. one camera clip plus its audio take,
   * or a whole multicam podcast. No single master recording is needed.
   *
   * files: [{ id, pcm, env?, audioOnly?, tracks?: ['V1', 'A1', ...] }]
   * Files whose clips all sit on the same single track are treated as one device recording
   * one after another, so they are never matched against each other (retakes of the same
   * script would otherwise look alike).
   */
  function candidatePairs(files) {
    var pairs = [];
    for (var i = 0; i < files.length; i++) {
      for (var j = i + 1; j < files.length; j++) {
        var a = files[i], b = files[j];
        if (a.tracks && b.tracks && a.tracks.length === 1 && b.tracks.length === 1 && a.tracks[0] === b.tracks[0]) continue;
        pairs.push([a, b]);
      }
    }
    return pairs;
  }

  // Edge { a, b, offset (b's media t0 in a's media time), status, score, ratio, sharpness, driftPpm } or null.
  function matchPair(fa, fb, opts) {
    if (!fa.env) fa.env = envelope(fa.pcm);
    if (!fb.env) fb.env = envelope(fb.pcm);
    var swap = fb.pcm.length > fa.pcm.length, ref = swap ? fb : fa, clip = swap ? fa : fb;
    var r = syncPair(ref, clip, opts);
    if (r.status === 'fail') return null;
    r.a = ref.id; r.b = clip.id;
    return r;
  }

  /*
   * Join matched pairs into groups with a maximum spanning forest (strongest matches first).
   * Returns [{ root, members: { id: { offset, status, via, score, ratio, sharpness, driftPpm } } }],
   * where offset is relative to the group's root file. Unmatched files become one-file groups.
   */
  function buildGroups(files, edges) {
    var parent = {}, adj = {};
    files.forEach(function (f) { parent[f.id] = f.id; adj[f.id] = []; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var rank = { ok: 0, low: 1 };
    edges = edges.slice().sort(function (x, y) {
      return (rank[x.status] - rank[y.status]) || (y.sharpness * y.score - x.sharpness * x.score);
    });
    edges.forEach(function (e) {
      var ra = find(e.a), rb = find(e.b);
      if (ra === rb) return;
      parent[ra] = rb;
      adj[e.a].push({ to: e.b, offset: e.offset, e: e });
      adj[e.b].push({ to: e.a, offset: -e.offset, e: e });
    });

    var byId = {}, comps = {};
    files.forEach(function (f) { byId[f.id] = f; var r = find(f.id); (comps[r] = comps[r] || []).push(f); });
    return Object.keys(comps).map(function (k) {
      var list = comps[k], root = null;
      var pool = list.filter(function (f) { return f.audioOnly; });
      if (!pool.length) pool = list;
      pool.forEach(function (f) { if (!root || f.pcm.length > root.pcm.length) root = f; });

      var members = {};
      members[root.id] = { offset: 0, status: list.length > 1 ? 'ref' : 'none', via: null };
      var queue = [root.id];
      while (queue.length) {
        var cur = queue.shift();
        adj[cur].forEach(function (n) {
          if (members[n.to]) return;
          var e = n.e;
          members[n.to] = { offset: members[cur].offset + n.offset, status: e.status, via: cur,
                            score: e.score, ratio: e.ratio, sharpness: e.sharpness, driftPpm: e.driftPpm, overlap: e.overlap };
          queue.push(n.to);
        });
      }
      return { root: root.id, members: members };
    });
  }

  function syncGroups(files, opts) {
    var edges = [];
    candidatePairs(files).forEach(function (p) { var e = matchPair(p[0], p[1], opts); if (e) edges.push(e); });
    return buildGroups(files, edges);
  }

  var SyncCore = {
    SR: SR, HOP: HOP, ENV_RATE: ENV_RATE,
    fft: fft, xcorr: xcorr, envelope: envelope,
    coarseOffset: coarseOffset, refineOffset: refineOffset, syncPair: syncPair,
    candidatePairs: candidatePairs, matchPair: matchPair, buildGroups: buildGroups, syncGroups: syncGroups
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SyncCore;
  root.SyncCore = SyncCore;
})(typeof window !== 'undefined' ? window : this);
