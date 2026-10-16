#!/usr/bin/env node
/**
 * Close-up screenshots of the people (faces by skin tone, hands, shoes, a seated skirt, hair) into
 * .shots/polish-*.png. A lab: ordinary people are placed in a row in front of a fixed camera, their
 * palettes are overwritten (skin tone, outfit) from the page, and the camera is put where it is wanted.
 *
 *   node scripts/polish-shots.mjs [--only faces,hands,shoes,skirt,hair,gallery,carenter] [--url ...]
 */
import { mkdirSync } from 'node:fs';
import { launch, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (n) => !only || only.has(n);
mkdirSync('.shots', { recursive: true });
const server = await startServer(args);
const browser = await launch();
const W = Number(args.w ?? 1280), H = Number(args.h ?? 720);

async function open(query, size = [W, H]) {
  const page = await (await browser.newContext({ viewport: { width: size[0], height: size[1] } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text()); });
  await page.goto(`${server.base}?transport=loopback&graphics=high&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH');
  await page.waitForTimeout(300);
  await page.addStyleTag({ content: '#hud, .hud, #help, #minimap, #prompt, #fps { display: none !important; }' });
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: `.shots/${name}` }); console.log('shot', `.shots/${name}`); };
const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
const cam = (page, pos, tgt, fov = 35) => page.evaluate(({ pos, tgt, fov }) => {
  const g = window.__hood.game;
  g.__cam = { pos, tgt, fov };
  if (!g.__camSys) {
    g.__camSys = true;
    g.addSystem({ name: 'shotcam', priority: 9999, lateUpdate: () => {
      const c = g.__cam;
      if (!c) return;
      g.camera.position.set(...c.pos);
      g.camera.lookAt(...c.tgt);
      if (g.camera.fov !== c.fov) { g.camera.fov = c.fov; g.camera.updateProjectionMatrix(); }
    } });
  }
}, { pos, tgt, fov });

/** Open ground near the player: the direction with the most clear room, and a spot 6 m along it. */
const stage = (page) => sim(page, (S) => {
  const me = S.registry.get(S.playerPedId).controller;
  let best = { d: 0, a: 0 };
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const hit = S.physics.world.castRay(new S.physics.R.Ray({ x: me.x, y: me.y + 1.4, z: me.z }, { x: Math.sin(a), y: 0, z: Math.cos(a) }), 60, true, undefined, 0x00080001);
    const d = hit ? hit.timeOfImpact : 60;
    if (d > best.d) best = { d, a };
  }
  const fx = Math.sin(best.a), fz = Math.cos(best.a);
  const x = me.x + fx * 7, z = me.z + fz * 7;
  return { x, z, y: S.groundAt(x, z), fx, fz, a: best.a };
});

const SKINS = [0x4a2f20, 0x5a3b2a, 0x7f5239, 0xa87450, 0xd0a07a, 0xf0c9a8];

/** Places people in a row across the view from `c`: `list` is [{ outfit, skin?, pose? }]. */
async function lineup(page, c, list, spacing, dist = 0) {
  await sim(page, (S, o) => {
    window.__lab = [];
    const n = o.list.length;
    o.list.forEach((it, i) => {
      const lx = (i - (n - 1) / 2) * o.spacing;
      const x = o.c.x + o.c.fz * lx, z = o.c.z - o.c.fx * lx;
      const p = S.addPed(x, S.groundAt(x, z), z, o.c.a + Math.PI, it.outfit, true);
      p.brain.enter('idle');
      p.busy = true;
      if (it.yawOff) p.controller.yaw += it.yawOff;
      window.__lab.push(p.id);
    });
  }, { c, list, spacing });
  await page.waitForTimeout(1200);
  // paint the skin tones
  await page.evaluate((list) => {
    const g = window.__hood.game;
    const peds = g.views.peds;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const set = (pal, r, hex) => { pal[r * 3] = lin(((hex >> 16) & 255) / 255); pal[r * 3 + 1] = lin(((hex >> 8) & 255) / 255); pal[r * 3 + 2] = lin((hex & 255) / 255); };
    const mix = (a, b, t) => { const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t); return (ch(16) << 16) | (ch(8) << 8) | ch(0); };
    window.__lab.forEach((id, i) => {
      const v = peds.views.get(id);
      const it = list[i];
      if (!v) return;
      if (v.actor) {
        const a = v.actor;
        const orig = a.update.bind(a);
        const base = { grounded: true, speed: 0, yawRate: 0, mode: 'normal', swing: 0, pose: 0 };
        if (it.gun) { const og = a.setGun.bind(a); a.setGun = () => og(it.gun); }
        a.update = (dt, inp, ap, k) => orig(dt, Object.assign({}, inp, base, it.input ?? {}, { extra: Object.assign({}, it.input?.extra ?? {}) }), it.aim ?? ap, k);
      }
      if (it.skin === undefined) return;
      for (const pal of [v.app.palette, v.actor?.palette]) {
        if (!pal) continue;
        set(pal, 0, it.skin);
        set(pal, 15, it.skin);
        set(pal, 1, mix(it.skin, 0x8a3b3b, 0.35));
        set(pal, 14, mix(it.skin, 0x15110e, 0.5));
      }
      if (it.hair !== undefined) for (const pal of [v.app.palette, v.actor?.palette]) if (pal) set(pal, 4, it.hair);
    });
  }, list);
}

if (want('faces')) {
  // six skin tones, close up, in three lights; the people are real actors
  for (const [tag, time] of [['day', '14:00'], ['dusk', '19:20'], ['night', '22:30']]) {
    const page = await open(`time=${time}&day=2&ambient=0&traffic=0&pedbudget=14`);
    await page.waitForTimeout(1200);
    const c = await stage(page);
    await lineup(page, c, SKINS.map((skin, i) => ({ outfit: [7, 1, 10, 8, 14, 2][i], skin })), 0.62);
    // two triples of faces, then the first and last tone big
    for (const [view, k0] of [['a', 1], ['b', 4]]) {
      const lx = (k0 - 2.5) * 0.62;
      await cam(page, [c.x - c.fx * 2.0 + c.fz * lx, c.y + 1.64, c.z - c.fz * 2.0 - c.fx * lx], [c.x + c.fz * lx, c.y + 1.58, c.z - c.fx * lx], 30);
      await page.waitForTimeout(450);
      await shot(page, `polish-faces-${tag}-${view}.png`);
    }
    for (const [k, sx] of [[0, -2.5], [5, 2.5]]) {
      await cam(page, [c.x - c.fx * 1.3 + c.fz * sx * 0.62, c.y + 1.64, c.z - c.fz * 1.3 - c.fx * sx * 0.62], [c.x + c.fz * sx * 0.62, c.y + 1.62, c.z - c.fx * sx * 0.62], 20);
      await page.waitForTimeout(400);
      await shot(page, `polish-face-${tag}-${k}.png`);
    }
    await page.close();
  }
}

if (want('hands')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0&pedbudget=14');
  await page.waitForTimeout(1000);
  const c = await stage(page);
  await lineup(page, c, [
    { outfit: 7, gun: 'pistol', input: { extra: { aim: 0 } }, aim: 0 },
    { outfit: 14, gun: 'rifle', input: { extra: { aim: 0, long: true } }, aim: 0 },
    { outfit: 1, gun: 'pistol', input: { extra: { aim: 0, crouch: true } }, aim: 0 },
  ], 1.6);
  await page.waitForTimeout(600);
  // the shooters face the camera; look at the gun hand from the front-right of each
  for (const [k, name] of [[0, 'pistol'], [1, 'rifle'], [2, 'crouch']]) {
    const lx = (k - 1) * 1.6;
    const px = c.x + c.fz * lx, pz = c.z - c.fx * lx;
    // the shooters face the camera (d = -f); the gun hand is on their right (+fz, -fx): look at it from there, close
    const dx = -c.fx, dz = -c.fz, rx = c.fz, rz = -c.fx;
    const hy = c.y + (k === 2 ? 0.95 : 1.42);
    await cam(page, [px + rx * 1.05 + dx * 0.62, hy + 0.08, pz + rz * 1.05 + dz * 0.62], [px + dx * 0.5, hy, pz + dz * 0.5], 30);
    await page.waitForTimeout(500);
    await shot(page, `polish-hands-${name}.png`);
  }
  await page.close();
}

if (want('wheel')) {
  const page = await open('time=14:00&day=2&start=car&ambient=0&traffic=0');
  await page.waitForTimeout(1000);
  await page.keyboard.down('KeyE'); await page.waitForTimeout(80); await page.keyboard.up('KeyE');
  await page.waitForTimeout(1500);
  const g = await sim(page, (S) => {
    const p = S.registry.get(S.vehicleId).car.pose();
    const yaw = 2 * Math.atan2(p.q.y, p.q.w);
    return { x: p.x, y: p.y, z: p.z, fx: Math.sin(yaw), fz: Math.cos(yaw) };
  });
  // the driver sits on the left (+X of the car, whose left is (fz, -fx)); look at the wheel from the passenger side, behind the hands
  const lx = g.fz, lz = -g.fx;
  // the camera sits inside the cabin (no glass in the way), put relative to the driver's hands
  const hands = await page.evaluate(() => {
    const gm = window.__hood.game;
    const id = gm.view.ped.id;
    const a = gm.views.peds.views.get(id).actor;
    const get = (n) => a.bones[a.assets.rig.index.get(n)].getWorldPosition(new (a.root.position.constructor)()).toArray();
    return { l: get('hand_L'), r: get('hand_R'), head: get('head') };
  });
  const mid = hands.l.map((v, i) => (v + hands.r[i]) / 2);
  console.log('hands', JSON.stringify(hands));
  for (const [name, off, fov] of [['wheel-a', [-0.62, 0.22, -0.08], 36], ['wheel-b', [0.0, 0.2, 0.7], 40], ['wheel-c', [-0.3, 0.55, -0.35], 34]]) {
    const [l, u, f] = off;
    await cam(page, [mid[0] + lx * l + g.fx * f, mid[1] + u, mid[2] + lz * l + g.fz * f], mid, fov);
    await page.waitForTimeout(500);
    await shot(page, `polish-${name}.png`);
  }
  await page.close();
}

if (want('hair')) {
  // every body's head, in groups of five, from the front-left, the back and the front
  const outfits = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 13, 15, 16];
  for (const [tag, time] of [['day', '14:00']]) {
    const page = await open(`time=${time}&day=2&ambient=0&traffic=0&pedbudget=14`);
    await page.waitForTimeout(1000);
    const c = await stage(page);
    await lineup(page, c, outfits.map((outfit) => ({ outfit })), 0.62);
    const n = outfits.length;
    for (let g = 0; g < 3; g++) {
      const k0 = g * 5, k1 = Math.min(n - 1, k0 + 4);
      const lx = ((k0 + k1) / 2 - (n - 1) / 2) * 0.62;
      for (const [view, side, dist] of [['front', 0, 2.9], ['back', 0, -2.9]]) {
        const ex = c.x + c.fz * lx - c.fx * dist, ez = c.z - c.fx * lx - c.fz * dist;
        await cam(page, [ex, c.y + 1.7, ez], [c.x + c.fz * lx, c.y + 1.55, c.z - c.fx * lx], 36);
        await page.waitForTimeout(450);
        await shot(page, `polish-hair-${view}-${g}.png`);
      }
    }
    await page.close();
  }
}

if (want('carenter')) {
  // the player at the driver's door of his own car: press E, a frame every 130 ms from the door side
  for (const dir of ['enter', 'exit']) {
    const page = await open('time=14:00&day=2&start=car&ambient=0&traffic=0');
    await page.waitForTimeout(1000);
    const g = await sim(page, (S) => {
      const p = S.registry.get(S.vehicleId).car.pose();
      const yaw = 2 * Math.atan2(p.q.y, p.q.w);
      return { x: p.x, y: p.y, z: p.z, fx: Math.sin(yaw), fz: Math.cos(yaw) };
    });
    const lx = g.fz, lz = -g.fx;
    // from the front-left, low, looking at the door
    await cam(page, [g.x + lx * 3.3 + g.fx * 2.4, g.y + 1.5, g.z + lz * 3.3 + g.fz * 2.4], [g.x + lx * 0.8 + g.fx * 0.3, g.y + 0.7, g.z + lz * 0.8 + g.fz * 0.3], 42);
    if (dir === 'exit') {
      await page.keyboard.down('KeyE'); await page.waitForTimeout(80); await page.keyboard.up('KeyE');
      await page.waitForTimeout(1600);
    }
    await page.keyboard.down('KeyE'); await page.waitForTimeout(80); await page.keyboard.up('KeyE');
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(110);
      await shot(page, `polish-car-${dir}-${i}.png`);
    }
    await page.close();
  }
}

if (want('shoes')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0&pedbudget=14');
  await page.waitForTimeout(1000);
  const c = await stage(page);
  // boots, dress shoes, sneakers, small sneakers, dress shoes
  await lineup(page, c, [0, 1, 7, 8, 10].map((outfit) => ({ outfit })), 0.55);
  await page.waitForTimeout(500);
  for (const [name, side, dist, h] of [['front', 0.0, 1.5, 0.3], ['three-quarter', 0.9, 1.35, 0.32], ['side', 1.4, 0.9, 0.3]]) {
    const dx = -c.fx, dz = -c.fz, rx = c.fz, rz = -c.fx;
    await cam(page, [c.x + dx * dist + rx * side * 1.2, c.y + h, c.z + dz * dist + rz * side * 1.2], [c.x + dx * 0.15 + rx * (name === 'side' ? 0.55 : 0), c.y + 0.07, c.z + dz * 0.15 + rz * (name === 'side' ? 0.55 : 0)], name === 'side' ? 34 : 40);
    await page.waitForTimeout(450);
    await shot(page, `polish-shoes-${name}.png`);
  }
  await page.close();
}

if (want('skirt')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0&pedbudget=14');
  await page.waitForTimeout(1000);
  const c = await stage(page);
  // seated and cowering in dresses and skirts (the figures hover: the bench is left out so the cloth is all there is to look at)
  await lineup(page, c, [
    { outfit: 10, input: { pose: 1 } },
    { outfit: 2, input: { pose: 1 } },
    { outfit: 16, input: { pose: 1 } },
    { outfit: 10, input: { pose: 4 } },
    { outfit: 19, input: { pose: 4 } },
  ], 0.85);
  await page.waitForTimeout(700);
  const dx = -c.fx, dz = -c.fz, rx = c.fz, rz = -c.fx;
  for (const [name, side, dist, fov] of [['front', 0, 3.2, 44], ['side', 1.0, 2.7, 44]]) {
    await cam(page, [c.x + dx * dist * (1 - side * 0.5) + rx * side * dist * 0.85, c.y + 1.15, c.z + dz * dist * (1 - side * 0.5) + rz * side * dist * 0.85], [c.x, c.y + 0.6, c.z], fov);
    await page.waitForTimeout(450);
    await shot(page, `polish-skirt-${name}.png`);
  }
  await page.close();
}

await browser.close();
await server.close();
