// Synthetic snooker table rendered in perspective, used as a stand-in camera
// (demo mode) and for automated accuracy tests. Ground truth is exposed.
import { TABLE } from '../js/geom.js';
import { BALL_HEX } from '../js/vision.js';

const { L, W, R } = TABLE;

export function demoLayout(seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const balls = [
    { color: 'white', x: 900, y: 620 },
    { color: 'yellow', x: 737, y: W / 2 + 292 },
    { color: 'green', x: 737, y: W / 2 - 292 },
    { color: 'brown', x: 737, y: W / 2 },
    { color: 'blue', x: L / 2, y: W / 2 },
    { color: 'pink', x: 2677, y: W / 2 },
    { color: 'black', x: L - 324, y: W / 2 },
  ];
  const reds = [
    [2760, 760], [2800, 1010], [2850, 890], [3010, 500], [2350, 1240], [1950, 420], [2500, 640], [3150, 1300],
  ];
  for (const [x, y] of reds) balls.push({ color: 'red', x: x + (rnd() - 0.5) * 30, y: y + (rnd() - 0.5) * 30 });
  return balls.map((b, i) => ({ ...b, id: i + 1 }));
}

function lookAt(C, T) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = nrm(sub(T, C));
  const x = nrm(cr(z, [0, 0, 1]));
  const y = cr(z, x);
  return { x, y, z, C };
}

export class DemoCamera {
  constructor(w = 1280, h = 720) {
    this.w = w; this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.balls = demoLayout(7);
    this.f = 0.62 * w;
    this.sway = 0;
    this.time = 0;
    this.camPos = [-1300, W / 2 - 200, 2000];
    this.target = [L * 0.42, W / 2, 0];
    this.roll = 0;
    this.noise = this.makeNoise();
  }

  makeNoise() {
    this.noiseTiles = [];
    for (let k = 0; k < 4; k++) {
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const x = c.getContext('2d'); const d = x.createImageData(128, 128);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.random() < 0.5 ? 0 : 255;
        d.data[i] = v; d.data[i + 1] = Math.random() < 0.5 ? 0 : 255; d.data[i + 2] = v; d.data[i + 3] = 10 + Math.random() * 22;
      }
      x.putImageData(d, 0, 0); this.noiseTiles.push(c);
    }
    return this.noiseTiles[0];
  }

  proj(P) {
    const { x, y, z, C } = this.cam;
    const d = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
    const cx = x[0] * d[0] + x[1] * d[1] + x[2] * d[2];
    const cy = y[0] * d[0] + y[1] * d[1] + y[2] * d[2];
    const cz = z[0] * d[0] + z[1] * d[1] + z[2] * d[2];
    let u = this.f * cx / cz, v = this.f * cy / cz;
    const cs = Math.cos(this.roll), sn = Math.sin(this.roll);
    return { x: u * cs - v * sn + this.w / 2, y: u * sn + v * cs + this.h / 2, z: cz };
  }

  polyPlane(pts, fill) {
    const c = this.ctx; c.fillStyle = fill; c.beginPath();
    pts.forEach((p, i) => { const q = this.proj([p[0], p[1], p[2] || 0]); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); });
    c.closePath(); c.fill();
  }

  circlePlane(cx, cy, z, r, fill, n = 28) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]); }
    this.polyPlane(pts, fill);
  }

  render(dt = 0, moving = false) {
    this.time += dt;
    let C = this.camPos.slice(), T = this.target.slice();
    this.roll = 0;
    if (moving) {
      const t = this.time;
      C = [C[0] + Math.sin(t * 0.7) * 90, C[1] + Math.sin(t * 0.53) * 160, C[2] + Math.sin(t * 0.9) * 60];
      T = [T[0] + Math.sin(t * 0.4) * 120, T[1] + Math.cos(t * 0.6) * 80, 0];
      this.roll = Math.sin(t * 0.8) * 0.03;
    }
    this.cam = lookAt(C, T);
    const c = this.ctx, w = this.w, h = this.h;
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#1b1f27'); bg.addColorStop(1, '#2c2620');
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    // floor + table body
    this.polyPlane([[-2500, -2000, -800], [L + 2500, -2000, -800], [L + 2500, W + 2000, -800], [-2500, W + 2000, -800]], '#3a3029');
    const rail = 160, cush = 48;
    this.polyPlane([[-cush - rail, -cush - rail], [L + cush + rail, -cush - rail], [L + cush + rail, W + cush + rail], [-cush - rail, W + cush + rail]], '#5a2f17');
    this.polyPlane([[-cush - rail, -cush - rail, 0], [L + cush + rail, -cush - rail, 0], [L + cush + rail, -cush - rail, -120], [-cush - rail, -cush - rail, -120]], '#3d1f0e');
    // cushions (slightly darker cloth) and playing cloth
    this.polyPlane([[-cush, -cush], [L + cush, -cush], [L + cush, W + cush], [-cush, W + cush]], '#17663a');
    const g = c.createRadialGradient(w / 2, h * 0.55, 30, w / 2, h * 0.55, w * 0.7);
    g.addColorStop(0, '#249a4e'); g.addColorStop(1, '#1b7c3e');
    this.polyPlane([[0, 0], [L, 0], [L, W], [0, W]], g);
    // pockets
    const pk = [[0, 0], [L / 2, -18], [L, 0], [L, W], [L / 2, W + 18], [0, W]];
    for (const [x, y] of pk) this.circlePlane(x, y, 0.5, 52, '#050505');
    // baulk line & D
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1;
    const a = this.proj([737, 0, 0]), b = this.proj([737, W, 0]);
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    // balls (far to near)
    const order = this.balls.map((bl) => ({ bl, z: this.proj([bl.x, bl.y, R]).z })).sort((p, q) => q.z - p.z);
    for (const { bl } of order) this.circlePlane(bl.x + 14, bl.y - 10, 0.6, R * 1.15, 'rgba(0,30,10,0.35)');
    for (const { bl } of order) {
      const p = this.proj([bl.x, bl.y, R]);
      const r = this.f * R / p.z;
      const base = bl.color === 'green' ? '#0b5427' : BALL_HEX[bl.color];
      const gr = c.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.08, p.x, p.y, r * 1.05);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.18, base); gr.addColorStop(0.85, base); gr.addColorStop(1, shade(base, 0.55));
      c.fillStyle = gr; c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
    }
    // a cue lying on the cloth and a chalk cube on the rail (must not become balls)
    const c1 = this.proj([1150, 260, 15]), c2 = this.proj([2350, 120, 15]);
    c.strokeStyle = '#c9a36a'; c.lineWidth = Math.max(2, this.f * 13 / c1.z); c.lineCap = 'round';
    c.beginPath(); c.moveTo(c1.x, c1.y); c.lineTo(c2.x, c2.y); c.stroke();
    this.polyPlane([[2000, W + 60, 1], [2030, W + 60, 1], [2030, W + 90, 1], [2000, W + 90, 1]], '#2a6fd0');
    // overhead lamp hot spots
    for (const lx of [L * 0.25, L * 0.5, L * 0.75]) {
      const q = this.proj([lx, W / 2, 0]);
      const rg = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, w * 0.12);
      rg.addColorStop(0, 'rgba(255,255,230,0.16)'); rg.addColorStop(1, 'rgba(255,255,230,0)');
      c.fillStyle = rg; c.fillRect(0, 0, w, h);
    }
    // sensor noise (changes every frame) + slight blur like a real phone stream
    this.tick = (this.tick || 0) + 1;
    const tile = this.noiseTiles[this.tick % this.noiseTiles.length];
    for (let y = 0; y < h; y += 128) for (let x = 0; x < w; x += 128) c.drawImage(tile, x, y);
    if (!this.out) { this.out = document.createElement('canvas'); this.out.width = w; this.out.height = h; this.octx = this.out.getContext('2d'); }
    this.octx.filter = 'blur(0.7px)';
    this.octx.drawImage(this.canvas, 0, 0);
    return this.out;
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
