// Snooker Eye – main app: camera, three modes (photo / tripod live / handheld live),
// editing, analysis requests and drawing.
import { TABLE, applyH, v } from './geom.js';
import {
  detectTable, calibrate, detectBalls, findBallAt, alignQuad, hsvArrays, BALL_HE, BALL_HEX, BALL_COLORS,
} from './vision.js';
import { thicknessLabel, POCKETS } from './shots.js';
import { Renderer } from './render.js';
import { ballSVG, elevationSVG, tipWords, tipMm, mountTipPad } from './tip.js';

const $ = (s) => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const vid = $('#vid');
const R = new Renderer(ctx);
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

// ---------------- state ----------------
const DEFAULTS = { power: 'auto', tip: 'auto', elev: 8, on: 'free', skill: 0.15, maxCush: 2, margin: 45, minimap: true, alts: true };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('se.settings.v3') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem('se.settings.v3', JSON.stringify(S.set)); } catch { /* storage unavailable */ } }

const S = {
  mode: 'photo', camReady: false, camError: null, tracks: [], lost: 0, cut: false,
  frozen: null, frozenW: 0, frozenH: 0,
  quad: null, calib: null, hue: null, orient: 'auto', tableSeen: false,
  balls: [], nextId: 1, selId: null,
  showRec: false, shots: [], shotIdx: 0,
  editCorners: false, editBalls: false, locked: false,
  set: loadSettings(),
  lastProc: 0, lastTableProbe: 0, quadHistory: [],
};


// ---------------- analysis worker ----------------
let worker = null, seq = 0, pending = false, dirty = false, lastAnalyzed = null;
try { worker = new Worker('js/worker.js', { type: 'module' }); } catch { worker = null; }
let analyzeSync = null;
if (!worker) import('./shots.js').then((m) => { analyzeSync = m.analyze; });
if (worker) {
  worker.onmessage = (e) => {
    pending = false;
    if (e.data.seq !== seq) { if (dirty) requestAnalysis(true); return; }
    if (e.data.error) { console.error(e.data.error); S.shots = []; }
    else applyShots(e.data.shots);
    if (dirty) requestAnalysis(true);
  };
}

function analysisOpts() {
  const st = S.set;
  const mode = st.on === 'free' ? { kind: 'free' } : { kind: 'snooker', on: st.on };
  const target = S.selId != null && S.balls.find((b) => b.id === S.selId && b.color !== 'white') ? S.selId : null;
  return {
    targetId: target, mode, power: st.power === 'auto' ? 'auto' : Number(st.power), tip: st.tip, elev: Number(st.elev),
    hand: S.calib && S.calib.pose ? S.calib.pose.hand : 1,
    sigmaDeg: Number(st.skill), maxCushions: Number(st.maxCush), limit: 6,
  };
}

function wantShots() {
  const hasTarget = S.selId != null && S.balls.some((b) => b.id === S.selId && b.color !== 'white');
  return S.calib && S.balls.some((b) => b.color === 'white') && (hasTarget || S.showRec);
}

function requestAnalysis(force = false) {
  if (!wantShots()) { S.shots = []; renderPanel(); return; }
  const balls = S.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, color: b.color }));
  const opts = analysisOpts();
  const key = JSON.stringify(opts);
  if (!force && lastAnalyzed && lastAnalyzed.key === key && sameBalls(lastAnalyzed.balls, balls)) return;
  if (pending) { dirty = true; return; }
  dirty = false;
  lastAnalyzed = { key, balls };
  seq++;
  if (worker) { pending = true; worker.postMessage({ seq, balls, opts }); }
  else if (analyzeSync) applyShots(analyzeSync(balls, opts));
}

function sameBalls(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((x) => [x.id, x]));
  for (const x of b) { const y = m.get(x.id); if (!y || y.color !== x.color || Math.hypot(x.x - y.x, x.y - y.y) > 9) return false; }
  return true;
}

function applyShots(shots) {
  const prevKey = S.shots[S.shotIdx] ? shotKey(S.shots[S.shotIdx]) : null;
  S.shots = shots || [];
  const i = prevKey ? S.shots.findIndex((s) => shotKey(s) === prevKey) : -1;
  S.shotIdx = i >= 0 ? i : 0;
  renderPanel();
}
const shotKey = (s) => `${s.type}|${s.target}|${s.firstBall || ''}|${s.pocket}|${s.cuePath.length}|${s.objPath.length}`;

// ---------------- camera ----------------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no-media');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  });
  vid.srcObject = stream;
  const track0 = stream.getVideoTracks()[0];
  try {
    const caps = track0.getCapabilities ? track0.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
    if (Object.keys(adv).length) await track0.applyConstraints({ advanced: [adv] });
  } catch { /* optional camera features */ }
  await vid.play().catch(() => {});
  await new Promise((r) => { if (vid.videoWidth) r(); else vid.onloadedmetadata = () => r(); });
  S.camReady = true;
}

function source() {
  if (S.mode === 'photo' && S.frozen) return { el: S.frozen, w: S.frozenW, h: S.frozenH, live: false };
  if (S.camReady && vid.videoWidth) return { el: vid, w: vid.videoWidth, h: vid.videoHeight, live: true };
  return null;
}

// ---------------- processing ----------------
function grab(src, maxSide) {
  const k = Math.min(1, maxSide / Math.max(src.w, src.h));
  const w = Math.round(src.w * k), h = Math.round(src.h * k);
  if (proc.width !== w || proc.height !== h) { proc.width = w; proc.height = h; }
  pctx.drawImage(src.el, 0, 0, w, h);
  const img = pctx.getImageData(0, 0, w, h);
  return { img, k, hsv: hsvArrays(img) };
}

// High-resolution crop around the table for ball detection.
const proc2 = document.createElement('canvas');
const pctx2 = proc2.getContext('2d', { willReadFrequently: true });
function grabTable(src, calib, maxSide) {
  const { L, W } = TABLE, m = 140;
  const pts = [{ x: -m, y: -m }, { x: L + m, y: -m }, { x: L + m, y: W + m }, { x: -m, y: W + m }].map((p) => applyH(calib.Hb, p));
  let x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)))), x1 = Math.min(src.w, Math.ceil(Math.max(...pts.map((p) => p.x))));
  let y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)))), y1 = Math.min(src.h, Math.ceil(Math.max(...pts.map((p) => p.y))));
  if (x1 - x0 < 20 || y1 - y0 < 20) return null;
  const k = Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0));
  const w = Math.max(1, Math.round((x1 - x0) * k)), h = Math.max(1, Math.round((y1 - y0) * k));
  if (proc2.width !== w || proc2.height !== h) { proc2.width = w; proc2.height = h; }
  pctx2.drawImage(src.el, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
  const img = pctx2.getImageData(0, 0, w, h);
  return { img, xf: { k, ox: x0, oy: y0 }, hsv: hsvArrays(img) };
}

function setCalibFromQuad(quad, w, h) {
  const c = calibrate(quad, w, h, Number(S.set.margin), S.orient);
  if (!c) return false;
  if (S.orient === 'auto' && S.mode !== 'photo') S.orient = c.orient;
  S.quad = quad; S.calib = c;
  const bm = Math.min(w, h) * 0.012;
  S.cut = quad.some((p) => p.x < bm || p.y < bm || p.x > w - bm || p.y > h - bm);
  return true;
}

// Tracker in table coordinates. A detection must be seen in several frames
// before it is shown, and positions are smoothed with a small dead band so
// the markers stand still on a still table.
function track(dets) {
  if (S.ignore && S.ignore.length) dets = dets.filter((d) => !S.ignore.some((q) => Math.hypot(q.x - d.x, q.y - d.y) < 45));
  const out = [];
  const used = new Set();
  for (const t of S.tracks) {
    let best = null, bd = t.manual ? 90 : 75;
    dets.forEach((d, i) => {
      if (used.has(i)) return;
      if (!t.manual && d.color !== t.color && !(t.hits < 3)) return;
      const dd = Math.hypot(d.x - t.x, d.y - t.y);
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best != null) {
      used.add(best);
      const d = dets[best];
      let x = t.x, y = t.y;
      if (bd > 40) { x = d.x; y = d.y; } else if (bd > 3) { x += (d.x - t.x) * 0.35; y += (d.y - t.y) * 0.35; }
      const votes = { ...(t.votes || {}) }; votes[d.color] = (votes[d.color] || 0) + 1;
      let color = t.color;
      if (!t.manual) { let bv = 0; for (const c in votes) if (votes[c] > bv) { bv = votes[c]; color = c; } }
      out.push({ ...t, x, y, color, votes, img: d.img, miss: 0, hits: Math.min(50, t.hits + 1) });
    } else if (t.manual || t.miss < (t.hits >= 3 ? 10 : 2)) out.push({ ...t, miss: t.miss + 1 });
  }
  dets.forEach((d, i) => { if (!used.has(i)) out.push({ ...d, id: S.nextId++, miss: 0, hits: 1, votes: { [d.color]: 1 } }); });
  S.tracks = out;
  S.balls = out.filter((t) => t.manual || t.hits >= 3);
}

let procCost = 60;
function processLive(src) {
  const t0 = performance.now();
  const g = grab(src, 640);
  if (S.mode === 'photo') {
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (t.ok) { setCalibFromQuad(t.quad, src.w, src.h); S.hue = t.hue; S.tableSeen = true; }
    else { S.tableSeen = t.reason === 'cut'; S.cut = t.reason === 'cut'; S.calib = null; }
    S.balls = [];
    return;
  }
  if ((S.mode === 'tripod' && !S.locked) || S.mode === 'hand') {
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (t.ok && S.quad && S.calib) {
      // reject a sudden implausible change of the table's size on screen
      const area = (q) => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p.x * n.y - n.x * p.y; }, 0) / 2);
      const ratio = area(t.quad) / Math.max(1, area(S.quad));
      if ((ratio < 0.6 || ratio > 1.65) && (S.lost || 0) < 8) { t.ok = false; t.reason = 'jump'; }
    }
    if (t.ok) {
      S.hue = t.hue; S.lost = 0;
      let q = t.quad;
      if (S.quad) {
        const al = alignQuad(S.quad, t.quad);
        q = al.quad;
        const diag = Math.hypot(src.w, src.h);
        const a = al.dist > diag * 0.05 ? 1 : (al.dist < diag * 0.004 ? 0.15 : 0.5);
        q = q.map((p, i) => ({ x: S.quad[i].x + (p.x - S.quad[i].x) * a, y: S.quad[i].y + (p.y - S.quad[i].y) * a }));
        // a big jump of the view means the balls must be re-acquired
        if (a === 1) { S.tracks = S.tracks.filter((x) => x.manual); S.ignore = []; }
      }
      setCalibFromQuad(q, src.w, src.h); S.tableSeen = true;
    } else {
      S.lost = (S.lost || 0) + 1;
      if (t.reason === 'cut') S.cut = true;
      if (S.lost > 12) { S.tableSeen = false; }
    }
  }
  if (S.calib && S.tableSeen !== false) {
    const c = grabTable(src, S.calib, 1100);
    if (c) {
      const dets = detectBalls(c.img, S.calib, c.xf, c.hsv, { clothHue: S.hue });
      track(dets);
      if (S.selId != null && !S.balls.some((b) => b.id === S.selId)) S.selId = null;
      requestAnalysis();
    }
  }
  procCost = procCost * 0.8 + (performance.now() - t0) * 0.2;
}

function capturePhoto() {
  const src = source();
  if (!src) { toast('אין תמונה מהמצלמה'); return; }
  const c = document.createElement('canvas');
  c.width = src.w; c.height = src.h;
  c.getContext('2d').drawImage(src.el, 0, 0);
  S.frozen = c; S.frozenW = src.w; S.frozenH = src.h;
  S.selId = null; S.shots = []; S.orient = 'auto';
  analyzeFrozen(true);
  renderActions();
}

function analyzeFrozen(detectQuad) {
  const src = { el: S.frozen, w: S.frozenW, h: S.frozenH };
  const keepManual = S.balls.filter((b) => b.manual);
  if (detectQuad || !S.quad) {
    const g = grab(src, 960);
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (!t.ok) {
      S.calib = null; S.balls = [];
      toast('לא זיהיתי את השולחן. לחץ "פינות" וסמן ידנית את 4 הפינות');
      S.quad = defaultQuad(src.w, src.h);
      setCalibFromQuad(S.quad, src.w, src.h);
      S.hue = 135;
      renderStatus();
      return;
    }
    S.hue = t.hue;
    setCalibFromQuad(t.quad, src.w, src.h);
  } else setCalibFromQuad(S.quad, src.w, src.h);
  const c = grabTable(src, S.calib, 2000);
  const dets = c ? detectBalls(c.img, S.calib, c.xf, c.hsv, { clothHue: S.hue }) : [];
  S.nextId = Math.max(S.nextId, 1);
  S.balls = dets.map((d) => ({ ...d, id: S.nextId++ })).concat(detectQuad ? [] : keepManual);
  if (!S.balls.some((b) => b.color === 'white')) toast('לא נמצא כדור לבן – גע בו כדי לסמן אותו');
  requestAnalysis(true);
  renderStatus();
}

// Tap on a spot where no ball is marked: search the image there.
function tapFind(framePt, commit = true) {
  const src = source();
  if (!src || !S.calib) return null;
  const c = grabTable(src, S.calib, S.mode === 'photo' ? 2000 : 1400);
  if (!c) return null;
  const r = findBallAt(c.img, S.calib, c.xf, framePt);
  if (!r) return null;
  const { L, W, R: RR } = TABLE;
  if (r.x < -40 || r.y < -40 || r.x > L + 40 || r.y > W + 40) return null;
  const b = {
    id: 0, color: r.color, x: Math.min(L - RR, Math.max(RR, r.x)), y: Math.min(W - RR, Math.max(RR, r.y)),
    manual: true, hits: 99, miss: 0, img: r.img,
  };
  if (!commit) return { ball: b, found: r.found };
  return commitTap(b, r.found);
}

function commitTap(b, found) {
  const RR = TABLE.R;
  b.id = S.nextId++;
  if (b.color !== 'red') for (const o of S.balls) if (o.color === b.color && o !== b) o.color = 'red';
  // replace any nearby automatic detection
  S.balls = S.balls.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) > 2 * RR);
  S.tracks = (S.tracks || []).filter((o) => Math.hypot(o.x - b.x, o.y - b.y) > 2 * RR);
  S.balls.push(b);
  if (S.mode !== 'photo') S.tracks.push(b);
  return { ball: b, found };
}

function defaultQuad(w, h) {
  return [{ x: w * 0.2, y: h * 0.25 }, { x: w * 0.8, y: h * 0.25 }, { x: w * 0.92, y: h * 0.85 }, { x: w * 0.08, y: h * 0.85 }];
}

// ---------------- drawing ----------------
let lastTs = 0;
function frame(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0); lastTs = ts;
  R.t = ts / 1000;
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, cw, ch);
  const src = source();
  if (src) {
    const s = Math.min(cw / src.w, ch / src.h);
    const view = { s, ox: (cw - src.w * s) / 2, oy: (ch - src.h * s) / 2 };
    R.setView(view);
    ctx.drawImage(src.el, view.ox, view.oy, src.w * s, src.h * s);
    const interval = S.mode === 'photo' ? 350 : Math.max(80, procCost * 1.6);
    if (src.live && ts - S.lastProc > interval) {
      S.lastProc = ts;
      try { processLive(src); } catch (e) { console.error(e); }
      renderStatus();
    }
    try { drawOverlay(cw, ch); } catch (e) { console.error(e); }
  }
  requestAnimationFrame(frame);
}

function drawOverlay(cw, ch) {
  const c = S.calib;
  if (!c) return;
  const live = !(S.mode === 'photo' && S.frozen);
  if (S.editCorners) R.quadHandles(S.quad, dragCorner);
  R.tableOutline(c, S.editCorners ? 0.9 : (live && S.mode === 'photo' ? 0.8 : 0.35));
  if (S.mode === 'photo' && !S.frozen) return;
  const cur = S.shots[S.shotIdx];
  if (S.set.alts && cur) S.shots.slice(0, 4).forEach((s, i) => { if (i !== S.shotIdx) R.shot(c, s, S.balls, { faint: true }); });
  R.balls(c, S.balls, S.selId, S.editBalls);
  if (cur && !S.editBalls) R.shot(c, cur, S.balls, { label: shotBadge(cur) });
  if (S.set.minimap) {
    const portrait = ch > cw;
    const w = portrait ? Math.min(220, cw * 0.5) : Math.min(260, cw * 0.3);
    R.minimap({ x: 12, y: portrait ? 104 : ch - w * 0.6 - 118, w }, S.balls, S.shots, cur, S.selId);
  }
}

// ---------------- text helpers ----------------
function scrOf(p) { return R.fr2scr(applyH(S.calib.Hb, p)); }

function cutSide(shot) {
  if (shot.cut < 1.5) return 'ישר';
  const g = shot.ghost;
  const a = scrOf(v.sub(g, v.mul(shot.dIn, 200))), b = scrOf(g), cpt = scrOf(v.add(g, v.mul(shot.u, 200)));
  const d = { x: b.x - a.x, y: b.y - a.y }, u = { x: cpt.x - b.x, y: cpt.y - b.y };
  return d.x * u.y - d.y * u.x > 0 ? 'ימינה' : 'שמאלה';
}

function pocketName(id) {
  const pk = POCKETS[id];
  const cen = scrOf({ x: TABLE.L / 2, y: TABLE.W / 2 });
  const p = scrOf({ x: pk.x, y: pk.y });
  const dx = p.x - cen.x, dy = p.y - cen.y;
  if (pk.kind === 'middle') {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'כיס אמצע ימני' : 'כיס אמצע שמאלי';
    return dy < 0 ? 'כיס אמצע רחוק' : 'כיס אמצע קרוב';
  }
  return `כיס פינה ${dy < 0 ? 'רחוק' : 'קרוב'} ${dx > 0 ? 'ימני' : 'שמאלי'}`;
}

const TYPE_HE = { direct: 'מכה ישירה', bank: 'דאבל (כדור לגומי)', kick: 'לבן דרך הגומי', combo: 'שרשרת' };
const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`);

function shotBadge(s) {
  return `${Math.round(s.cut)}° ${cutSide(s)} · ${thicknessLabel(s.cut)} · ${pct(s.pPot)}`;
}

function howTo(cur) {
  const tip = cur.tip || { x: 0, y: 0 };
  const pl = cur.play || {};
  const extra = [];
  const side = pl.side;
  if (side && Math.abs(side.netMm) >= 1) {
    const towards = tip.x > 0 ? 'ימינה' : 'שמאלה';
    const away = tip.x > 0 ? 'שמאלה' : 'ימינה';
    extra.push(side.netMm > 0
      ? `צד: הלבן יברח ~${Math.round(side.netMm)} מ״מ ${away} → כוון ${Math.round(side.netMm)} מ״מ ${towards}`
      : `קירוס: הלבן יתעקם ~${Math.round(-side.netMm)} מ״מ ${towards} → כוון ${Math.round(-side.netMm)} מ״מ ${away}`);
  }
  if (pl.throwDeg >= 0.7 && cur.cut > 3) {
    const mm = (2 * TABLE.R * Math.sin(pl.throwDeg * Math.PI / 180)).toFixed(1);
    extra.push(`זריקה ~${pl.throwDeg.toFixed(1)}°: חתוך מעט דק יותר (~${mm} מ״מ)`);
  }
  return `<div class="howto">
    ${ballSVG(tip, 66, { showCentre: true })}
    <div class="lines">נקודת פגיעה: <b>${tipWords(tip)}</b><br>${tipMm(tip)}<br>גובה מקל: <b>${Math.round(S.set.elev)}°</b> · כוח <b>${cur.power}/5</b></div>
  </div>${extra.map((x) => `<div class="tip" style="color:#ffcf6b">${x}</div>`).join('')}`;
}

function renderTipBtn() {
  const b = $('#tipBtn');
  const cur = S.shots[S.shotIdx];
  const auto = S.set.tip === 'auto';
  const tip = auto ? (cur && cur.tip) : S.set.tip;
  b.innerHTML = (tip ? ballSVG(tip, 46, { guides: false, showCentre: true }) : ballSVG('auto', 46, { guides: false })) + (auto ? '<span class="badge">A</span>' : '');
}

function openTipSheet() {
  const st = S.set;
  openSheet('נקודת פגיעה בלבן', `
    <div class="tipgrid"><div>
    <div class="tiphead" id="tipHead">${tipWords(st.tip)}</div>
    <div id="tipPadBox"></div></div><div>
    <div class="btnrow"><button class="btn" id="tipCentre">מרכז הכדור</button><button class="btn ${st.tip === 'auto' ? 'primary' : ''}" id="tipAuto">אוטומטי (האפליקציה בוחרת)</button></div>
    <div class="row"><div class="lbl">גובה המקל: <b id="elevV">${st.elev}</b>°</div>
      <div class="elevrow"><div id="elevPic">${elevationSVG(st.elev)}</div><input type="range" id="elev" min="0" max="45" step="1" value="${st.elev}"></div>
      <div class="hint">מקל שטוח (5–10°) = מכה נקייה. מקל גבוה + צד = הלבן מתעקם (קירוס).</div></div>
    <div class="row hint">העיגול המקווקו = גבול בטוח (מעבר לו יש סכנת החלקה). עיגול פנימי = גובה לגלגול טבעי.</div></div></div>`);
  $('#sheet .sheet-card').classList.add('tipcard');
  const box = $('#tipPadBox');
  const pad = mountTipPad(box, st.tip, (t) => { $('#tipHead').textContent = tipWords(t); },
    (t) => { S.set.tip = t; saveSettings(); $('#tipAuto').classList.remove('primary'); renderTipBtn(); requestAnalysis(true); });
  $('#tipCentre').onclick = () => { S.set.tip = { x: 0, y: 0 }; saveSettings(); pad.set(S.set.tip); $('#tipHead').textContent = tipWords(S.set.tip); $('#tipAuto').classList.remove('primary'); renderTipBtn(); requestAnalysis(true); };
  $('#tipAuto').onclick = () => { S.set.tip = 'auto'; saveSettings(); $('#tipHead').textContent = tipWords('auto'); $('#tipAuto').classList.add('primary'); renderTipBtn(); requestAnalysis(true); };
  const el = $('#elev');
  el.oninput = () => { $('#elevV').textContent = el.value; $('#elevPic').innerHTML = elevationSVG(Number(el.value)); };
  el.onchange = () => { S.set.elev = Number(el.value); saveSettings(); requestAnalysis(true); };
}
$('#tipBtn').onclick = openTipSheet;

// ---------------- panel ----------------
function renderPanel() {
  renderTipBtn();
  const panel = $('#panel');
  const cur = S.shots[S.shotIdx];
  const hasTarget = S.selId != null;
  if (!S.calib || (!hasTarget && !S.showRec) || S.editBalls || S.editCorners) { panel.hidden = true; return; }
  panel.hidden = false;
  if (!cur) {
    const sel = S.balls.find((b) => b.id === S.selId);
    $('#pTitle').textContent = sel && sel.color === 'white' ? 'זה הכדור הלבן' : 'אין מכה טובה';
    $('#pBody').innerHTML = sel && sel.color === 'white'
      ? '<div class="tip">גע בכדור שאתה רוצה להכניס</div>'
      : '<div class="tip">כל הדרכים חסומות או רחוקות מדי. נסה להגדיל את מספר הגומיות בהגדרות, או לשחק מכת ביטחון.</div>';
    $('#pCount').textContent = ''; $('#pList').innerHTML = '';
    return;
  }
  const typeHe = cur.type === 'combo' ? `שרשרת: ${BALL_HE[cur.firstColor]} ← ${BALL_HE[cur.targetColor]}` : TYPE_HE[cur.type];
  $('#pTitle').innerHTML = `<span class="swatch" style="background:${BALL_HEX[cur.targetColor]}"></span>${BALL_HE[cur.targetColor]} → ${pocketName(cur.pocket)}`;
  const after = cur.play && cur.play.after;
  let afterTxt = 'הלבן ייעצר בעיגול הכחול';
  if (after && after.scratch != null) afterTxt = '⚠️ הלבן ייכנס לכיס – שנה כוח/סיבוב';
  else if (after && after.kiss != null) afterTxt = 'הלבן ייתקל בכדור אחר';
  $('#pBody').innerHTML = `
    ${howTo(cur)}
    <div class="kv">
      <span class="k">סוג</span><span class="v wide">${typeHe}${cur.cueCush ? ` (${cur.cueCush} גומי)` : ''}</span>
      <span class="k">חיתוך</span><span class="v big">${Math.round(cur.cut)}° ${cutSide(cur)}</span>
      <span class="k">עובי</span><span class="v">${thicknessLabel(cur.cut)}</span>
      <span class="k">כוח</span><span class="v">${'●'.repeat(cur.power)}${'○'.repeat(5 - cur.power)} ${cur.power}/5</span>
      <span class="k">בפגיעה</span><span class="v">${({ follow: 'עליון', stun: 'סטופ', draw: 'אחורי' })[cur.spin]}</span>
      <span class="k">סיכוי</span><span class="v">${pct(cur.pPot)}<div class="bar"><i style="width:${pct(cur.pPot)}"></i></div></span>
      ${cur.nextP > 0 ? `<span class="k">לכדור הבא</span><span class="v">${pct(cur.nextP)}</span>` : ''}
    </div>
    <div class="tip">🎯 כוון את הלבן למרכז העיגול הלבן</div>
    <div class="tip">${afterTxt}</div>
    ${cur.play && !cur.play.objReach ? '<div class="tip" style="color:#ff8a8a">הכוח חלש מדי להגיע לכיס</div>' : ''}`;
  $('#pCount').textContent = `${S.shotIdx + 1} / ${S.shots.length}`;
  $('#pList').innerHTML = S.shots.map((s, i) => `<button data-i="${i}" class="${i === S.shotIdx ? 'on' : ''}">
    <span><span class="swatch" style="background:${BALL_HEX[s.targetColor]}"></span>${s.type === 'direct' ? '' : TYPE_HE[s.type] + ' · '}${pocketName(s.pocket)}</span>
    <span class="pc">${pct(s.pPot)}</span></button>`).join('');
}

$('#pList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  S.shotIdx = Number(b.dataset.i); renderPanel();
});
$('#pPrev').onclick = () => { if (S.shots.length) { S.shotIdx = (S.shotIdx - 1 + S.shots.length) % S.shots.length; renderPanel(); } };
$('#pNext').onclick = () => { if (S.shots.length) { S.shotIdx = (S.shotIdx + 1) % S.shots.length; renderPanel(); } };
$('#pClose').onclick = () => { S.selId = null; S.showRec = false; S.shots = []; renderPanel(); renderActions(); };

// ---------------- status / actions ----------------
function renderStatus() {
  const st = $('#status');
  st.className = 'status';
  if (S.camError) { st.textContent = S.camError; st.classList.add('warn'); return; }
  if (S.mode === 'photo' && !S.frozen) {
    st.textContent = !S.tableSeen ? 'כוון את המצלמה כך שכל השולחן ייראה' : (S.cut ? 'השולחן חתוך – התרחק או הרם את הטלפון' : 'השולחן בפריים ✓ – צלם');
    if (S.tableSeen && !S.cut) st.classList.add('ok'); else if (S.cut) st.classList.add('warn');
    return;
  }
  if (!S.calib) { st.textContent = 'מחפש שולחן…'; return; }
  const n = S.balls.length;
  const white = S.balls.some((b) => b.color === 'white');
  let t = `${S.mode === 'tripod' ? (S.locked ? '🔒 שולחן נעול' : 'שולחן זוהה') : 'שולחן'} · ${n} כדורים`;
  if (!white) t += ' · אין לבן';
  if (S.cut) { t += ' · השולחן חתוך – התרחק כדי שכל השולחן ייראה'; st.classList.add('warn'); }
  else if (S.calib.elev < 14) { t += ' · הרם את הטלפון לדיוק'; st.classList.add('warn'); } else st.classList.add('ok');
  if (!S.selId && !S.showRec && n) t += ' · גע בכדור';
  st.textContent = t;
}

function btn(label, cls, fn, title) {
  const b = document.createElement('button');
  b.className = 'btn ' + (cls || ''); b.innerHTML = label; b.onclick = fn; if (title) b.title = title;
  return b;
}

function renderActions() {
  const a = $('#actions'); a.innerHTML = '';
  const recBtn = btn('💡 המלצה', S.showRec ? 'on' : '', () => { S.showRec = !S.showRec; if (S.showRec) S.selId = null; requestAnalysis(true); renderActions(); });
  if (S.mode === 'photo') {
    if (!S.frozen) { a.append(btn('●', 'shutter', capturePhoto, 'צלם')); return; }
    a.append(btn('↺ צלם שוב', '', () => { S.frozen = null; S.editBalls = S.editCorners = false; S.selId = null; S.shots = []; S.showRec = false; renderPanel(); renderActions(); }));
    a.append(recBtn);
    a.append(btn('◳ פינות', S.editCorners ? 'on' : '', toggleCorners));
    if (S.editCorners) a.append(btn('⟲ סובב', '', rotateTable));
    a.append(btn('✎ כדורים', S.editBalls ? 'on' : '', () => { S.editBalls = !S.editBalls; S.editCorners = false; renderPanel(); renderActions(); toast(S.editBalls ? 'גע בכדור לשינוי צבע/מחיקה, גע במקום ריק להוספה, גרור להזזה' : ''); }));
  } else if (S.mode === 'tripod') {
    a.append(btn(S.locked ? '🔓 שחרר' : '🔒 נעל שולחן', S.locked ? 'on' : 'primary', () => {
      if (!S.locked && !S.calib) { toast('עוד לא זוהה שולחן'); return; }
      S.locked = !S.locked; S.editCorners = false;
      toast(S.locked ? 'השולחן נעול. אל תזיז את הטלפון' : 'מזהה את השולחן מחדש');
      renderActions();
    }));
    a.append(recBtn);
    a.append(btn('◳ פינות', S.editCorners ? 'on' : '', toggleCorners));
    if (S.editCorners) a.append(btn('⟲ סובב', '', rotateTable));
  } else {
    a.append(recBtn);
  }
}

function toggleCorners() {
  S.editCorners = !S.editCorners; S.editBalls = false;
  if (S.editCorners) {
    if (S.mode === 'tripod') S.locked = true;
    if (!S.quad) { const src = source(); if (src) { S.quad = defaultQuad(src.w, src.h); setCalibFromQuad(S.quad, src.w, src.h); } }
    toast('גרור כל פינה לקצה הבד הירוק (כולל הגומי). "סובב" אם האורך והרוחב התחלפו');
  }
  renderPanel(); renderActions();
}

function rotateTable() {
  S.orient = S.calib ? 1 - S.calib.orient : 0;
  const src = source(); if (!src || !S.quad) return;
  setCalibFromQuad(S.quad, src.w, src.h);
  if (S.mode === 'photo' && S.frozen) analyzeFrozen(false);
  else { S.balls = []; }
}

function toast(msg) {
  const t = $('#toast');
  if (!msg) { t.hidden = true; return; }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3800);
}

// ---------------- pointer interaction ----------------
let dragCorner = -1, dragBall = null, downPt = null, moved = false, downT = 0, pressTimer = 0, longDone = false;

function evPt(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function ballAtScreen(p) {
  if (!S.calib) return null;
  let best = null, bd = Infinity;
  for (const b of S.balls) {
    const s = scrOf(b);
    const r = Math.max(12, R.ballRadiusScr(b, S.calib.Hb) * 1.5);
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < r && d < bd) { bd = d; best = b; }
  }
  return best;
}

function screenToTable(p) {
  const f = R.scr2fr(p);
  return applyH(S.calib.Hbinv, f);
}

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  downPt = evPt(e); moved = false; downT = performance.now(); longDone = false;
  clearTimeout(pressTimer);
  if (!S.editCorners && !S.editBalls && S.calib) {
    const at = downPt;
    pressTimer = setTimeout(() => {
      if (moved || !downPt) return;
      const b = ballAtScreen(at);
      longDone = true;
      if (b) openBallSheet(b, null);
      else openBallSheet(null, screenToTable(at));
    }, 550);
  }
  if (S.editCorners && S.quad) {
    let bi = -1, bd = 44;
    S.quad.forEach((q, i) => { const s = R.fr2scr(q); const d = Math.hypot(s.x - downPt.x, s.y - downPt.y); if (d < bd) { bd = d; bi = i; } });
    dragCorner = bi;
  } else if (S.editBalls) {
    dragBall = ballAtScreen(downPt);
  }
});

cv.addEventListener('pointermove', (e) => {
  if (!downPt) return;
  const p = evPt(e);
  if (Math.hypot(p.x - downPt.x, p.y - downPt.y) > 7) moved = true;
  if (dragCorner >= 0 && moved) {
    const src = source();
    const q = S.quad.slice(); q[dragCorner] = R.scr2fr(p);
    setCalibFromQuad(q, src.w, src.h);
  } else if (dragBall && moved && S.calib) {
    const t = screenToTable(p);
    dragBall.x = Math.min(TABLE.L - TABLE.R, Math.max(TABLE.R, t.x));
    dragBall.y = Math.min(TABLE.W - TABLE.R, Math.max(TABLE.R, t.y));
  }
});

cv.addEventListener('pointerup', (e) => {
  const p = evPt(e);
  const wasCorner = dragCorner >= 0, wasBall = dragBall;
  dragCorner = -1; dragBall = null;
  clearTimeout(pressTimer);
  if (!downPt) return;
  downPt = null;
  if (longDone) return;
  if (moved) {
    if (wasCorner && S.mode === 'photo' && S.frozen) analyzeFrozen(false);
    if (wasBall) requestAnalysis(true);
    return;
  }
  if (S.editCorners) return;
  if (S.editBalls) { if (S.calib) openBallSheet(ballAtScreen(p), screenToTable(p)); return; }
  if (!S.calib) { toast('עוד לא זוהה שולחן'); return; }
  let b = ballAtScreen(p);
  const dScr = (q) => { const s2 = scrOf(q); return Math.hypot(s2.x - p.x, s2.y - p.y); };
  // if the tap is not right on a marked ball, look at the image there
  if (!b || dScr(b) > 0.8 * R.ballRadiusScr(b, S.calib.Hb)) {
    const t = screenToTable(p);
    const inside = t.x > -30 && t.y > -30 && t.x < TABLE.L + 30 && t.y < TABLE.W + 30;
    const r = inside ? tapFind(R.scr2fr(p), false) : null;
    const dup = r && S.balls.find((o) => Math.hypot(o.x - r.ball.x, o.y - r.ball.y) < TABLE.R * 1.2);
    if (r && dup) b = dup;
    else if (r && (r.found || !b) && (!b || dScr(r.ball) < dScr(b))) {
      b = commitTap(r.ball, r.found).ball;
      toast(r.found ? `סימנתי ${BALL_HE[b.color]} · לחיצה ארוכה לשינוי צבע` : `סימנתי כדור ידנית (${BALL_HE[b.color]}) · לחיצה ארוכה לשינוי צבע`);
    }
  }
  if (b) {
    S.selId = b.id; S.showRec = false;
    if (b.color === 'white') toast('זה הלבן – גע בכדור שאתה רוצה להכניס');
  } else S.selId = null;
  S.shotIdx = 0;
  requestAnalysis(true); renderActions(); renderStatus();
});

// ---------------- sheets ----------------
function openSheet(title, html) {
  $('#sheet .sheet-card').classList.remove('tipcard');
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = html; $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheetClose').onclick = closeSheet;
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function colorButtons() {
  return `<div class="colors">${BALL_COLORS.map((c) => `<button data-c="${c}"><span class="ball" style="background:${BALL_HEX[c]}"></span>${BALL_HE[c]}</button>`).join('')}</div>`;
}

function openBallSheet(ball, tpos) {
  if (ball) {
    openSheet(`כדור ${BALL_HE[ball.color]}`, `${colorButtons()}<div class="row"><button class="btn" id="delBall" style="width:100%;color:#ff8a8a">🗑 מחק כדור</button></div>`);
    $('#sheetBody').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { setColor(ball, b.dataset.c); closeSheet(); }; });
    $('#delBall').onclick = () => {
      S.balls = S.balls.filter((x) => x.id !== ball.id); S.tracks = (S.tracks || []).filter((x) => x.id !== ball.id);
      S.ignore = (S.ignore || []).concat([{ x: ball.x, y: ball.y }]);
      if (S.selId === ball.id) S.selId = null; closeSheet(); requestAnalysis(true);
    };
  } else {
    if (tpos.x < 0 || tpos.y < 0 || tpos.x > TABLE.L || tpos.y > TABLE.W) { toast('הנקודה מחוץ לשולחן'); return; }
    openSheet('הוסף כדור כאן', colorButtons());
    $('#sheetBody').querySelectorAll('[data-c]').forEach((b) => {
      b.onclick = () => {
        const nb = { id: S.nextId++, color: 'red', manual: true, hits: 99, miss: 0, x: Math.min(TABLE.L - TABLE.R, Math.max(TABLE.R, tpos.x)), y: Math.min(TABLE.W - TABLE.R, Math.max(TABLE.R, tpos.y)) };
        S.balls.push(nb); if (S.mode !== 'photo') S.tracks.push(nb); setColor(nb, b.dataset.c); closeSheet();
      };
    });
  }
}

function setColor(ball, c) {
  if (c !== 'red') for (const o of S.balls) if (o !== ball && o.color === c) o.color = 'red';
  ball.color = c; ball.manual = true;
  for (const t of S.tracks || []) if (t.id === ball.id) { t.color = c; t.manual = true; }
  requestAnalysis(true);
}

function seg(name, value, options) {
  return `<div class="seg" data-set="${name}">${options.map(([v2, l]) => `<button data-v="${v2}" class="${String(value) === String(v2) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function openSettings() {
  const st = S.set;
  openSheet('הגדרות', `
    <div class="row"><div class="lbl">כדור על (חוקי סנוקר)</div>
      ${seg('on', st.on, [['free', 'חופשי'], ['auto', 'אוטומטי'], ['red', 'אדום'], ['colour', 'צבע']])}
      <div class="hint">"חופשי" – כל כדור. "אוטומטי" – אדומים כל עוד יש, אחר כך צבעים לפי הסדר.</div></div>
    <div class="row"><div class="lbl">רמת שחקן (לחישוב סיכוי)</div>
      ${seg('skill', st.skill, [['0.25', 'מתחיל'], ['0.15', 'בינוני'], ['0.1', 'מתקדם'], ['0.06', 'מקצוען']])}</div>
    <div class="row"><div class="lbl">מקסימום גומיות ללבן</div>
      ${seg('maxCush', st.maxCush, [['0', '0'], ['1', '1'], ['2', '2']])}</div>
    <div class="row"><div class="lbl">רוחב הגומי מעבר לקו המשחק: <b id="mv">${st.margin}</b> מ״מ</div>
      <input type="range" id="margin" min="0" max="80" step="1" value="${st.margin}">
      <div class="hint">הזיהוי האוטומטי מוצא את קצה הבד כולל הגומי (בערך 45 מ״מ). אם סימנת פינות בדיוק על אף הגומי – שים 0.</div></div>
    <div class="row"><div class="lbl">תצוגה</div>
      ${seg('minimap', st.minimap, [[true, 'מפה עליונה'], [false, 'בלי מפה']])}
      <div style="height:6px"></div>
      ${seg('alts', st.alts, [[true, 'הצג חלופות'], [false, 'רק המכה הנבחרת']])}</div>
    <div class="row hint">Snooker Eye · החישובים גיאומטריים, התוצאה בפועל תלויה גם בביצוע.</div>`);
  $('#sheetBody').querySelectorAll('.seg[data-set] button').forEach((b) => {
    b.onclick = () => {
      const k = b.parentElement.dataset.set;
      let val = b.dataset.v;
      if (val === 'true') val = true; else if (val === 'false') val = false;
      S.set[k] = val; saveSettings();
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      requestAnalysis(true);
    };
  });
  const m = $('#margin');
  m.oninput = () => { $('#mv').textContent = m.value; };
  m.onchange = () => {
    S.set.margin = Number(m.value); saveSettings();
    const src = source();
    if (S.quad && src) { setCalibFromQuad(S.quad, src.w, src.h); if (S.mode === 'photo' && S.frozen) analyzeFrozen(false); }
  };
}
$('#btnSettings').onclick = openSettings;

function bindSeg(id, key) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S.set[key]) === b.dataset.v));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.set[key] = b.dataset.v; saveSettings();
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    requestAnalysis(true);
  });
}
bindSeg('#segPower', 'power');

// ---------------- modes / source ----------------
function setMode(m) {
  S.mode = m;
  S.frozen = null; S.editBalls = false; S.editCorners = false; S.locked = false;
  S.balls = []; S.tracks = []; S.ignore = []; S.lost = 0; S.selId = null; S.shots = []; S.showRec = false; S.quad = null; S.calib = null; S.orient = 'auto'; S.quadHistory = [];
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const tips = {
    photo: 'צלם את השולחן, ואז גע בכדור',
    tripod: 'הנח את הטלפון על מעמד גבוה, ולחץ "נעל שולחן"',
    hand: 'החזק את הטלפון מעל השולחן – הקווים יעקבו',
  };
  toast(tips[m]);
  renderPanel(); renderActions(); renderStatus();
}
document.querySelectorAll('#modes button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

// ---------------- boot ----------------
async function boot() {
  renderActions(); renderStatus();
  requestAnimationFrame(frame);
  try {
    await startCamera();
    S.camError = null;
    setMode(S.mode);
  } catch (e) {
    S.camError = 'אין גישה למצלמה – אשר הרשאת מצלמה לאפליקציה ונסה שוב';
    renderStatus();
    const a = $('#actions'); a.innerHTML = '';
    a.append(btn('🎥 נסה שוב', 'primary', () => location.reload()));
  }
  renderStatus();
}
boot();

// test hooks (used by the automated checks)
window.__snooker = {
  S, setMode, capturePhoto,
  select(color) { const b = S.balls.find((x) => x.color === color); if (b) { S.selId = b.id; requestAnalysis(true); } return b; },
  tapFrame(pt) { return tapFind(pt); },
};
