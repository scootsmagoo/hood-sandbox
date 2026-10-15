#!/usr/bin/env node
/**
 * Screenshots of the ambient traffic on the baked tile, into .shots/: a busy Peachtree St, a queue at a
 * red light, signal heads close up, and a carjack at a light (real key presses, loopback transport so the
 * script can find a car stopped at a red light).
 *
 *   node scripts/traffic-shots.mjs [--url http://127.0.0.1:5180/]
 */
import { mkdirSync } from 'node:fs';
import { launch, parseArgs, startServer } from './lib/harness.mjs';
import { STATE, doorStand, walkTo } from './drive-helpers.mjs';

const args = parseArgs();
mkdirSync('.shots', { recursive: true });
const server = await startServer(args);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${server.base}?graphics=high&traffic=0.5&transport=loopback&time=12:00&timescale=0&ambient=0&seed=3`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
await page.evaluate(() => {
  window.__events = [];
  window.__hood.game.onSimEvent((e) => window.__events.push(e));
  const g = window.__hood.game;
  window.__camTarget = null;
  g.addSystem({ name: 'dbgcam', priority: 999, lateUpdate() { const c = window.__camTarget; if (!c) return; g.camera.position.set(c.x, c.y, c.z); g.camera.lookAt(c.tx, c.ty, c.tz); } });
  window.__cam = (x, y, z, tx, ty, tz) => { window.__camTarget = { x, y, z, tx, ty, tz }; };
  window.__camOff = () => { window.__camTarget = null; };
  const hud = document.querySelector('.hud-help, #help, .help');
  if (hud) hud.style.display = 'none';
});
const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
const shot = async (name) => { await page.screenshot({ path: `.shots/${name}` }); console.log('shot', name); };
await page.keyboard.press('Shift');
await page.waitForTimeout(15000);

// 1. the busiest stretch of road
await page.evaluate(() => {
  const v = window.__hood.game.view;
  const cars = [...v.entities.values()].filter((e) => e.kind === 2 && (e.flags & (1 << 13)));
  let best = null, bn = -1;
  for (const c of cars) { const n = cars.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 55).length; if (n > bn) { bn = n; best = c; } }
  const yaw = 2 * Math.atan2(best.q.y, best.q.w);
  window.__cam(best.x - Math.sin(yaw) * 40, best.y + 22, best.z - Math.cos(yaw) * 40, best.x + Math.sin(yaw) * 20, best.y, best.z + Math.cos(yaw) * 20);
});
await page.waitForTimeout(700);
await shot('traffic-busy-street.png');

// 2. a car stopped at a red light: put the player near it
let found = null;
for (let i = 0; i < 480 && !found; i++) {
  const cand = await sim((s) => {
    const p = s.registry.get(s.playerPedId).controller;
    let best = null;
    for (const c of s.traffic.cars) {
      if (c.veh.car.speed > 0.3 || !c.gateWhy.startsWith('signal closed')) continue;
      const b = c.veh.car.body.translation();
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (!best || d < best.d) best = { id: c.veh.id, x: b.x, z: b.z, d, phys: c.mode === 'phys' && !!c.veh.occupantId };
    }
    return best;
  });
  if (cand && cand.phys && cand.d < 60) found = cand;
  else if (cand) {
    await sim((s, c) => { s.registry.get(s.playerPedId).controller.teleport(c.x + 22, s.groundAt(c.x + 22, c.z) + 0.3, c.z + 3); }, cand);
    await page.waitForTimeout(1200);
  } else await page.waitForTimeout(250);
}
if (!found) throw new Error('no car at a red light');
await page.waitForTimeout(2500);
const q = await page.evaluate((id) => {
  const v = window.__hood.game.view;
  const e = v.entities.get(id);
  const yaw = 2 * Math.atan2(e.q.y, e.q.w);
  window.__cam(e.x - Math.sin(yaw) * 26 + Math.cos(yaw) * 5, e.y + 7, e.z - Math.cos(yaw) * 26 - Math.sin(yaw) * 5, e.x + Math.sin(yaw) * 14, e.y + 1, e.z + Math.cos(yaw) * 14);
  return { x: e.x, y: e.y, z: e.z, yaw };
}, found.id);
await page.waitForTimeout(700);
await shot('traffic-red-light-queue.png');

// 3. the signal heads, close up
await page.evaluate((q) => {
  window.__cam(q.x + Math.sin(q.yaw) * 6 - Math.cos(q.yaw) * 3, q.y + 3.2, q.z + Math.cos(q.yaw) * 6 + Math.sin(q.yaw) * 3, q.x + Math.sin(q.yaw) * 24, q.y + 4.2, q.z + Math.cos(q.yaw) * 24);
}, q);
await page.waitForTimeout(500);
await shot('traffic-signal-heads.png');

// 4. the carjack at the light, with the real keys
await page.evaluate(() => window.__camOff());
await sim((s, id) => {
  const v = s.registry.get(id);
  const pose = v.car.pose();
  const yaw = v.car.yaw;
  const x = pose.x + Math.cos(yaw) * 3.2 - Math.sin(yaw) * 5.5;
  const z = pose.z - Math.sin(yaw) * 3.2 - Math.cos(yaw) * 5.5;
  s.registry.get(s.playerPedId).controller.teleport(x, s.groundAt(x, z) + 0.2, z);
}, found.id);
await page.waitForTimeout(500);
const r = await walkTo(page, async (s) => doorStand(page, s.cars.find((c) => c.id === found.id)), { tol: 0.6, timeoutMs: 15000 });
console.log('at the door', r.ok);
await page.waitForTimeout(400);
await shot('traffic-carjack-1-at-the-door.png');
await page.keyboard.down('KeyE');
await page.waitForTimeout(80);
await page.keyboard.up('KeyE');
await page.waitForTimeout(550);
await shot('traffic-carjack-2-pulling-out.png');
await page.waitForTimeout(1800);
await shot('traffic-carjack-3-in-the-car.png');
const s = await page.evaluate(STATE);
console.log('in car', s.inCar, 'events', (await page.evaluate(() => window.__events.filter((e) => ['carjack', 'crime'].includes(e.type)).map((e) => e.type))).join(','));
console.log(errors.length ? `console errors: ${errors.join(' | ')}` : 'no console errors');
await browser.close();
await server.close();
