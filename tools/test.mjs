// Headless end-to-end check: serves the web app, runs it on the synthetic demo
// table, measures detection accuracy against ground truth and saves screenshots.
// usage: node tools/test.mjs [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../app/src/main/assets/www');
const out = path.resolve(process.argv[2] || 'test-out');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, d) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const errors = [];
let fail = 0;
async function run(viewport, name) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.stack}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(`http://localhost:${port}/index.html?demo=1`);
  await page.waitForTimeout(1500);
  // photo mode
  await page.evaluate(() => window.__snooker.capturePhoto());
  await page.waitForTimeout(400);
  const res = await page.evaluate(() => {
    const { S, truth } = window.__snooker;
    const L = 3569, W = 1778;
    const syms = [(b) => b, (b) => ({ ...b, x: L - b.x }), (b) => ({ ...b, y: W - b.y }), (b) => ({ ...b, x: L - b.x, y: W - b.y })];
    let tr = truth(), bestS = 1e18;
    for (const f of syms) {
      const t2 = truth().map(f); let sum = 0;
      for (const t of t2) { let bd = 1e6; for (const d of S.balls) if (d.color === t.color) bd = Math.min(bd, Math.hypot(d.x - t.x, d.y - t.y)); sum += Math.min(bd, 500); }
      if (sum < bestS) { bestS = sum; tr = t2; }
    }
    const det = S.balls;
    const used = new Set(); const errs = []; let missing = 0;
    for (const t of tr) {
      let best = null, bd = 1e9;
      det.forEach((d, i) => { if (used.has(i) || d.color !== t.color) return; const dd = Math.hypot(d.x - t.x, d.y - t.y); if (dd < bd) { bd = dd; best = i; } });
      if (best == null || bd > 80) { missing++; errs.push({ color: t.color, miss: true, x: t.x, y: t.y }); } else { used.add(best); errs.push({ color: t.color, err: bd }); }
    }
    const extra = det.filter((_, i) => !used.has(i)).map((d) => ({ color: d.color, x: Math.round(d.x), y: Math.round(d.y) }));
    return { n: det.length, truth: tr.length, missing, extra, errs, elev: S.calib && S.calib.elev, f: S.calib && S.calib.f, orient: S.calib && S.calib.orient };
  });
  const errVals = res.errs.filter((e) => !e.miss).map((e) => e.err);
  const mean = errVals.reduce((a, b) => a + b, 0) / Math.max(1, errVals.length);
  console.log(`[${name}] detected ${res.n}/${res.truth}, missing ${res.missing}, extra ${res.extra.length} ${JSON.stringify(res.extra)}, mean err ${mean.toFixed(1)}mm, max ${Math.max(...errVals).toFixed(1)}mm, elev ${res.elev?.toFixed(1)}°, f ${res.f?.toFixed(0)}, orient ${res.orient}`);
  if (res.missing) console.log("  missing", JSON.stringify(res.errs.filter((e) => e.miss)));
  if (res.missing > 1 || mean > 25) { fail++; console.log('  details', JSON.stringify(res.errs)); }
  await page.screenshot({ path: path.join(out, `${name}-1-photo.png`) });
  // select pink and wait for analysis
  await page.evaluate(() => window.__snooker.select('pink'));
  await page.waitForTimeout(2500);
  const shots = await page.evaluate(() => window.__snooker.S.shots.map((s) => ({ type: s.type, pocket: s.pocket, cut: Math.round(s.cut), p: Math.round(s.pPot * 100), power: s.power, spin: s.spin, scratch: s.play.after.scratch })));
  console.log(`[${name}] pink shots`, JSON.stringify(shots));
  if (!shots.length) fail++;
  await page.screenshot({ path: path.join(out, `${name}-2-pink.png`) });
  // recommendation
  await page.evaluate(() => { window.__snooker.S.selId = null; document.querySelector('#actions .btn:nth-child(2)').click(); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${name}-3-rec.png`) });
  // tripod live
  await page.evaluate(() => window.__snooker.setMode('tripod'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#actions .btn').click()); // lock
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__snooker.select('black'));
  await page.waitForTimeout(2500);
  const tri = await page.evaluate(() => ({ n: window.__snooker.S.balls.length, shots: window.__snooker.S.shots.length }));
  console.log(`[${name}] tripod balls ${tri.n}, shots ${tri.shots}`);
  await page.screenshot({ path: path.join(out, `${name}-4-tripod.png`) });
  // handheld live
  await page.evaluate(() => window.__snooker.setMode('hand'));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__snooker.select('blue'));
  await page.waitForTimeout(3000);
  const hand = await page.evaluate(() => ({ n: window.__snooker.S.balls.length, shots: window.__snooker.S.shots.length, quad: !!window.__snooker.S.quad }));
  console.log(`[${name}] hand balls ${hand.n}, shots ${hand.shots}`);
  await page.screenshot({ path: path.join(out, `${name}-5-hand.png`) });
  await page.close();
}

await run({ width: 915, height: 412 }, 'landscape');
await run({ width: 412, height: 915 }, 'portrait');
await browser.close();
server.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); fail++; }
console.log(fail ? `FAILED (${fail})` : 'OK');
process.exit(fail ? 1 : 0);
