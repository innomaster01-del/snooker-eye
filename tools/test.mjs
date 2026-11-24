// Headless end-to-end check. The app runs its real camera code path; the camera
// stream is a synthetic, noisy snooker table (tools/demo.js) injected in place of
// getUserMedia. Measures detection accuracy, stability and false positives.
// usage: node tools/test.mjs [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../app/src/main/assets/www');
const out = path.resolve(process.argv[2] || 'test-out');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = u.startsWith('/__test/') ? path.join(here, u.slice(8)) : path.join(root, u === '/' ? 'index.html' : u);
  fs.readFile(p, (err, d) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
}).listen(0);
const port = server.address().port;

const FAKE_CAMERA = () => {
  window.__demoMoving = false;
  navigator.mediaDevices.getUserMedia = async () => {
    const { DemoCamera } = await import('/__test/demo.js');
    const cam = new DemoCamera(1280, 720);
    window.__demo = cam;
    const outC = document.createElement('canvas'); outC.width = 1280; outC.height = 720;
    const octx = outC.getContext('2d');
    let last = performance.now();
    const loop = (t) => { const f = cam.render((t - last) / 1000, window.__demoMoving); last = t; octx.drawImage(f, 0, 0); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return outC.captureStream(30);
  };
};

function score(res, name) {
  const errVals = res.errs.filter((e) => !e.miss).map((e) => e.err);
  const mean = errVals.reduce((a, b) => a + b, 0) / Math.max(1, errVals.length);
  console.log(`[${name}] found ${res.n}/${res.truth}, missing ${res.missing} ${JSON.stringify(res.errs.filter((e) => e.miss).map((e) => e.color))}, false ${res.extra.length} ${JSON.stringify(res.extra)}, mean err ${mean.toFixed(1)}mm, max ${Math.max(0, ...errVals).toFixed(1)}mm`);
  return { mean, ...res };
}

const MEASURE = () => {
  const { S } = window.__snooker;
  const truth = () => window.__demo.balls;
  const L = 3569, W = 1778;
  const syms = [(b) => b, (b) => ({ ...b, x: L - b.x }), (b) => ({ ...b, y: W - b.y }), (b) => ({ ...b, x: L - b.x, y: W - b.y })];
  let tr = truth(), bestS = 1e18;
  for (const f of syms) {
    const t2 = truth().map(f); let sum = 0;
    for (const t of t2) { let bd = 1e6; for (const d of S.balls) if (d.color === t.color) bd = Math.min(bd, Math.hypot(d.x - t.x, d.y - t.y)); sum += Math.min(bd, 500); }
    if (sum < bestS) { bestS = sum; tr = t2; }
  }
  const det = S.balls; const used = new Set(); const errs = []; let missing = 0;
  for (const t of tr) {
    let best = null, bd = 1e9;
    det.forEach((d, i) => { if (used.has(i) || d.color !== t.color) return; const dd = Math.hypot(d.x - t.x, d.y - t.y); if (dd < bd) { bd = dd; best = i; } });
    if (best == null || bd > 80) { missing++; errs.push({ color: t.color, miss: true }); } else { used.add(best); errs.push({ color: t.color, err: bd }); }
  }
  const extra = det.filter((_, i) => !used.has(i)).map((d) => ({ c: d.color, x: Math.round(d.x), y: Math.round(d.y) }));
  return { n: det.length, truth: tr.length, missing, extra, errs, ids: det.map((d) => d.id).sort((a, b) => a - b).join(',') };
};

const browser = await chromium.launch();
const errors = [];
let fail = 0;
async function run(viewport, name) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.stack}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.addInitScript(FAKE_CAMERA);
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(2000);
  // photo
  await page.evaluate(() => window.__snooker.capturePhoto());
  await page.waitForTimeout(500);
  let r = score(await page.evaluate(MEASURE), `${name} photo`);
  if (r.missing > 1 || r.extra.length > 1 || r.mean > 25) fail++;
  await page.screenshot({ path: path.join(out, `${name}-1-photo.png`) });
  // remove the detected pink, then tap where it is (tap-search path)
  await page.evaluate(() => { const S = window.__snooker.S; const p = S.balls.find((b) => b.color === 'pink'); S.balls = S.balls.filter((b) => b !== p); });
  const pinkScr = await page.evaluate(() => {
    const t = window.__demo.balls.find((b) => b.color === 'pink');
    const p = window.__demo.proj([t.x, t.y, 26.25]);
    const cv = document.querySelector('#cv');
    const s = Math.min(cv.clientWidth / 1280, cv.clientHeight / 720);
    return { x: p.x * s + (cv.clientWidth - 1280 * s) / 2 + 3, y: p.y * s + (cv.clientHeight - 720 * s) / 2 - 2 };
  });
  await page.mouse.click(pinkScr.x, pinkScr.y);
  await page.waitForTimeout(2500);
  const tapRes = await page.evaluate(() => { const S = window.__snooker.S; const b = S.balls.find((x) => x.id === S.selId); return b ? { color: b.color, x: Math.round(b.x), y: Math.round(b.y), shots: S.shots.length } : null; });
  console.log(`[${name}] tap on pink ->`, JSON.stringify(tapRes));
  if (name === 'landscape' && (!tapRes || tapRes.color !== 'pink')) fail++;
  await page.screenshot({ path: path.join(out, `${name}-2-tap.png`) });
  // tripod live: stability over time
  await page.evaluate(() => window.__snooker.setMode('tripod'));
  await page.waitForTimeout(2500);
  const a = await page.evaluate(MEASURE);
  await page.waitForTimeout(2500);
  const b = await page.evaluate(MEASURE);
  score(a, `${name} tripod t1`); r = score(b, `${name} tripod t2`);
  console.log(`[${name}] tripod ids stable: ${a.ids === b.ids}`);
  if (r.missing > 2 || r.extra.length > 1 || a.ids !== b.ids) fail++;
  await page.evaluate(() => window.__snooker.select('black'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${name}-3-tripod.png`) });
  // handheld live with a moving camera
  await page.evaluate(() => { window.__demoMoving = true; window.__snooker.setMode('hand'); });
  await page.waitForTimeout(4000);
  r = score(await page.evaluate(MEASURE), `${name} hand`);
  if (r.missing > 3 || r.extra.length > 2) fail++;
  await page.evaluate(() => window.__snooker.select('blue'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${name}-4-hand.png`) });
  await page.close();
}

await run({ width: 915, height: 412 }, 'landscape');
await run({ width: 412, height: 915 }, 'portrait');
await browser.close();
server.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); fail++; }
console.log(fail ? `FAILED (${fail})` : 'OK');
process.exit(fail ? 1 : 0);
