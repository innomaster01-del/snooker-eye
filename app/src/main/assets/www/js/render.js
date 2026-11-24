// Overlay drawing: broadcast-style shot lines projected onto the real table,
// ghost ball, cue-ball path, pocket rings and a top-down mini map.
import { TABLE, applyH, scaleAt } from './geom.js';
import { BALL_HEX } from './vision.js';
import { POCKETS } from './shots.js';

const { L, W, R } = TABLE;

export function lineColorFor(color) {
  if (color === 'black') return '#e9e9e9';
  if (color === 'white') return '#ffffff';
  if (color === 'brown') return '#e0a060';
  if (color === 'green') return '#6dff9a';
  if (color === 'blue') return '#6fa0ff';
  if (color === 'red') return '#ff5a5a';
  return BALL_HEX[color] || '#ffd84a';
}

export class Renderer {
  constructor(ctx) { this.ctx = ctx; this.view = { s: 1, ox: 0, oy: 0 }; this.t = 0; }

  setView(view) { this.view = view; }

  fr2scr(p) { const { s, ox, oy } = this.view; return { x: p.x * s + ox, y: p.y * s + oy }; }
  scr2fr(p) { const { s, ox, oy } = this.view; return { x: (p.x - ox) / s, y: (p.y - oy) / s }; }

  tb(p, H) { return this.fr2scr(applyH(H, p)); }

  poly(pts, H, style) {
    const c = this.ctx;
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = style.color; c.lineWidth = style.width || 3;
    if (style.dash) c.setLineDash(style.dash);
    if (style.glow) { c.shadowColor = style.glow; c.shadowBlur = style.blur || 10; }
    c.globalAlpha = style.alpha == null ? 1 : style.alpha;
    c.beginPath();
    // subdivide so lines stay correct even if the homography bends near the horizon
    let first = true;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (i === 0) { const s = this.tb(a, H); c.moveTo(s.x, s.y); first = false; continue; }
      const b = pts[i - 1];
      const n = 6;
      for (let k = 1; k <= n; k++) {
        const q = this.tb({ x: b.x + (a.x - b.x) * k / n, y: b.y + (a.y - b.y) * k / n }, H);
        c.lineTo(q.x, q.y);
      }
    }
    if (!first) c.stroke();
    c.restore();
  }

  ballRadiusScr(p, Hb) { return R * scaleAt(Hb, p) * this.view.s; }

  ring(p, Hb, style) {
    const c = this.ctx, s = this.tb(p, Hb), r = (style.r || 1) * this.ballRadiusScr(p, Hb);
    c.save();
    c.strokeStyle = style.color; c.lineWidth = style.width || 2;
    if (style.dash) c.setLineDash(style.dash);
    if (style.glow) { c.shadowColor = style.glow; c.shadowBlur = style.blur || 8; }
    c.globalAlpha = style.alpha == null ? 1 : style.alpha;
    c.beginPath(); c.arc(s.x, s.y, Math.max(3, r), 0, Math.PI * 2);
    if (style.fill) { c.fillStyle = style.fill; c.fill(); }
    c.stroke();
    c.restore();
    return { s, r };
  }

  dot(p, H, color, rad = 4) {
    const c = this.ctx, s = this.tb(p, H);
    c.save(); c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 8;
    c.beginPath(); c.arc(s.x, s.y, rad, 0, Math.PI * 2); c.fill(); c.restore();
  }

  pill(x, y, text, opts = {}) {
    const c = this.ctx;
    c.save();
    c.font = `${opts.bold ? 700 : 600} ${opts.size || 14}px system-ui, "Segoe UI", Arial`;
    c.direction = 'rtl';
    const w = c.measureText(text).width + 18, h = (opts.size || 14) + 12;
    let bx = x - w / 2, by = y - h / 2;
    bx = Math.max(4, Math.min(c.canvas.width / (window.devicePixelRatio || 1) - w - 4, bx));
    by = Math.max(4, by);
    c.fillStyle = opts.bg || 'rgba(8,14,24,0.78)';
    c.strokeStyle = opts.border || 'rgba(255,255,255,0.25)';
    c.lineWidth = 1;
    c.beginPath(); c.roundRect(bx, by, w, h, h / 2); c.fill(); c.stroke();
    c.fillStyle = opts.color || '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, bx + w / 2, by + h / 2 + 1);
    c.restore();
  }

  tableOutline(calib, alpha = 0.55) {
    const pts = [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }, { x: 0, y: 0 }];
    this.poly(pts, calib.H, { color: 'rgba(120,255,200,0.9)', width: 1.5, alpha, dash: [6, 6] });
    for (const pk of POCKETS) this.ring({ x: pk.x, y: pk.y }, calib.H, { color: 'rgba(120,255,200,0.8)', width: 1.2, r: 1.6, alpha: alpha * 0.8 });
  }

  quadHandles(quad, active) {
    const c = this.ctx;
    c.save();
    c.strokeStyle = '#ffd84a'; c.lineWidth = 2; c.setLineDash([8, 6]);
    c.beginPath();
    quad.forEach((p, i) => { const s = this.fr2scr(p); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
    c.closePath(); c.stroke(); c.setLineDash([]);
    quad.forEach((p, i) => {
      const s = this.fr2scr(p);
      c.fillStyle = i === active ? '#ffd84a' : 'rgba(255,216,74,0.35)';
      c.strokeStyle = '#ffd84a'; c.lineWidth = 2.5;
      c.beginPath(); c.arc(s.x, s.y, 16, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = '#111'; c.font = '700 13px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(i + 1), s.x, s.y + 1);
    });
    c.restore();
  }

  balls(calib, balls, selId, editMode) {
    for (const b of balls) {
      const sel = b.id === selId;
      const col = b.color === 'white' ? '#ffffff' : lineColorFor(b.color);
      this.ring(b, calib.Hb, {
        color: sel ? '#ffd84a' : col, width: sel ? 3 : 1.4, r: sel ? 1.55 : 1.25,
        alpha: sel ? 1 : (editMode ? 0.95 : 0.6), glow: sel ? '#ffd84a' : null, dash: editMode && !sel ? [4, 3] : null,
      });
    }
  }

  shot(calib, shot, balls, opts = {}) {
    const Hb = calib.Hb;
    const faint = !!opts.faint;
    const cueBall = balls.find((b) => b.color === 'white');
    const tgt = balls.find((b) => b.id === shot.target);
    const objCol = lineColorFor(shot.targetColor);
    if (faint) {
      this.poly(shot.cuePath, Hb, { color: '#ffffff', width: 1.5, alpha: 0.35 });
      this.poly(shot.objPath, Hb, { color: objCol, width: 1.5, alpha: 0.35 });
      return;
    }
    const pulse = 0.75 + 0.25 * Math.sin(this.t * 4);
    // cue ball path to the ghost
    this.poly(shot.cuePath, Hb, { color: '#ffffff', width: 3.2, glow: 'rgba(255,255,255,0.9)', blur: 12 });
    for (let i = 1; i < shot.cuePath.length - 1; i++) this.dot(shot.cuePath[i], Hb, '#ffffff', 4.5);
    // ghost ball
    this.ring(shot.ghost, Hb, { color: '#ffffff', width: 2.2, dash: [5, 4], fill: 'rgba(255,255,255,0.18)', glow: '#fff', blur: 10, alpha: pulse });
    // combo middle leg
    if (shot.type === 'combo') {
      const fc = lineColorFor(shot.firstColor);
      this.poly(shot.midPath, Hb, { color: fc, width: 3, glow: fc, blur: 10 });
      this.ring(shot.ghost2, Hb, { color: fc, width: 1.8, dash: [4, 4], fill: 'rgba(255,255,255,0.10)' });
    }
    // object ball to pocket
    this.poly(shot.objPath, Hb, { color: objCol, width: 3.4, glow: objCol, blur: 14 });
    for (let i = 1; i < shot.objPath.length - 1; i++) this.dot(shot.objPath[i], Hb, objCol, 4.5);
    const pk = POCKETS[shot.pocket];
    const ps = this.tb({ x: pk.x, y: pk.y }, calib.H);
    const pr = 2.2 * R * scaleAt(calib.H, { x: pk.x, y: pk.y }) * this.view.s;
    const c = this.ctx;
    c.save(); c.strokeStyle = objCol; c.lineWidth = 3; c.shadowColor = objCol; c.shadowBlur = 16; c.globalAlpha = pulse;
    c.beginPath(); c.arc(ps.x, ps.y, Math.max(8, pr), 0, Math.PI * 2); c.stroke(); c.restore();
    // cue ball after contact
    const after = shot.play && shot.play.after;
    if (after && after.path.length > 1) {
      const foul = after.scratch != null;
      const ac = foul ? '#ff4d4d' : '#4fd8ff';
      this.poly(after.path, Hb, { color: ac, width: 2.6, dash: [9, 7], glow: ac, blur: 10 });
      const e = this.ring(after.end, Hb, { color: ac, width: 2.2, fill: foul ? 'rgba(255,60,60,0.25)' : 'rgba(79,216,255,0.22)', glow: ac });
      if (opts.labels !== false) this.pill(e.s.x, e.s.y - e.r - 18, foul ? 'פאול – הלבן נכנס' : (after.kiss != null ? 'הלבן יפגע בכדור' : 'הלבן ייעצר כאן'), { size: 12, color: ac });
    }
    if (tgt && opts.labels !== false && opts.label) {
      const g = this.tb(shot.ghost, Hb);
      const rr = this.ballRadiusScr(shot.ghost, Hb);
      this.pill(g.x, g.y + rr + 22, opts.label, { size: 14, bold: true });
    }
    if (cueBall && opts.hideCueRing !== true) this.ring(cueBall, Hb, { color: '#fff', width: 2.5, r: 1.35, glow: '#fff' });
  }

  minimap(rect, balls, shots, selShot, selId) {
    const c = this.ctx;
    const { x, y, w } = rect;
    const pad = w * 0.045, h = w * (W / L) + pad * 2;
    const sx = (w - pad * 2) / L;
    const P = (p) => ({ x: x + pad + p.x * sx, y: y + pad + (W - p.y) * sx });
    c.save();
    c.fillStyle = 'rgba(40,22,10,0.92)'; c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1;
    c.beginPath(); c.roundRect(x, y, w, h, 10); c.fill(); c.stroke();
    c.fillStyle = '#0f6b34';
    c.fillRect(x + pad, y + pad, L * sx, W * sx);
    // baulk line + D
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1;
    const b1 = P({ x: 737, y: 0 }), b2 = P({ x: 737, y: W });
    c.beginPath(); c.moveTo(b1.x, b1.y); c.lineTo(b2.x, b2.y); c.stroke();
    const dc = P({ x: 737, y: W / 2 });
    c.beginPath(); c.arc(dc.x, dc.y, 292 * sx, Math.PI / 2, Math.PI * 1.5); c.stroke();
    c.fillStyle = '#000';
    for (const pk of POCKETS) { const q = P(pk); c.beginPath(); c.arc(q.x, q.y, 48 * sx, 0, Math.PI * 2); c.fill(); }
    const pl = (pts, col, wd, dash) => {
      c.save(); c.strokeStyle = col; c.lineWidth = wd; if (dash) c.setLineDash(dash);
      c.beginPath(); pts.forEach((p, i) => { const q = P(p); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); }); c.stroke(); c.restore();
    };
    if (selShot) {
      pl(selShot.cuePath, '#fff', 1.6);
      if (selShot.midPath) pl(selShot.midPath, lineColorFor(selShot.firstColor), 1.6);
      pl(selShot.objPath, lineColorFor(selShot.targetColor), 1.8);
      if (selShot.play && selShot.play.after) pl(selShot.play.after.path, selShot.play.after.scratch != null ? '#ff4d4d' : '#4fd8ff', 1.3, [4, 3]);
      const g = P(selShot.ghost);
      c.strokeStyle = '#fff'; c.setLineDash([2, 2]); c.beginPath(); c.arc(g.x, g.y, R * sx, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
      if (selShot.play && selShot.play.after) { const e = P(selShot.play.after.end); c.strokeStyle = '#4fd8ff'; c.beginPath(); c.arc(e.x, e.y, R * sx, 0, Math.PI * 2); c.stroke(); }
    }
    for (const b of balls) {
      const q = P(b);
      c.fillStyle = BALL_HEX[b.color]; c.strokeStyle = b.id === selId ? '#ffd84a' : 'rgba(0,0,0,0.6)'; c.lineWidth = b.id === selId ? 2 : 0.8;
      c.beginPath(); c.arc(q.x, q.y, Math.max(2.2, R * sx), 0, Math.PI * 2); c.fill(); c.stroke();
    }
    c.restore();
    return { x, y, w, h, P };
  }
}
