#!/usr/bin/env node
/**
 * Screenshots of the guns into .shots/, on the baked Five Points tile: aiming with a crosshair and
 * a gamepad lock-on, tracers and muzzle flash, a ped hit, cover, and a drive-by. The sim runs on
 * the main thread (loopback transport) so the script can set a scene up through
 * `window.__hood.game.transport.host.simulation`; what the player does is a real key press, or an
 * action held the way the gamepad source holds it.
 *
 *   node scripts/gun-shots.mjs [--url http://127.0.0.1:5180/]
 *
 * Writes: gun-aim.png, gun-lock.png, gun-fire.png, gun-burst.png, gun-hit.png, gun-hit-down.png, gun-cover-high.png, gun-cover-side.png,
 * gun-cover-aim.png, gun-cover-low.png, gun-cover-low-aim.png, gun-driveby.png, gun-touch.png
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});

async function open(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`${base}?transport=loopback&graphics=low&ambient=0&traffic=0&parked=0&time=14:00&timescale=0&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH'); // help panel off
  await page.waitForTimeout(600);
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: `.shots/${name}` }); console.log('shot', `.shots/${name}`); };
const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
const game = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game, ${JSON.stringify(arg ?? null)})`);
const hold = (page, action, on) => game(page, (g, a) => g.input.holdAction(a.action, a.on), { action, on });

/** The longest clear way across open ground from the player, as a unit vector. */
const openWay = (S) => {
  const p = S.registry.get(S.playerPedId).controller;
  let best = { d: 0, x: 0, z: 1 };
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const dir = { x: Math.sin(a), y: 0, z: Math.cos(a) };
    const hit = S.physics.world.castRay(new S.physics.R.Ray({ x: p.x, y: p.y + 1.4, z: p.z }, dir), 60, true, undefined, 0x00080001);
    const d = hit ? hit.timeOfImpact : 60;
    if (d > best.d) best = { d, x: dir.x, z: dir.z };
  }
  return best;
};

// ---- aim, crosshair, then a gamepad lock-on on a target a little off the centre
{
  const page = await open('weapons=all');
  const way = await sim(page, openWay);
  console.log('open way', JSON.stringify(way));
  await sim(page, (S, w) => {
    const c = S.registry.get(S.playerPedId).controller;
    const put = (d, side, outfit) => {
      const x = c.x + w.x * d + -w.z * side;
      const z = c.z + w.z * d + w.x * side;
      const n = S.addPed(x, S.groundAt(x, z), z, Math.atan2(-w.x, -w.z), outfit, true);
      n.brain.enter('idle');
      return n;
    };
    put(15, 0.9, 2);
    put(22, -3, 3);
    put(11, 3.2, 4);
  }, way);
  await game(page, (g, w) => {
    g.cameraRig.yaw = Math.atan2(-w.x, -w.z);
    g.cameraRig.pitch = -0.05;
  }, way);
  await page.waitForTimeout(300);
  await hold(page, 'aim', true);
  await page.waitForTimeout(900);
  await shot(page, 'gun-aim.png');
  // A pad aims with a strong lock-on: the marker rides the target near the crosshair.
  await game(page, (g) => g.input.setDevice('gamepad'));
  await page.waitForTimeout(500);
  await shot(page, 'gun-lock.png');
  console.log('lock', await game(page, (g) => ({ lock: g.aim.lock, active: g.aim.active, spread: g.aim.spreadDeg })));
  // Fire three rounds slowed down so the flash and the tracers can be seen.
  await game(page, (g) => { g.gunFx.timeScale = 0.08; });
  await hold(page, 'fire', true);
  await page.waitForTimeout(90);
  await hold(page, 'fire', false);
  await page.waitForTimeout(150);
  await shot(page, 'gun-fire.png');
  await page.waitForTimeout(300);
  await hold(page, 'aim', false);
  console.log('fx', JSON.stringify(await game(page, (g) => g.gunFx.active)));
}

// ---- a burst of SMG fire at a wall: tracers, flashes, puffs and holes
{
  const page = await open('weapons=all');
  const way = await sim(page, openWay);
  await game(page, (g, w) => {
    g.cameraRig.yaw = Math.atan2(-w.x, -w.z) + 0.25;
    g.cameraRig.pitch = -0.02;
    g.gunFx.timeScale = 0.1;
  }, way);
  await hold(page, 'weapon2', true);
  await page.waitForTimeout(100);
  await hold(page, 'weapon2', false);
  await page.waitForTimeout(600);
  await hold(page, 'aim', true);
  await hold(page, 'fire', true);
  await page.waitForTimeout(450);
  await shot(page, 'gun-burst.png');
  await page.waitForTimeout(200);
  await hold(page, 'fire', false);
  await hold(page, 'aim', false);
  console.log('fx', JSON.stringify(await game(page, (g) => g.gunFx.active)));
}

// ---- a ped hit with the shotgun
{
  const page = await open('weapons=all');
  const way = await sim(page, openWay);
  await sim(page, (S, w) => {
    const c = S.registry.get(S.playerPedId).controller;
    const x = c.x + w.x * 5;
    const z = c.z + w.z * 5;
    const n = S.addPed(x, S.groundAt(x, z), z, Math.atan2(-w.x, -w.z), 2, true);
    n.brain.enter('idle');
    window.__npc = n.id;
    S.registry.get(S.playerPedId).gun.weapon = 'shotgun';
    S.registry.get(S.playerPedId).gun.equipLeft = 0;
  }, way);
  await game(page, (g, w) => {
    g.cameraRig.yaw = Math.atan2(-w.x, -w.z) + 0.1;
    g.cameraRig.pitch = -0.1;
    g.gunFx.timeScale = 0.15;
  }, way);
  await page.waitForTimeout(400);
  await hold(page, 'aim', true);
  await game(page, (g) => g.input.setDevice('gamepad'));
  await page.waitForTimeout(700);
  await hold(page, 'fire', true);
  await page.waitForTimeout(80);
  await hold(page, 'fire', false);
  await page.waitForTimeout(260);
  await shot(page, 'gun-hit.png');
  await page.waitForTimeout(900);
  await shot(page, 'gun-hit-down.png');
  console.log('npc', JSON.stringify(await sim(page, (S) => { const n = S.registry.get(window.__npc); return { life: n.life, health: n.health }; })));
}

// ---- cover: flush against a wall, then aiming from it
{
  const page = await open('weapons=all');
  const way = await sim(page, openWay);
  const spot = await sim(page, (S) => {
    const p = S.registry.get(S.playerPedId);
    const c = p.controller;
    const R = S.physics.R;
    // The nearest building face within reach of the spawn: tall (a ray at 3 m hits as well), flat for 3 m each side.
    const cast = (x, y, z, d, len) => S.physics.world.castRayAndGetNormal(new R.Ray({ x, y, z }, d), len, true, undefined, 0x00080001);
    let best = null;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const dir = { x: Math.sin(a), y: 0, z: Math.cos(a) };
      const hit = cast(c.x, c.y + 1.2, c.z, dir, 40);
      if (!hit || Math.abs(hit.normal.y) > 0.2 || (best && hit.timeOfImpact >= best.t)) continue;
      const nl = Math.hypot(hit.normal.x, hit.normal.z);
      const n = { x: hit.normal.x / nl, z: hit.normal.z / nl };
      if (-(n.x * dir.x + n.z * dir.z) < 0.85) continue;
      const px = c.x + dir.x * hit.timeOfImpact;
      const pz = c.z + dir.z * hit.timeOfImpact;
      let wide = true;
      for (const off of [-3, -1.5, 1.5, 3]) {
        for (const yy of [0.5, 3]) {
          const h2 = cast(px + n.x * 1.1 + -n.z * off, c.y + yy, pz + n.z * 1.1 + n.x * off, { x: -n.x, y: 0, z: -n.z }, 2);
          if (!h2 || Math.abs(h2.timeOfImpact - 1.1) > 0.15) wide = false;
        }
      }
      if (wide) best = { t: hit.timeOfImpact, x: px + n.x * 1.1, z: pz + n.z * 1.1, n };
    }
    if (!best) return null;
    p.controller.teleport(best.x, S.groundAt(best.x, best.z) + 0.05, best.z, Math.atan2(-best.n.x, -best.n.z));
    return { x: best.x, z: best.z, dir: { x: -best.n.x, z: -best.n.z }, d: best.t };
  });
  console.log('cover spot', JSON.stringify(spot));
  if (spot) {
    await game(page, (g, s) => {
      g.cameraRig.yaw = Math.atan2(-s.dir.x, -s.dir.z);
      g.cameraRig.pitch = -0.12;
    }, spot);
    await page.waitForTimeout(500);
    await page.keyboard.down('KeyX');
    await page.waitForTimeout(100);
    await page.keyboard.up('KeyX');
    await page.waitForTimeout(500);
    const k = await sim(page, (S) => { const p = S.registry.get(S.playerPedId); return p.cover && { low: p.cover.low, nx: p.cover.nx, nz: p.cover.nz }; });
    console.log('cover', JSON.stringify(k), JSON.stringify(await sim(page, (S) => { const c = S.registry.get(S.playerPedId).controller; return [c.x, c.y, c.z, S.players.get(1).axes[2]]; })));
    // From the street side, a little round, so the wall is behind the figure; then along the wall.
    await game(page, (g, k) => { g.cameraRig.yaw = Math.atan2(k.nx, k.nz) + 0.5; g.cameraRig.pitch = -0.1; }, k);
    await page.waitForTimeout(500);
    await shot(page, 'gun-cover-high.png');
    await game(page, (g, k) => { g.cameraRig.yaw = Math.atan2(k.nx, k.nz) + 1.35; }, k);
    await page.waitForTimeout(400);
    await shot(page, 'gun-cover-side.png');
    // Aim from it (leaning out).
    await game(page, (g, k) => { g.cameraRig.yaw = Math.atan2(k.nx, k.nz) + 1.3; g.cameraRig.pitch = -0.05; }, k);
    await page.keyboard.down('KeyZ');
    await page.waitForTimeout(900);
    await shot(page, 'gun-cover-aim.png');
    await page.keyboard.up('KeyZ');
  }
}

// ---- a drive-by: aim from the car with the SMG
{
  const page = await open('weapons=all&start=car&driver=flee');
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(90);
  await page.keyboard.up('KeyE');
  await page.waitForTimeout(500);
  await sim(page, (S) => {
    const v = S.registry.get(S.vehicleId);
    const q = v.car.pose();
    // A man on the kerb beside the car, to its right.
    const rx = -(1 - 2 * (q.q.y * q.q.y + q.q.z * q.q.z));
    const rz = -(2 * (q.q.x * q.q.z - q.q.w * q.q.y));
    const x = q.x + rx * 9 + Math.sin(v.car.yaw) * 3;
    const z = q.z + rz * 9 + Math.cos(v.car.yaw) * 3;
    const n = S.addPed(x, S.groundAt(x, z), z, 0, 3, true);
    n.brain.enter('idle');
    window.__npc = n.id;
    window.__side = { rx, rz };
  });
  await hold(page, 'weapon2', true);
  await page.waitForTimeout(100);
  await hold(page, 'weapon2', false);
  await page.waitForTimeout(500);
  await game(page, (g) => {
    const S = g.transport.host.simulation;
    const n = S.registry.get(window.__npc).controller;
    const p = S.registry.get(S.playerPedId).controller;
    // Look from the driver's eye along the line to him (the camera is a hair to the right of the pivot).
    g.cameraRig.yaw = Math.atan2(-(n.x - p.x), -(n.z - p.z));
    g.cameraRig.pitch = Math.atan2(n.y + 1.2 - (p.y + 1.35), Math.hypot(n.x - p.x, n.z - p.z));
    g.gunFx.timeScale = 0.12;
  });
  await page.keyboard.down('KeyZ');
  await page.waitForTimeout(800);
  await hold(page, 'fire', true);
  await page.waitForTimeout(500);
  await shot(page, 'gun-driveby.png');
  await hold(page, 'fire', false);
  await page.keyboard.up('KeyZ');
  console.log('npc', JSON.stringify(await sim(page, (S) => { const n = S.registry.get(window.__npc); return { life: n.life, health: n.health }; })));
}

// ---- cover behind a low wall on the procedural test ground: crouched, then standing to shoot over it
{
  const page = await open('weapons=all&tile=none');
  await sim(page, (S) => {
    const p = S.registry.get(S.playerPedId);
    // The test ground has a 1 m wall at (-14, 10), 6 m long and 0.6 m thick.
    p.controller.teleport(-14, 0.1, 8.1, 0);
    const n = S.addPed(-14.55, S.groundAt(-14.55, 22), 22, Math.PI, 3, true);
    n.brain.enter('idle');
    window.__npc = n.id;
  });
  await game(page, (g) => { g.cameraRig.yaw = Math.PI + 0.55; g.cameraRig.pitch = -0.2; });
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyX');
  await page.waitForTimeout(100);
  await page.keyboard.up('KeyX');
  await page.waitForTimeout(600);
  console.log('low cover', JSON.stringify(await sim(page, (S) => { const p = S.registry.get(S.playerPedId); return p.cover && { low: p.cover.low }; })));
  await shot(page, 'gun-cover-low.png');
  await game(page, (g) => { g.cameraRig.yaw = Math.PI; g.cameraRig.pitch = -0.02; });
  await page.keyboard.down('KeyZ');
  await page.waitForTimeout(900);
  await shot(page, 'gun-cover-low-aim.png');
  await page.keyboard.up('KeyZ');
}

// ---- the touch buttons, on a phone in landscape, with the gun up
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.goto(`${base}?transport=loopback&graphics=low&ambient=0&traffic=0&parked=0&time=14:00&timescale=0&weapons=all`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.waitForTimeout(800);
  const way = await sim(page, openWay);
  await sim(page, (S, w) => {
    const c = S.registry.get(S.playerPedId).controller;
    const n = S.addPed(c.x + w.x * 14 - w.z * 1.5, S.groundAt(c.x + w.x * 14, c.z + w.z * 14), c.z + w.z * 14 + w.x * 1.5, 0, 4, true);
    n.brain.enter('idle');
  }, way);
  await game(page, (g, w) => { g.cameraRig.yaw = Math.atan2(-w.x, -w.z); g.cameraRig.pitch = -0.04; }, way);
  const r = await page.evaluate(() => { const b = document.querySelector('.b-aim').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.touchscreen.tap(r.x, r.y);
  await page.waitForTimeout(1000);
  await shot(page, 'gun-touch.png');
  await ctx.close();
}

await browser.close();
