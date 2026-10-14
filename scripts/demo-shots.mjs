#!/usr/bin/env node
/**
 * Screenshots of the showpiece moments into .shots/: the carjack (door open, driver dragged out and
 * running, the player taking the wheel) and a donut with tyre smoke. Plays the real game on the baked
 * tile with real key presses.
 *
 *   node scripts/demo-shots.mjs [--url http://127.0.0.1:5180/] [--mood flee|fight] [--car sedan|pickup] [--tile none]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { STATE, carPoint, doorStand, walkTo } from './drive-helpers.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const mood = typeof args.mood === 'string' ? args.mood : 'flee';
const car = typeof args.car === 'string' ? args.car : 'sedan';
const tile = typeof args.tile === 'string' ? `&tile=${args.tile}` : '';
mkdirSync('.shots', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});

async function open(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.waitForTimeout(800);
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: `.shots/${name}` }); console.log('shot', `.shots/${name}`); };
const HALF = { sedan: [0.92, 2.2], coupe: [0.92, 2.2], pickup: [1.0, 2.65] };

// ---- the carjack
{
  const page = await open(`graphics=low&driver=${mood}&car=${car}${tile}`);
  const s0 = await page.evaluate(STATE);
  const hero = s0.car;
  const [hx, hz] = HALF[hero.type] ?? HALF.sedan;
  const find = (s) => s.cars.find((c) => c.id === hero.id);
  await shot(page, 'jack-1-start.png');
  await walkTo(page, (s) => carPoint(find(s), -(hx + 1.5), -(hz + 1.7)), { tol: 1.0, sprint: true });
  await walkTo(page, (s) => carPoint(find(s), hx + 1.5, -(hz + 1.7)), { tol: 1.0, sprint: true });
  await walkTo(page, async (s) => doorStand(page, find(s)), { tol: 0.5 });
  // Look at the door from the front-left: the camera sits behind and to the right of the view direction.
  await page.evaluate(() => { window.__hood.game.cameraRig.preset = 1; });
  const aim = async () => page.evaluate(() => {
    const g = window.__hood.game;
    const car = g.view.vehicle;
    const cy = Math.atan2(2 * (car.q.x * car.q.z + car.q.w * car.q.y), 1 - 2 * (car.q.x * car.q.x + car.q.y * car.q.y));
    // The camera stands in the street off the car's front-left corner and looks back at the door: the
    // view direction is (-3.95, -2.95) in the car's frame (x left, z forward).
    const lx = -3.95;
    const lz = -2.95;
    const dx = Math.cos(cy) * lx + Math.sin(cy) * lz;
    const dz = -Math.sin(cy) * lx + Math.cos(cy) * lz;
    g.cameraRig.yaw = Math.atan2(-dx, -dz);
    g.cameraRig.pitch = -0.18;
  });
  await aim();
  await page.waitForTimeout(400);
  await shot(page, 'jack-2-at-door.png');
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(60);
  await page.keyboard.up('KeyE');
  const t0 = Date.now();
  for (const [i, at] of [[3, 330], [4, 620], [5, 1000], [6, 1500], [7, 2400]]) {
    const wait = at - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    await aim();
    await shot(page, `jack-${i}.png`);
  }
  await page.close();
}

// ---- the donut
{
  const page = await open(`graphics=low&start=car&car=${car}&parked=0${tile}`);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(80);
  await page.keyboard.up('KeyE');
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(3600);
  await shot(page, 'donut-1.png');
  await page.waitForTimeout(700);
  await shot(page, 'donut-2.png');
  await page.waitForTimeout(700);
  await shot(page, 'donut-3.png');
  const s = await page.evaluate(STATE);
  console.log('donut state', JSON.stringify({ speed: s.car.speed, skidding: (s.car.flags & 16) !== 0 }));
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');
  await page.close();
}
await browser.close();
