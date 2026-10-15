#!/usr/bin/env node
/**
 * Screenshots of the GTA IV physics pass into .shots/ (docs/physics.md): body roll in a hard corner (the sedan and the
 * pickup), the nose diving under hard braking, a pedestrian thrown over a bonnet, bodies thrown by an explosion, and a
 * rollover off a kerb. The sim runs on the main thread (loopback transport) on the procedural test ground and is stepped
 * by hand (`host.advance`) so each moment is caught exactly.
 *
 *   node scripts/physics-shots.mjs [--url http://127.0.0.1:5180/] [--only roll,dive,hood,blast,rollover]
 *
 * Writes: physics-roll-sedan.png, physics-roll-pickup.png, physics-dive.png, physics-hood.png, physics-hood-2.png,
 * physics-blast.png, physics-rollover.png
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (name) => !only || only.has(name);
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`${base}?transport=loopback&tile=none&graphics=high&parked=0&ambient=0&traffic=0&time=15:30&timescale=0&start=car&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.down('KeyH');
  await page.waitForTimeout(90);
  await page.keyboard.up('KeyH'); // help panel off
  await page.evaluate(() => window.__hood.game.transport.host.stop());
  await page.waitForTimeout(300);
  // Page-side helpers: drive the player's car by hand, one tick at a time.
  await page.evaluate(() => {
    window.__t = 100000;
    window.__drive = (host, axes, buttons = 0, ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        host.input({ tick: ++window.__t, buttons, axes: [0, 0, axes.yaw ?? 0, -0.2, axes.throttle ?? 0, axes.brake ?? 0, axes.steer ?? 0, 6, 0] });
        host.advance(1);
      }
    };
  });
  await page.evaluate(`window.__setup = ${SETUP_CAR.toString()}`);
  return page;
}
const shot = async (page, name, wait = 700, freeze = true) => {
  // Freeze the player's car where it is: the renderer extrapolates a moving car past the newest snapshot while the sim is
  // paused, which would slide it ahead of its driver. One tick with no velocity keeps the pose (roll, dive) as it was.
  if (freeze) await page.evaluate(() => {
    const host = window.__hood.game.transport.host;
    const S = host.simulation;
    const v = S.registry.get(S.vehicleId);
    v.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    v.car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    v.car.adopt();
    host.advance(1);
  });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `.shots/${name}` });
  console.log('shot', `.shots/${name}`);
};
const run = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host, window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);

/** Puts the player in their car on the open plaza, facing north, rolling at `speed`. */
const SETUP_CAR = (host, S, a) => {
  const v = S.registry.get(S.vehicleId);
  const me = S.registry.get(S.playerPedId);
  v.car.teleport(a.x ?? 0, 0.6, a.z ?? 60, Math.PI);
  host.advance(20);
  me.controller.teleport((a.x ?? 0) + 2.4, 0, a.z ?? 60);
  host.advance(2);
  host.input({ tick: ++window.__t, buttons: 4, axes: [0, 0, 0, 0, 0, 0, 0, 6, 0] });
  host.advance(3);
  host.input({ tick: ++window.__t, buttons: 0, axes: [0, 0, 0, 0, 0, 0, 0, 6, 0] });
  host.advance(60);
  v.car.body.setLinvel({ x: 0, y: 0, z: -(a.speed ?? 0) }, true);
  v.car.adopt();
  return S.registry.get(S.playerPedId).vehicleId === v.id;
};

/** Sets the chase camera's angle off the car's tail (radians, positive to the car's left as seen from behind) and pitch. */
const CAM = (host, S, a) => {
  const rig = window.__hood.game.cameraRig;
  rig.offYaw = a.yaw;
  rig.offPitch = a.pitch ?? 0.1;
  rig.idle = -1e6;
  rig.preset = a.preset ?? 1;
};

for (const type of ['sedan', 'pickup']) {
  if (!want('roll')) break;
  const page = await open(`car=${type}`);
  const info = await run(page, (host, S, t) => {
    const ok = window.__setup(host, S, { speed: 22, z: 90 });
    // hold 22 m/s with the wheel two thirds over: a hard steady corner
    for (let i = 0; i < 100; i++) {
      const v = S.registry.get(S.vehicleId);
      window.__drive(host, { throttle: Math.max(0, Math.min(1, (22 - v.car.speedForward) * 0.6)), steer: 0.65 });
    }
    return { ok, t };
  }, type);
  await run(page, CAM, { yaw: Math.PI * 0.82, pitch: 0.05, preset: 0 });
  await run(page, (host) => window.__drive(host, { throttle: 0.5, steer: 0.65 }, 0, 2));
  console.log('roll', type, JSON.stringify(info));
  await shot(page, `physics-roll-${type}.png`, 1400);
  await page.close();
}

if (want('dive')) {
  const page = await open('car=sedan');
  await run(page, (host, S) => window.__setup(host, S, { speed: 26, z: 100 }));
  await run(page, CAM, { yaw: Math.PI / 2, pitch: 0.02, preset: 0 });
  await run(page, (host) => window.__drive(host, { throttle: 0.3 }, 0, 30));
  await page.waitForTimeout(1200);
  const info = await run(page, (host, S) => {
    const v = S.registry.get(S.vehicleId);
    let dive = 0;
    for (let i = 0; i < 24; i++) {
      window.__drive(host, { brake: 1 });
      const q = v.car.body.rotation();
      const fy = 2 * (q.y * q.z - q.w * q.x);
      dive = Math.min(dive, Math.asin(Math.max(-1, Math.min(1, fy))) * 57.3);
    }
    return { dive, speed: v.car.speedForward };
  });
  console.log('dive', JSON.stringify(info));
  await shot(page, 'physics-dive.png', 900);
  await page.close();
}

if (want('hood')) {
  const page = await open('car=sedan');
  await run(page, (host, S) => window.__setup(host, S, { speed: 15, z: 100 }));
  await run(page, CAM, { yaw: Math.PI * 0.5, pitch: 0.08, preset: 1 });
  const info = await run(page, (host, S) => {
    const v = S.registry.get(S.vehicleId);
    const p = v.car.pose();
    const npc = S.addPed(p.x + 0.2, 0, p.z - 22, Math.PI / 2, 3, true);
    npc.brain.enter('idle');
    let t = -1;
    for (let i = 0; i < 200 && t < 0; i++) {
      window.__drive(host, { throttle: Math.max(0, Math.min(1, (15 - v.car.speedForward) * 0.6)) });
      if (S.ragdolls.has(npc.id)) t = i;
    }
    window.__npc = npc.id;
    window.__drive(host, { throttle: 0.2 }, 0, 16);
    return { t, rag: S.ragdolls.has(npc.id) };
  });
  console.log('hood', JSON.stringify(info));
  await shot(page, 'physics-hood.png', 900, false);
  await run(page, (host) => window.__drive(host, { brake: 1 }, 0, 16));
  await shot(page, 'physics-hood-2.png', 900, false);
  await page.close();
}

if (want('blast')) {
  const page = await open('car=sedan');
  const info = await run(page, (host, S) => {
    const me = S.registry.get(S.playerPedId);
    const car = S.registry.get(S.vehicleId);
    car.car.teleport(0, 0.6, 50, 0.4);
    me.controller.teleport(13, 0, 61);
    host.advance(30);
    const p = car.car.pose();
    const ids = [];
    for (const [dx, dz] of [[2.6, 0.5], [-2.4, 1.2], [0.6, 3.3], [-1.2, -3.4], [3.5, -2.2]]) {
      const n = S.addPed(p.x + dx, 0, p.z + dz, Math.atan2(dx, dz), 1 + ids.length, true);
      n.brain.enter('idle');
      ids.push(n.id);
    }
    host.advance(10);
    S.explodeVehicle(car);
    host.advance(16);
    return { ragdolls: S.ragdolls.activeCount, ids };
  });
  await run(page, (host, S) => {
    const rig = window.__hood.game.cameraRig;
    const me = S.registry.get(S.playerPedId).controller;
    rig.yaw = Math.atan2(me.x - 0, me.z - 50);
    rig.pitch = -0.12;
    rig.preset = 1;
  });
  console.log('blast', JSON.stringify(info));
  await shot(page, 'physics-blast.png', 1000);
  await run(page, (host) => host.advance(70));
  await shot(page, 'physics-blast-2.png', 900);
  await page.close();
}

if (want('rollover')) {
  const page = await open('car=pickup');
  const info = await run(page, (host, S) => {
    // the 0.3 m kerb on the plaza runs 6 m along x at z 0.5 to 3.5 (x -17 to -11): slide the pickup sideways into its south face
    const v = S.registry.get(S.vehicleId);
    const ok = window.__setup(host, S, { speed: 0, x: -14, z: 7.2 });
    v.car.teleport(-14, 0.6, 7.6, Math.PI / 2);
    host.advance(20);
    v.car.body.setLinvel({ x: 0, y: 0, z: -12 }, true);
    v.car.adopt();
    let up = 1;
    for (let i = 0; i < 26; i++) {
      window.__drive(host, {});
      const q = v.car.body.rotation();
      up = 1 - 2 * (q.x * q.x + q.z * q.z);
    }
    return { ok, up };
  });
  await run(page, (host, S) => {
    const rig = window.__hood.game.cameraRig;
    rig.offYaw = -Math.PI / 2 - 0.4;
    rig.offPitch = 0.15;
    rig.idle = -1e6;
    rig.preset = 1;
  });
  console.log('rollover', JSON.stringify(info));
  await shot(page, 'physics-rollover.png', 900, false);
  await run(page, (host) => window.__drive(host, {}, 0, 40));
  await shot(page, 'physics-rollover-2.png', 900, false);
  await page.close();
}

await browser.close();
