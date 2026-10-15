#!/usr/bin/env node
/**
 * Screenshots of the Blender cars (tools/blender, `npm run assets`) into .shots/cars-*.png, on the
 * baked Five Points tile. The sim runs on the main thread (loopback transport) so the script can
 * spawn cars, give them a police livery and crash them; a camera system placed after the rig frames
 * a car from a fixed offset in its own frame.
 *
 *   node scripts/car-shots.mjs [--url http://127.0.0.1:5180/] [--only close,police,traffic,wreck,compare,lod] [--query gfx=classic]
 *
 * Writes: cars-sedan-day.png, cars-sedan-rear-day.png, cars-coupe-day.png, cars-coupe-rear-day.png,
 * cars-pickup-day.png, cars-pickup-rear-day.png, cars-police-day.png, cars-police-night.png,
 * cars-police-night-2.png, cars-traffic-peachtree.png, cars-traffic-peachtree-2.png, cars-wreck.png,
 * cars-wreck-side.png, cars-wreck-rear.png, cars-standin-vs-new.png, cars-lod.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5180/';
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (k) => !only || only.has(k);
const extra = typeof args.query === 'string' ? `&${args.query}` : '';
mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
});
let problems = 0;

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { problems++; console.log('pageerror', String(e)); });
  page.on('console', (m) => { if (m.type() === 'error') { problems++; console.log('console error', m.text()); } });
  await page.goto(`${base}?transport=loopback&graphics=high&${query}${extra}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__hood.error);
  if (err) throw new Error(err);
  await page.keyboard.press('Shift');
  await page.addStyleTag({ content: '.hud-help { display: none !important; }' });
  await page.waitForTimeout(500);
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: `.shots/${name}` });
  console.log('shot', `.shots/${name}`);
};
/** Runs `fn(S, arg)` in the page: `S` is the Simulation. */
const run = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);

/** The hero car (the one the player starts beside): its id, position and heading. */
const hero = (page) =>
  run(page, (S) => {
    const v = [...S.vehicles()][0];
    const p = v.car.pose();
    return { id: v.id, x: p.x, y: p.y, z: p.z, yaw: v.car.yaw };
  });

/** Frames entity `id` from an offset in its own frame (+X left, +Z forward), looking at a point in its frame. */
async function frame(page, id, eye, look = [0, 0.35, 0], fov = 50) {
  await page.evaluate(({ id, eye, look, fov }) => {
    const g = window.__hood.game;
    const T = g.camera.position.constructor;
    const Q = g.camera.quaternion.constructor;
    const sys = g.systems?.find?.((s) => s.name === 'car-shots-camera');
    if (sys) sys.target = { id, eye, look, fov };
    else
      g.addSystem({
        name: 'car-shots-camera',
        priority: 900,
        target: { id, eye, look, fov },
        lateUpdate() {
          const t = this.target;
          const st = g.view.entities.get(t.id);
          if (!st) return;
          const q = new Q(st.q.x, st.q.y, st.q.z, st.q.w);
          const e = new T(...t.eye).applyQuaternion(q).add(new T(st.x, st.y, st.z));
          const l = new T(...t.look).applyQuaternion(q).add(new T(st.x, st.y, st.z));
          g.camera.fov = t.fov;
          g.camera.position.copy(e);
          g.camera.lookAt(l);
          g.camera.updateProjectionMatrix();
          g.camera.updateMatrixWorld(true);
        },
      });
  }, { id, eye, look, fov });
}

/** Spawns a car of `type` `ahead` m in front of the hero car (along its heading) and `side` m to its left. */
const spawn = (page, type, ahead, side, opts = {}) =>
  run(page, (S, a) => {
    const h = [...S.vehicles()][0];
    const p = h.car.pose();
    const yaw = h.car.yaw + (a.turn ?? 0);
    const fx = Math.sin(h.car.yaw), fz = Math.cos(h.car.yaw);
    const x = p.x + fx * a.ahead + fz * a.side;
    const z = p.z + fz * a.ahead - fx * a.side;
    const v = S.spawnVehicle(a.type, x, S.groundAt(x, z), z, yaw, a.color ?? 0x3d5a80, (v) => {
      if (a.police) {
        v.police = a.police;
        v.lightbar = !!a.lightbar;
      }
    });
    return v.id;
  }, { type, ahead, side, ...opts });

const ACP = { agency: 'acp', body: 0x2c3e50, stripe: 0xe8c547, lightbar: [0x3ea8ff, 0xffb000] };
const GHP = { agency: 'ghp', body: 0x1f4d3a, stripe: 0xe9e4d4, lightbar: [0xff4422, 0xffd000] };

// ---- close-ups by day, one car of each type
if (want('close')) {
  for (const [type, color] of [['sedan', 0x2e4a62], ['coupe', 0xc9a227], ['pickup', 0x6e2a22]]) {
    const page = await open(`start=car&time=13:30&timescale=0&parked=0&ambient=0&traffic=0`);
    const id = await spawn(page, type, 9, 0, { color });
    await frame(page, id, [3.4, 1.15, 4.6], [0, 0.3, 0.2], 46);
    await page.waitForTimeout(1500);
    await shot(page, `cars-${type}-day.png`);
    await frame(page, id, [-3.2, 1.4, -4.8], [0, 0.35, -0.2], 46);
    await page.waitForTimeout(600);
    await shot(page, `cars-${type}-rear-day.png`);
    await page.context().close();
  }
}

// ---- the police cruiser: by day, and at night with the lightbar going
if (want('police')) {
  for (const [time, name] of [['13:30', 'day'], ['23:30', 'night']]) {
    const page = await open(`start=car&time=${time}&timescale=0&parked=0&ambient=0&traffic=0`);
    const id = await spawn(page, 'sedan', 8, 0, { police: ACP, lightbar: true, color: ACP.body });
    await frame(page, id, [3.3, 1.25, 4.8], [0, 0.45, 0], 48);
    await page.waitForTimeout(1500);
    // the bar flashes ten phases a second: take a few and keep them all
    await shot(page, `cars-police-${name}.png`);
    if (name === 'night') {
      await page.waitForTimeout(330);
      await shot(page, `cars-police-${name}-2.png`);
      // the state patrol's pursuit coupe beside it
      const id2 = await spawn(page, 'coupe', 14, 0, { police: GHP, lightbar: true, color: GHP.body });
      await frame(page, id2, [-3.4, 1.3, 4.6], [0, 0.4, -1], 50);
      await page.waitForTimeout(800);
      await shot(page, `cars-police-coupe-${name}.png`);
    }
    await page.context().close();
  }
}

// ---- traffic on Peachtree, from the street
if (want('traffic')) {
  const page = await open(`start=car&time=14:30&timescale=0&parked=0&traffic=1&pedbudget=30`);
  await page.waitForTimeout(12000);
  // behind the traffic car with the most traffic ahead of it, at a pedestrian's eye height
  const best = await run(page, (S) => {
    const cars = [...S.vehicles()].filter((v) => v.trafficCar);
    let best = null, most = -1;
    for (const v of cars) {
      const p = v.car.pose(), yaw = v.car.yaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      let n = 0;
      for (const o of cars) {
        if (o === v) continue;
        const q = o.car.pose();
        const dx = q.x - p.x, dz = q.z - p.z;
        const along = dx * fx + dz * fz;
        if (along > 0 && along < 70 && Math.abs(dx * fz - dz * fx) < 14) n++;
      }
      if (n > most) { most = n; best = v.id; }
    }
    return { id: best, most };
  });
  console.log('framing traffic car', best);
  await frame(page, best.id, [-2.4, 2.2, -9], [0, 0.8, 30], 60);
  await page.waitForTimeout(800);
  await shot(page, 'cars-traffic-peachtree.png');
  await frame(page, best.id, [6, 3.5, 14], [0, 0.5, 4], 58);
  await page.waitForTimeout(600);
  await shot(page, 'cars-traffic-peachtree-2.png');
  const counts = await page.evaluate(() => window.__hood.game.views.traffic.counts());
  console.log('traffic instances by level of detail', counts);
  await page.context().close();
}

// ---- a wreck: two sedans head-on, then a pickup into the side, then backed into a post
if (want('wreck')) {
  const page = await open(`start=car&time=15:00&timescale=0&parked=0&ambient=0&traffic=0`);
  const a = await spawn(page, 'sedan', 10, 0, { color: 0x6b7a8f });
  const b = await spawn(page, 'sedan', 30, 0, { color: 0x8a2d1e, turn: Math.PI });
  // An invisible hand speeds each car up along its heading (in steps under the sim's crash threshold, so only the hit itself
  // reads as a crash) until it hits something: the crash itself is the sim's own.
  const launch = (ids, speed) =>
    run(page, (S, o) => new Promise((done) => {
      const live = new Set(o.ids);
      const t0 = performance.now();
      const timer = setInterval(() => {
        for (const id of live) {
          const v = S.registry.get(id);
          if (!v || v.car.impactSpeedLoss > 3 || performance.now() - t0 > 4000) { live.delete(id); continue; }
          const yaw = v.car.yaw, lv = v.car.body.linvel();
          const tx = Math.sin(yaw) * o.speed, tz = Math.cos(yaw) * o.speed;
          const dx = tx - lv.x, dz = tz - lv.z, d = Math.hypot(dx, dz);
          const k = d > 0.9 ? 0.9 / d : 1;
          v.car.body.setLinvel({ x: lv.x + dx * k, y: lv.y, z: lv.z + dz * k }, true);
          const av = v.car.body.angvel();
          v.car.body.setAngvel({ x: av.x, y: 0, z: av.z }, true);
        }
        if (!live.size) { clearInterval(timer); done(); }
      }, 16);
    }), { ids, speed });
  const home = await run(page, (S, o) => o.ids.map((id) => { const v = S.registry.get(id); const p = v.car.pose(); return [p.x, p.y, p.z, v.car.yaw]; }), { ids: [a, b] });
  await page.waitForTimeout(600);
  // three head-ons, each from where they started (the bumpers go on the second or third)
  for (let k = 0; k < 3; k++) {
    if (k) {
      await run(page, (S, o) => o.ids.forEach((id, i) => { const [x, y, z, yaw] = o.home[i]; S.registry.get(id).car.teleport(x, y + 0.3, z, yaw); }), { ids: [a, b], home });
      await page.waitForTimeout(900);
    }
    await launch([a, b], 15 + k);
    await page.waitForTimeout(1800);
  }
  // a pickup into a's tail
  const pk = await run(page, (S, o) => {
    const va = S.registry.get(o.a);
    const p = va.car.pose();
    const yaw = va.car.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const x = p.x - fx * 26, z = p.z - fz * 26;
    const v = S.spawnVehicle('pickup', x, S.groundAt(x, z), z, yaw, 0x444444);
    return v.id;
  }, { a });
  await page.waitForTimeout(600);
  await launch([pk], 15);
  await page.waitForTimeout(3000);
  const dmg = await page.evaluate((id) => {
    const s = window.__hood.game.views.damage.get(id);
    return s && { dents: s.dents.length, front: Math.round(s.front), bumperF: s.bumperF, bumperR: s.bumperR, hood: s.hood, windows: s.windows.toString(2) };
  }, a);
  console.log('wreck damage', JSON.stringify(dmg), 'debris', await page.evaluate(() => window.__hood.game.views.debris.count));
  await frame(page, a, [3.6, 1.3, 4.6], [0, 0.3, 0.3], 50);
  await page.waitForTimeout(800);
  await shot(page, 'cars-wreck.png');
  await frame(page, a, [5.5, 1.1, -0.5], [0, 0.3, 0], 50);
  await page.waitForTimeout(500);
  await shot(page, 'cars-wreck-side.png');
  await frame(page, a, [-3.4, 1.3, -4.8], [0, 0.3, -0.5], 50);
  await page.waitForTimeout(500);
  await shot(page, 'cars-wreck-rear.png');
  await frame(page, b, [-3.0, 1.4, 4.8], [0, 0.3, 0.6], 50);
  await page.waitForTimeout(500);
  await shot(page, 'cars-wreck-b.png');
  await page.context().close();
}

// ---- the stand-in box car against the new one, side by side
if (want('compare')) {
  const pics = [];
  for (const q of ['cars=box', '']) {
    const page = await open(`start=car&time=13:30&timescale=0&parked=0&ambient=0&traffic=0&${q}`);
    const h = await hero(page);
    await frame(page, h.id, [3.6, 1.2, 4.4], [0, 0.35, 0.1], 46);
    await page.waitForTimeout(1200);
    pics.push((await page.screenshot()).toString('base64'));
    await page.context().close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 400 } });
  const page = await ctx.newPage();
  await page.setContent(`<body style="margin:0;background:#111;display:flex">${pics.map((p, i) => `<div style="position:relative"><img src="data:image/png;base64,${p}" style="width:640px;height:360px;display:block"><div style="position:absolute;left:12px;top:8px;color:#fff;font:600 18px sans-serif;text-shadow:0 1px 3px #000">${i ? 'Blender asset' : 'stand-in'}</div></div>`).join('')}</body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.shots/cars-standin-vs-new.png', clip: { x: 0, y: 0, width: 1280, height: 360 } });
  console.log('shot .shots/cars-standin-vs-new.png');
  await ctx.close();
}

// ---- levels of detail: a row of cars receding from the camera
if (want('lod')) {
  const page = await open(`start=car&time=13:30&timescale=0&parked=0&ambient=0&traffic=0`);
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await spawn(page, ['sedan', 'coupe', 'pickup'][i % 3], 12 + i * 18, -3.5, { color: [0x7a1e1e, 0xc9a227, 0x2f4f6f][i % 3] }));
  const h = await hero(page);
  await frame(page, h.id, [-3.5, 1.6, 2], [-3.5, 0.8, 60], 40);
  await page.waitForTimeout(1500);
  await shot(page, 'cars-lod.png');
  const lods = await page.evaluate((ids) => ids.map((id) => window.__hood.game.views.views?.get(id)?.model?.lod), ids);
  console.log('levels of detail along the row', lods);
  await page.context().close();
}

await browser.close();
console.log(problems ? `${problems} console problems` : 'no console errors');
process.exit(problems ? 1 : 0);
