/* engine.js – Neubauer-chamber cell counting engine (pure functions; runs in a Web Worker or on the main thread).
 *
 * Pipeline
 *   1. prepare()      box-downscale the photo by an integer factor and build a "darkness" map that keeps thin outlines
 *   2. findBlock()    locate the 4x4 counting block (a corner square of the chamber) from the ruled grid lines
 *   3. findCells()    cell candidates = bright blobs surrounded by a closed dark outline, scored by a logistic model
 *
 * All coordinates returned by analyze() are in FULL-RESOLUTION image pixels.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ small helpers
  function median(a) { if (!a.length) return 0; const b = Array.from(a).sort((x, y) => x - y); return b[b.length >> 1]; }

  /** Rolling max of array a over window [i, i+len-1]. */
  function rollMax(a, len) {
    const n = a.length, out = new Float32Array(n), dq = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (tail > head && a[dq[tail - 1]] <= a[i]) tail--;
      dq[tail++] = i;
      while (dq[head] > i + len - 1) head++;
      out[i] = a[dq[head]];
    }
    return out;
  }

  // ------------------------------------------------------------------ 1. preparation
  /**
   * Box-downscale full-res RGBA by integer factor f. Also builds dk = darkest min(R,G) of every f*f block so that thin
   * dark cell outlines survive downscaling (min(R,G): yellow cell cores have low blue but are not dark).
   */
  function prepare(rgba, W, H, f) {
    const w = Math.floor(W / f), h = Math.floor(H / f);
    const data = new Uint8ClampedArray(w * h * 4), dk = new Uint8Array(w * h);
    const n = f * f;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, d = 255;
      for (let dy = 0; dy < f; dy++) {
        let o = ((y * f + dy) * W + x * f) * 4;
        for (let dx = 0; dx < f; dx++, o += 4) {
          const R = rgba[o], G = rgba[o + 1]; r += R; g += G; b += rgba[o + 2];
          const m = R < G ? R : G; if (m < d) d = m;
        }
      }
      const i = y * w + x, o2 = i * 4;
      data[o2] = r / n; data[o2 + 1] = g / n; data[o2 + 2] = b / n; data[o2 + 3] = 255; dk[i] = d;
    }
    return { w, h, data, dk, f };
  }

  /** Per-row [xl,xr] extents of the lit disc (the round microscope field of view). */
  function discExtents(rgba, w, h) {
    const xl = new Int16Array(h), xr = new Int16Array(h);
    for (let y = 0; y < h; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; if (rgba[o] + rgba[o + 1] + rgba[o + 2] > 90) { l = x; break; } }
      for (let x = w - 1; x >= 0; x--) { const o = (y * w + x) * 4; if (rgba[o] + rgba[o + 1] + rgba[o + 2] > 90) { r = x; break; } }
      xl[y] = l; xr[y] = r;
    }
    return { xl, xr };
  }

  /** Brightness statistics inside the disc: b0 = background level (median), hi = highlight level (99.5th percentile). */
  function imageStats(P, ext) {
    const hist = new Float64Array(256); let n = 0;
    const { w, h, data } = P;
    for (let y = 0; y < h; y += 2) {
      const l = ext.xl[y], r = ext.xr[y]; if (l < 0 || r < 0) continue;
      for (let x = l + 8; x < r - 8; x += 2) { const o = (y * w + x) * 4; const v = data[o] < data[o + 1] ? data[o] : data[o + 1]; hist[v | 0]++; n++; }
    }
    const pct = f => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= f * n) return v; } return 255; };
    const b0 = pct(0.5), hi = Math.max(pct(0.995), b0 + 60);
    return { b0, hi };
  }

  // ------------------------------------------------------------------ 2. grid / counting block
  // Line thresholds are set from each photo's own brightness (background b0, highlights hi), see gridParams().
  const GRID = { ridgeD: 7, minRun: 70, runGap: 2 };
  function gridParams(st) {
    const range = st.hi - st.b0;
    return Object.assign({}, GRID, { ridgeT: 0.22 * range, ridgeMin: st.b0 + 0.18 * range });   // = 38 and 105 for a typical photo
  }

  function minChannel(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, o = 0; i < w * h; i++, o += 4) { const r = rgba[o], gg = rgba[o + 1], b = rgba[o + 2]; g[i] = r < gg ? (r < b ? r : b) : (gg < b ? gg : b); }
    return g;
  }

  /** Thin bright ridges (grid lines are neutral white; yellow cells have low blue so they drop out), long runs only. */
  function ridgeMap(g, w, h, dir, p) {
    const d = p.ridgeD, T = p.ridgeT, L = p.minRun, gap = p.runGap;
    const m = new Uint8Array(w * h), win = 2 * d + 1;
    if (dir === 'v') {
      for (let y = 0; y < h; y++) {
        const r = y * w; let s = 0;
        for (let x = 0; x < win && x < w; x++) s += g[r + x];
        for (let x = d; x < w - d; x++) { const v = g[r + x]; if (v >= p.ridgeMin && v - s / win >= T) m[r + x] = 1; s += g[r + x + d + 1] - g[r + x - d]; }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = 0; y < win && y < h; y++) s += g[y * w + x];
        for (let y = d; y < h - d; y++) { const v = g[y * w + x]; if (v >= p.ridgeMin && v - s / win >= T) m[y * w + x] = 1; s += g[(y + d + 1) * w + x] - g[(y - d) * w + x]; }
      }
    }
    const wide = new Uint8Array(w * h);
    if (dir === 'v') { for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (m[i - 1] | m[i] | m[i + 1]) wide[i] = 1; } }
    else { for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (m[i - w] | m[i] | m[i + w]) wide[i] = 1; } }
    const out = new Uint8Array(w * h);
    const major = dir === 'v' ? h : w, minor = dir === 'v' ? w : h;
    const stride = dir === 'v' ? w : 1, mstride = dir === 'v' ? 1 : w;
    for (let a = 0; a < minor; a++) {
      let start = -1, last = -1;
      const flush = () => { if (start >= 0 && last - start + 1 >= L) for (let t = start; t <= last; t++) { const i = t * stride + a * mstride; if (m[i]) out[i] = 1; } };
      for (let t = 0; t < major; t++) {
        if (wide[t * stride + a * mstride]) { if (start < 0) start = t; else if (t - last > gap + 1) { flush(); start = t; } last = t; }
      }
      flush();
    }
    return out;
  }

  /** Projection-sharpness score for each tilt angle (degrees). */
  function angleScores(ridge, w, h, dir, rangeDeg, stepDeg) {
    const pts = [];
    for (let i = 0; i < ridge.length; i++) if (ridge[i]) pts.push(i);
    const sub = pts.length > 60000 ? Math.ceil(pts.length / 60000) : 1;
    const scores = [];
    const size = Math.ceil(Math.hypot(w, h)) + 4;
    for (let da = -rangeDeg; da <= rangeDeg + 1e-9; da += stepDeg) {
      const th = da * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const bins = new Float32Array(size);
      for (let k = 0; k < pts.length; k += sub) {
        const x = pts[k] % w, y = (pts[k] / w) | 0;
        const u = dir === 'v' ? x * c + y * s : y * c - x * s;
        bins[Math.round(u) + 2 + (dir === 'v' ? 0 : w)] += 1;
      }
      let sc = 0; for (let b = 0; b < size; b++) { const v = bins[b] + (b > 0 ? bins[b - 1] : 0) + (b < size - 1 ? bins[b + 1] : 0); sc += v * v; }
      scores.push([da, sc]);
    }
    return scores;
  }

  /** Project ridge pixels on the tilted axis; also the visible chord length at each position. */
  function lineProfile(ridge, w, h, dir, deg, ext) {
    const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const off = dir === 'v' ? Math.ceil(h * Math.abs(s)) + 4 : Math.ceil(w * Math.abs(s)) + 4;
    const n = (dir === 'v' ? w : h) + 2 * off;
    const cnt = new Float32Array(n), chord = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!ridge[y * w + x]) continue;
      cnt[Math.round(dir === 'v' ? x * c + y * s : y * c - x * s) + off] += 1;
    }
    for (let y = 0; y < h; y++) {
      const l = ext.xl[y], r = ext.xr[y]; if (l < 0 || r < 0) continue;
      for (let x = l; x <= r; x++) chord[Math.round(dir === 'v' ? x * c + y * s : y * c - x * s) + off] += 1;
    }
    return { cnt, chord, off };
  }

  /** Normalised line coverage s[i] (fraction of the visible chord covered), with peak-hold variants. */
  function coverage(P) {
    const { cnt, chord, off } = P, n = cnt.length;
    const s = new Float32Array(n), pk = new Float32Array(n), pk2 = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) { const c = chord[i]; if (c >= 40) s[i] = (cnt[i - 1] + cnt[i] + cnt[i + 1]) / (c * 3); }
    for (let i = 1; i < n - 1; i++) pk[i] = Math.max(s[i - 1], s[i], s[i + 1]);
    for (let i = 2; i < n - 2; i++) pk2[i] = Math.max(s[i - 2], s[i - 1], s[i], s[i + 1], s[i + 2]);
    return { s, pk, pk2, off, n };
  }

  /**
   * Best 5-line lattice (4 equal squares) of spacing S for every S: five line strengths (one boundary line may be faint),
   * empty gaps between lines, finely ruled neighbour (lines at multiples of S/5) beyond one side, mildly centred.
   */
  function latticeScores(cov, Smin, Smax, centerIdx) {
    const { pk, pk2, n } = cov;
    const best = new Float32Array(Smax + 1).fill(-1e9), arg = new Int32Array(Smax + 1);
    const cap = 0.55;
    for (let S = Smin; S <= Smax; S++) {
      const rm = rollMax(pk, Math.max(3, S - 14)), step = S / 5;
      for (let x0 = 2; x0 + 4 * S < n - 2; x0++) {
        let sum = 0, m1 = 9, m2 = 9, gap = 0;
        for (let k = 0; k < 5; k++) { const v = pk[x0 + k * S]; sum += v < cap ? v : cap; if (v < m1) { m2 = m1; m1 = v; } else if (v < m2) m2 = v; }
        if (m2 < 0.08) continue;
        for (let k = 0; k < 4; k++) gap += rm[x0 + k * S + 7];
        let lo = 0, hi = 0;
        for (let j = 1; j <= 4; j++) {
          const a = Math.round(x0 - j * step), b = Math.round(x0 + 4 * S + j * step);
          if (a >= 2) lo += pk2[a]; if (b < n - 2) hi += pk2[b];
        }
        const sc = sum - gap + 2.0 * Math.min(m2, 0.3) + 1.5 * (Math.max(lo, hi) / 4) - 0.4 * (Math.abs(x0 + 2 * S - centerIdx) / S);
        if (sc > best[S]) { best[S] = sc; arg[S] = x0; }
      }
    }
    return { best, arg };
  }

  function refineLattice(cov, x0, S) {
    const { s } = cov; const ks = [], ps = [];
    for (let k = 0; k < 5; k++) {
      const c = Math.round(x0 + k * S); let b = c, bv = -1;
      for (let d = -4; d <= 4; d++) { const v = s[c + d] || 0; if (v > bv) { bv = v; b = c + d; } }
      if (bv >= 0.12) { ks.push(k); ps.push(b); }
    }
    if (ks.length < 3) return { x0, S };
    let sk = 0, sp = 0, skk = 0, skp = 0; const n = ks.length;
    for (let i = 0; i < n; i++) { sk += ks[i]; sp += ps[i]; skk += ks[i] * ks[i]; skp += ks[i] * ps[i]; }
    const S2 = (n * skp - sk * sp) / (n * skk - sk * sk);
    return { x0: (sp - S2 * sk) / n, S: S2 };
  }

  /**
   * Find the 4x4 counting block in the work image P. Returns null if no convincing lattice is found, else
   * {theta, u0, v0, Su, Sv, S, score} with the grid frame rotated by theta:  u = x cos + y sin,  v = -x sin + y cos.
   */
  function findBlock(P, ext, st) {
    const { w, h, data } = P;
    const g = minChannel(data, w, h), gp = gridParams(st || imageStats(P, ext));
    const rv = ridgeMap(g, w, h, 'v', gp), rh = ridgeMap(g, w, h, 'h', gp);
    const sv = angleScores(rv, w, h, 'v', 3, 0.1), sh = angleScores(rh, w, h, 'h', 3, 0.1);
    const mv = Math.max(...sv.map(s => s[1])) || 1, mh = Math.max(...sh.map(s => s[1])) || 1;
    let deg = 0, bs = -1;
    for (let i = 0; i < sv.length; i++) { const sc = sv[i][1] / mv + sh[i][1] / mh; if (sc > bs) { bs = sc; deg = sv[i][0]; } }
    const cx = coverage(lineProfile(rv, w, h, 'v', deg, ext)), cy = coverage(lineProfile(rh, w, h, 'h', deg, ext));
    const Smin = Math.round(Math.min(w, h) * 0.04), Smax = Math.round(Math.min(w, h) * 0.24);
    let sx = 0, sy = 0, sn = 0;
    for (let y = 0; y < h; y++) if (ext.xl[y] >= 0 && ext.xr[y] >= 0) { sx += (ext.xl[y] + ext.xr[y]) / 2; sy += y; sn++; }
    const th = deg * Math.PI / 180, tc = Math.cos(th), ts = Math.sin(th), dcx = sx / sn, dcy = sy / sn;
    const lx = latticeScores(cx, Smin, Smax, dcx * tc + dcy * ts + cx.off);
    const ly = latticeScores(cy, Smin, Smax, -dcx * ts + dcy * tc + cy.off);
    let top = -1e9; const tot = [];
    for (let S = Smin; S <= Smax; S++) { const t = lx.best[S] + ly.best[S]; tot.push([S, t]); if (t > top) top = t; }
    if (top < 2.5) return null;                       // nothing grid-like found
    let chosen = null;
    for (const [S, t] of tot) if (t >= 0.82 * top) chosen = S;   // finest centre-grid also scores well: prefer the largest S
    let bestS = chosen, bt = -1e9;
    for (const [S, t] of tot) if (Math.abs(S - chosen) <= 3 && t > bt) { bt = t; bestS = S; }
    const rx = refineLattice(cx, lx.arg[bestS], bestS), ry = refineLattice(cy, ly.arg[bestS], bestS);
    return { theta: th, thetaDeg: deg, u0: rx.x0 - cx.off, Su: rx.S, v0: ry.x0 - cy.off, Sv: ry.S, S: bestS, score: bt };
  }

  // ------------------------------------------------------------------ 3. cells
  // Logistic model (10 features) trained on hand-annotated Neubauer photos; see tools/ for the training harness.
  const MODEL = {
    feats: ['closure', 'rMean', 'rSd', 'inner', 'darkFrac', 'sd', 'nbr', 'yel', 'halo', 'ringDark'],
    mean: [0.9402, 4.5125, 1.142, 0.6769, 0.352, 0.3821, 2.2382, 0.1783, 0.2034, 0.2789],
    sd: [0.1062, 0.7396, 0.5073, 0.2994, 0.1668, 0.0634, 2.5862, 0.3106, 0.1568, 0.2064],
    w: [0.0199, 0.0684, -0.3795, 0.212, -0.8542, 0.1889, -0.9371, 0.2908, 0.4708, -0.7291],
    b: -0.7689,
  };

  /**
   * Cell candidates in the work image. k = S / 143.5 rescales all pixel-size parameters (tuned for S = 143.5 px).
   * Each candidate: {x, y, p (cell probability), rMean, ...features}
   */
  function findCells(P, ext, st, k) {
    const { w, h, data, dk } = P, n = w * h;
    const range = st.hi - st.b0;
    const seedBr = st.b0 + 0.28 * range, dark = 0.78 * st.b0;
    const br = new Float32Array(n), yl = new Float32Array(n);
    for (let i = 0; i < n; i++) { const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]; br[i] = r < g ? r : g; yl[i] = br[i] - b; }
    const II = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += br[y * w + x]; II[(y + 1) * (w + 1) + x + 1] = II[y * (w + 1) + x + 1] + row; } }
    const box = (x, y, r) => { const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
      return (II[y1 * (w + 1) + x1] - II[y0 * (w + 1) + x1] - II[y1 * (w + 1) + x0] + II[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0)); };
    const rb = Math.max(1, Math.round(2 * k)), sw = Math.max(2, Math.round(3 * k));
    const r0 = 2.5 * k, r1 = 9 * k, margin = Math.ceil(r1) + 3;
    const bm = new Float32Array(n);
    for (let y = rb; y < h - rb; y++) for (let x = rb; x < w - rb; x++) bm[y * w + x] = box(x, y, rb);
    const seeds = [];
    for (let y = margin; y < h - margin; y++) {
      const l = ext.xl[y], r = ext.xr[y]; if (l < 0 || r < 0) continue;
      for (let x = Math.max(margin, l); x < Math.min(w - margin, r); x++) {
        const v = bm[y * w + x]; if (v < seedBr) continue;
        let ok = true;
        for (let dy = -sw; dy <= sw && ok; dy++) for (let dx = -sw; dx <= sw; dx++) if (bm[(y + dy) * w + x + dx] > v) { ok = false; break; }
        if (ok) seeds.push([x, y]);
      }
    }
    const NR = 24, cs = [], sn = [];
    for (let a = 0; a < NR; a++) { cs.push(Math.cos(2 * Math.PI * a / NR)); sn.push(Math.sin(2 * Math.PI * a / NR)); }
    const evalAt = (cx, cy) => {
      let closed = 0, sumMin = 0; const radii = [];
      for (let a = 0; a < NR; a++) {
        let m = 255, mr = 0;
        for (let r = r0; r <= r1; r += 0.5) { const v = dk[Math.round(cy + r * sn[a]) * w + Math.round(cx + r * cs[a])]; if (v < m) { m = v; mr = r; } }
        sumMin += m; if (m <= dark) { closed++; radii.push(mr); }
      }
      let mean = 0; for (const r of radii) mean += r; mean = radii.length ? mean / radii.length : 0;
      let sd = 0; for (const r of radii) sd += (r - mean) ** 2; sd = radii.length ? Math.sqrt(sd / radii.length) : 3 * k;
      return { closure: closed / NR, rMean: mean / k, rSd: sd / k, ringDark: sumMin / NR / st.b0 };
    };
    let cand = [];
    for (const [x, y] of seeds) {
      let best = null;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const e = evalAt(x + dx, y + dy), sc = e.closure - 0.05 * e.rSd;
        if (!best || sc > best.sc) best = Object.assign({ sc, x: x + dx, y: y + dy }, e);
      }
      if (best.closure < 0.6 || best.rSd > 2.5 || best.rMean < 2.5 || best.rMean > 8.5) continue;
      best.inner = (box(best.x, best.y, Math.max(1, Math.round(k))) - st.b0) / range;
      cand.push(best);
    }
    cand.sort((a, b) => b.closure - a.closure || a.rSd - b.rSd);
    const kept = [], nms = 6 * k;
    for (const c of cand) if (!kept.some(q => Math.hypot(q.x - c.x, q.y - c.y) < nms)) kept.push(c);
    const R10 = Math.round(10 * k);
    for (const c of kept) {
      let dkc = 0, tot = 0, s = 0, s2 = 0, yy = 0, ny = 0, halo = 0, nh = 0;
      for (let dy = -R10; dy <= R10; dy++) for (let dx = -R10; dx <= R10; dx++) {
        const d2 = (dx * dx + dy * dy) / (k * k); if (d2 > 100) continue;
        const x = c.x + dx, y = c.y + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x; tot++; if (dk[i] <= dark) dkc++; s += br[i]; s2 += br[i] * br[i];
        if (d2 <= 9) { yy += yl[i]; ny++; }
        if (d2 >= 49 && d2 <= 81) { halo += br[i]; nh++; }
      }
      c.darkFrac = dkc / tot;
      const m = s / tot; c.sd = Math.sqrt(Math.max(0, s2 / tot - m * m)) / range;
      c.yel = (ny ? yy / ny : 0) / range; c.halo = ((nh ? halo / nh : st.b0) - st.b0) / range;
      let nb = 0; for (const q of kept) if (q !== c && Math.hypot(q.x - c.x, q.y - c.y) < 24 * k) nb++;
      c.nbr = nb;
    }
    for (const c of kept) {
      let z = MODEL.b;
      for (let j = 0; j < MODEL.feats.length; j++) z += MODEL.w[j] * (c[MODEL.feats[j]] - MODEL.mean[j]) / MODEL.sd[j];
      c.p = 1 / (1 + Math.exp(-z));
    }
    return kept;
  }

  // ------------------------------------------------------------------ orchestration
  /**
   * analyze({data,w,h}) -> { f, work:{w,h}, block|null, cells:[{x,y,p,r}], stats }   (x,y,r in full-res pixels)
   * progress(label, fraction) is optional.
   */
  function analyze(full, progress) {
    const tell = (s, f) => { if (progress) progress(s, f); };
    const t0 = Date.now();
    tell('Preparing image', 0.05);
    // pick the downscale so that the grid spacing lands near 143 work px (first guess: ~2000 px wide work image)
    let f = Math.max(1, Math.round(full.w / 2016));
    let P = prepare(full.data, full.w, full.h, f);
    let ext = discExtents(P.data, P.w, P.h), st = imageStats(P, ext);
    tell('Finding the counting grid', 0.3);
    let block = findBlock(P, ext, st);
    if (block) {
      const Sfull = block.S * f, f2 = Math.max(1, Math.round(Sfull / 143.5));   // aim for ~143 work px per grid square
      if (f2 !== f) {                                   // different magnification: redo at the matching scale
        f = f2; P = prepare(full.data, full.w, full.h, f); ext = discExtents(P.data, P.w, P.h); st = imageStats(P, ext);
        block = findBlock(P, ext, st);
      }
    }
    const k = block ? Math.min(2, Math.max(0.5, block.S / 143.5)) : 1;
    tell('Detecting cells', 0.6);
    const cells = findCells(P, ext, st, k).map(c => ({
      x: (c.x + 0.5) * f, y: (c.y + 0.5) * f, p: c.p, r: Math.max(5, (c.rMean + 1.2) * k) * f,
    }));
    tell('Done', 1);
    return {
      f, work: { w: P.w, h: P.h }, stats: st, k, ms: Date.now() - t0,
      block: block ? {
        theta: block.theta, u0: block.u0 * f, v0: block.v0 * f, Su: block.Su * f, Sv: block.Sv * f, score: block.score,
        corners: blockCorners(block, f),
      } : null,
      cells,
    };
  }

  /** Corners (TL,TR,BR,BL) of the block in full-res px. */
  function blockCorners(B, f) {
    const c = Math.cos(B.theta), s = Math.sin(B.theta);
    const to = (u, v) => ({ x: (u * c - v * s) * f, y: (u * s + v * c) * f });
    return [to(B.u0, B.v0), to(B.u0 + 4 * B.Su, B.v0), to(B.u0 + 4 * B.Su, B.v0 + 4 * B.Sv), to(B.u0, B.v0 + 4 * B.Sv)];
  }

  // ------------------------------------------------------------------ geometry for the UI
  /** Homography mapping unit square -> quad (TL,TR,BR,BL) and its inverse (Heckbert). */
  function quadHomography(q) {
    const [p0, p1, p2, p3] = q;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    let a, b, c, d, e, f, g, hh;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) { a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x; d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y; g = 0; hh = 0; }
    else {
      const den = dx1 * dy2 - dx2 * dy1;
      g = (dx3 * dy2 - dx2 * dy3) / den; hh = (dx1 * dy3 - dx3 * dy1) / den;
      a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + hh * p3.x; c = p0.x;
      d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + hh * p3.y; f = p0.y;
    }
    // forward: (s,t)->(x,y) with  x=(a s + b t + c)/(g s + hh t + 1); matrix M=[[a,b,c],[d,e,f],[g,hh,1]]
    const M = [a, b, c, d, e, f, g, hh, 1];
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    const inv = [
      (M[4] * M[8] - M[5] * M[7]) / det, (M[2] * M[7] - M[1] * M[8]) / det, (M[1] * M[5] - M[2] * M[4]) / det,
      (M[5] * M[6] - M[3] * M[8]) / det, (M[0] * M[8] - M[2] * M[6]) / det, (M[2] * M[3] - M[0] * M[5]) / det,
      (M[3] * M[7] - M[4] * M[6]) / det, (M[1] * M[6] - M[0] * M[7]) / det, (M[0] * M[4] - M[1] * M[3]) / det,
    ];
    return { M, inv };
  }
  /** (x,y) in image -> (s,t) in the block's unit square (0..1 inside). */
  function locate(H, x, y) {
    const m = H.inv, w = m[6] * x + m[7] * y + m[8];
    return { s: (m[0] * x + m[1] * y + m[2]) / w, t: (m[3] * x + m[4] * y + m[5]) / w };
  }
  /** (s,t) -> (x,y). */
  function place(H, s, t) {
    const m = H.M, w = m[6] * s + m[7] * t + m[8];
    return { x: (m[0] * s + m[1] * t + m[2]) / w, y: (m[3] * s + m[4] * t + m[5]) / w };
  }

  root.CellEngine = { analyze, prepare, discExtents, imageStats, findBlock, findCells, blockCorners, quadHomography, locate, place, MODEL, median };
})(typeof self !== 'undefined' ? self : globalThis);
