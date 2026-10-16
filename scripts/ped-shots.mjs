#!/usr/bin/env node
/**
 * Screenshots of the ambient pedestrians into .shots/, on the baked Five Points tile: busy sidewalks at
 * lunchtime and (empty ones) at 4 a.m., a bus stop, people crossing at a signal, a crowd running from a
 * fight, and a carjack on a busy sidewalk. The sim runs on the main thread (loopback transport) so the
 * script can put the player where the people are; everything the player does is a real key press.
 *
 *   node scripts/ped-shots.mjs [--url http://127.0.0.1:5180/] [--only lunch,busstop,...] [--graphics high|low]
 *
 * Writes: peds-lunch-1.png, peds-lunch-2.png, peds-4am.png, peds-busstop.png, peds-crossing.png,
 * peds-fight-1.png, peds-fight-2.png, peds-jack-1.png, peds-jack-2.png, peds-poses.png
 */
import { mkdirSync } from 'node:fs';
import { launch, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const graphics = typeof args.graphics === 'string' ? args.graphics : 'high';
mkdirSync('.shots', { recursive: true });
const server = await startServer(args);
const browser = await launch();

const tap = async (page, key, ms = 90) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
async function open(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`${server.base}?transport=loopback&graphics=${graphics}&${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  await page.keyboard.press('Shift');
  await tap(page, 'KeyH');
  await page.waitForTimeout(500);
  return page;
}
const shot = async (page, name) => { await page.screenshot({ path: `.shots/${name}` }); console.log('shot', `.shots/${name}`); };
const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
/** Stand the player at (x, z) and look at (lx, lz) from behind. */
const stand = (page, x, z, lx, lz, preset = 1, pitch = -0.2) => sim(page, (S, a) => {
  const c = S.registry.get(S.playerPedId).controller;
  c.teleport(a.x, S.groundAt(a.x, a.z) + 0.1, a.z, Math.atan2(a.lx - a.x, a.lz - a.z));
  const g = window.__hood.game;
  g.cameraRig.preset = a.preset;
  g.cameraRig.yaw = Math.atan2(-(a.lx - a.x), -(a.lz - a.z));
  g.cameraRig.pitch = a.pitch;
}, { x, z, lx, lz, preset, pitch });
const want = (n) => !only || only.has(n);

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
  // a node 9 to 14 m from the middle of the group, so they are in front of the camera
  let node = -1, bd = 1e9;
  for (let i = 0; i < g.nodeCount; i++) {
    const d = Math.hypot(g.x[i] - cx, g.z[i] - cz);
    if (d > 8 && d < bd && g.degree(i) >= 1) { bd = d; node = i; }
  }
  return { cx, cz, n: near.length, px: g.x[node], pz: g.z[node], total: A.list.length };
}, radius);

if (want('lunch')) {
  const page = await open('time=12:00&day=2');
  await page.waitForTimeout(2500);
  const c = await cluster(page);
  console.log('lunch cluster', c);
  await stand(page, c.px, c.pz, c.cx, c.cz, 1, -0.12);
  await page.waitForTimeout(900);
  await shot(page, 'peds-lunch-1.png');
  // a second look, from the other side of the same crowd, higher up
  await stand(page, c.cx + (c.cx - c.px), c.cz + (c.cz - c.pz), c.cx, c.cz, 2, -0.3);
  await page.waitForTimeout(900);
  await shot(page, 'peds-lunch-2.png');
  console.log('lunch', await sim(page, (S) => ({ peds: S.ambient.count, entities: S.registry.size })));
  await page.close();
}

if (want('4am')) {
  const page = await open('time=04:00&day=2');
  await page.waitForTimeout(2500);
  console.log('4am', await sim(page, (S) => ({ peds: S.ambient.count, target: S.ambient.target })));
  await shot(page, 'peds-4am.png');
  await page.close();
}

if (want('busstop')) {
  const page = await open('time=08:00&day=1');
  await page.waitForTimeout(1500);
  // put a small group at a bus stop near the middle of the tile, if the director did not already
  const stop = await sim(page, (S) => {
    const A = S.ambient;
    const pts = A.scenarios.points;
    let best = -1, bd = 1e9;
    pts.forEach((p, i) => { if (p.type === 'busstop') { const d = Math.hypot(p.x, p.z); if (d < bd) { bd = d; best = i; } } });
    if (best < 0) return null;
    if (A.scenarios.used[best] === 0) {
      const gid = Object.keys(A.population.pedGroups)[0];
      A.spawnScenario(best, gid, A.population.pedGroups[gid]);
    }
    const p = pts[best];
    return { x: p.x, z: p.z, yaw: p.yaw, used: A.scenarios.used[best] };
  });
  console.log('bus stop', stop);
  // stand on the road side looking back at the stop: the camera sits behind the player
  const fx = Math.sin(stop.yaw), fz = Math.cos(stop.yaw);
  await stand(page, stop.x + fx * 7, stop.z + fz * 7, stop.x, stop.z, 0, -0.1);
  await page.waitForTimeout(700);
  await shot(page, 'peds-busstop.png');
  await page.close();
}

if (want('crossing')) {
  const page = await open('time=12:00&day=2');
  await page.waitForTimeout(1500);
  // a signalised crossing near the middle, and walkers sent across it
  const x = await sim(page, (S) => {
    const A = S.ambient, g = A.graph;
    let best = -1, bd = 1e9;
    for (let e = 0; e < g.edgeCount; e++) {
      const m = g.crossingOf(e);
      if (!m || !m.signals || !m.junction || g.len[e] < 8) continue;
      const mx = (g.x[g.ea[e]] + g.x[g.eb[e]]) / 2, mz = (g.z[g.ea[e]] + g.z[g.eb[e]]) / 2;
      const d = Math.hypot(mx - 40, mz - 40);
      if (d < bd) { bd = d; best = e; }
    }
    // peds on both sides, heading for the crossing
    const a = g.ea[best], b = g.eb[best];
    const gid = Object.keys(A.population.pedGroups)[0];
    const made = [];
    for (let k = 0; k < 9; k++) {
      const from = k % 2 ? a : b;
      const to = k % 2 ? b : a;
      const t = 0.15 + 0.1 * (k >> 1);
      void t;
      // along the sidewalk that leads to the crossing's end
      let e2 = -1;
      for (const e of g.edgesAt(from)) if (e !== best && g.kindOf(e) !== 'crossing') { e2 = e; break; }
      if (e2 < 0) continue;
      const far = g.other(e2, from);
      const f = 0.25 + 0.55 * ((k >> 1) / 5);
      const px = g.x[from] + (g.x[far] - g.x[from]) * f, pz = g.z[from] + (g.z[far] - g.z[from]) * f;
      const p = A.makePed(gid, A.population.pedGroups[gid], px, g.y[from], pz, far, from, null);
      if (p) { p.amb.prev = far; p.amb.node = far; p.amb.next = from; made.push(p.id); }
      void to;
    }
    const mx = (g.x[a] + g.x[b]) / 2, mz = (g.z[a] + g.z[b]) / 2;
    return { mx, mz, ax: g.x[a], az: g.z[a], bx: g.x[b], bz: g.z[b], made: made.length, junction: g.crossingOf(best).junction };
  });
  console.log('crossing', x);
  const dx = x.bx - x.ax, dz = x.bz - x.az, l = Math.hypot(dx, dz);
  // stand along the road, looking across the crossing from a few metres up the street
  await stand(page, x.mx - (dz / l) * 7, x.mz + (dx / l) * 7, x.mx, x.mz, 2, -0.3);
  for (const n of [1, 2, 3]) {
    await page.waitForTimeout(n === 1 ? 2500 : 4000);
    const st = await sim(page, (S, m) => {
      const A = S.ambient;
      const near = A.list.filter((p) => Math.hypot(p.controller.x - m.x, p.controller.z - m.z) < 14);
      const modes = {};
      for (const p of near) modes[p.amb.mode] = (modes[p.amb.mode] ?? 0) + 1;
      return modes;
    }, { x: x.mx, z: x.mz });
    console.log('crossing modes', n, st);
    await shot(page, `peds-crossing-${n}.png`);
  }
  await page.close();
}

if (want('fight')) {
  const page = await open('time=12:30&day=2');
  await page.waitForTimeout(2500);
  const c = await cluster(page, 18);
  console.log('fight cluster', c);
  // hit someone in the middle of the crowd, standing on the far side of them from the rest so the crowd is in front of the camera
  const victim = await sim(page, (S, cl) => {
    const A = S.ambient;
    let best = null, bd = 1e9;
    for (const p of A.list) { const d = Math.hypot(p.controller.x - cl.cx, p.controller.z - cl.cz); if (d < bd && p.amb.mode !== 'scenario') { bd = d; best = p; } }
    best = best ?? A.list[0];
    const c2 = best.controller;
    const pc = S.registry.get(S.playerPedId).controller;
    let dx = c2.x - cl.cx, dz = c2.z - cl.cz;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    if (l < 0.5) { dx = 1; dz = 0; }
    const px = c2.x + dx * 1.35, pz = c2.z + dz * 1.35;
    pc.teleport(px, S.groundAt(px, pz) + 0.1, pz, Math.atan2(c2.x - px, c2.z - pz));
    const g = window.__hood.game;
    g.cameraRig.preset = 2;
    g.cameraRig.yaw = Math.atan2(-(c2.x - px), -(c2.z - pz)) + 0.35;
    g.cameraRig.pitch = -0.42;
    // and a ring of onlookers a few metres out, on whatever sidewalk is there
    const gr = A.graph;
    const gid = Object.keys(A.population.pedGroups)[0];
    let made = 0;
    for (let e = 0; e < gr.edgeCount && made < 9; e++) {
      if (!gr.isSpawnEdge(e)) continue;
      for (const t of [0.2, 0.5, 0.8]) {
        const a = gr.ea[e], b = gr.eb[e];
        const x = gr.x[a] + (gr.x[b] - gr.x[a]) * t, z = gr.z[a] + (gr.z[b] - gr.z[a]) * t;
        const d = Math.hypot(x - c2.x, z - c2.z);
        if (d < 3 || d > 12 || made >= 9 || (e + Math.round(t * 5)) % 2) continue;
        if (A.makePed(gid, A.population.pedGroups[gid], x, gr.y[a], z, a, b, null)) made++;
      }
    }
    return { id: best.id, x: c2.x, z: c2.z, made };
  }, c);
  await page.waitForTimeout(600);
  await tap(page, 'KeyQ');
  await page.waitForTimeout(450);
  await shot(page, 'peds-fight-1.png');
  await page.waitForTimeout(1400);
  await shot(page, 'peds-fight-2.png');
  console.log('fight', victim, await sim(page, (S) => {
    const modes = {};
    for (const p of S.ambient.list) modes[p.amb.mode] = (modes[p.amb.mode] ?? 0) + 1;
    return modes;
  }));
  await page.close();
}

if (want('jack')) {
  const page = await open('time=12:00&day=2&start=jack&driver=flee&parked=2&traffic=0');
  await page.waitForTimeout(1500);
  // four people on the sidewalk in sight of the car, then the player pulls the driver out
  const r = await sim(page, (S) => {
    const A = S.ambient;
    const me = S.playerPosition();
    const g = A.graph;
    const gid = Object.keys(A.population.pedGroups)[0];
    const cands = [];
    for (let e = 0; e < g.edgeCount; e++) {
      if (!g.isSpawnEdge(e)) continue;
      const a = g.ea[e], b = g.eb[e];
      for (const t of [0.25, 0.6]) {
        const x = g.x[a] + (g.x[b] - g.x[a]) * t, z = g.z[a] + (g.z[b] - g.z[a]) * t;
        const d = Math.hypot(x - me.x, z - me.z);
        if (d > 5 && d < 24 && S.law.clearLine({ x, y: g.y[a] + 1.5, z }, { x: me.x, y: me.y + 1.2, z: me.z })) cands.push({ e, t, x, z, d });
      }
    }
    cands.sort((p, q) => p.d - q.d);
    const used = [];
    for (const c of cands) {
      if (used.length >= 5) break;
      if (used.some((u) => Math.hypot(u.x - c.x, u.z - c.z) < 4)) continue;
      const a = g.ea[c.e], b = g.eb[c.e];
      if (A.makePed(gid, A.population.pedGroups[gid], c.x, g.y[a], c.z, a, b, null)) used.push(c);
    }
    return used.length;
  });
  console.log('bystanders placed', r);
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => { const gm = window.__hood.game; return { v: gm.view.vehicle && { x: gm.view.vehicle.x, z: gm.view.vehicle.z }, p: gm.view.ped && { x: gm.view.ped.x, z: gm.view.ped.z } }; });
  await page.evaluate((g) => { const rig = window.__hood.game.cameraRig; rig.preset = 2; rig.yaw = Math.atan2(g.p.x - g.v.x, g.p.z - g.v.z) + 0.4; rig.pitch = -0.3; }, g);
  await tap(page, 'KeyE');
  await page.waitForTimeout(700);
  await shot(page, 'peds-jack-1.png');
  await page.waitForTimeout(2600);
  await shot(page, 'peds-jack-2.png');
  console.log('jack', await sim(page, (S) => {
    const modes = {};
    for (const p of S.ambient.list) modes[p.amb.mode] = (modes[p.amb.mode] ?? 0) + 1;
    return { modes, pending: S.law.pending.length, heat: S.law.heat.level };
  }));
  await page.close();
}

if (want('poses')) {
  const page = await open('time=11:00&day=2&ambient=1&pedbudget=0');
  await page.waitForTimeout(1200);
  // a row of people in each of the poses, a few metres in front of the camera
  await sim(page, (S) => {
    const A = S.ambient;
    const pc = S.registry.get(S.playerPedId).controller;
    const gid = Object.keys(A.population.pedGroups)[0];
    const group = A.population.pedGroups[gid];
    const acts = ['sit', 'phone', 'chat', 'atm', 'browse', 'photo', 'wait', 'cower'];
    const g = A.graph;
    const node = g.nearestNode(pc.x, pc.z, 30);
    acts.forEach((act, i) => {
      const x = pc.x + (i - 3.5) * 1.1;
      const z = pc.z - 4.2;
      const p = A.makePed(gid, group, x, S.groundAt(x, z), z, node, -1, { yaw: 0, point: -1, slot: 0, count: 1, action: act === 'cower' ? 'wait' : act, dur: 900, type: 'corner' });
      if (!p) return;
      p.controller.yaw = Math.PI;
      p.amb.poseT = 99;
      if (act === 'cower') { p.amb.mode = 'cower'; p.amb.until = 900; p.amb.faceX = pc.x; p.amb.faceZ = pc.z; }
    });
    const gm = window.__hood.game;
    gm.cameraRig.preset = 0;
    gm.cameraRig.yaw = 0;
    gm.cameraRig.pitch = -0.12;
  });
  await page.waitForTimeout(1500);
  await shot(page, 'peds-poses.png');
  await page.close();
}

await browser.close();
await server.close();
