// Shot engine: direct pots, banks (object off a cushion), kicks (cue ball off one
// or two cushions), two-ball combinations, cue-ball path with spin, success odds
// and snooker "ball on" logic. All units mm, mm/s.
import { TABLE, v, distPointSeg } from './geom.js';
import { BALL_VALUE } from './vision.js';

const { L, W, R } = TABLE;
const D2 = 2 * R;
const G = 9810, MU_S = 0.2, MU_R = 0.012, A_R = MU_R * G, E_CUSH = 0.72;
export const POWER_DIST = [0, 600, 1500, 3000, 5000, 8000]; // free rolling distance per power level
const speedFor = (p) => Math.sqrt(2 * A_R * POWER_DIST[p]);

export const SPIN_HE = { follow: 'עליון (follow)', stun: 'סטופ (stun)', draw: 'אחורי (draw)' };
export const COLOR_ORDER = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];

const CUSHIONS = [
  { axis: 'y', v: R, from: 0, to: L, long: true, name: 'bottom' },
  { axis: 'y', v: W - R, from: 0, to: L, long: true, name: 'top' },
  { axis: 'x', v: R, from: 0, to: W, long: false, name: 'left' },
  { axis: 'x', v: L - R, from: 0, to: W, long: false, name: 'right' },
];

export const POCKETS = [
  { id: 0, x: 0, y: 0, kind: 'corner', aim: { x: -14, y: -14 } },
  { id: 1, x: L / 2, y: 0, kind: 'middle', aim: { x: L / 2, y: -28 } },
  { id: 2, x: L, y: 0, kind: 'corner', aim: { x: L + 14, y: -14 } },
  { id: 3, x: L, y: W, kind: 'corner', aim: { x: L + 14, y: W + 14 } },
  { id: 4, x: L / 2, y: W, kind: 'middle', aim: { x: L / 2, y: W + 28 } },
  { id: 5, x: 0, y: W, kind: 'corner', aim: { x: -14, y: W + 14 } },
];

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

const mirror = (p, c) => (c.axis === 'x' ? { x: 2 * c.v - p.x, y: p.y } : { x: p.x, y: 2 * c.v - p.y });

function hitCushion(a, b, c) {
  // intersection of segment a->b with cushion line c
  const ka = c.axis === 'x' ? a.x : a.y, kb = c.axis === 'x' ? b.x : b.y;
  if ((ka - c.v) * (kb - c.v) > 0 || ka === kb) return null;
  const t = (c.v - ka) / (kb - ka);
  const p = v.lerp(a, b, t);
  const along = c.axis === 'x' ? p.y : p.x;
  // stay clear of pocket mouths
  if (along < 110 || along > c.to - 110) return null;
  if (c.long && Math.abs(along - L / 2) < 90) return null;
  return p;
}

function segClear(a, b, balls, ignore, r = D2 - 0.5) {
  for (const bl of balls) {
    if (ignore.includes(bl.id)) continue;
    if (distPointSeg(bl, a, b) < r) return false;
  }
  return true;
}

function onTable(p, m = R) { return p.x >= m - 0.5 && p.x <= L - m + 0.5 && p.y >= m - 0.5 && p.y <= W - m + 0.5; }

// Effective half-tolerance (mm, lateral) for a ball arriving at pocket with direction u.
function pocketTolerance(pk, u) {
  if (pk.kind === 'corner') {
    const diag = v.norm({ x: pk.x === 0 ? -1 : 1, y: pk.y === 0 ? -1 : 1 });
    const cosA = v.dot(u, diag);
    const ang = Math.acos(Math.min(1, Math.max(-1, cosA))) * 180 / Math.PI;
    if (ang > 52) return 0;
    return Math.max(5, 30 * Math.cos(ang * Math.PI / 180) - (ang > 40 ? 8 : 0));
  }
  const n = { x: 0, y: pk.y === 0 ? -1 : 1 };
  const cosB = v.dot(u, n);
  const ang = Math.acos(Math.min(1, Math.max(-1, cosB))) * 180 / Math.PI;
  if (ang > 60) return 0;
  return Math.max(4, 36 * Math.cos(ang * Math.PI / 180));
}

export function thicknessLabel(cutDeg) {
  const f = 1 - Math.sin(cutDeg * Math.PI / 180);
  if (f > 0.9) return 'מלא';
  if (f > 0.62) return '¾ כדור';
  if (f > 0.38) return '½ כדור';
  if (f > 0.17) return '¼ כדור';
  return 'דק מאוד';
}

// Simulate the cue ball after contact. Returns path & end state.
export function simulateCue(start, vel0, spin0, balls, ignore, side0 = 0) {
  let p = { ...start }, vel = { ...vel0 }, w = { ...spin0 }, ws = side0;
  const path = [{ ...p }];
  const dt = 0.004;
  let last = { ...p }, scratch = null, kiss = null, cushions = 0;
  for (let step = 0; step < 6000; step++) {
    const slip = v.sub(vel, w);
    const sl = v.len(slip);
    if (sl > 4) {
      const sh = v.mul(slip, 1 / sl);
      const dv = MU_S * G * dt;
      if (3.5 * dv >= sl) { const f = v.add(v.mul(vel, 5 / 7), v.mul(w, 2 / 7)); vel = f; w = { ...f }; }
      else { vel = v.sub(vel, v.mul(sh, dv)); w = v.add(w, v.mul(sh, 2.5 * dv)); }
    } else {
      const sp = v.len(vel);
      const ns = Math.max(0, sp - A_R * dt);
      vel = sp > 0 ? v.mul(vel, ns / sp) : vel; w = { ...vel };
    }
    p = v.add(p, v.mul(vel, dt));
    // pockets
    for (const pk of POCKETS) {
      const near = pk.kind === 'corner'
        ? (Math.abs(p.x - pk.x) < R + 30 && Math.abs(p.y - pk.y) < R + 30 && Math.hypot(p.x - pk.x, p.y - pk.y) < 70)
        : (Math.abs(p.x - pk.x) < 42 && Math.abs(p.y - pk.y) < R + 4);
      if (near) { scratch = pk.id; break; }
    }
    if (scratch != null) { path.push({ ...p }); break; }
    // cushions
    let bounced = false, n = null;
    if (p.x < R) { p.x = 2 * R - p.x; vel.x = -vel.x * E_CUSH; w.x = -w.x * E_CUSH; vel.y *= 0.92; bounced = true; n = { x: 1, y: 0 }; }
    if (p.x > L - R) { p.x = 2 * (L - R) - p.x; vel.x = -vel.x * E_CUSH; w.x = -w.x * E_CUSH; vel.y *= 0.92; bounced = true; n = { x: -1, y: 0 }; }
    if (p.y < R) { p.y = 2 * R - p.y; vel.y = -vel.y * E_CUSH; w.y = -w.y * E_CUSH; vel.x *= 0.92; bounced = true; n = { x: 0, y: 1 }; }
    if (p.y > W - R) { p.y = 2 * (W - R) - p.y; vel.y = -vel.y * E_CUSH; w.y = -w.y * E_CUSH; vel.x *= 0.92; bounced = true; n = { x: 0, y: -1 }; }
    if (bounced) {
      // side spin grips the cushion: tangential kick along z x n, then most of it is used up
      if (n && Math.abs(ws) > 1) {
        const tz = { x: -n.y, y: n.x };
        const kick = v.mul(tz, 0.28 * ws);
        vel = v.add(vel, kick); w = v.add(w, kick);
        ws *= 0.45;
      }
      cushions++; path.push({ ...p }); last = { ...p };
    }
    ws *= Math.exp(-dt / 3);
    // other balls
    for (const bl of balls) {
      if (ignore.includes(bl.id)) continue;
      if (Math.hypot(bl.x - p.x, bl.y - p.y) < D2) { kiss = bl.id; break; }
    }
    if (kiss != null) { path.push({ ...p }); break; }
    if (Math.hypot(p.x - last.x, p.y - last.y) > 25) { path.push({ ...p }); last = { ...p }; }
    if (v.len(vel) < 6 && sl <= 4) break;
  }
  if (path.length < 2 || v.dist(path[path.length - 1], p) > 0.5) path.push({ ...p });
  return { path, end: p, scratch, kiss, cushions };
}

// ---------- shot generation ----------
function cueRoutes(C, Gh, balls, ignore, maxCush) {
  const routes = [];
  if (segClear(C, Gh, balls, ignore)) routes.push({ pts: [C, Gh], cush: 0 });
  if (maxCush >= 1) {
    for (const c of CUSHIONS) {
      const Gm = mirror(Gh, c);
      const B = hitCushion(C, Gm, c);
      if (!B) continue;
      if (segClear(C, B, balls, ignore) && segClear(B, Gh, balls, ignore)) routes.push({ pts: [C, B, Gh], cush: 1 });
    }
  }
  if (maxCush >= 2) {
    for (const c1 of CUSHIONS) for (const c2 of CUSHIONS) {
      if (c1 === c2) continue;
      const Gmm = mirror(mirror(Gh, c2), c1);
      const B1 = hitCushion(C, Gmm, c1);
      if (!B1) continue;
      const B2 = hitCushion(B1, mirror(Gh, c2), c2);
      if (!B2) continue;
      if (segClear(C, B1, balls, ignore) && segClear(B1, B2, balls, ignore) && segClear(B2, Gh, balls, ignore)) routes.push({ pts: [C, B1, B2, Gh], cush: 2 });
    }
  }
  return routes;
}

function ghostOk(Gh, balls, ignore) {
  if (!onTable(Gh)) return false;
  for (const bl of balls) if (!ignore.includes(bl.id) && Math.hypot(bl.x - Gh.x, bl.y - Gh.y) < D2 - 1) return false;
  return true;
}

function pathLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += v.dist(pts[i - 1], pts[i]); return s; }

// Object-ball routes from O to each pocket: direct or one-cushion bank.
function objectRoutes(O, balls, ignore, allowBank) {
  const out = [];
  for (const pk of POCKETS) {
    const T = pk.aim;
    const u = v.norm(v.sub(T, O));
    const tol = pocketTolerance(pk, u);
    if (tol > 0 && segClear(O, T, balls, ignore)) out.push({ pocket: pk, pts: [O, T], u, tol, cush: 0, dist: v.dist(O, T) });
    if (!allowBank) continue;
    for (const c of CUSHIONS) {
      const Tm = mirror(T, c);
      const B = hitCushion(O, Tm, c);
      if (!B) continue;
      const u2 = v.norm(v.sub(T, B));
      const tol2 = pocketTolerance(pk, u2);
      if (tol2 <= 0) continue;
      if (!segClear(O, B, balls, ignore) || !segClear(B, T, balls, ignore)) continue;
      out.push({ pocket: pk, pts: [O, B, T], u: v.norm(v.sub(B, O)), tol: tol2, cush: 1, dist: v.dist(O, B) + v.dist(B, T) });
    }
  }
  return out;
}

function cutOf(dIn, u) {
  const c = Math.max(-1, Math.min(1, v.dot(dIn, u)));
  return Math.acos(c) * 180 / Math.PI;
}

// Build all candidate shots for target ball (or all legal balls).
export function findShots(balls, opts = {}) {
  const {
    targetIds = null, sigmaDeg = 0.7, maxCushions = 2, allowBank = true, allowCombo = true,
  } = opts;
  const cue = balls.find((b) => b.color === 'white');
  if (!cue) return [];
  const C = { x: cue.x, y: cue.y };
  const sigma = sigmaDeg * Math.PI / 180;
  const targets = balls.filter((b) => b.color !== 'white' && (!targetIds || targetIds.includes(b.id)));
  const shots = [];
  for (const O of targets) {
    // direct & bank
    for (const orr of objectRoutes(O, balls, [O.id, cue.id], allowBank)) {
      const Gh = v.sub(O, v.mul(orr.u, D2));
      if (!ghostOk(Gh, balls, [O.id, cue.id])) continue;
      for (const cr of cueRoutes(C, Gh, balls, [cue.id, O.id], maxCushions)) {
        const pts = cr.pts;
        const dIn = v.norm(v.sub(Gh, pts[pts.length - 2]));
        const cut = cutOf(dIn, orr.u);
        if (cut > 80) continue;
        // the cue must not clip the object ball before reaching the ghost
        if (distPointSeg(O, pts[pts.length - 2], v.sub(Gh, v.mul(dIn, 3))) < D2 - 2) continue;
        const dcg = pathLen(pts);
        const sCue = sigma * (1 + 0.7 * cr.cush) + (cr.cush ? 0.004 : 0);
        const sObj = Math.hypot(sCue * dcg / (D2 * Math.max(0.17, Math.cos(cut * Math.PI / 180))), 0.005 + 0.004 * orr.cush);
        const tau = orr.tol / orr.dist;
        let p = erf(tau / (sObj * Math.SQRT2));
        if (orr.cush) p *= 0.8;
        const type = cr.cush ? 'kick' : (orr.cush ? 'bank' : 'direct');
        shots.push({
          type, target: O.id, targetColor: O.color, pocket: orr.pocket.id, ghost: Gh, cuePath: pts, objPath: orr.pts,
          dIn, u: orr.u, cut, cueDist: dcg, objDist: orr.dist, cueCush: cr.cush, objCush: orr.cush, p,
        });
      }
    }
    // combination: cue -> O -> O2 -> pocket
    if (allowCombo) {
      for (const O2 of balls) {
        if (O2.id === O.id || O2.id === cue.id) continue;
        if (v.dist(O, O2) > 1400) continue;
        for (const orr of objectRoutes(O2, balls, [O2.id, O.id, cue.id], false)) {
          const G2 = v.sub(O2, v.mul(orr.u, D2));
          if (!ghostOk(G2, balls, [O2.id, O.id, cue.id])) continue;
          const u1 = v.norm(v.sub(G2, O));
          const cut2 = cutOf(u1, orr.u);
          if (cut2 > 55) continue;
          if (!segClear(O, G2, balls, [O.id, O2.id, cue.id])) continue;
          const G1 = v.sub(O, v.mul(u1, D2));
          if (!ghostOk(G1, balls, [O.id, cue.id])) continue;
          if (!segClear(C, G1, balls, [cue.id, O.id])) continue;
          const dIn = v.norm(v.sub(G1, C));
          const cut1 = cutOf(dIn, u1);
          if (cut1 > 70) continue;
          const d1 = v.dist(C, G1), d12 = v.dist(O, G2);
          const s1 = sigma * d1 / (D2 * Math.max(0.2, Math.cos(cut1 * Math.PI / 180)));
          const s2 = Math.hypot(s1 * d12 / (D2 * Math.max(0.2, Math.cos(cut2 * Math.PI / 180))), 0.006);
          const p = 0.85 * erf((orr.tol / orr.dist) / (s2 * Math.SQRT2));
          // in a combo the ball that drops is O2; O is just the first ball hit
          shots.push({
            type: 'combo', target: O2.id, targetColor: O2.color, firstBall: O.id, firstColor: O.color, pocket: orr.pocket.id,
            ghost: G1, ghost2: G2, cuePath: [C, G1], midPath: [O, G2], objPath: orr.pts, dIn, u: u1, u2: orr.u,
            cut: cut1, cut2, cueDist: d1, objDist: orr.dist, cueCush: 0, objCush: 0, p,
          });
        }
      }
    }
  }
  return shots;
}

// Cue tip position: x = side (+ right as the player sees it), y = height
// (+ above centre), both as a fraction of the ball radius. 0.4 = natural roll.
export const TIP_LIMIT = 0.6;
export const AUTO_TIPS = [0.5, 0.25, 0, -0.25, -0.5].map((y) => ({ x: 0, y }));

// Approach phase along a straight line: sliding -> rolling (Han 2005 style).
function approach(v0, b, dist) {
  let vv = v0, w = 2.5 * b * v0, s = 0, t = 0, tSlide = 0;
  const dt = 0.002;
  while (s < dist) {
    const slip = vv - w;
    if (Math.abs(slip) > 2) {
      const dv = MU_S * G * dt * Math.sign(slip);
      if (3.5 * Math.abs(dv) >= Math.abs(slip)) { const f = (5 * vv + 2 * w) / 7; vv = f; w = f; }
      else { vv -= dv; w += 2.5 * dv; }
      tSlide = t;
    } else { vv = Math.max(0, vv - A_R * dt); w = vv; }
    s += vv * dt; t += dt;
    if (vv < 30) return { reach: false };
    if (t > 20) return { reach: false };
  }
  return { reach: true, vc: vv, wc: w, t, tSlide };
}

export function spinName(s) { return s > 0.55 ? 'follow' : (s > -0.2 ? 'stun' : 'draw'); }

// Collision-induced throw (deg) for a given cut and spin ratio at contact.
function throwDeg(cutDeg, s) {
  const c = cutDeg * Math.PI / 180;
  const base = Math.min(2.8, 6.5 * Math.sin(c) * Math.cos(c));
  return base * (Math.abs(s) < 0.3 ? 1 : 0.55);
}

// Deflection of the cue ball by side spin: squirt (away from the side used)
// minus swerve (back towards it, grows with cue elevation). mm at the ghost.
function sideCorrection(tip, elevDeg, dist, ap) {
  if (!tip.x) return { squirtDeg: 0, swerveMm: 0, netMm: 0 };
  const a = tip.x;
  const squirtDeg = 4.8 * Math.abs(a);
  const squirtMm = dist * Math.tan(squirtDeg * Math.PI / 180);
  const tS = Math.min(ap.t, Math.max(ap.tSlide, 0.25));
  const acc = MU_S * G * 0.5 * Math.abs(a) * Math.sin(elevDeg * Math.PI / 180);
  const swerveMm = Math.min(squirtMm * 1.5, 0.5 * acc * tS * tS);
  return { squirtDeg, swerveMm, netMm: squirtMm - swerveMm };
}

// Speed bookkeeping and cue-ball after-path for a chosen power/tip.
export function playShot(shot, balls, power, tip, elevDeg = 8, hand = 1) {
  const v0 = speedFor(power);
  const ap = approach(v0, tip.y, shot.cueDist);
  if (!ap.reach) return { reach: false };
  const loss = Math.pow(0.8, shot.cueCush || 0);
  const vc = ap.vc * loss, wc = ap.wc * loss;
  const theta = shot.cut * Math.PI / 180;
  let vObj = vc * Math.cos(theta) * 0.95;
  if (shot.type === 'combo') {
    const v1 = Math.sqrt(Math.max(0, vObj * vObj - 2 * A_R * v.dist(shot.midPath[0], shot.midPath[1])));
    vObj = v1 * Math.cos(shot.cut2 * Math.PI / 180) * 0.95;
  }
  const need = 2 * A_R * (shot.objDist + 40) / Math.pow(E_CUSH, 2 * (shot.objCush || 0));
  const objReach = vObj * vObj >= need;
  const dIn = shot.dIn, u = shot.u;
  let t = v.sub(dIn, v.mul(u, v.dot(dIn, u)));
  const tl = v.len(t);
  t = tl > 1e-6 ? v.mul(t, 1 / tl) : { x: 0, y: 0 };
  const vel = v.mul(t, vc * Math.sin(theta));
  const w = v.mul(dIn, wc);
  // side spin about the vertical axis; right-hand side = clockwise from above
  const side0 = -hand * 2.5 * tip.x * v0 * Math.exp(-ap.t / 3) * loss;
  const ignore = [balls.find((b) => b.color === 'white')?.id, shot.target, shot.firstBall].filter((x) => x != null);
  const sim = simulateCue(shot.ghost, vel, w, balls, ignore, side0);
  const sRatio = vc > 0 ? wc / vc : 0;
  return {
    reach: true, objReach, vc, vObj, after: sim, spinRatio: sRatio, spinKind: spinName(sRatio),
    throwDeg: throwDeg(shot.cut, sRatio), side: sideCorrection(tip, elevDeg, shot.cueDist, ap),
  };
}

export function nextBallOn(potColor, balls, mode) {
  // mode: { kind: 'free' } | { kind: 'snooker', on: 'red'|'colour'|'yellow'.. }
  const reds = balls.filter((b) => b.color === 'red').length;
  if (mode.kind === 'free') return null;
  if (potColor === 'red') return COLOR_ORDER.slice();
  if (reds - 0 > 0 && mode.on !== 'sequence') return ['red'];
  const i = COLOR_ORDER.indexOf(potColor);
  return i >= 0 && i < 5 ? [COLOR_ORDER[i + 1]] : [];
}

export function ballsOn(balls, mode) {
  if (!mode || mode.kind === 'free') return null;
  if (mode.on === 'red') return ['red'];
  if (mode.on === 'colour') return COLOR_ORDER.slice();
  if (mode.on === 'auto') {
    if (balls.some((b) => b.color === 'red')) return ['red'];
    for (const c of COLOR_ORDER) if (balls.some((b) => b.color === c)) return [c];
    return [];
  }
  return [mode.on];
}

function bestDirectFrom(E, balls, colors, removedIds, sigmaDeg) {
  const pseudo = balls.filter((b) => !removedIds.includes(b.id)).map((b) => (b.color === 'white' ? { ...b, x: E.x, y: E.y } : b));
  const ids = pseudo.filter((b) => colors.includes(b.color)).map((b) => b.id);
  if (!ids.length) return { p: 0, value: 0 };
  const shots = findShots(pseudo, { targetIds: ids, sigmaDeg, maxCushions: 0, allowBank: false, allowCombo: false });
  let best = { p: 0, value: 0 };
  for (const s of shots) {
    const val = BALL_VALUE[s.targetColor];
    const sc = s.p * (1 + val / 7);
    if (sc > best.p * (1 + best.value / 7)) best = { p: s.p, value: val };
  }
  return best;
}

// Full analysis: returns ranked shots with chosen power/spin and after-paths.
export function analyze(balls, opts = {}) {
  const {
    targetId = null, mode = { kind: 'free' }, power = 'auto', tip = 'auto', sigmaDeg = 0.15, maxCushions = 2,
    limit = 8, elev = 8, hand = 1,
  } = opts;
  let targetIds = null;
  if (targetId != null) targetIds = [targetId];
  else {
    const on = ballsOn(balls, mode);
    if (on) targetIds = balls.filter((b) => on.includes(b.color)).map((b) => b.id);
  }
  let shots = findShots(balls, { targetIds, sigmaDeg, maxCushions });
  if (targetId != null) {
    // a combo where the chosen ball is the one that drops, or where it is hit first
    const extra = findShots(balls, { targetIds: null, sigmaDeg, maxCushions: 0, allowBank: false }).filter((s) => s.type === 'combo' && (s.target === targetId || s.firstBall === targetId));
    const key = (s) => `${s.type}|${s.target}|${s.firstBall}|${s.pocket}`;
    const seen = new Set(shots.map(key));
    for (const s of extra) if (!seen.has(key(s))) shots.push(s);
  }
  shots.sort((a, b) => b.p - a.p);
  shots = shots.slice(0, Math.max(limit * 2, 12));
  const powers = power === 'auto' ? [1, 2, 3, 4, 5] : [power];
  const tips = tip === 'auto' ? AUTO_TIPS : [tip];
  const out = [];
  for (const s of shots) {
    let best = null;
    const nextColors = nextBallOn(s.targetColor, balls, mode.kind === 'free' ? { kind: 'snooker', on: 'auto' } : mode) || [];
    for (const pw of powers) {
      for (const tp of tips) {
        const r = playShot(s, balls, pw, tp, elev, hand);
        if (!r.reach) continue;
        let pPot = s.p * (r.objReach ? 1 : 0.05);
        // overly hard shots lose accuracy
        pPot *= [1, 1, 1, 0.97, 0.92, 0.85][pw];
        const removed = [s.target];
        let nextP = 0, nextVal = 0;
        if (r.after.scratch == null) {
          const nb = bestDirectFrom(r.after.end, balls, nextColors, removed, sigmaDeg);
          nextP = nb.p; nextVal = nb.value;
        }
        const value = BALL_VALUE[s.targetColor] || 1;
        let score = pPot * (value + 0.9 * nextP * Math.max(1, nextVal)) - (r.after.scratch != null ? 4 : 0) - (r.after.kiss != null ? 0.3 : 0);
        if (!best || score > best.score) best = { score, power: pw, tip: tp, spin: r.spinKind, pPot, nextP, play: r };
      }
    }
    if (!best) continue;
    out.push({ ...s, ...best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
