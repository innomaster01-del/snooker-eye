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

function hullToQuad(hull) {
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
  const edges = P.map((p, i) => ({ i, a: p, b: P[(i + 1) % P.length], len: Math.hypot(P[(i + 1) % P.length].x - p.x, P[(i + 1) % P.length].y - p.y) }));
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
  const quad = hullToQuad(hull);
  if (!quad) return { ok: false, reason: 'quad', hue };
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

// Detect balls. img: ImageData (processing scale), k = procScale (proc = frame*k).
export function detectBalls(img, calib, clothHue, k = 1, hsvIn = null) {
  const { L, W, R } = TABLE;
  const hsv = hsvIn || hsvArrays(img);
  const { H: HH, S, V, w, h } = hsv;
  const Sc = [k, 0, 0, 0, k, 0, 0, 0, 1];
  const Hp = mulH(Sc, calib.H), Hpinv = invH(Hp);
  const Hbp = mulH(Sc, calib.Hb), Hbpinv = invH(Hbp);
  const M = 32;
  // bounding box of the region in proc coords
  const corners = [{ x: -M, y: -M }, { x: L + M, y: -M }, { x: L + M, y: W + M }, { x: -M, y: W + M }].map((p) => applyH(Hp, p));
  // also include lifted corners (ball tops near far cushion)
  const lc = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }].map((p) => applyH(mulH(Sc, liftedH(calib.pose, 2 * R)), p));
  const all = corners.concat(lc);
  const bx0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.x)))), bx1 = Math.min(w - 1, Math.ceil(Math.max(...all.map((p) => p.x))));
  const by0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.y)))), by1 = Math.min(h - 1, Math.ceil(Math.max(...all.map((p) => p.y))));
  if (bx1 <= bx0 || by1 <= by0) return [];
  const mask = new Uint8Array(w * h);
  const inReg = new Uint8Array(w * h);
  const vHist = new Uint32Array(256);
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = Hpinv;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const X = a0 * x + a1 * y + a2, Y = a3 * x + a4 * y + a5, Z = a6 * x + a7 * y + a8;
      const tx = X / Z, ty = Y / Z;
      if (tx < -M || tx > L + M || ty < -M || ty > W + M) continue;
      const i = y * w + x;
      const cloth = S[i] > 50 && V[i] > 14 && hueDiff(HH[i], clothHue) < 26;
      inReg[i] = 1;
      if (!cloth) mask[i] = 1; else vHist[V[i]]++;
    }
  }
  const comps = components(mask, w, h, 4, [bx0, by0, bx1, by1]);
  const pockets = pocketPoints();
  const { data } = img;
  const raw = [];
  for (const comp of comps) {
    let sx = 0, sy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (const p of comp) { const x = p % w, y = (p / w) | 0; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const c = { x: sx / comp.length + 0.5, y: sy / comp.length + 0.5 };
    const tp = applyH(Hbpinv, c);
    const rpx = R * scaleAt(Hp, { x: Math.min(L, Math.max(0, tp.x)), y: Math.min(W, Math.max(0, tp.y)) });
    const A1 = Math.PI * rpx * rpx;
    if (comp.length < 0.33 * A1 || rpx < 1.6) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    let n = Math.max(1, Math.round(comp.length / (A1 * 0.92)));
    if (n > 22) continue; // person / cue / big occluder
    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (n === 1 && elong > 2.2) continue; // cue shaft, rail sliver
    if (n > 1 && comp.length / (bw * bh) < 0.18) continue; // stringy blob
    let groups;
    if (n === 1) groups = [comp];
    else {
      const pts = comp.map((p) => ({ x: p % w, y: (p / w) | 0, i: p }));
      groups = kmeans(pts, n);
    }
    for (const g of groups) {
      if (g.length < 0.3 * A1) continue;
      // colour stats
      let r = 0, gg = 0, b = 0, cnt = 0, gx = 0, gy = 0, dark = 0;
      for (const p of g) {
        gx += p % w; gy += (p / w) | 0;
        const vv = V[p], ss = S[p];
        if (vv < 40) { dark++; continue; }
        if (vv > 235 && ss < 40) continue; // specular highlight
        r += data[p * 4]; gg += data[p * 4 + 1]; b += data[p * 4 + 2]; cnt++;
      }
      const center = { x: gx / g.length + 0.5, y: gy / g.length + 0.5 };
      const t = applyH(Hbpinv, center);
      if (t.x < R - 15 || t.x > L - R + 15 || t.y < R - 15 || t.y > W - R + 15) continue;
      const darkFrac = dark / g.length;
      let lab;
      if (cnt < 3 || darkFrac > 0.7) lab = { L: 10, a: 0, b: 0 };
      else lab = srgbToLab(r / cnt, gg / cnt, b / cnt);
      // pocket holes look like black balls sitting on the cushion line
      let nearPocket = false;
      for (const pk of pockets) if (Math.hypot(pk.x - t.x, pk.y - t.y) < 75) nearPocket = true;
      if (nearPocket && lab.L < 28) continue;
      raw.push({ x: Math.min(L - R, Math.max(R, t.x)), y: Math.min(W - R, Math.max(R, t.y)), lab, img: { x: center.x / k, y: center.y / k }, rpx: rpx / k, area: g.length / A1 });
    }
  }
  const out = classify(raw);
  if (!out.some((b) => b.color === 'green')) {
    const g = findGreenBall(hsv, inReg, vHist, clothHue, Hp, Hbpinv, k, [bx0, by0, bx1, by1]);
    if (g && !out.some((b) => Math.hypot(b.x - g.x, b.y - g.y) < 2 * R)) out.push(g);
  }
  return out;
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

export function classify(raw) {
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
