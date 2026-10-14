#!/usr/bin/env node
/**
 * Screenshots of the law and damage systems into .shots/, on the baked Five Points tile. The sim runs
 * on the main thread (loopback transport) so the script can set a scene up through `window.__hood.game.transport.host.simulation`;
 * everything the player does is a real key press.
 *
 *   node scripts/law-shots.mjs [--url http://127.0.0.1:5180/]
 *
 * Writes: law-downed.png, law-smoking.png, law-fire.png, law-explosion.png, law-stars-reported.png,
 * law-stars-seen.png, law-stars-lost.png, law-chase.png, law-wasted.png, law-busted.png
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { STATE } from './drive-helpers.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});

const tap = async (page, key, ms = 90) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
async function open(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`${base}?transport=loopback&graphics=low&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await tap(page, 'KeyH'); // help panel off
  await page.waitForTimeout(600);
  return page;
}
const shot = async (page, name, clip) => { await page.screenshot({ path: `.shots/${name}`, ...(clip ? { clip } : {}) }); console.log('shot', `.shots/${name}`); };
const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);

// ---- a punch: the NPC goes down
{
  const page = await open('driver=flee&parked=3');
  await sim(page, (S) => {
    const p = S.registry.get(S.playerPedId);
    const c = p.controller;
    const yaw = Math.atan2(S.vehicleId ? 1 : 0, 0);
    void yaw;
    const f = { x: Math.sin(c.yaw), z: Math.cos(c.yaw) };
    const n = S.addPed(c.x + f.x * 1.3, S.groundAt(c.x + f.x * 1.3, c.z + f.z * 1.3), c.z + f.z * 1.3, c.yaw + Math.PI, 3, true);
    n.brain.enter('idle');
    window.__npc = n.id;
  });
  await page.evaluate(() => { const g = window.__hood.game; g.cameraRig.preset = 1; });
  // Put the camera behind the player's facing, a little to the side.
  await page.evaluate(() => {
    const g = window.__hood.game;
    const ped = g.view.ped;
    const yaw = Math.atan2(2 * (ped.q.x * ped.q.z + ped.q.w * ped.q.y), 1 - 2 * (ped.q.x * ped.q.x + ped.q.y * ped.q.y));
    g.cameraRig.yaw = yaw + Math.PI - 0.5;
    g.cameraRig.pitch = -0.2;
  });
  await page.waitForTimeout(500);
  await tap(page, 'KeyQ');
  await page.waitForTimeout(160);
  await shot(page, 'law-punch.png');
  await page.waitForTimeout(500);
  await shot(page, 'law-downed.png');
  console.log('npc state', await sim(page, (S) => { const n = S.registry.get(window.__npc); return { life: n.life, health: n.health }; }));
}

// ---- a smoking car, then fire, then the explosion
{
  const page = await open('start=car&parked=0');
  await tap(page, 'KeyE');
  await page.waitForTimeout(400);
  await sim(page, (S) => { const v = S.registry.get(S.vehicleId); S.damageVehicle(v, 300, 640, 0); });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1600);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shot(page, 'law-smoking.png');
  await sim(page, (S) => { const v = S.registry.get(S.vehicleId); S.damageVehicle(v, 200, 600, 0); });
  await page.waitForTimeout(500);
  // Out of the car before it blows.
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyS');
  await tap(page, 'KeyE');
  await sim(page, (S) => {
    const v = S.registry.get(S.vehicleId);
    S.damageVehicle(v, 0, 400, 0);
    const p = S.registry.get(S.playerPedId).controller;
    const c = v.car.pose();
    const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz) || 1;
    p.teleport(c.x + (dx / d) * 14, p.y, c.z + (dz / d) * 14);
  });
  // Look at the car from where the player stands.
  const aim = () => page.evaluate(() => {
    const g = window.__hood.game;
    const car = g.view.vehicle;
    const me = g.view.ped;
    g.cameraRig.preset = 2;
    g.cameraRig.yaw = Math.atan2(-(car.x - me.x), -(car.z - me.z));
    g.cameraRig.pitch = -0.12;
  });
  await aim();
  await page.waitForFunction(() => { const g = window.__hood.game; const s = g.view.vehicle; return s && (s.flags & 512) !== 0; }, null, { timeout: 15000 }).catch(() => console.log('no fire'));
  await aim();
  await page.waitForTimeout(900);
  await shot(page, 'law-fire.png');
  await page.waitForFunction(() => { const g = window.__hood.game; const s = g.view.vehicle; return s && (s.flags & 1024) !== 0; }, null, { timeout: 15000 }).catch(() => console.log('no explosion'));
  await aim();
  await page.waitForTimeout(120);
  await shot(page, 'law-explosion.png');
  await page.waitForTimeout(2500);
  await shot(page, 'law-burnt.png');
}

// ---- the stars, and a police car on the player's tail
{
  const page = await open('start=car&parked=0');
  await tap(page, 'KeyE');
  await page.waitForTimeout(500);
  await sim(page, (S) => {
    const p = S.playerPosition();
    // A crime with a real report: hollow stars while only reported.
    S.law.heat.report(2, 3, p.x, p.z);
  });
  await page.waitForTimeout(300);
  const clip = { x: 1000, y: 0, width: 280, height: 90 };
  await shot(page, 'law-stars-reported.png', clip);
  // Wait where we are until a police car has eyes on us, then roll off slowly with it behind.
  await page.waitForFunction(() => window.__hood.game.view.heatPhase === 2, null, { timeout: 60000 }).catch(() => console.log('never seen'));
  await shot(page, 'law-stars-seen.png', clip);
  let got = false;
  for (let i = 0; i < 160 && !got; i++) {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(60);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => {
      const g = window.__hood.game;
      const me = g.view.vehicle;
      let best = null;
      for (const e of g.view.entities.values()) {
        if (e.kind !== 2 || (e.flags & 2048) === 0) continue;
        const v = g.camera.position.clone().set(e.x, e.y + 1, e.z).project(g.camera);
        const d = me ? Math.hypot(e.x - me.x, e.z - me.z) : 999;
        if (v.z < 1 && Math.abs(v.x) < 0.8 && Math.abs(v.y) < 0.8 && (!best || d < best.d)) best = { d, x: v.x };
      }
      return best;
    });
    if (st && st.d < 45) {
      got = true;
      console.log('police car in view at', st.d.toFixed(0), 'm');
    }
  }
  if (got) await shot(page, 'law-chase.png');
  else console.log('no police car in view');
  // And closer: put a police car on the player's tail (the sim spawns it the way dispatch would), drive off, look back.
  await sim(page, (S) => {
    const v = S.registry.get(S.vehicleId);
    const p = v.car.pose();
    const fwd = { x: Math.sin(v.car.yaw), z: Math.cos(v.car.yaw) };
    const snap = S.police.graph.nearest(p.x - fwd.x * 16, p.z - fwd.z * 16);
    const at = S.police.graph.at(snap.edge, snap.s);
    const agency = S.law.data.agencies[0];
    S.police.spawnUnit({ x: at.x, z: at.z, edge: snap.edge, s: snap.s, dx: at.dx, dz: at.dz }, { agency, row: { heat: 1, maxUnits: 5, spawnIntervalS: 1, unitsPerSpawn: 1, loadout: 'pistol' }, units: 1 }, p.x, p.z);
  });
  await page.keyboard.down('KeyC');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1800);
  for (const n of ['a', 'b', 'c', 'd']) {
    await shot(page, `law-lightbar-${n}.png`);
    await page.waitForTimeout(130);
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyC');
  // The flashing stars: lose them.
  await sim(page, (S) => { S.law.heat.step(S.law.data ? 2 : 2, false); });
  await page.waitForTimeout(150);
  await shot(page, 'law-stars-lost.png', clip);
  await page.waitForTimeout(250);
  await shot(page, 'law-stars-lost2.png', clip);
}

// ---- wasted and busted
{
  const page = await open('parked=0');
  await sim(page, (S) => { const p = S.registry.get(S.playerPedId); p.health = 4; });
  await sim(page, (S) => { const p = S.registry.get(S.playerPedId); p.controller.teleport(p.controller.x, p.controller.y + 9, p.controller.z); });
  await page.waitForTimeout(1900);
  await shot(page, 'law-wasted.png');
  await page.waitForTimeout(2500);
  console.log('after wasted', (await page.evaluate(STATE)).ped, await page.evaluate(() => window.__hood.game.view.health));
  await sim(page, (S) => { S.beginBusted(1, 0); });
  await page.waitForTimeout(1500);
  await shot(page, 'law-busted.png');
}

await browser.close();
