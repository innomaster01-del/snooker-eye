// Cue-ball tip selector (where to strike the white) and cue elevation drawings.
import { TIP_LIMIT } from './shots.js';
import { TABLE } from './geom.js';

let uid = 0;

// SVG of the cue ball seen from behind with the tip contact point.
export function ballSVG(tip, size = 46, opts = {}) {
  const id = `g${++uid}`;
  const c = 50, r = 46;
  const t = tip && tip !== 'auto' ? tip : null;
  const dx = t ? c + t.x * r : c, dy = t ? c - t.y * r : c;
  const labels = opts.labels ? `
    <text x="50" y="13" class="tl">עליון</text>
    <text x="50" y="93" class="tl">אחורי</text>
    <text x="9" y="52" class="tl" transform="rotate(-90 9 50)">שמאל</text>
    <text x="91" y="52" class="tl" transform="rotate(90 91 50)">ימין</text>` : '';
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" ${opts.id ? `id="${opts.id}"` : ''}>
    <defs><radialGradient id="${id}" cx="38%" cy="32%" r="70%">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#ece9df"/><stop offset="1" stop-color="#b9b5a8"/>
    </radialGradient></defs>
    <style>.tl{font:600 6.5px system-ui;fill:#7c7a72;text-anchor:middle;letter-spacing:.3px}</style>
    <circle cx="50" cy="50" r="${r}" fill="url(#${id})" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
    ${opts.guides !== false ? `<circle cx="50" cy="50" r="${r * TIP_LIMIT}" fill="none" stroke="#8d8a80" stroke-width="0.8" stroke-dasharray="3 2.5"/>
    <circle cx="50" cy="50" r="${r * 0.4}" fill="none" stroke="#b0ada3" stroke-width="0.5"/>
    <line x1="${c - r}" y1="50" x2="${c + r}" y2="50" stroke="#9a978d" stroke-width="0.5"/>
    <line x1="50" y1="${c - r}" x2="50" y2="${c + r}" stroke="#9a978d" stroke-width="0.5"/>` : ''}
    ${labels}
    ${t || opts.showCentre ? `<g ${opts.dotId ? `id="${opts.dotId}"` : ''} transform="translate(${dx} ${dy})">
      ${opts.labels ? '<line x1="-11" y1="0" x2="11" y2="0" stroke="#1b2a44" stroke-width="1.2"/><line x1="0" y1="-11" x2="0" y2="11" stroke="#1b2a44" stroke-width="1.2"/>' : ''}
      <circle r="${opts.labels ? 7 : 9}" fill="#2f7fd6" stroke="#0d3f7a" stroke-width="1.2"/>
      <circle r="${opts.labels ? 2.2 : 3}" cx="-2" cy="-2" fill="rgba(255,255,255,.55)"/>
    </g>` : `<text x="50" y="58" text-anchor="middle" font="700 26px system-ui" style="font:800 26px system-ui;fill:#555">A</text>`}
  </svg>`;
}

// Side view: cue at angle `deg` above the horizontal hitting the ball.
export function elevationSVG(deg, w = 150, h = 70) {
  const a = deg * Math.PI / 180;
  const bx = w - 18, by = h - 14, br = 7;
  const len = w * 0.85;
  const tipx = bx - br * Math.cos(a) - 1, tipy = by - br * Math.sin(a) - 1;
  const ex = tipx - len * Math.cos(a), ey = tipy - len * Math.sin(a);
  const arcR = 34;
  const ax = bx - arcR, ay = by;
  const ax2 = bx - arcR * Math.cos(a), ay2 = by - arcR * Math.sin(a);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" rx="10" fill="#178a8a"/>
    <line x1="6" y1="${by + br}" x2="${w - 6}" y2="${by + br}" stroke="#0d5c5c" stroke-width="2"/>
    <line x1="${bx - 46}" y1="${by}" x2="${bx}" y2="${by}" stroke="#111" stroke-width="1.6"/>
    <line x1="${ex}" y1="${ey}" x2="${tipx}" y2="${tipy}" stroke="#7a3b16" stroke-width="5" stroke-linecap="round"/>
    <line x1="${ex + (tipx - ex) * 0.55}" y1="${ey + (tipy - ey) * 0.55}" x2="${tipx}" y2="${tipy}" stroke="#e7b15a" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M ${ax} ${ay} A ${arcR} ${arcR} 0 0 1 ${ax2} ${ay2}" fill="none" stroke="#111" stroke-width="1.3"/>
    <circle cx="${bx}" cy="${by}" r="${br}" fill="#f4f1e6" stroke="#666" stroke-width="0.8"/>
    <text x="${bx - arcR - 6}" y="${by - 4}" font-size="11" font-weight="700" fill="#fff" text-anchor="end">${Math.round(deg)}°</text>
  </svg>`;
}

export function tipWords(tip) {
  if (!tip || tip === 'auto') return 'אוטומטי';
  const parts = [];
  if (tip.y > 0.45) parts.push('עליון חזק'); else if (tip.y > 0.12) parts.push('עליון');
  else if (tip.y < -0.45) parts.push('אחורי חזק'); else if (tip.y < -0.12) parts.push('אחורי'); else parts.push('מרכז');
  if (tip.x > 0.1) parts.push('ימין'); else if (tip.x < -0.1) parts.push('שמאל');
  return parts.join(' + ');
}

export function tipMm(tip) {
  const R = TABLE.R;
  const out = [];
  const vy = Math.round(Math.abs(tip.y) * R), vx = Math.round(Math.abs(tip.x) * R);
  if (vy >= 2) out.push(`${vy} מ״מ ${tip.y > 0 ? 'מעל' : 'מתחת ל'}מרכז`);
  if (vx >= 2) out.push(`${vx} מ״מ ${tip.x > 0 ? 'ימינה' : 'שמאלה'}`);
  return out.length ? out.join(', ') : 'בדיוק במרכז';
}

// Interactive pad inside a container; calls onChange({x,y}) while dragging.
export function mountTipPad(container, tip, onChange, onEnd) {
  const draw = (t) => {
    container.innerHTML = ballSVG(t, 270, { labels: true, showCentre: true, dotId: 'tipdot' }).replace('<svg ', '<svg class="tippad" ');
  };
  let cur = tip && tip !== 'auto' ? { ...tip } : { x: 0, y: 0 };
  draw(cur);
  const pick = (e) => {
    const svg = container.querySelector('svg');
    const r = svg.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width * 100 - 50) / 46;
    let y = -((e.clientY - r.top) / r.height * 100 - 50) / 46;
    const m = Math.hypot(x, y);
    if (m > TIP_LIMIT) { x *= TIP_LIMIT / m; y *= TIP_LIMIT / m; }
    cur = { x: Math.round(x * 40) / 40, y: Math.round(y * 40) / 40 };
    const dot = container.querySelector('#tipdot');
    if (dot) dot.setAttribute('transform', `translate(${50 + cur.x * 46} ${50 - cur.y * 46})`);
    onChange(cur);
  };
  let down = false;
  container.onpointerdown = (e) => { down = true; container.setPointerCapture(e.pointerId); pick(e); };
  container.onpointermove = (e) => { if (down) pick(e); };
  container.onpointerup = () => { if (down) { down = false; onEnd(cur); } };
  return { set: (t) => { cur = { ...t }; draw(cur); } };
}
