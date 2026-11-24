// Snooker Eye – main app: camera, three modes (photo / tripod live / handheld live),
// editing, analysis requests and drawing.
import { TABLE, applyH, v } from './geom.js';
import {
  detectTable, calibrate, detectBalls, alignQuad, hsvArrays, BALL_HE, BALL_HEX, BALL_COLORS,
} from './vision.js';
import { thicknessLabel, SPIN_HE, POCKETS } from './shots.js';
import { Renderer } from './render.js';
import { DemoCamera } from './demo.js';

const $ = (s) => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const vid = $('#vid');
const R = new Renderer(ctx);
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

// ---------------- state ----------------
const DEFAULTS = { power: 'auto', spin: 'auto', on: 'free', skill: 0.15, maxCush: 2, margin: 45, minimap: true, alts: true };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('se.settings.v2') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem('se.settings.v2', JSON.stringify(S.set)); } catch { /* storage unavailable */ } }

const S = {
  mode: 'photo', source: 'camera', camReady: false, camError: null,
  frozen: null, frozenW: 0, frozenH: 0,
  quad: null, calib: null, hue: null, orient: 'auto', tableSeen: false,
  balls: [], nextId: 1, selId: null,
  showRec: false, shots: [], shotIdx: 0,
  editCorners: false, editBalls: false, locked: false,
  set: loadSettings(),
  lastProc: 0, lastTableProbe: 0, quadHistory: [],
};

const demo = new DemoCamera(1280, 720);

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
    targetId: target, mode, power: st.power === 'auto' ? 'auto' : Number(st.power), spin: st.spin,
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
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  vid.srcObject = stream;
  await vid.play().catch(() => {});
  await new Promise((r) => { if (vid.videoWidth) r(); else vid.onloadedmetadata = () => r(); });
  S.camReady = true;
}

function source() {
  if (S.mode === 'photo' && S.frozen) return { el: S.frozen, w: S.frozenW, h: S.frozenH, live: false };
  if (S.source === 'demo') return { el: demo.canvas, w: demo.w, h: demo.h, live: true };
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

function setCalibFromQuad(quad, w, h) {
  const c = calibrate(quad, w, h, Number(S.set.margin), S.orient);
  if (!c) return false;
  if (S.orient === 'auto' && S.mode !== 'photo') S.orient = c.orient;
  S.quad = quad; S.calib = c;
  return true;
}

// simple multi-object tracker in table coordinates
function track(dets) {
  const out = [];
  const used = new Set();
  const tracks = S.balls;
  for (const t of tracks) {
    let best = null, bd = 70;
    dets.forEach((d, i) => {
      if (used.has(i) || d.color !== t.color) return;
      const dd = Math.hypot(d.x - t.x, d.y - t.y);
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best != null) {
      used.add(best);
      const d = dets[best];
      const a = bd > 30 ? 1 : 0.45;
      out.push({ ...t, x: t.x + (d.x - t.x) * a, y: t.y + (d.y - t.y) * a, img: d.img, miss: 0 });
    } else if ((t.miss || 0) < 5) out.push({ ...t, miss: (t.miss || 0) + 1 });
  }
  dets.forEach((d, i) => { if (!used.has(i)) out.push({ ...d, id: S.nextId++, miss: 0 }); });
  S.balls = out;
}

function processLive(src, now) {
  const handheld = S.mode === 'hand';
  const g = grab(src, 640);
  if (S.mode === 'photo') {
    // framing helper: show detected table outline before taking the photo
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (t.ok) { setCalibFromQuad(t.quad, src.w, src.h); S.hue = t.hue; S.tableSeen = true; }
    else { S.tableSeen = false; S.calib = null; }
    S.balls = [];
    return;
  }
  if (S.mode === 'tripod' && !S.locked) {
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (t.ok) {
      S.quadHistory.push(t.quad); if (S.quadHistory.length > 6) S.quadHistory.shift();
      const q = S.quad ? alignQuad(S.quad, t.quad).quad : t.quad;
      setCalibFromQuad(q, src.w, src.h); S.hue = t.hue; S.tableSeen = true;
    } else S.tableSeen = false;
  }
  if (handheld) {
    const t = detectTable(g.img, 1 / g.k, g.hsv);
    if (t.ok) {
      S.hue = t.hue;
      let q = t.quad;
      if (S.quad) {
        const al = alignQuad(S.quad, t.quad);
        q = al.quad;
        const diag = Math.hypot(src.w, src.h);
        const a = al.dist > diag * 0.06 ? 1 : 0.55;
        q = q.map((p, i) => ({ x: S.quad[i].x + (p.x - S.quad[i].x) * a, y: S.quad[i].y + (p.y - S.quad[i].y) * a }));
      }
      setCalibFromQuad(q, src.w, src.h); S.tableSeen = true;
    } else { S.tableSeen = false; }
  }
  if (S.calib && S.hue != null && S.tableSeen !== false) {
    const dets = detectBalls(g.img, S.calib, S.hue, g.k, g.hsv);
    track(dets);
    if (S.selId != null && !S.balls.some((b) => b.id === S.selId)) S.selId = null;
    requestAnalysis();
  }
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
  const g = grab(src, 1280);
  if (detectQuad || !S.quad) {
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
  const dets = detectBalls(g.img, S.calib, S.hue, g.k, g.hsv);
  S.nextId = 1;
  S.balls = dets.map((d) => ({ ...d, id: S.nextId++ }));
  if (!S.balls.some((b) => b.color === 'white')) toast('לא נמצא כדור לבן – הוסף אותו ב"עריכת כדורים"');
  requestAnalysis(true);
  renderStatus();
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
  if (S.source === 'demo' && !(S.mode === 'photo' && S.frozen)) demo.render(dt, S.mode === 'hand');
  const src = source();
  if (src) {
    const s = Math.min(cw / src.w, ch / src.h);
    const view = { s, ox: (cw - src.w * s) / 2, oy: (ch - src.h * s) / 2 };
    R.setView(view);
    ctx.drawImage(src.el, view.ox, view.oy, src.w * s, src.h * s);
    const interval = S.mode === 'photo' ? 350 : 90;
    if (src.live && ts - S.lastProc > interval) {
      S.lastProc = ts;
      try { processLive(src, ts); } catch (e) { console.error(e); }
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

function tipFor(s) {
  const far = s.cueDist > 1500;
  if (s.spin === 'follow') return 'פגע בלבן מעל המרכז';
  if (s.spin === 'stun') return far ? 'פגע בלבן מעט מתחת למרכז' : 'פגע בלבן במרכז';
  return far ? 'פגע בלבן נמוך מאוד, מכה חדה' : 'פגע בלבן מתחת למרכז';
}

// ---------------- panel ----------------
function renderPanel() {
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
    <div class="kv">
      <span class="k">סוג</span><span class="v">${typeHe}${cur.cueCush ? ` (${cur.cueCush} גומי)` : ''}</span>
      <span class="k">זווית חיתוך</span><span class="v big">${Math.round(cur.cut)}° ${cutSide(cur)}</span>
      <span class="k">עובי פגיעה</span><span class="v">${thicknessLabel(cur.cut)}</span>
      <span class="k">כוח</span><span class="v">${'●'.repeat(cur.power)}${'○'.repeat(5 - cur.power)} ${cur.power}/5</span>
      <span class="k">סיבוב</span><span class="v">${SPIN_HE[cur.spin]}</span>
      <span class="k">סיכוי להכניס</span><span class="v">${pct(cur.pPot)}<div class="bar"><i style="width:${pct(cur.pPot)}"></i></div></span>
      ${cur.nextP > 0 ? `<span class="k">עמדה לבא</span><span class="v">${pct(cur.nextP)}</span>` : ''}
    </div>
    <div class="tip">🎯 כוון את הלבן למרכז העיגול הלבן · ${tipFor(cur)}</div>
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
  if (S.camError && S.source === 'camera') { st.textContent = S.camError; st.classList.add('warn'); return; }
  if (S.mode === 'photo' && !S.frozen) {
    st.textContent = S.tableSeen ? 'השולחן בפריים ✓ – צלם' : 'כוון את המצלמה כך שכל השולחן ייראה';
    if (S.tableSeen) st.classList.add('ok');
    return;
  }
  if (!S.calib) { st.textContent = 'מחפש שולחן…'; return; }
  const n = S.balls.length;
  const white = S.balls.some((b) => b.color === 'white');
  let t = `${S.mode === 'tripod' ? (S.locked ? '🔒 שולחן נעול' : 'שולחן זוהה') : 'שולחן'} · ${n} כדורים`;
  if (!white) t += ' · אין לבן';
  if (S.calib.elev < 14) { t += ' · הרם את הטלפון לדיוק'; st.classList.add('warn'); } else st.classList.add('ok');
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
let dragCorner = -1, dragBall = null, downPt = null, moved = false;

function evPt(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function ballAtScreen(p) {
  if (!S.calib) return null;
  let best = null, bd = Infinity;
  for (const b of S.balls) {
    const s = scrOf(b);
    const r = Math.max(22, R.ballRadiusScr(b, S.calib.Hb) * 1.8);
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
  downPt = evPt(e); moved = false;
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
  if (!downPt) return;
  downPt = null;
  if (moved) {
    if (wasCorner && S.mode === 'photo' && S.frozen) analyzeFrozen(false);
    if (wasBall) requestAnalysis(true);
    return;
  }
  if (S.editCorners) return;
  if (S.editBalls) { if (S.calib) openBallSheet(ballAtScreen(p), screenToTable(p)); return; }
  const b = ballAtScreen(p);
  if (b) {
    S.selId = b.id; S.showRec = false;
    if (b.color === 'white') toast('זה הלבן – גע בכדור שאתה רוצה להכניס');
  } else S.selId = null;
  S.shotIdx = 0;
  requestAnalysis(true); renderActions(); renderStatus();
});

// ---------------- sheets ----------------
function openSheet(title, html) {
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
    $('#delBall').onclick = () => { S.balls = S.balls.filter((x) => x !== ball); if (S.selId === ball.id) S.selId = null; closeSheet(); requestAnalysis(true); };
  } else {
    if (tpos.x < 0 || tpos.y < 0 || tpos.x > TABLE.L || tpos.y > TABLE.W) { toast('הנקודה מחוץ לשולחן'); return; }
    openSheet('הוסף כדור כאן', colorButtons());
    $('#sheetBody').querySelectorAll('[data-c]').forEach((b) => {
      b.onclick = () => {
        const nb = { id: S.nextId++, color: 'red', x: Math.min(TABLE.L - TABLE.R, Math.max(TABLE.R, tpos.x)), y: Math.min(TABLE.W - TABLE.R, Math.max(TABLE.R, tpos.y)) };
        S.balls.push(nb); setColor(nb, b.dataset.c); closeSheet();
      };
    });
  }
}

function setColor(ball, c) {
  if (c !== 'red') for (const o of S.balls) if (o !== ball && o.color === c) o.color = 'red';
  ball.color = c;
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
bindSeg('#segSpin', 'spin');

// ---------------- modes / source ----------------
function setMode(m) {
  S.mode = m;
  S.frozen = null; S.editBalls = false; S.editCorners = false; S.locked = false;
  S.balls = []; S.selId = null; S.shots = []; S.showRec = false; S.quad = null; S.calib = null; S.orient = 'auto'; S.quadHistory = [];
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

function setSource(s) {
  S.source = s;
  $('#btnSource').textContent = s === 'demo' ? '🎮 דמו' : '🎥 מצלמה';
  setMode(S.mode);
}
$('#btnSource').onclick = () => setSource(S.source === 'demo' ? 'camera' : 'demo');

// ---------------- boot ----------------
async function boot() {
  const params = new URLSearchParams(location.search);
  renderActions(); renderStatus();
  requestAnimationFrame(frame);
  if (params.has('demo')) { setSource('demo'); return; }
  try {
    await startCamera();
    S.camError = null;
  } catch (e) {
    S.camError = 'אין גישה למצלמה – עובר לדמו';
    toast('אין גישה למצלמה. אפשר לנסות במצב דמו');
    setSource('demo');
  }
  renderStatus();
}
boot();

// test hooks (used by the automated checks)
window.__snooker = {
  S, demo,
  setMode, setSource, capturePhoto,
  select(color) { const b = S.balls.find((x) => x.color === color); if (b) { S.selId = b.id; requestAnalysis(true); } return b; },
  truth() { return demo.balls; },
};
