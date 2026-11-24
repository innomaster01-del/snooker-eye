// Computer vision without external libraries: cloth segmentation, table quad,
// homography calibration and ball detection/classification.
import {
  TABLE, homography, applyH, invH, mulH, scaleAt, convexHull, lineIntersect,
  focalFromH, poseFromH, liftedH, elevationDeg, polyArea,
} from './geom.js';

// ---------- colour helpers ----------
function hsvArrays(img) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const H = new Uint16Array(n), S = new Uint8Array(n), V = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = mx - mn;
    V[i] = mx;
    S[i] = mx === 0 ? 0 : Math.round((d * 255) / mx);
    let hh = 0;
    if (d > 0) {
      if (mx === r) hh = 60 * (((g - b) / d) % 6);
      else if (mx === g) hh = 60 * ((b - r) / d + 2);
      else hh = 60 * ((r - g) / d + 4);
      if (hh < 0) hh += 360;
    }
    H[i] = hh | 0;
  }
  return { H, S, V, w, h };
}

const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function srgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return { L: 116 * Y - 16, a: 500 * (X - Y), b: 200 * (Y - Z) };
}

export const BALL_COLORS = ['white', 'red', 'yellow', 'green', 'brown', 'blue', 'pink', 'black'];
export const BALL_VALUE = { red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7, white: 0 };
export const BALL_HEX = {
  white: '#f4f1e6', red: '#d0161d', yellow: '#f2cf1f', green: '#138a3c',
  brown: '#7a4320', blue: '#1f49c4', pink: '#f08aa8', black: '#141414',
};
export const BALL_HE = {
  white: 'לבן', red: 'אדום', yellow: 'צהוב', green: 'ירוק', brown: 'חום', blue: 'כחול', pink: 'ורוד', black: 'שחור',
};
const PROTO = {
  white: { L: 90, a: 0, b: 6 }, black: { L: 12, a: 0, b: 0 }, red: { L: 42, a: 58, b: 40 },
  pink: { L: 68, a: 40, b: 8 }, brown: { L: 33, a: 18, b: 26 }, yellow: { L: 82, a: 2, b: 74 },
  green: { L: 42, a: -38, b: 22 }, blue: { L: 32, a: 14, b: -52 },
};
const CAP = { white: 1, red: 15, yellow: 1, green: 1, brown: 1, blue: 1, pink: 1, black: 1 };

function labDist(p, q) {
  const dL = (p.L - q.L) * 0.55, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ---------- connected components ----------
function components(mask, w, h, minArea, bbox) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  const x0 = bbox ? bbox[0] : 0, y0 = bbox ? bbox[1] : 0, x1 = bbox ? bbox[2] : w - 1, y1 = bbox ? bbox[3] : h - 1;
  let id = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const s = y * w + x;
      if (!mask[s] || lab[s]) continue;
      id++;
      let sp = 0; stack[sp++] = s; lab[s] = id;
      const pix = [];
      while (sp) {
        const p = stack[--sp];
        pix.push(p);
        const px = p % w, py = (p / w) | 0;
        if (px > x0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (px < x1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (py > y0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (py < y1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (pix.length >= minArea) comps.push(pix);
    }
  }
  return comps;
}

// ---------- cloth / table ----------
export function estimateClothHue(hsv) {
  const { H, S, V } = hsv;
  const bins = new Float32Array(72);
  for (let i = 0; i < H.length; i += 2) {
    if (S[i] > 70 && V[i] > 35) bins[(H[i] / 5) | 0] += 1;
  }
  // smooth and look for the strongest peak in green..blue (cloth colours)
  let best = -1, bestV = 0;
  for (let b = 0; b < 72; b++) {
    const hue = b * 5 + 2.5;
    if (hue < 70 || hue > 250) continue;
    const s = bins[(b + 71) % 72] + 2 * bins[b] + bins[(b + 1) % 72];
    if (s > bestV) { bestV = s; best = b; }
  }
  if (best < 0) return null;
  // refine with weighted mean in +-15 deg
  const c = best * 5 + 2.5; let sw = 0, sh = 0;
  for (let b = 0; b < 72; b++) {
    const hue = b * 5 + 2.5;
    if (hueDiff(hue, c) <= 15) { sw += bins[b]; sh += bins[b] * hue; }
  }
  return sw ? sh / sw : c;
}

function clothMask(hsv, hue, tol = 24) {
  const { H, S, V } = hsv;
  const n = H.length, m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (S[i] > 50 && V[i] > 16 && hueDiff(H[i], hue) < tol) m[i] = 1;
  }
  return m;
}

function hullToQuad(hull, w = 1e9, h = 1e9) {
  let P = hull.slice();
  if (P.length < 4) return null;
  const triA = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  while (P.length > 8) {
    let bi = 0, bv = Infinity;
    for (let i = 0; i < P.length; i++) {
      const a = triA(P[(i - 1 + P.length) % P.length], P[i], P[(i + 1) % P.length]);
      if (a < bv) { bv = a; bi = i; }
    }
    P.splice(bi, 1);
  }
  const onB = (p) => (p.x < 2.5 ? 1 : 0) | (p.x > w - 2.5 ? 2 : 0) | (p.y < 1.5 ? 4 : 0) | (p.y > h - 1.5 ? 8 : 0);
  const edges = P.map((p, i) => ({ i, a: p, b: P[(i + 1) % P.length], len: Math.hypot(P[(i + 1) % P.length].x - p.x, P[(i + 1) % P.length].y - p.y) }))
    // edges running along the image border are not table sides (table cut off)
    .filter((e) => !(onB(e.a) & onB(e.b)));
  const top = edges.slice().sort((a, b) => b.len - a.len).slice(0, 4).sort((a, b) => a.i - b.i);
  if (top.length < 4) return null;
  const quad = [];
  for (let k = 0; k < 4; k++) {
    const e1 = top[k], e2 = top[(k + 1) % 4];
    const p = lineIntersect(e1.a, e1.b, e2.a, e2.b);
    if (!p) return null;
    quad.push(p);
  }
  // quad corner k is between edge k and k+1: rotate so corner order follows the hull
  return quad;
}

// Detect the playing-cloth quadrilateral. img = ImageData at processing scale.
// scaleBack converts processing coords to frame coords.
export function detectTable(img, scaleBack = 1, hsvIn = null) {
  const hsv = hsvIn || hsvArrays(img);
  const hue = estimateClothHue(hsv);
  if (hue == null) return { ok: false, reason: 'no-cloth' };
  const { w, h } = hsv;
  const m = clothMask(hsv, hue);
  // light opening: drop isolated pixels
  const comps = components(m, w, h, (w * h) * 0.02);
  if (!comps.length) return { ok: false, reason: 'small', hue };
  let big = comps[0];
  for (const c of comps) if (c.length > big.length) big = c;
  // row extremes -> hull
  const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
  for (const p of big) { const x = p % w, y = (p / w) | 0; if (x < minX[y]) minX[y] = x; if (x > maxX[y]) maxX[y] = x; }
  const pts = [];
  for (let y = 0; y < h; y++) if (maxX[y] >= 0) { pts.push({ x: minX[y], y: y + 0.5 }); pts.push({ x: maxX[y] + 1, y: y + 0.5 }); }
  const hull = convexHull(pts);
  const quad = hullToQuad(hull, w, h);
  if (!quad) return { ok: false, reason: 'cut', hue };
  // must be a convex quadrilateral
  let sgn = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (sgn === 0) sgn = Math.sign(cr); else if (Math.sign(cr) !== sgn) return { ok: false, reason: 'quad', hue };
  }
  const area = Math.abs(polyArea(quad));
  if (area < w * h * 0.04) return { ok: false, reason: 'small', hue };
  for (const p of quad) if (p.x < -w * 0.6 || p.x > w * 1.6 || p.y < -h * 0.6 || p.y > h * 1.6) return { ok: false, reason: 'quad', hue };
  const fill = big.length / area;
  return { ok: true, hue, quad: quad.map((p) => ({ x: p.x * scaleBack, y: p.y * scaleBack })), fill };
}

// Re-order quad b to best match quad a (cyclic shifts and reversal).
export function alignQuad(a, b) {
  let best = b, bd = Infinity;
  for (const rev of [false, true]) {
    const q = rev ? b.slice().reverse() : b;
    for (let s = 0; s < 4; s++) {
      let d = 0;
      for (let i = 0; i < 4; i++) { const p = a[i], r = q[(i + s) % 4]; d += Math.hypot(p.x - r.x, p.y - r.y); }
      if (d < bd) { bd = d; best = [0, 1, 2, 3].map((i) => q[(i + s) % 4]); }
    }
  }
  return { quad: best, dist: bd / 4 };
}

// Build calibration from a quad (frame coords). `margin` = how far outside the
// cushion noses the quad lies (mm), e.g. 45 for auto-detected outer cloth, 0 when
// the user placed corners on the cushion noses. orient: 'auto' | 0 | 1.
export function calibrate(quad, frameW, frameH, margin = 45, orient = 'auto') {
  const { L, W, R } = TABLE, c = margin;
  const rects = [
    [{ x: -c, y: -c }, { x: L + c, y: -c }, { x: L + c, y: W + c }, { x: -c, y: W + c }],
    [{ x: -c, y: -c }, { x: -c, y: W + c }, { x: L + c, y: W + c }, { x: L + c, y: -c }],
  ];
  const cx = frameW / 2, cy = frameH / 2;
  const cand = rects.map((r, k) => {
    const H = homography(r, quad);
    if (!H) return null;
    const fo = focalFromH(H, cx, cy);
    const plausible = fo.ok && fo.f > 0.35 * Math.max(frameW, frameH) && fo.f < 4 * Math.max(frameW, frameH);
    return { k, H, fo, plausible };
  });
  let pick;
  if (orient === 0 || orient === 1) pick = cand[orient];
  else {
    const ok = cand.filter((c2) => c2 && c2.plausible);
    if (ok.length === 2) pick = ok[0].fo.residual <= ok[1].fo.residual ? ok[0] : ok[1];
    else if (ok.length === 1) pick = ok[0];
    if (!pick || (ok.length === 2 && Math.abs(ok[0].fo.residual - ok[1].fo.residual) < 0.05)) {
      // nearly top-down: longer image edges are the long cushions
      const e = (i) => Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].y - quad[i].y);
      pick = (e(0) + e(2) >= e(1) + e(3)) ? cand[0] : cand[1];
    }
  }
  if (!pick) return null;
  const H = pick.H;
  const fDefault = 0.78 * Math.max(frameW, frameH);
  const f = pick.plausible ? pick.fo.f : fDefault;
  const pose = poseFromH(H, f, cx, cy);
  const Hb = liftedH(pose, R);
  // keep Hb consistent with H scale where the pose is poor (top-down): fall back to H
  const elev = elevationDeg(pose);
  return {
    H, Hinv: invH(H), Hb, Hbinv: invH(Hb), pose, f, elev, orient: pick.k, quad, margin, frameW, frameH,
    focalOk: pick.plausible,
  };
}

export function pocketPoints() {
  const { L, W } = TABLE;
  return [
    { x: 0, y: 0, kind: 'corner' }, { x: L / 2, y: 0, kind: 'middle' }, { x: L, y: 0, kind: 'corner' },
    { x: L, y: W, kind: 'corner' }, { x: L / 2, y: W, kind: 'middle' }, { x: 0, y: W, kind: 'corner' },
  ];
}

function kmeans(points, k, iters = 10) {
  // farthest point seeding
  const cents = [points[0]];
  while (cents.length < k) {
    let bp = points[0], bd = -1;
    for (const p of points) {
      let d = Infinity;
      for (const c of cents) d = Math.min(d, (p.x - c.x) ** 2 + (p.y - c.y) ** 2);
      if (d > bd) { bd = d; bp = p; }
    }
    cents.push({ x: bp.x, y: bp.y });
  }
  const asg = new Int32Array(points.length);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < points.length; i++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const d = (points[i].x - cents[j].x) ** 2 + (points[i].y - cents[j].y) ** 2; if (d < bd) { bd = d; bi = j; } }
      asg[i] = bi;
    }
    const sx = new Float64Array(k), sy = new Float64Array(k), sn = new Float64Array(k);
    for (let i = 0; i < points.length; i++) { sx[asg[i]] += points[i].x; sy[asg[i]] += points[i].y; sn[asg[i]]++; }
    for (let j = 0; j < k; j++) if (sn[j]) cents[j] = { x: sx[j] / sn[j], y: sy[j] / sn[j] };
  }
  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < points.length; i++) groups[asg[i]].push(points[i].i);
  return groups.filter((g) => g.length);
}

// Transform helpers: processing image coords = (frame - o) * k
function xfMat(xf) { return [xf.k, 0, -xf.k * xf.ox, 0, xf.k, -xf.k * xf.oy, 0, 0, 1]; }
const toFrame = (p, xf) => ({ x: p.x / xf.k + xf.ox, y: p.y / xf.k + xf.oy });

// Cloth colour model from the table region: chromaticity median + spread.
function clothModel(data, idxs) {
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hs = new Uint32Array(256);
  let n = 0;
  for (let q = 0; q < idxs.length; q += 3) {
    const j = idxs[q] * 4, r = data[j], g = data[j + 1], b = data[j + 2], sm = r + g + b + 1;
    hr[Math.min(255, (r * 255 / sm) | 0)]++; hg[Math.min(255, (g * 255 / sm) | 0)]++; hs[Math.min(255, (sm / 3) | 0)]++; n++;
  }
  const med = (h) => { let a = 0; for (let i = 0; i < 256; i++) { a += h[i]; if (a >= n / 2) return i; } return 128; };
  const mr = med(hr), mg = med(hg), ms = med(hs);
  // spread: median absolute deviation of chroma distance
  const hd = new Uint32Array(256);
  for (let q = 0; q < idxs.length; q += 3) {
    const j = idxs[q] * 4, r = data[j], g = data[j + 1], b = data[j + 2], sm = r + g + b + 1;
    const d = Math.abs(r * 255 / sm - mr) + Math.abs(g * 255 / sm - mg);
    hd[Math.min(255, d | 0)]++;
  }
  const mad = med(hd);
  return { mr, mg, ms, tau: Math.max(9, Math.min(30, mad * 3.2 + 4)) };
}

// Greedy disc fitting: place ball-sized discs where they cover the most blob
// pixels. Separates touching balls and ignores shadow tails.
function fitDiscs(comp, w, minx, miny, bw, bh, rpx) {
  const m = new Uint8Array(bw * bh);
  for (const p of comp) m[(((p / w) | 0) - miny) * bw + (p % w - minx)] = 1;
  const rr = rpx * 0.88, r2 = rr * rr;
  const discA = Math.PI * r2;
  const step = Math.max(1, Math.round(rpx / 3));
  const out = [];
  for (let iter = 0; iter < 18; iter++) {
    let best = null, bc = 0;
    for (let cy = 0; cy < bh; cy += step) for (let cx = 0; cx < bw; cx += step) {
      if (!m[cy * bw + cx]) continue;
      let c = 0;
      for (let y = Math.max(0, Math.round(cy - rr)); y <= Math.min(bh - 1, Math.round(cy + rr)); y++)
        for (let x = Math.max(0, Math.round(cx - rr)); x <= Math.min(bw - 1, Math.round(cx + rr)); x++)
          if (m[y * bw + x] && (x - cx) ** 2 + (y - cy) ** 2 <= r2) c++;
      if (c > bc) { bc = c; best = { x: cx, y: cy }; }
    }
    if (!best || bc < (rpx < 5 ? 0.5 : 0.6) * discA) break;
    // refine to the centroid of covered pixels
    let sx = 0, sy = 0, n = 0;
    for (let y = Math.max(0, Math.round(best.y - rr)); y <= Math.min(bh - 1, Math.round(best.y + rr)); y++)
      for (let x = Math.max(0, Math.round(best.x - rr)); x <= Math.min(bw - 1, Math.round(best.x + rr)); x++)
        if (m[y * bw + x] && (x - best.x) ** 2 + (y - best.y) ** 2 <= r2) { sx += x; sy += y; n++; }
    const c = { x: sx / n, y: sy / n };
    out.push({ x: c.x + minx, y: c.y + miny, cover: bc / discA });
    const er = rpx * 1.15, er2 = er * er;
    for (let y = Math.max(0, Math.floor(c.y - er)); y <= Math.min(bh - 1, Math.ceil(c.y + er)); y++)
      for (let x = Math.max(0, Math.floor(c.x - er)); x <= Math.min(bw - 1, Math.ceil(c.x + er)); x++)
        if ((x - c.x) ** 2 + (y - c.y) ** 2 <= er2) m[y * bw + x] = 0;
  }
  return out;
}

// Detect balls in a processing image (usually a crop around the table).
export function detectBalls(img, calib, xfIn, hsvIn = null, opts = {}) {
  const { L, W, R } = TABLE;
  const xf = typeof xfIn === 'number' ? { k: xfIn, ox: 0, oy: 0 } : xfIn;
  const hsv = hsvIn || hsvArrays(img);
  const { H: HH, S, V, w, h } = hsv;
  const { data } = img;
  const Sc = xfMat(xf);
  const Hp = mulH(Sc, calib.H), Hpinv = invH(Hp);
  const Hbp = mulH(Sc, calib.Hb), Hbpinv = invH(Hbp);
  const M = 30;
  const corners = [{ x: -M, y: -M }, { x: L + M, y: -M }, { x: L + M, y: W + M }, { x: -M, y: W + M }].map((p) => applyH(Hp, p));
  const lc = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }].map((p) => applyH(mulH(Sc, liftedH(calib.pose, 2 * R)), p));
  const all = corners.concat(lc);
  const bx0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.x)))), bx1 = Math.min(w - 1, Math.ceil(Math.max(...all.map((p) => p.x))));
  const by0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.y)))), by1 = Math.min(h - 1, Math.ceil(Math.max(...all.map((p) => p.y))));
  if (bx1 <= bx0 + 4 || by1 <= by0 + 4) return [];
  // 1. region pixels (inside the cushion lines, small margin)
  const inReg = new Uint8Array(w * h);
  const idxs = [];
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = Hpinv;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const X = a0 * x + a1 * y + a2, Y = a3 * x + a4 * y + a5, Z = a6 * x + a7 * y + a8;
    const tx = X / Z, ty = Y / Z;
    if (tx < -M || tx > L + M || ty < -M || ty > W + M) continue;
    const i = y * w + x; inReg[i] = 1; idxs.push(i);
  }
  if (idxs.length < 500) return [];
  const cm = opts.cloth || clothModel(data, idxs);
  // 2. "not cloth" mask by chromaticity (shadows keep the cloth chroma)
  const raw0 = new Uint8Array(w * h);
  const vHist = new Uint32Array(256);
  for (const i of idxs) {
    const j = i * 4, r = data[j], g = data[j + 1], b = data[j + 2], sm = r + g + b + 1;
    const d = Math.abs(r * 255 / sm - cm.mr) + Math.abs(g * 255 / sm - cm.mg);
    const bright = sm / 3;
    // cloth, or a shadow on the cloth (darker, roughly the same colour)
    const cloth = (d < cm.tau && bright > cm.ms * 0.22 && bright < cm.ms * 1.9)
      || (d < cm.tau * 1.6 && bright > cm.ms * 0.38 && bright < cm.ms * 0.92);
    if (!cloth) raw0[i] = 1; else vHist[V[i]]++;
  }
  // 3. morphological opening (cross) to kill sensor noise and thin edges
  const er = new Uint8Array(w * h), mask = new Uint8Array(w * h);
  for (let y = by0 + 1; y < by1; y++) for (let x = bx0 + 1; x < bx1; x++) {
    const i = y * w + x;
    if (raw0[i] && raw0[i - 1] && raw0[i + 1] && raw0[i - w] && raw0[i + w]) er[i] = 1;
  }
  for (let y = by0 + 1; y < by1; y++) for (let x = bx0 + 1; x < bx1; x++) {
    const i = y * w + x;
    if (raw0[i] && (er[i] || er[i - 1] || er[i + 1] || er[i - w] || er[i + w])) mask[i] = 1;
  }
  const comps = components(mask, w, h, 6, [bx0, by0, bx1, by1]);
  const pockets = pocketPoints();
  const raw = [];
  for (const comp of comps) {
    let sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (const p of comp) { const x = p % w, y = (p / w) | 0; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const c = { x: sx / comp.length + 0.5, y: sy / comp.length + 0.5 };
    const tp = applyH(Hbpinv, c);
    const rpx = R * scaleAt(Hp, { x: Math.min(L, Math.max(0, tp.x)), y: Math.min(W, Math.max(0, tp.y)) });
    const dbg = opts.debug && Math.hypot(tp.x - opts.debug.x, tp.y - opts.debug.y) < 150 ? opts.debug.log : null;
    if (dbg) dbg.push({ stage: 'comp', area: comp.length, rpx, bw: maxx - minx + 1, bh: maxy - miny + 1 });
    if (rpx < 2.2) continue; // too far / too small to be reliable
    const A1 = Math.PI * rpx * rpx;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (comp.length < (rpx < 5 ? 0.28 : 0.42) * A1) continue;
    const n = Math.max(1, Math.round(comp.length / (A1 * 0.95)));
    if (n > 18) continue; // hand, arm, cue, chalk box…
    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    const fill = comp.length / (bw * bh);
    if (n === 1 && (elong > 1.8 || fill < 0.5)) continue;
    if (n > 1 && (fill < 0.28 || elong > n + 1.2)) continue;
    const discs = fitDiscs(comp, w, minx, miny, bw, bh, rpx);
    if (dbg) dbg.push({ stage: 'discs', n, elong, fill, discs: discs.length });
    for (const d of discs) {
      // colour from the inner part of the disc (no edges, no shadow)
      let r = 0, gg = 0, b = 0, cnt = 0, dark = 0, tot = 0, dsum = 0;
      const ri = rpx * 0.72;
      for (let y = Math.round(d.y - ri); y <= Math.round(d.y + ri); y++) for (let x = Math.round(d.x - ri); x <= Math.round(d.x + ri); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h || (x - d.x) ** 2 + (y - d.y) ** 2 > ri * ri) continue;
        const p = y * w + x, j = p * 4, rr = data[j], g2 = data[j + 1], bb = data[j + 2], sm = rr + g2 + bb + 1;
        tot++;
        dsum += Math.abs(rr * 255 / sm - cm.mr) + Math.abs(g2 * 255 / sm - cm.mg);
        if (V[p] < 40) { dark++; continue; }
        if (V[p] > 235 && S[p] < 40) continue;
        r += rr; gg += g2; b += bb; cnt++;
      }
      if (!tot) continue;
      const center = { x: d.x + 0.5, y: d.y + 0.5 };
      const t = applyH(Hbpinv, center);
      if (t.x < R - 12 || t.x > L - R + 12 || t.y < R - 12 || t.y > W - R + 12) continue;
      const darkFrac = dark / tot;
      const meanBright = cnt ? (r + gg + b) / (3 * cnt) : 20;
      const contrast = dsum / tot;
      if (dbg) dbg.push({ stage: 'disc', contrast, tau: cm.tau, darkFrac, meanBright, ms: cm.ms, cover: d.cover });
      if (contrast < cm.tau * 1.8 && darkFrac < 0.5 && meanBright < cm.ms * 1.45) continue;
      let lab;
      if (cnt < 3 || darkFrac > 0.6) lab = { L: 10, a: 0, b: 0 };
      else lab = srgbToLab(r / cnt, gg / cnt, b / cnt);
      let nearPocket = false;
      for (const pk of pockets) if (Math.hypot(pk.x - t.x, pk.y - t.y) < 80) nearPocket = true;
      if (nearPocket && lab.L < 30) continue;
      raw.push({
        x: Math.min(L - R, Math.max(R, t.x)), y: Math.min(W - R, Math.max(R, t.y)), lab,
        rgb: cnt ? [r / cnt, gg / cnt, b / cnt] : [20, 20, 20],
        img: toFrame(center, xf), rpx: rpx / xf.k, cover: d.cover,
      });
    }
  }
  const out = classify(raw);
  if (!out.some((b) => b.color === 'green')) {
    const clothHue = opts.clothHue != null ? opts.clothHue : estimateClothHue(hsv);
    if (clothHue != null) {
      const g = findGreenBall(hsv, inReg, vHist, clothHue, Hp, Hbpinv, xf.k, [bx0, by0, bx1, by1]);
      if (g && !out.some((b) => Math.hypot(b.x - g.x, b.y - g.y) < 2 * R)) { g.img = toFrame({ x: g.img.x * xf.k, y: g.img.y * xf.k }, xf); out.push(g); }
    }
  }
  return out;
}

// Look for one ball near a tapped frame point; returns a ball or a best guess.
export function findBallAt(img, calib, xf, framePt) {
  const { R } = TABLE;
  const Sc = xfMat(xf);
  const Hp = mulH(Sc, calib.H), Hbp = mulH(Sc, calib.Hb), Hbpinv = invH(Hbp);
  const p = { x: (framePt.x - xf.ox) * xf.k, y: (framePt.y - xf.oy) * xf.k };
  const t0 = applyH(Hbpinv, p);
  const rpx = Math.max(2, R * scaleAt(Hp, t0));
  const { data, width: w, height: h } = img;
  const rad = Math.ceil(rpx * 2.6);
  const x0 = Math.max(0, Math.round(p.x - rad)), x1 = Math.min(w - 1, Math.round(p.x + rad));
  const y0 = Math.max(0, Math.round(p.y - rad)), y1 = Math.min(h - 1, Math.round(p.y + rad));
  // cloth reference = ring around the search window
  const ring = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > rad * 0.8 && d <= rad) ring.push(y * w + x);
  }
  if (ring.length < 20) return null;
  const cm = clothModel(data, ring.concat(ring, ring));
  // score every candidate centre by how many "non-cloth" pixels a disc of radius rpx covers
  const nc = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
  const ww = x1 - x0 + 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const j = (y * w + x) * 4, r = data[j], g = data[j + 1], b = data[j + 2], sm = r + g + b + 1;
    const d = Math.abs(r * 255 / sm - cm.mr) + Math.abs(g * 255 / sm - cm.mg);
    const br = sm / 3;
    nc[(y - y0) * ww + (x - x0)] = (d > cm.tau * 1.2 || br > cm.ms * 1.5 || br < cm.ms * 0.45) ? 1 : 0;
  }
  let best = null, bs = 0;
  const step = Math.max(1, Math.round(rpx / 4));
  const rr = Math.max(1.5, rpx * 0.9);
  for (let cy = y0 + rr; cy <= y1 - rr; cy += step) for (let cx = x0 + rr; cx <= x1 - rr; cx += step) {
    let inside = 0, tot = 0;
    for (let y = Math.round(cy - rr); y <= Math.round(cy + rr); y++) for (let x = Math.round(cx - rr); x <= Math.round(cx + rr); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > rr * rr) continue;
      tot++; inside += nc[(y - y0) * ww + (x - x0)];
    }
    const dn = Math.hypot(cx - p.x, cy - p.y) / rpx;
    const sc = inside / Math.max(1, tot) - 0.12 * dn * dn;
    if (sc > bs) { bs = sc; best = { x: cx, y: cy }; }
  }
  const found = best && bs > 0.45;
  const c = found ? best : p;
  // colour of the inner disc (skip highlight and very dark pixels unless black)
  let r = 0, g = 0, b = 0, n = 0, dark = 0, tot = 0;
  const ri = rr * 0.75;
  for (let y = Math.round(c.y - ri); y <= Math.round(c.y + ri); y++) for (let x = Math.round(c.x - ri); x <= Math.round(c.x + ri); x++) {
    if (x < 0 || y < 0 || x >= w || y >= h || (x - c.x) ** 2 + (y - c.y) ** 2 > ri * ri) continue;
    const j = (y * w + x) * 4, mx = Math.max(data[j], data[j + 1], data[j + 2]), mn = Math.min(data[j], data[j + 1], data[j + 2]);
    tot++;
    if (mx < 40) { dark++; continue; }
    if (mx > 235 && mx - mn < 40) continue;
    r += data[j]; g += data[j + 1]; b += data[j + 2]; n++;
  }
  const t = applyH(Hbpinv, c);
  let lab = { L: 10, a: 0, b: 0 };
  if (n >= 3 && dark / Math.max(1, tot) < 0.6) {
    let rgb = [r / n, g / n, b / n];
    if (lastWB) rgb = rgb.map((v, i) => Math.min(255, v * lastWB.gain[i] * lastWB.lift));
    lab = srgbToLab(...rgb);
  }
  let bestC = 'red', bd = Infinity;
  for (const col of BALL_COLORS) { const d = labDist(lab, PROTO[col]); if (d < bd) { bd = d; bestC = col; } }
  return { x: t.x, y: t.y, color: bestC, found, img: toFrame(c, xf) };
}

// The green ball has the same hue as the cloth, so it is found as a compact,
// clearly darker cloth-hued blob that carries a specular highlight.
function findGreenBall(hsv, inReg, vHist, clothHue, Hp, Hbpinv, k, bbox) {
  const { L, W, R } = TABLE;
  const { H: HH, S, V, w, h } = hsv;
  let tot = 0; for (let i = 0; i < 256; i++) tot += vHist[i];
  if (!tot) return null;
  let acc = 0, med = 0;
  for (let i = 0; i < 256; i++) { acc += vHist[i]; if (acc >= tot / 2) { med = i; break; } }
  const thr = med * 0.68;
  const m2 = new Uint8Array(w * h);
  for (let y = bbox[1]; y <= bbox[3]; y++) for (let x = bbox[0]; x <= bbox[2]; x++) {
    const i = y * w + x;
    if (inReg[i] && V[i] < thr && V[i] > 12 && S[i] > 90 && hueDiff(HH[i], clothHue) < 40) m2[i] = 1;
  }
  const comps = components(m2, w, h, 4, bbox);
  let best = null, bestScore = 0;
  for (const comp of comps) {
    let sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (const p of comp) { const x = p % w, y = (p / w) | 0; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const c = { x: sx / comp.length + 0.5, y: sy / comp.length + 0.5 };
    const t = applyH(Hbpinv, c);
    if (t.x < R || t.x > L - R || t.y < R || t.y > W - R) continue;
    const rpx = R * scaleAt(Hp, t);
    const A1 = Math.PI * rpx * rpx;
    const ratio = comp.length / A1;
    if (ratio < 0.35 || ratio > 1.6) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 1.8) continue;
    // highlight: bright, low-saturation pixels close to the blob
    let hl = 0;
    const r2 = Math.ceil(rpx * 1.2);
    for (let y = Math.max(0, Math.round(c.y - r2)); y <= Math.min(h - 1, Math.round(c.y + r2)); y++)
      for (let x = Math.max(0, Math.round(c.x - r2)); x <= Math.min(w - 1, Math.round(c.x + r2)); x++) {
        const i = y * w + x;
        if (V[i] > Math.max(200, med * 1.25) && S[i] < 110) hl++;
      }
    if (!hl) continue;
    const score = (1 - Math.abs(1 - ratio)) * (comp.length / (bw * bh));
    if (score > bestScore) { bestScore = score; best = { x: t.x, y: t.y, color: 'green', img: { x: c.x / k, y: c.y / k }, rpx: rpx / k, conf: 0.6 }; }
  }
  return best;
}

let lastWB = null;
export function classify(raw) {
  // white balance from the most likely white ball (bright, neutral)
  let wb = null, wbL = 0;
  for (const bl of raw) {
    if (!bl.rgb) continue;
    const [r, g, b] = bl.rgb, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 120 && (mx - mn) / mx < 0.28 && bl.lab.L > wbL) { wbL = bl.lab.L; wb = bl.rgb; }
  }
  if (wb) {
    const m = (wb[0] + wb[1] + wb[2]) / 3;
    const gain = wb.map((c) => Math.min(1.6, Math.max(0.6, m / Math.max(1, c))));
    const lift = Math.min(1.5, 228 / Math.max(1, m));
    lastWB = { gain, lift };
    for (const bl of raw) if (bl.rgb && bl.lab.L > 12) bl.lab = srgbToLab(...bl.rgb.map((c, i) => Math.min(255, c * gain[i] * lift)));
  }
  // greedy assignment by colour distance with capacities
  const pairs = [];
  raw.forEach((bl, i) => { for (const c of BALL_COLORS) pairs.push({ i, c, d: labDist(bl.lab, PROTO[c]) }); });
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set(), cap = { ...CAP };
  const out = [];
  for (const p of pairs) {
    if (used.has(p.i) || cap[p.c] <= 0) continue;
    if (p.d > 70) continue;
    used.add(p.i); cap[p.c]--;
    const bl = raw[p.i];
    out.push({ x: bl.x, y: bl.y, color: p.c, img: bl.img, rpx: bl.rpx, conf: Math.max(0, 1 - p.d / 70) });
  }
  return out;
}

export { hsvArrays };
