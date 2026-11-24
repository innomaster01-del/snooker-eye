// Geometry helpers: vectors, homographies, camera pose from a planar rectangle.
// Table coordinates are millimetres on the playing surface (cushion-nose lines):
// x along the length 0..L, y across 0..W, z up.

export const TABLE = {
  L: 3569,          // playing length (mm)
  W: 1778,          // playing width (mm)
  R: 26.25,         // ball radius (mm), 52.5 mm balls
};

export const v = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  len: (a) => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
  perp: (a) => ({ x: -a.y, y: a.x }),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
};

// Distance from point p to segment ab.
export function distPointSeg(p, a, b) {
  const ab = v.sub(b, a);
  const l2 = v.dot(ab, ab);
  if (l2 < 1e-9) return v.dist(p, a);
  let t = v.dot(v.sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return v.dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

// Solve A x = b (n x n) with partial pivoting. Returns null if singular.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Homography (row-major 9 array) mapping src[i] -> dst[i] for 4 points.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: w } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -w * x, -w * y]); b.push(w);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [...h, 1];
}

export function applyH(H, p) {
  const X = H[0] * p.x + H[1] * p.y + H[2];
  const Y = H[3] * p.x + H[4] * p.y + H[5];
  const Z = H[6] * p.x + H[7] * p.y + H[8];
  return { x: X / Z, y: Y / Z };
}

export function invH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const r = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return r.map((x) => x / det);
}

export function mulH(A, B) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return r;
}

// Largest singular value of the 2x2 Jacobian of H at table point p
// (image pixels per table mm, in the most "face-on" direction).
export function scaleAt(H, p) {
  const e = 1;
  const a = applyH(H, p), bx = applyH(H, { x: p.x + e, y: p.y }), by = applyH(H, { x: p.x, y: p.y + e });
  const j11 = bx.x - a.x, j21 = bx.y - a.y, j12 = by.x - a.x, j22 = by.y - a.y;
  const t = j11 * j11 + j12 * j12 + j21 * j21 + j22 * j22;
  const d = j11 * j22 - j12 * j21;
  const s = Math.sqrt(Math.max(0, t * t / 4 - d * d));
  return Math.sqrt(t / 2 + s);
}

const c3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const d3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const n3 = (a) => Math.hypot(a[0], a[1], a[2]);

// Estimate focal length (pixels) from a table->image homography, principal point at (cx, cy).
// Returns { f, residual, ok } where residual measures how well the two
// rectangle constraints agree (0 = perfect).
export function focalFromH(H, cx, cy) {
  // shift principal point to origin
  const T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const G = mulH(T, H);
  const h1 = [G[0], G[3], G[6]], h2 = [G[1], G[4], G[7]];
  const num1 = -(h1[0] * h2[0] + h1[1] * h2[1]);
  const den1 = h1[2] * h2[2];
  const num2 = (h2[0] * h2[0] + h2[1] * h2[1]) - (h1[0] * h1[0] + h1[1] * h1[1]);
  const den2 = h1[2] * h1[2] - h2[2] * h2[2];
  const f1 = Math.abs(den1) > 1e-18 ? num1 / den1 : NaN;
  const f2 = Math.abs(den2) > 1e-18 ? num2 / den2 : NaN;
  const ok1 = f1 > 0 && isFinite(f1), ok2 = f2 > 0 && isFinite(f2);
  if (ok1 && ok2) return { f: Math.sqrt(Math.sqrt(f1 * f2)), residual: Math.abs(Math.log(f1 / f2)), ok: true };
  if (ok1) return { f: Math.sqrt(f1), residual: 1.5, ok: true };
  if (ok2) return { f: Math.sqrt(f2), residual: 1.5, ok: true };
  return { f: NaN, residual: 99, ok: false };
}

// Decompose H = lambda*K[r1 r2 t]; returns pose and a homography for the plane at
// height zh (mm) above the table, i.e. through ball centres when zh = R.
export function poseFromH(H, f, cx, cy) {
  const Ki = (h) => [(h[0] - cx * h[2]) / f, (h[1] - cy * h[2]) / f, h[2]];
  const h1 = Ki([H[0], H[3], H[6]]), h2 = Ki([H[1], H[4], H[7]]), h3 = Ki([H[2], H[5], H[8]]);
  let lam = (n3(h1) + n3(h2)) / 2;
  if (h3[2] / lam < 0) lam = -lam; // table must be in front of the camera
  const r1 = h1.map((x) => x / lam), r2 = h2.map((x) => x / lam), t = h3.map((x) => x / lam);
  let r3 = c3(r1, r2);
  const nr3 = n3(r3) || 1; r3 = r3.map((x) => x / nr3);
  // r3 must point from table towards the camera (camera at origin): r3 . t < 0
  let hand = 1;
  if (d3(r3, t) > 0) { r3 = r3.map((x) => -x); hand = -1; }
  // hand = +1 when (x, y, up) is a right-handed frame in the real world
  return { f, cx, cy, r1, r2, r3, t, hand };
}

export function liftedH(pose, zh) {
  const { f, cx, cy, r1, r2, r3, t } = pose;
  const tt = [t[0] + r3[0] * zh, t[1] + r3[1] * zh, t[2] + r3[2] * zh];
  const K = (c) => [f * c[0] + cx * c[2], f * c[1] + cy * c[2], c[2]];
  const a = K(r1), b = K(r2), c = K(tt);
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

// Camera elevation angle (degrees) above the table plane at the table centre.
export function elevationDeg(pose) {
  const { r1, r2, r3, t } = pose;
  const P = [r1[0] * TABLE.L / 2 + r2[0] * TABLE.W / 2 + t[0], r1[1] * TABLE.L / 2 + r2[1] * TABLE.W / 2 + t[1], r1[2] * TABLE.L / 2 + r2[2] * TABLE.W / 2 + t[2]];
  const toCam = [-P[0], -P[1], -P[2]];
  return Math.asin(Math.min(1, Math.abs(d3(toCam, r3)) / n3(toCam))) * 180 / Math.PI;
}

// Convex hull (monotone chain), points {x,y}; returns CCW hull.
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

export function polyArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

export function lineIntersect(p1, p2, p3, p4) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1.x * p2.y - p1.y * p2.x, b = p3.x * p4.y - p3.y * p4.x;
  return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
}

export function pointInPoly(p, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
