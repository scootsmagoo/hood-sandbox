#!/usr/bin/env node
/**
 * Graphics comparison shots into .shots/ (docs/graphics-plan.md). The same fixed camera views, drawn
 * with the default look (GTA IV) or with `--query gfx=classic`, so a before and an after can be put
 * side by side. Views named `<place>-<time>` exist for every place (five-points, peachtree,
 * centennial, aerial, street, plaza) and time (day 14:00, dusk 18:50, night 23:30), and `driving`.
 *
 *   node scripts/gfx-shots.mjs --prefix gta4 [--query "gfx=classic"] [--views five-points-day,peachtree-night,...]
 *                              [--url http://127.0.0.1:5180/] [--graphics high|medium|low] [--size 1280x720]
 *
 * Views are camera placements, not gameplay: a system added after the camera rig puts the camera at
 * a fixed eye point and look-at target, with the clock frozen (`timescale=0`). Traffic and people are
 * on, so cars and walkers differ a little between runs.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const prefix = typeof args.prefix === 'string' ? args.prefix : 'gfx';
const extra = typeof args.query === 'string' ? `&${args.query}` : '';
const tier = typeof args.graphics === 'string' ? args.graphics : 'high';
const [w, h] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);

/** time: the game clock; eye/look: world metres (+X east, +Y up, -Z north); fov degrees. */
const VIEWS = {
  'street-day': { time: '14:00', eye: [-74, 3.8, -66], look: [-165, 16, -185], fov: 62 },
  'street-night': { time: '23:30', eye: [-74, 3.8, -66], look: [-165, 16, -185], fov: 62 },
  'street-dusk': { time: '18:50', eye: [-74, 3.8, -66], look: [-165, 16, -185], fov: 62 },
  'plaza-day': { time: '15:30', eye: [74, 2.4, 46], look: [1, 10, -3], fov: 66 },
  'plaza-night': { time: '23:30', eye: [74, 2.4, 46], look: [1, 10, -3], fov: 66 },
  'aerial-day': { time: '14:00', eye: [150, 150, 210], look: [-80, 20, -160], fov: 55 },
  'aerial-night': { time: '23:30', eye: [150, 150, 210], look: [-80, 20, -160], fov: 55 },
  driving: { time: '17:30', eye: [0, 0, 0], look: [0, 0, 0], fov: 62, drive: true },
};
// The look's shots: a place at three times of day.
const PLACES = {
  'five-points': { eye: [-45, 5.4, 66], look: [5, 12, -8], fov: 64 },
  peachtree: { eye: [30, 4.4, -45], look: [95, 17, -170], fov: 62 },
  centennial: { eye: [-203, -10.5, -640], look: [-320, -14, -730], fov: 70 },
  aerial: { eye: [150, 150, 210], look: [-80, 20, -160], fov: 55 },
  // Sweet Auburn: Auburn Avenue NE, street trees and lamps
  auburn: { eye: [535, -8.3, -140], look: [640, -14, -138.5], fov: 62 },
};
const TIMES = { day: '14:00', dusk: '18:50', night: '23:30' };
for (const [pn, pv] of Object.entries(PLACES)) for (const [tn, tv] of Object.entries(TIMES)) VIEWS[`${pn}-${tn}`] = { time: tv, ...pv };
for (const [tn, tv] of Object.entries(TIMES)) VIEWS[`driving-${tn}`] = { time: tv, eye: [0, 0, 0], look: [0, 0, 0], fov: 62, drive: true };
if (typeof args.eye === 'string' && typeof args.look === 'string') {
  // A one-off view: --eye x,y,z --look x,y,z [--time HH:MM]
  VIEWS.custom = { time: typeof args.time === 'string' ? args.time : '14:00', eye: args.eye.split(',').map(Number), look: args.look.split(',').map(Number), fov: 62 };
  args.views = 'custom';
}
const names = typeof args.views === 'string' ? args.views.split(',') : Object.keys(VIEWS);
mkdirSync('.shots', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});
const errors = [];
for (const name of names) {
  const v = VIEWS[name];
  if (!v) throw new Error(`unknown view ${name}`);
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: pageerror ${e}`));
  await page.goto(`${base}?graphics=${tier}&time=${v.time}&timescale=0${v.drive ? '&start=car' : ''}${extra}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH'); // hide the help card
  if (v.drive) {
    // Get in the parked car and drive straight for a few seconds (the spawn sits beside it).
    await page.keyboard.down('KeyE'); await page.waitForTimeout(120); await page.keyboard.up('KeyE');
    await page.waitForTimeout(1500);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3500);
  } else {
    await page.evaluate(({ eye, look, fov }) => {
      const g = window.__hood.game;
      g.addSystem({
        name: 'gfx-shots-camera',
        priority: 900,
        lateUpdate: () => {
          g.camera.fov = fov;
          g.camera.position.set(eye[0], eye[1], eye[2]);
          g.camera.lookAt(look[0], look[1], look[2]);
          g.camera.updateProjectionMatrix();
          g.camera.updateMatrixWorld(true);
        },
      });
      // Hide the HUD so the pictures are of the world.
      for (const sel of ['.hud', '.hud-prompt', '#hud', 'canvas:not(#view)']) document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
    }, v);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `.shots/${prefix}-${name}.png` });
  console.log('shot', `.shots/${prefix}-${name}.png`);
  await page.close();
}
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
process.exit(errors.length ? 1 : 0);
