#!/usr/bin/env node
/**
 * Screenshots of the characters into .shots/chars-*.png: Kudzu close up by day and at night, a
 * lunchtime crowd, an officer, a carjack, a ragdoll, a bench and a phone call, and the old block
 * figures against the new ones. The sim runs on the main thread (loopback) so the script can place
 * people; the camera is put where it is wanted by a system that runs after the game's own.
 *
 *   node scripts/char-shots.mjs [--url http://127.0.0.1:5180/] [--only kudzu,lunch,officer,jack,ragdoll,bench,vs]
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
  await page.keyboard.press('KeyH'); // hide the help
  await page.waitForTimeout(400);
  // hide the HUD for the portraits
  if (args.hud === undefined) await page.addStyleTag({ content: '#hud, .hud, #help, #minimap, #prompt, #fps { display: none !important; }' });
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
const player = (page) => sim(page, (S) => { const c = S.registry.get(S.playerPedId).controller; return { x: c.x, y: c.y, z: c.z, yaw: c.yaw }; });

if (want('kudzu')) {
  for (const [tag, time] of [['day', '14:00'], ['night', '22:30']]) {
    const page = await open(`time=${time}&day=2&ambient=0&traffic=0`);
    await page.waitForTimeout(1500);
    const p = await player(page);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    // three quarters from the front, then from behind (the game camera's own view)
    await cam(page, [p.x + fx * 2.4 + fz * 1.1, p.y + 1.45, p.z + fz * 2.4 - fx * 1.1], [p.x, p.y + 1.15, p.z], 34);
    await page.waitForTimeout(700);
    await shot(page, `chars-kudzu-${tag}.png`);
    await cam(page, [p.x - fx * 2.3 + fz * 0.9, p.y + 1.5, p.z - fz * 2.3 - fx * 0.9], [p.x, p.y + 1.1, p.z], 40);
    await page.waitForTimeout(500);
    await shot(page, `chars-kudzu-${tag}-back.png`);
    await cam(page, [p.x + fx * 1.15 + fz * 0.35, p.y + 1.62, p.z + fz * 1.15 - fx * 0.35], [p.x, p.y + 1.58, p.z], 28);
    await page.waitForTimeout(400);
    await shot(page, `chars-kudzu-${tag}-face.png`);
    await page.close();
  }
}

// where the most people are, as the centre of the cluster and a sidewalk spot a few metres off it
const cluster = (page, radius = 20) => sim(page, (S, r) => {
  const A = S.ambient;
  let best = null, bc = 0;
  for (const p of A.list) {
    const c = p.controller;
    let n = 0;
    for (const q of A.list) if (Math.hypot(q.controller.x - c.x, q.controller.z - c.z) < r) n++;
    if (n > bc) { bc = n; best = p; }
  }
  if (!best) return null;
  const near = A.list.filter((q) => Math.hypot(q.controller.x - best.controller.x, q.controller.z - best.controller.z) < r);
  const cx = near.reduce((s, q) => s + q.controller.x, 0) / near.length;
  const cz = near.reduce((s, q) => s + q.controller.z, 0) / near.length;
  const g = A.graph;
  let node = -1, bd = 1e9;
  for (let i = 0; i < g.nodeCount; i++) {
    const d = Math.hypot(g.x[i] - cx, g.z[i] - cz);
    if (d > 8 && d < bd && g.degree(i) >= 1) { bd = d; node = i; }
  }
  return { cx, cz, n: near.length, px: g.x[node], pz: g.z[node], y: g.y[node] };
}, radius);

if (want('lunch')) {
  const page = await open(`time=12:15&day=2${args.query ? `&${args.query}` : ''}`);
  await page.waitForTimeout(3000);
  const c = await cluster(page);
  await sim(page, (S, c) => {
    const pc = S.registry.get(S.playerPedId).controller;
    pc.teleport(c.px, S.groundAt(c.px, c.pz) + 0.1, c.pz, Math.atan2(c.cx - c.px, c.cz - c.pz));
  }, c);
  const dx = c.cx - c.px, dz = c.cz - c.pz, l = Math.hypot(dx, dz) || 1;
  await cam(page, [c.px - (dx / l) * 1.5 + (dz / l) * 1.2, c.y + 2.2, c.pz - (dz / l) * 1.5 - (dx / l) * 1.2], [c.cx, c.y + 1.0, c.cz], 52);
  await page.waitForTimeout(900);
  await shot(page, `chars-lunch${args.tag ?? ''}.png`);
  await page.close();
}

if (want('officer')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0');
  await page.waitForTimeout(800);
  const o = await sim(page, (S) => {
    const me = S.registry.get(S.playerPedId);
    const c = me.controller;
    S.police.roadblocks.enabled = false;
    S.police.heli.enabled = false;
    // officers 12 m away with a clear line, in whichever direction has one
    let spot = null;
    for (let k = 0; k < 16 && !spot; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = c.x + Math.sin(a) * 12, z = c.z + Math.cos(a) * 12;
      if (S.law.clearLine({ x: c.x, y: c.y + 1.4, z: c.z }, { x, y: S.groundAt(x, z) + 1.4, z }) && Math.abs(S.groundAt(x, z) - c.y) < 0.6) spot = { x, z, a };
    }
    const ag = S.law.data.agencies.find((x) => x.id === 'acp');
    const block = { id: 99, x: spot.x, z: spot.z, dirX: 1, dirZ: 0, width: 8, unitIds: [], t0: 0, passedAt: 0, gap: null, stripId: 0 };
    const face = Math.atan2(c.x - spot.x, c.z - spot.z);
    S.police.spawnStatic(ag, 'pistol', { x: spot.x + 5, z: spot.z + 5, yaw: 0 }, { x: spot.x + 1.0, z: spot.z + 0.2, yaw: face }, block);
    S.police.spawnStatic(ag, 'rifle', { x: spot.x - 5, z: spot.z + 5, yaw: 0 }, { x: spot.x - 1.2, z: spot.z + 0.6, yaw: face }, block);
    S.law.heat.report(2, 4, c.x, c.z, true);
    me.armour = 1e9;
    return { spot, me: { x: c.x, y: c.y, z: c.z } };
  });
  await page.waitForTimeout(1200);
  const dx = o.me.x - o.spot.x, dz = o.me.z - o.spot.z, l = Math.hypot(dx, dz) || 1;
  await cam(page, [o.spot.x + (dx / l) * 3.6 - (dz / l) * 1.5, o.me.y + 1.6, o.spot.z + (dz / l) * 3.6 + (dx / l) * 1.5], [o.spot.x, o.me.y + 1.1, o.spot.z + 0.3], 44);
  await page.waitForTimeout(500);
  await shot(page, 'chars-officer.png');
  await page.close();
}

if (want('jack')) {
  const page = await open('time=12:00&day=2&start=jack&driver=flee&parked=2&traffic=0&ambient=0');
  await page.waitForTimeout(1500);
  const p = await page.evaluate(() => { const gm = window.__hood.game; return { v: gm.view.vehicle && { x: gm.view.vehicle.x, y: gm.view.vehicle.y, z: gm.view.vehicle.z }, p: { x: gm.view.ped.x, y: gm.view.ped.y, z: gm.view.ped.z } }; });
  const dx = p.p.x - p.v.x, dz = p.p.z - p.v.z, l = Math.hypot(dx, dz) || 1;
  await cam(page, [p.p.x + (dx / l) * 2.2 + (dz / l) * 2.4, p.p.y + 1.9, p.p.z + (dz / l) * 2.2 - (dx / l) * 2.4], [(p.p.x + p.v.x) / 2, p.p.y + 0.9, (p.p.z + p.v.z) / 2], 44);
  await page.keyboard.down('KeyE'); await page.waitForTimeout(80); await page.keyboard.up('KeyE');
  await page.waitForTimeout(550);
  await shot(page, 'chars-jack-1.png');
  await page.waitForTimeout(450);
  await shot(page, 'chars-jack-2.png');
  await page.close();
}

if (want('ragdoll')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0');
  await page.waitForTimeout(800);
  await sim(page, (S) => {
    const me = S.registry.get(S.playerPedId).controller;
    const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
    window.__rag = [];
    for (let i = 0; i < 4; i++) {
      const x = me.x + fx * 4 + fz * (i - 1.5) * 1.3, z = me.z + fz * 4 - fx * (i - 1.5) * 1.3;
      const n = S.addPed(x, S.groundAt(x, z), z, me.yaw + Math.PI, 1 + i * 4, true);
      n.brain.enter('idle');
      if (i % 2 === 0) { S.ragdolls.knock(n, fx * 4.5, 2.5, fz * 4.5); window.__rag.push(n.id); }
    }
  });
  const at = () => sim(page, (S) => window.__rag.map((id) => { const c = S.registry.get(id).controller; return { x: c.x, y: c.y, z: c.z }; }));
  await page.waitForTimeout(350);
  let r = await at();
  const p = await player(page);
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  const mx = (r[0].x + r[1].x) / 2, mz = (r[0].z + r[1].z) / 2;
  await cam(page, [mx + fz * 3.4 - fx * 0.8, p.y + 1.7, mz - fx * 3.4 - fz * 0.8], [mx, p.y + 0.6, mz], 46);
  await page.waitForTimeout(150);
  await shot(page, 'chars-ragdoll-1.png');
  await page.waitForTimeout(1300);
  await shot(page, 'chars-ragdoll-2.png');
  await page.close();
}

if (want('bench')) {
  const page = await open(`time=11:00&day=2&ambient=1&pedbudget=0${args.query ? `&${args.query}` : ''}`);
  await page.waitForTimeout(1200);
  await sim(page, (S) => {
    const A = S.ambient;
    const pc = S.registry.get(S.playerPedId).controller;
    const gid = Object.keys(A.population.pedGroups)[0];
    const group = A.population.pedGroups[gid];
    const acts = ['sit', 'phone', 'chat', 'atm', 'browse', 'photo', 'wait', 'cower'];
    const g = A.graph;
    const node = g.nearestNode(pc.x, pc.z, 30);
    acts.forEach((act, i) => {
      const x = pc.x + (i - 3.5) * 1.15;
      const z = pc.z - 4.2;
      const p = A.makePed(gid, group, x, S.groundAt(x, z), z, node, -1, { yaw: 0, point: -1, slot: 0, count: 1, action: act === 'cower' ? 'wait' : act, dur: 900, type: 'corner' });
      if (!p) return;
      p.controller.yaw = Math.PI;
      p.amb.poseT = 99;
      if (act === 'cower') { p.amb.mode = 'cower'; p.amb.until = 900; p.amb.faceX = pc.x; p.amb.faceZ = pc.z; }
    });
  });
  await page.waitForTimeout(1500);
  const p = await player(page);
  await cam(page, [p.x, p.y + 1.7, p.z + 1.0], [p.x, p.y + 0.95, p.z - 4.2], 62);
  await page.waitForTimeout(500);
  await shot(page, `chars-poses${args.tag ?? ''}.png`);
  await page.close();
}
if (want('gallery')) {
  const page = await open('time=13:00&day=2&ambient=0&traffic=0');
  await page.waitForTimeout(800);
  // every outfit in two rows, facing the camera, on open ground
  const g = await sim(page, (S) => {
    const me = S.registry.get(S.playerPedId).controller;
    let best = { d: 0, a: 0 };
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const hit = S.physics.world.castRay(new S.physics.R.Ray({ x: me.x, y: me.y + 1.4, z: me.z }, { x: Math.sin(a), y: 0, z: Math.cos(a) }), 60, true, undefined, 0x00080001);
      const d = hit ? hit.timeOfImpact : 60;
      if (d > best.d) best = { d, a };
    }
    const fx = Math.sin(best.a), fz = Math.cos(best.a);
    const cx = me.x + fx * 9, cz = me.z + fz * 9;
    const n = 21;
    for (let i = 0; i < n; i++) {
      const row = i < 11 ? 0 : 1, col = row ? i - 11 : i, cnt = row ? 10 : 11;
      const lx = (col - (cnt - 1) / 2) * 1.35, lz = row * 2.2;
      const x = cx + fz * lx + fx * lz, z = cz - fx * lx + fz * lz;
      const p = S.addPed(x, S.groundAt(x, z), z, best.a + Math.PI, i, true);
      p.brain.enter('idle');
    }
    return { cx, cz, y: me.y, fx, fz };
  });
  await page.waitForTimeout(1500);
  const side = (k) => [g.cx - g.fx * 11 * k, g.cz - g.fz * 11 * k];
  await cam(page, [g.cx - g.fx * 11.5, g.y + 1.6, g.cz - g.fz * 11.5], [g.cx + g.fx * 1.1, g.y + 1.0, g.cz + g.fz * 1.1], 40);
  await page.waitForTimeout(500);
  await shot(page, 'chars-gallery.png');
  await cam(page, [g.cx + g.fx * 14, g.y + 1.6, g.cz + g.fz * 14], [g.cx + g.fx * 1.1, g.y + 1.0, g.cz + g.fz * 1.1], 40);
  await page.waitForTimeout(500);
  await shot(page, 'chars-gallery-back.png');
  await page.close();
}

if (want('benchsit')) {
  const page = await open('time=11:30&day=2');
  await page.waitForTimeout(1500);
  // people on the bench nearest the middle of the tile (made if the director has not already)
  const stop = await sim(page, (S) => {
    const A = S.ambient;
    const pts = A.scenarios.points;
    let best = -1, bd = 1e9;
    pts.forEach((p, i) => { if (p.type === 'bench') { const d = Math.hypot(p.x, p.z); if (d < bd) { bd = d; best = i; } } });
    if (best < 0) return null;
    const gid = Object.keys(A.population.pedGroups)[0];
    if (A.scenarios.used[best] === 0) A.spawnScenario(best, gid, A.population.pedGroups[gid]);
    const p = pts[best];
    const pc = S.registry.get(S.playerPedId).controller;
    pc.teleport(p.x + Math.sin(p.yaw) * 6, S.groundAt(p.x, p.z) + 0.1, p.z + Math.cos(p.yaw) * 6, Math.atan2(-Math.sin(p.yaw), -Math.cos(p.yaw)));
    return { x: p.x, z: p.z, yaw: p.yaw, y: S.groundAt(p.x, p.z), used: A.scenarios.used[best] };
  });
  console.log('bench', stop);
  await page.waitForTimeout(1500);
  const fx = Math.sin(stop.yaw), fz = Math.cos(stop.yaw);
  await cam(page, [stop.x + fx * 3.4 + fz * 1.5, stop.y + 1.5, stop.z + fz * 3.4 - fx * 1.5], [stop.x, stop.y + 0.8, stop.z], 42);
  await page.waitForTimeout(500);
  await shot(page, 'chars-bench.png');
  await page.close();
}

if (want('aim')) {
  const page = await open('time=14:00&day=2&ambient=0&traffic=0&weapons=all');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__hood.game.input.holdAction('aim', true));
  await page.waitForTimeout(900);
  const p = await player(page);
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  await cam(page, [p.x + fx * 2.2 + fz * 2.4, p.y + 1.5, p.z + fz * 2.2 - fx * 2.4], [p.x, p.y + 1.2, p.z], 40);
  await page.waitForTimeout(500);
  await shot(page, 'chars-aim-rifle.png');
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(700);
  await shot(page, 'chars-aim-pistol.png');
  await page.close();
}

if (want('drive')) {
  const page = await open('time=14:00&day=2&start=car&ambient=0&traffic=0');
  await page.waitForTimeout(1000);
  await page.keyboard.down('KeyE'); await page.waitForTimeout(80); await page.keyboard.up('KeyE');
  await page.waitForTimeout(1500);
  const g = await sim(page, (S) => {
    const car = S.registry.get(S.vehicleId).car;
    const p = car.pose();
    const yaw = 2 * Math.atan2(p.q.y, p.q.w);
    return { x: p.x, y: p.y, z: p.z, fx: Math.sin(yaw), fz: Math.cos(yaw) };
  });
  // from above the bonnet, looking back through the windscreen at the driver
  await cam(page, [g.x + g.fx * 3.0 + g.fz * 0.5, g.y + 2.1, g.z + g.fz * 3.0 - g.fx * 0.5], [g.x + g.fz * 0.4, g.y + 0.95, g.z - g.fx * 0.4], 40);
  await page.waitForTimeout(500);
  await shot(page, 'chars-drive.png');
  await page.close();
}

await browser.close();
await server.close();
