#!/usr/bin/env node
/**
 * Screenshots of the landmark polish into .shots/polish-*.png: a skybridge floating between towers, the stadium's roof, the
 * wheel at two times (it turns, its cabins stay level), the fountain's jets at two times.
 *
 *   node scripts/polish-landmark-shots.mjs [--only skybridge,stadium,wheel,fountain] [--url http://127.0.0.1:5231/] [--time 14:00]
 *
 * Cameras are given as a game-frame eye and target (metres, y above the ground at the target's x, z for `up`/`aim`), like
 * scripts/landmark-shots.mjs. The wheel's clock is moved on through the Landmarks system so two shots a few seconds apart show it turned.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (n) => !only || only.has(n);
const time = typeof args.time === 'string' ? args.time : '14:00';
const [W, H] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);
mkdirSync('.shots', { recursive: true });

const tileDir = 'public/tiles/atlanta/m1-five-points';
const tile = JSON.parse(readFileSync(`${tileDir}/tile.json`, 'utf8'));
const lms = JSON.parse(readFileSync(`${tileDir}/landmarks.json`, 'utf8')).landmarks;
const hm = new Float32Array(readFileSync(`${tileDir}/height.bin`).buffer.slice(0));
const hmeta = tile.heightmap;
const ground = (x, z) => {
  const fx = Math.max(0, Math.min(hmeta.cols - 1.001, (x - hmeta.minX) / hmeta.cellSize));
  const fz = Math.max(0, Math.min(hmeta.rows - 1.001, (z - hmeta.minZ) / hmeta.cellSize));
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
  const v = (rr, cc) => hm[rr * hmeta.cols + cc];
  return v(r, c) * (1 - tx) * (1 - tz) + v(r, c + 1) * tx * (1 - tz) + v(r + 1, c) * (1 - tx) * tz + v(r + 1, c + 1) * tx * tz;
};
/** A camera standing `dist` m from (x, z) towards compass bearing `az`, `up` m over the ground there, looking `aim` m above the ground at (x, z). */
const view = (x, z, az, dist, up, aim, fov = 55) => {
  const a = (az * Math.PI) / 180;
  const ex = x + Math.sin(a) * dist, ez = z - Math.cos(a) * dist;
  return { eye: [ex, ground(ex, ez) + up, ez], look: [x, ground(x, z) + aim, z], fov };
};
const hero = (id) => lms.find((l) => l.id === id);
const hy = (id) => hero(id).hero.y;
const heroView = (id, az, dist, up, aim, fov = 55) => {
  const l = hero(id);
  const a = (az * Math.PI) / 180;
  const ex = l.x + Math.sin(a) * dist, ez = l.z - Math.cos(a) * dist;
  return { eye: [ex, Math.max(ground(ex, ez), hy(id)) + up, ez], look: [l.x, hy(id) + aim, l.z], fov };
};

const server = await startServer(args);
const browser = await launch();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
page.on('pageerror', (e) => errors.push(`pageerror ${e}`));
page.on('console', (m) => { if (m.type() === 'error' || /\[landmarks\]/.test(m.text())) errors.push(m.text()); });
async function setup() {
  await page.goto(`${server.base}?graphics=high&time=${time}&timescale=0&traffic=0&peds=0`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH');
  await page.evaluate(() => {
    const g = window.__hood.game;
    window.__cam = { eye: [0, 100, 0], look: [0, 0, 0], fov: 55 };
    g.addSystem({ name: 'polish-camera', priority: 900, lateUpdate: () => {
      const c = window.__cam;
      g.camera.fov = c.fov;
      g.camera.position.set(...c.eye);
      g.camera.lookAt(...c.look);
      g.camera.updateProjectionMatrix();
      g.camera.updateMatrixWorld(true);
    } });
    for (const sel of ['.hud', '.hud-prompt', '#hud', 'canvas:not(#view)']) document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
  });
}
/** The dev server reloads the page when a source or a manifest changes (an asset rebuilt, another agent's edit): set up again. */
async function ensure() {
  for (let tries = 0; tries < 5; tries++) {
    const ok = await page.evaluate(() => !!window.__cam && !!window.__hood?.ready).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(2500);
    const still = await page.evaluate(() => !!window.__cam && !!window.__hood?.ready).catch(() => false);
    if (!still) await setup().catch(() => {});
  }
}
await setup();
const shot = async (name, v, settle = 1800) => {
  await ensure();
  await page.evaluate((c) => { window.__cam = c; }, v);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `.shots/${name}.png` });
  console.log('shot', `.shots/${name}.png`);
};
/** Moves the landmarks' clock on (the wheel and the jets run on it). */
const advance = async (s) => { await ensure(); return page.evaluate((d) => { const l = window.__hood.game.systems.find((x) => x.name === 'landmarks'); l.t += d; return l.t; }, s); };

if (want('skybridge')) {
  // the connectors of the hotel district: five of them in a row over one street, at x 68 to 71, z -621 to -692
  const at = (ex, up, ez, lx, lz, aim, fov) => ({ eye: [ex, ground(ex, ez) + up, ez], look: [lx, ground(lx, lz) + aim, lz], fov });
  await shot('polish-skybridge', at(70, 45, -560, 70, -660, 8, 60), 4500);
  await shot('polish-skybridge-2', at(70, 2, -575, 70, -655, 9, 60));
  await shot('polish-skybridge-3', at(70, 3.5, -648, 70, -700, 8, 70));
  await shot('polish-skybridge-4', at(20, 30, -660, 90, -660, 8, 60));
  await shot('polish-skybridge-5', at(204, 40, -640, 204, -684, 8, 55));
}
if (want('stadium')) {
  await shot('polish-stadium', heroView('mercedes-benz-stadium', 80, 380, 300, 20, 55), 3500);
  await shot('polish-stadium-top', heroView('mercedes-benz-stadium', 70, 120, 330, 40, 60));
  await shot('polish-stadium-street', heroView('mercedes-benz-stadium', 95, 230, 25, 30, 62));
  await shot('polish-stadium-oculus', heroView('mercedes-benz-stadium', 100, 150, 200, 75, 62));
  await shot('polish-stadium-side', heroView('mercedes-benz-stadium', 160, 240, 90, 60, 55));
}
if (want('wheel')) {
  await shot('polish-wheel-1', heroView('skyview-atlanta', 120, 130, 40, 30, 58), 3500);
  const t0 = await advance(0);
  await advance(30);
  await shot('polish-wheel-2', heroView('skyview-atlanta', 120, 130, 40, 30, 58), 1200);
  console.log('wheel clock', t0, '->', await advance(0));
  await shot('polish-wheel-far', heroView('skyview-atlanta', 80, 260, 40, 30, 45));
}
if (want('fountain')) {
  await shot('polish-fountain-1', heroView('fountain-of-rings', 180, 70, 60, 0, 55), 3500);
  await advance(2.3);
  await shot('polish-fountain-2', heroView('fountain-of-rings', 180, 70, 60, 0, 55), 900);
  await shot('polish-fountain-near-1', heroView('fountain-of-rings', 170, 38, 5, 1, 62), 900);
  await advance(3.1);
  await shot('polish-fountain-near-2', heroView('fountain-of-rings', 170, 38, 5, 1, 62), 900);
}
console.log(errors.length ? `console problems:\n${[...new Set(errors)].join('\n')}` : 'no console errors');
await browser.close();
await server.close();
process.exit(0);
