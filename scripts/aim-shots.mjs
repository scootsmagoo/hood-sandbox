#!/usr/bin/env node
/**
 * The aim pose at a range of pitches: screenshots into .shots/aimfix-<tag>-<gun>-<stance>-<pitch>.png and a printed
 * table of the chest's tilt from vertical and the head over the chest. The sim runs on the main thread (loopback).
 *
 *   node scripts/aim-shots.mjs [--tag after] [--guns pistol,rifle] [--stances stand,walk,crouch] [--pitches -45,-20,0,20,45] [--front]
 */
import { mkdirSync } from 'node:fs';
import { launch, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const tag = typeof args.tag === 'string' ? args.tag : 'after';
const guns = (typeof args.guns === 'string' ? args.guns : 'pistol,rifle').split(',');
const stances = (typeof args.stances === 'string' ? args.stances : 'stand,walk').split(',');
const pitches = (typeof args.pitches === 'string' ? args.pitches : '-45,-20,0,20,45').split(',').map(Number);
const views = (typeof args.views === 'string' ? args.views : 'side,front').split(',');
mkdirSync('.shots', { recursive: true });
const server = await startServer(args);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 960, height: 640 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e)));
await page.goto(`${server.base}?transport=loopback&graphics=low&ambient=0&traffic=0&parked=0&time=14:00&timescale=0&weapons=all`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
await page.keyboard.press('Shift');
await page.keyboard.press('KeyH');
await page.addStyleTag({ content: '#help { display: none !important; }' });
await page.waitForTimeout(600);
const game = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game, ${JSON.stringify(arg ?? null)})`);
const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
const hold = (action, on) => game((g, a) => g.input.holdAction(a.action, a.on), { action, on });

const way = await sim((S) => {
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
});

/** Chest and head state of the player's actor, read off the scene graph. */
const probe = () => game((g) => {
  const out = {};
  let best = null;
  g.scene.traverse((o) => { if (o.name?.startsWith('ped-') && o.visible) { const d = o.position.distanceTo(g.camera.position); if (!best || d < best.d) best = { o, d }; } });
  if (!best) return null;
  best.o.updateMatrixWorld(true);
  const bones = {};
  best.o.traverse((b) => { if (b.isBone) bones[b.name] = b; });
  const V = g.camera.position.constructor;
  const P = (n) => bones[n].getWorldPosition(new V());
  const up = (n) => { const m = bones[n].matrixWorld.elements; return null; };
  const sh = P('upperarm_R'), hnd = P('hand_R');
  const armDeg = Math.atan2(hnd.y - sh.y, Math.hypot(hnd.x - sh.x, hnd.z - sh.z)) * 180 / Math.PI;
  const pel = P('pelvis'), ch = P('chest'), nk = P('neck'), hd = P('head'), hR = P('hand_R');
  const torso = nk.clone().sub(pel).normalize();
  return { armDeg, tiltDeg: Math.acos(Math.max(-1, Math.min(1, torso.y))) * 180 / Math.PI, headOverChest: hd.y - ch.y, handY: hR.y - ch.y, torsoFwd: torso.clone().setY(0).length() };
});

const cam = (pos, tgt, fov = 40) => game((g, c) => {
  g.__cam = c;
  if (!g.__camSys) {
    g.__camSys = true;
    g.addSystem({ name: 'shotcam', priority: 9999, lateUpdate: () => {
      const c = g.__cam;
      if (!c || !c.on) return;
      g.camera.position.set(...c.pos);
      g.camera.lookAt(...c.tgt);
      if (g.camera.fov !== c.fov) { g.camera.fov = c.fov; g.camera.updateProjectionMatrix(); }
    } });
  }
}, { pos, tgt, fov, on: !!pos });

const yaw0 = Math.atan2(-way.x, -way.z);
for (const gun of guns) {
  const key = { pistol: 'weapon1', rifle: 'weapon3' }[gun] ?? gun;
  if (gun === 'rifle') await sim((S) => { const g = S.registry.get(S.playerPedId).gun; g.weapon = 'rifle'; g.equipLeft = 0; });
  else await sim((S) => { const g = S.registry.get(S.playerPedId).gun; g.weapon = 'pistol'; g.equipLeft = 0; });
  for (const stance of stances) {
    await hold('aim', false);
    await page.waitForTimeout(300);
    await page.waitForTimeout(300);
    await hold('aim', true);
    await hold('forward', stance === 'walk');
    for (const pitch of pitches) {
      for (const view of views) {
        await game((g, a) => { g.__aimYaw = a.yaw; g.__aimPitch = a.pitch; if (!g.__lock) { g.__lock = true; g.addSystem({ name: 'aimlock', priority: -1, update: () => { g.cameraRig.yaw = g.__aimYaw; g.cameraRig.pitch = g.__aimPitch; } }); } }, { yaw: yaw0, pitch: pitch * Math.PI / 180 });
        await page.waitForTimeout(700);
        const p = await sim((S) => { const c = S.registry.get(S.playerPedId).controller; return { x: c.x, y: c.y, z: c.z }; });
        const fx = -way.x, fz = -way.z; // unused sign guard
        const f = { x: -Math.sin(yaw0), z: -Math.cos(yaw0) }; // the way he faces
        const r = { x: -f.z, z: f.x };
        if (view === 'front') await cam([p.x + f.x * 2.6 + r.x * 0.5, p.y + 1.5, p.z + f.z * 2.6 + r.z * 0.5], [p.x, p.y + 1.25, p.z], 42);
        else if (view === 'side') await cam([p.x + r.x * 3.0 - f.x * 0.2, p.y + 1.3, p.z + r.z * 3.0 - f.z * 0.2], [p.x + f.x * 0.2, p.y + 1.2, p.z + f.z * 0.2], 40);
        else await cam(null, null);
        await page.waitForTimeout(250);
        const m = await probe();
        if (args.growth) for (let k = 0; k < 4; k++) { await page.waitForTimeout(1500); const mm = await probe(); console.log('  later tilt', mm.tiltDeg.toFixed(1)); }
        const name = `aimfix-${tag}-${gun}-${stance}-${view}-${pitch >= 0 ? '+' : ''}${pitch}.png`;
        await page.screenshot({ path: `.shots/${name}` });
        console.log(name, m ? `arm ${m.armDeg.toFixed(0)} tilt ${m.tiltDeg.toFixed(1)} headOverChest ${m.headOverChest.toFixed(2)} handAboveChest ${m.handY.toFixed(2)}` : 'no actor');
      }
    }
    await hold('forward', false);
  }
}
await hold('aim', false);
await browser.close();
await server.close();
