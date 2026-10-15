#!/usr/bin/env node
/**
 * Screenshots of the police escalation into .shots/, on the baked Five Points tile: a roadblock, the
 * helicopter and its searchlight at night, a PIT on the freeway by the Highway Patrol, a spike strip,
 * and an officer firing. The sim runs on the main thread (loopback transport) and is stepped by hand
 * (`host.advance`) so each scene is set up exactly and caught at the right tick; the page's animation
 * frames can be stepped by hand too (`__raf`), so a muzzle flash that lasts 55 ms is on screen when
 * the picture is taken.
 *
 *   node scripts/police-shots.mjs [--url http://127.0.0.1:5180/] [--only roadblock,heli,pit,spikes,fire]
 *
 * Writes: police-roadblock.png, police-roadblock-near.png, police-heli-night.png, police-heli-day.png,
 * police-pit-align.png, police-pit-strike.png, police-pit-spin.png, police-spikes-ahead.png,
 * police-spikes-flat.png, police-fire.png
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // Animation frames can be taken over: `__raf.manual = true` queues them, `__raf.step(ms)` runs one frame.
  await ctx.addInitScript(() => {
    const real = window.requestAnimationFrame.bind(window);
    const queue = [];
    const raf = { manual: false, t: 0, step(ms = 16.7) { raf.t += ms; const q = queue.splice(0); for (const cb of q) cb(raf.t); } };
    window.__raf = raf;
    window.requestAnimationFrame = (cb) => (raf.manual ? (queue.push(cb), 0) : real(cb));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`${base}?transport=loopback&graphics=medium&parked=0&ambient=0&traffic=0&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await page.keyboard.down('KeyH');
  await page.waitForTimeout(90);
  await page.keyboard.up('KeyH'); // help panel off
  await page.evaluate(() => window.__hood.game.transport.host.stop());
  await page.waitForTimeout(500);
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: `.shots/${name}` });
  console.log('shot', `.shots/${name}`);
};
/** Runs `fn(host, S, arg)` in the page: `host` is the sim host, `S` the Simulation. */
const run = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host, window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);

/** Page-side helper: drives the player's car along the road it is on (the police's own route prediction), at a speed. */
const BOT = () => {
  window.__bot = {
    speed: 14,
    n: 100000,
    step(host, S) {
      const v = S.registry.get(S.vehicleId);
      const p = v.car.pose();
      const sp = v.car.speedForward;
      const path = S.police.nav.predict(p.x, p.z, v.car.yaw, 0, 60);
      const a = path[Math.min(path.length - 1, 5)] ?? { x: p.x + Math.sin(v.car.yaw), z: p.z + Math.cos(v.car.yaw) };
      let err = Math.atan2(a.x - p.x, a.z - p.z) - v.car.yaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      const steer = Math.max(-1, Math.min(1, -err * 2.2));
      const thr = Math.max(0, Math.min(1, (this.speed - sp) * 0.5));
      const brk = Math.max(0, Math.min(1, (sp - this.speed - 1.5) * 0.3));
      host.input({ tick: ++this.n, buttons: 0, axes: [0, 0, 0, 0, thr, brk, steer, 14, 0] });
      host.advance(1);
      const me = S.registry.get(S.playerPedId);
      me.armour = 1e9;
    },
    run(host, S, ticks, until) {
      for (let i = 0; i < ticks; i++) {
        this.step(host, S);
        if (until && until()) return i;
      }
      return -1;
    },
    park(host, S, ticks = 60) {
      for (let i = 0; i < ticks; i++) {
        host.input({ tick: ++this.n, buttons: 8, axes: [0, 0, 0, 0, 0, 0, 0, 14, 0] });
        host.advance(1);
      }
    },
  };
};

const want = (name) => !only || only.has(name);

// ---- a roadblock
if (want('roadblock')) {
  const page = await open('start=car&time=14:00&timescale=0');
  await page.evaluate(BOT);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(100);
  await page.keyboard.up('KeyE');
  const info = await run(page, (host, S) => {
    host.advance(50);
    const p = S.registry.get(S.playerPedId).controller;
    S.law.heat.report(3, 4, p.x, p.z, true);
    S.police.heli.enabled = false;
    window.__bot.speed = 13;
    // wait where they are until the police arrive and see them, then go
    for (let i = 0; i < 60 * 25 && !S.police.seesPlayer; i += 10) window.__bot.park(host, S, 10);
    const inCar = S.registry.get(S.playerPedId).vehicleId === S.vehicleId;
    const t = window.__bot.run(host, S, 60 * 40, () => S.police.roadblocks.blocks.length > 0 && S.police.units.some((u) => u.block));
    const b = S.police.roadblocks.blocks[0];
    if (!b) return { found: false, t, inCar, hero: S.registry.get(S.vehicleId).car.pose(), speed: S.registry.get(S.vehicleId).car.speedForward, heat: S.law.heat.level, units: S.police.units.length, tgt: S.police.tgt && { live: S.police.tgt.live, inCar: S.police.tgt.inCar, speed: S.police.tgt.speed } };
    const v = S.registry.get(S.vehicleId);
    const yaw = Math.atan2(b.dirX, b.dirZ);
    const at = (d) => ({ x: b.x - b.dirX * d, z: b.z - b.dirZ * d });
    const p0 = at(55);
    v.car.teleport(p0.x, S.groundAt(p0.x, p0.z) + 0.6, p0.z, yaw);
    v.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    window.__bot.park(host, S, 90);
    window.__bot.near = at(34);
    return { found: true, t, block: { x: b.x, z: b.z, gap: b.gap, cars: b.unitIds.length }, strips: S.police.spikes.count };
  });
  console.log('roadblock', JSON.stringify(info));
  await page.waitForTimeout(1500);
  await shot(page, 'police-roadblock.png');
  await run(page, (host, S) => {
    const v = S.registry.get(S.vehicleId);
    const n = window.__bot.near;
    const b = S.police.roadblocks.blocks[0];
    v.car.teleport(n.x, S.groundAt(n.x, n.z) + 0.6, n.z, Math.atan2(b.dirX, b.dirZ));
    window.__bot.park(host, S, 60);
    const rig = window.__hood.game.cameraRig;
    rig.preset = 1;
    rig.offYaw = 0.5;
    rig.offPitch = 0.14;
    rig.idle = -1e6;
  });
  await page.waitForTimeout(1500);
  await shot(page, 'police-roadblock-near.png');
  await page.close();
}

// ---- the helicopter, at night and by day
if (want('heli')) {
  const scene = async (query, name) => {
    const page = await open(query);
    const info = await run(page, (host, S) => {
      host.advance(30);
      const me = S.registry.get(S.playerPedId).controller;
      const p = { x: me.x, z: me.z };
      S.law.heat.report(3, 4, p.x, p.z, true);
      S.police.roadblocks.enabled = false;
      S.police.spikes.enabled = false;
      host.advance(40); // the helicopter is made
      const h = S.police.heli.helis[0];
      const rig = window.__hood.game.cameraRig;
      // the camera looks at the helicopter over the player's shoulder: 36 m ahead of the player and 30 m up
      const yaw = 3.4;
      const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const hx = p.x + f.x * 36;
      const hz = p.z + f.z * 36;
      h.x = hx;
      h.z = hz;
      h.y = S.groundAt(hx, hz) + 30;
      h.vx = h.vy = h.vz = 0;
      h.yaw = Math.atan2(p.x - hx, p.z - hz) + 0.12;
      host.advance(2);
      rig.yaw = yaw;
      rig.pitch = 0.3;
      rig.preset = 2;
      return { agl: h.agl, searchlight: h.searchlight, sees: h.sees };
    });
    console.log(name, JSON.stringify(info));
    await page.waitForTimeout(1200);
    await shot(page, name);
    await page.close();
  };
  await scene('time=23:20&timescale=0', 'police-heli-night.png');
  await scene('time=14:00&timescale=0', 'police-heli-day.png');
}

// ---- a PIT on the freeway by the Highway Patrol
if (want('pit')) {
  const page = await open('start=car&time=14:00&timescale=0');
  await page.evaluate(BOT);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(100);
  await page.keyboard.up('KeyE');
  const info = await run(page, (host, S) => {
    host.advance(30);
    const v = S.registry.get(S.vehicleId);
    // the long straight motorway: park the car on its centre line heading along it
    const rd = S.tile.roads.filter((r) => r.class === 'motorway' && !r.bridge && r.points.length > 6).sort((a, b) => Math.hypot(b.points[b.points.length - 1][0] - b.points[0][0], b.points[b.points.length - 1][2] - b.points[0][2]) - Math.hypot(a.points[a.points.length - 1][0] - a.points[0][0], a.points[a.points.length - 1][2] - a.points[0][2]))[0];
    const cum = [0];
    for (let i = 1; i < rd.points.length; i++) cum.push(cum[i - 1] + Math.hypot(rd.points[i][0] - rd.points[i - 1][0], rd.points[i][2] - rd.points[i - 1][2]));
    const at = (d) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const k = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
      const p0 = rd.points[i - 1];
      const p1 = rd.points[i];
      return { x: p0[0] + (p1[0] - p0[0]) * k, y: p0[1] + (p1[1] - p0[1]) * k, z: p0[2] + (p1[2] - p0[2]) * k, yaw: Math.atan2(p1[0] - p0[0], p1[2] - p0[2]) };
    };
    // the car 75 m along it at 15 m/s, a Highway Patrol cruiser 45 m behind at 19
    const h0 = at(75);
    v.car.teleport(h0.x, h0.y + 0.7, h0.z, h0.yaw);
    v.car.body.setLinvel({ x: Math.sin(h0.yaw) * 15, y: 0, z: Math.cos(h0.yaw) * 15 }, true);
    v.car.adopt();
    window.__bot.speed = 15;
    host.advance(5);
    S.law.heat.report(2, 4, h0.x, h0.z, true);
    S.police.roadblocks.enabled = false;
    S.police.heli.enabled = false;
    S.police.spikes.enabled = false;
    const ghp = S.law.data.agencies.find((x) => x.id === 'ghp');
    const c0 = at(30);
    const u = S.police.deployUnit(ghp, c0.x, c0.z, c0.yaw, 'shotgun');
    const cop = S.registry.get(u.vehicleId);
    cop.car.teleport(c0.x, c0.y + 0.7, c0.z, c0.yaw);
    cop.car.body.setLinvel({ x: Math.sin(c0.yaw) * 19, y: 0, z: Math.cos(c0.yaw) * 19 }, true);
    cop.car.adopt();
    window.__pit = u;
    const out = {};
    out.align = window.__bot.run(host, S, 60 * 14, () => u.pit && u.pit.alignT > 0.9);
    out.road = { id: rd.id, w: rd.width, class: rd.class };
    return out;
  });
  console.log('pit align', JSON.stringify(info));
  await page.waitForTimeout(1200);
  await shot(page, 'police-pit-align.png');
  const strike = await run(page, (host, S) => {
    const u = window.__pit;
    const i = window.__bot.run(host, S, 60 * 8, () => u.pit && u.pit.struck && u.pit.hit);
    window.__bot.run(host, S, 4);
    return { i, pit: !!u.pit };
  });
  console.log('pit strike', JSON.stringify(strike));
  await page.waitForTimeout(1000);
  await shot(page, 'police-pit-strike.png');
  await run(page, (host, S) => {
    window.__bot.run(host, S, 55);
  });
  await page.waitForTimeout(1000);
  await shot(page, 'police-pit-spin.png');
  const ev = await run(page, (host, S) => ({ pit: S.police.stats, hero: Math.round((S.registry.get(S.vehicleId).car.yaw * 180) / Math.PI) }));
  console.log('pit stats', JSON.stringify(ev));
  await page.close();
}

// ---- a spike strip, on the long straight of the freeway
if (want('spikes')) {
  const page = await open('start=car&time=14:00&timescale=0');
  await page.evaluate(BOT);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(100);
  await page.keyboard.up('KeyE');
  await run(page, (host, S) => {
    host.advance(30);
    const v = S.registry.get(S.vehicleId);
    const rd = S.tile.roads.filter((r) => r.class === 'motorway' && !r.bridge && r.points.length > 6).sort((a, b) => Math.hypot(b.points[b.points.length - 1][0] - b.points[0][0], b.points[b.points.length - 1][2] - b.points[0][2]) - Math.hypot(a.points[a.points.length - 1][0] - a.points[0][0], a.points[a.points.length - 1][2] - a.points[0][2]))[0];
    const cum = [0];
    for (let i = 1; i < rd.points.length; i++) cum.push(cum[i - 1] + Math.hypot(rd.points[i][0] - rd.points[i - 1][0], rd.points[i][2] - rd.points[i - 1][2]));
    const at = (d) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const k = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
      const p0 = rd.points[i - 1];
      const p1 = rd.points[i];
      return { x: p0[0] + (p1[0] - p0[0]) * k, y: p0[1] + (p1[1] - p0[1]) * k, z: p0[2] + (p1[2] - p0[2]) * k, yaw: Math.atan2(p1[0] - p0[0], p1[2] - p0[2]) };
    };
    window.__at = at;
    const h0 = at(40);
    v.car.teleport(h0.x, h0.y + 0.7, h0.z, h0.yaw);
    v.car.body.setLinvel({ x: Math.sin(h0.yaw) * 12, y: 0, z: Math.cos(h0.yaw) * 12 }, true);
    v.car.adopt();
    host.advance(5);
    S.law.heat.report(3, 4, h0.x, h0.z, true);
    S.police.roadblocks.enabled = false;
    S.police.heli.enabled = false;
    S.police.spikes.enabled = false;
    S.police.standDown = () => {};
    window.__bot.speed = 12;
    // a strip across the carriageway 85 m along, wide enough for the lane
    const s0 = at(105);
    S.police.spikes.lay(s0.x, s0.z, s0.yaw + Math.PI / 2, 9);
    window.__bot.run(host, S, 60 * 12, () => {
      const q = v.car.pose();
      return Math.hypot(q.x - s0.x, q.z - s0.z) < 11;
    });
  });
  await page.waitForTimeout(1500);
  await shot(page, 'police-spikes-ahead.png');
  const flat = await run(page, (host, S) => {
    window.__bot.run(host, S, 60 * 6, () => S.registry.get(S.vehicleId).car.flatMask === 15);
    window.__bot.run(host, S, 20);
    window.__bot.speed = 0;
    window.__bot.run(host, S, 200);
    const rig = window.__hood.game.cameraRig;
    rig.preset = 0;
    rig.offYaw = 1.15;
    rig.offPitch = 0.05;
    rig.idle = -1e6;
    return { mask: S.registry.get(S.vehicleId).car.flatMask, speed: S.registry.get(S.vehicleId).car.speed };
  });
  console.log('flat', JSON.stringify(flat));
  await page.waitForTimeout(1500);
  await shot(page, 'police-spikes-flat.png');
  await page.close();
}

// ---- an officer firing
if (want('fire')) {
  const page = await open('time=14:00&timescale=0');
  await page.evaluate(() => {
    // (the sim's own record of the shots: the client hears events only between frames)
    const S = window.__hood.game.transport.host.simulation;
    window.__shots = [];
    const emit = S.emit.bind(S);
    S.emit = (e) => { if (e.type === 'weapon:fire' || e.type === 'police:fire') window.__shots.push(e); emit(e); };
  });
  const info = await run(page, (host, S) => {
    const me = S.registry.get(S.playerPedId);
    const c = me.controller;
    S.police.roadblocks.enabled = false;
    S.police.heli.enabled = false;
    // an officer 13 m away with a clear line, in whichever direction has one
    let spot = null;
    for (let k = 0; k < 16 && !spot; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = c.x + Math.sin(a) * 13;
      const z = c.z + Math.cos(a) * 13;
      if (S.law.clearLine({ x: c.x, y: c.y + 1.4, z: c.z }, { x, y: S.groundAt(x, z) + 1.4, z }) && Math.abs(S.groundAt(x, z) - c.y) < 0.6) spot = { x, z, a };
    }
    const ag = S.law.data.agencies.find((x) => x.id === 'acp');
    const block = { id: 99, x: spot.x, z: spot.z, dirX: 1, dirZ: 0, width: 8, unitIds: [], t0: 0, passedAt: 0, gap: null, stripId: 0 };
    S.police.spawnStatic(ag, 'rifle', { x: spot.x + 3, z: spot.z + 3, yaw: 0 }, { x: spot.x, z: spot.z, yaw: Math.atan2(c.x - spot.x, c.z - spot.z) }, block);
    S.law.heat.report(3, 4, c.x, c.z, true);
    me.armour = 1e9;
    // step until the first burst
    let n = 0;
    while (n < 60 * 20 && window.__shots.filter((e) => e.type === 'police:fire').length < 3) {
      host.advance(1);
      me.armour = 1e9;
      if (me.life !== 'alive') me.life = 'alive';
      n++;
    }
    const g = window.__hood.game;
    g.cameraRig.yaw = Math.atan2(-(spot.x - c.x), -(spot.z - c.z)) + 0.55;
    g.cameraRig.pitch = -0.1;
    g.cameraRig.preset = 0;
    return { n, shots: window.__shots.length, spot };
  });
  console.log('fire', JSON.stringify(info));
  await page.waitForTimeout(1200);
  // take over the frames, replay the last shot into the client, draw one frame and take the picture
  await page.evaluate(() => {
    const g = window.__hood.game;
    window.__raf.manual = true;
    window.__raf.t = performance.now();
    window.__raf.step(16.7);
    window.__raf.step(16.7);
    const last = window.__shots.filter((e) => e.type === 'weapon:fire').slice(-1);
    for (const e of last) for (const fn of g.net.listeners) fn(e);
    window.__raf.step(20);
  });
  await shot(page, 'police-fire.png');
  await page.evaluate(() => { window.__raf.manual = false; });
  await page.close();
}

await browser.close();
