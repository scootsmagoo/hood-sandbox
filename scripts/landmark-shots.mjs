#!/usr/bin/env node
/**
 * Screenshots of the hero landmarks into .shots/landmark-<id>-<view>-<day|night>.png (and landmark-skyline-*.png).
 * Camera positions are described relative to the landmark in the baked tile (public/tiles/.../landmarks.json), with the
 * ground height read from height.bin, so a view stays right when a re-bake moves the ground.
 *
 *   node scripts/landmark-shots.mjs [--only westin-peachtree-plaza,georgia-state-capitol] [--times day,night]
 *                                   [--url http://127.0.0.1:5193/] [--size 1280x720] [--graphics high]
 *
 * A view is { az, dist, up, aim }: the camera stands `dist` metres from the landmark's centre towards compass bearing `az`
 * (0 north, 90 east), `up` metres above the ground there, and looks at the point `aim` metres above the landmark's ground.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []));
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5193/';
const tier = typeof args.graphics === 'string' ? args.graphics : 'high';
const [w, h] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const times = (typeof args.times === 'string' ? args.times : 'day,night').split(',');
const TIMES = { day: '14:00', dusk: '18:50', night: '23:30' };

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

/** Views per landmark. Bearings are where the camera stands (towards), so az 180 looks at the south face from the south. */
const V = (az, dist, up, aim, fov = 55) => ({ az, dist, up, aim, fov });
const VIEWS = {
  'mercedes-benz-stadium': { aerial: V(80, 380, 300, 20, 55), street: V(95, 230, 25, 30, 62), top: V(70, 120, 330, 40, 60) },
  'georgia-state-capitol': { aerial: V(150, 190, 120, 28, 50), front: V(160, 130, 30, 30, 55), far: V(200, 420, 90, 40, 36) },
  'westin-peachtree-plaza': { aerial: V(210, 330, 130, 100, 50), far: V(160, 700, 160, 110, 32), foot: V(230, 90, 30, 100, 62) },
  'hyatt-regency-atlanta': { aerial: V(200, 260, 140, 60, 50), mid: V(250, 230, 75, 70, 55) },
  'state-farm-arena': { aerial: V(100, 220, 130, 15, 52), front: V(55, 190, 70, 20, 55) },
  'georgia-aquarium': { aerial: V(130, 300, 190, 5, 52), front: V(150, 190, 30, 10, 60) },
  'world-of-coca-cola': { aerial: V(120, 230, 130, 5, 52), front: V(140, 130, 20, 10, 62) },
  'skyview-atlanta': { near: V(120, 110, 15, 30, 60), mid: V(80, 260, 40, 30, 45) },
  'fountain-of-rings': { aerial: V(180, 70, 60, 0, 55), near: V(170, 50, 12, 0, 62) },
  'truist-plaza': { mid: V(190, 330, 120, 140, 55), far: V(200, 700, 120, 150, 34) },
  '191-peachtree-tower': { mid: V(150, 320, 120, 140, 55), far: V(150, 700, 120, 150, 34) },
  'flatiron-building-atlanta': { near: V(215, 150, 70, 25, 55) },
  'georgia-pacific-tower': { mid: V(190, 260, 90, 110, 55) },
  'marriott-marquis': { mid: V(200, 330, 90, 90, 55) },
  'state-of-georgia-building': { mid: V(150, 240, 80, 100, 55) },
  'atlanta-city-hall': { mid: V(200, 220, 60, 35, 55) },
  'hurt-building': { mid: V(200, 220, 60, 40, 55) },
  'atlanta-central-library': { mid: V(220, 140, 40, 12, 55) },
  'basilica-of-the-sacred-heart': { mid: V(250, 130, 30, 25, 55) },
  'corey-tower': { mid: V(200, 150, 40, 45, 55) },
  'hilton-atlanta': { mid: V(200, 260, 80, 60, 55) },
  'candler-building': { near: V(180, 160, 80, 40, 55) },
};
const SKYLINE = { eye: [20, 70, -100], look: [200, 100, -800], fov: 52 };
const SKYLINE_LOW = { eye: [380, 110, 430], look: [150, 95, -650], fov: 48 };

const jobs = [];
for (const [id, views] of Object.entries(VIEWS)) {
  if (only && !only.has(id)) continue;
  const lm = lms.find((l) => l.id === id);
  if (!lm?.hero) { console.warn(`no hero ${id} in the tile`); continue; }
  const gy = lm.hero.y;
  for (const [vn, v] of Object.entries(views)) {
    const a = (v.az * Math.PI) / 180;
    const ex = lm.x + Math.sin(a) * v.dist;
    const ez = lm.z - Math.cos(a) * v.dist;
    jobs.push({ name: `${id}-${vn}`, eye: [ex, Math.max(ground(ex, ez), gy) + v.up, ez], look: [lm.x, gy + v.aim, lm.z], fov: v.fov });
  }
}
if (!only || only.has('skyline')) {
  jobs.push({ name: 'skyline-aerial', ...SKYLINE });
  jobs.push({ name: 'skyline-low', ...SKYLINE_LOW });
}
if (typeof args.eye === 'string' && typeof args.look === 'string') {
  jobs.length = 0;
  jobs.push({ name: typeof args.name === 'string' ? args.name : 'custom', eye: args.eye.split(',').map(Number), look: args.look.split(',').map(Number), fov: Number(args.fov ?? 55) });
}

mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});
const errors = [];
async function setup(page, tn) {
  await page.goto(`${base}?graphics=${tier}&time=${TIMES[tn]}&timescale=0&traffic=0&peds=0`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH');
  await page.evaluate(() => {
    const g = window.__hood.game;
    window.__lmCam = { eye: [0, 100, 0], look: [0, 0, 0], fov: 55 };
    g.addSystem({
      name: 'landmark-shots-camera',
      priority: 900,
      lateUpdate: () => {
        const c = window.__lmCam;
        g.camera.fov = c.fov;
        g.camera.position.set(c.eye[0], c.eye[1], c.eye[2]);
        g.camera.lookAt(c.look[0], c.look[1], c.look[2]);
        g.camera.updateProjectionMatrix();
        g.camera.updateMatrixWorld(true);
      },
    });
    for (const sel of ['.hud', '.hud-prompt', '#hud', 'canvas:not(#view)']) document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
  });
}
for (const tn of times) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /\[landmarks\]/.test(m.text())) errors.push(`${tn}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${tn}: pageerror ${e}`));
  await setup(page, tn);
  let first = true;
  for (const j of jobs) {
    // the dev server reloads the page when a source file changes (another agent's edit, a manifest): set up again
    for (let tries = 0; tries < 4; tries++) {
      const ok = await page.evaluate(() => !!window.__lmCam && !!window.__hood?.ready).catch(() => false);
      if (ok) break;
      await page.waitForTimeout(2500);
      const still = await page.evaluate(() => !!window.__lmCam && !!window.__hood?.ready).catch(() => false);
      if (!still) await setup(page, tn).catch(() => {});
      first = true;
    }
    await page.evaluate((c) => { window.__lmCam = c; }, { eye: j.eye, look: j.look, fov: j.fov });
    await page.waitForTimeout(first ? 3500 : 1600);
    first = false;
    const file = `.shots/landmark-${j.name}-${tn}.png`;
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
  await page.close();
}
await browser.close();
console.log(errors.length ? `console messages:\n${[...new Set(errors)].join('\n')}` : 'no console errors');
process.exit(0);
