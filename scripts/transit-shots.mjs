#!/usr/bin/env node
/**
 * Screenshots of the rail transit (`.shots/transit-*.png`): a street entrance, the Five Points platform with a train coming in,
 * riding inside, the window view, the chase view, the minimap with the lines. Loopback transport, so the script can put the
 * player where it wants (the sim is on the page).
 *
 *   node scripts/transit-shots.mjs [--url http://127.0.0.1:5180/] [--only entrance,platform,inside,window,chase,minimap] [--size 1280x720]
 *
 * Without --url it starts its own Vite server on a free port.
 */
import { createServer as createNetServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []));
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (n) => !only || only.has(n);
const [W, Hh] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);
let server = null;
let base = typeof args.url === 'string' ? args.url : null;
if (!base) {
  const { createServer } = await import('vite');
  const port = await new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  server = await createServer({ root, logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
  await server.listen();
  base = `http://127.0.0.1:${port}/`;
}
mkdirSync(resolve(root, '.shots'), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: W, height: Hh } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
const query = typeof args.query === 'string' ? args.query : 'transport=loopback&time=13:00&traffic=0.4';
await page.goto(`${base}?${query}`);
await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 180000 });
const bootErr = await page.evaluate(() => window.__hood.error);
if (bootErr) { console.log('BOOT ERROR', bootErr); process.exit(1); }
await page.keyboard.press('Shift');
// (the help panel off)
await page.keyboard.press('KeyH');
const sim = (fn, arg) => page.evaluate(([src, a]) => { const S = window.__hood.game.transport.host.simulation; return new Function('S', 'a', `return (${src})(S, a)`)(S, a); }, [fn.toString(), arg]);
const shot = async (name) => { await page.screenshot({ path: resolve(root, `.shots/transit-${name}.png`) }); console.log('shot', `.shots/transit-${name}.png`); };
const wait = (ms) => page.waitForTimeout(ms);
/** Points the on-foot camera: yaw so it looks along (dx, dz). */
const lookAlong = (dx, dz, pitch = -0.15) => page.evaluate(([dx, dz, pitch]) => { const r = window.__hood.game.cameraRig; r.yaw = Math.atan2(-dx, -dz); r.pitch = pitch; }, [dx, dz, pitch]);

const fp = await sim((S) => S.transit.data.stations.findIndex((s) => s.name === 'Five Points'));
console.log('Five Points is station', fp);

if (want('entrance')) {
  // the street end of a Five Points entrance, the camera looking down the stairs
  const e = await sim((S, i) => S.transit.data.stations[i].entrances[0], fp);
  await sim((S, e) => { const p = S.registry.get(S.playerPedId).controller; const x = e.x - Math.sin(e.yaw) * 4.5, z = e.z - Math.cos(e.yaw) * 4.5; p.teleport(x, S.groundAt(x, z) + 0.2, z, e.yaw); }, e);
  await lookAlong(Math.sin(e.yaw), Math.cos(e.yaw), -0.28);
  await wait(2500);
  await shot('entrance');
}

if (want('platform') || want('inside') || want('window') || want('chase')) {
  // a train coming in to the East-West platform at Five Points: the camera on the platform, looking back along the track at it
  const pick = await sim((S, a) => {
    const T = S.transit;
    for (let i = 0; i < 60 * 600; i++) {
      for (const tr of T.model.trains) {
        const st = T.data.routes[tr.route].stops[tr.stop];
        if (!st || st.station !== a.fp || st.platform !== 0 || tr.phase !== 'run') continue;
        // (eastbound: on to Georgia State, out of the tunnel and up on the viaduct, for the window view)
        const stops = T.data.routes[tr.route].stops;
        if (!stops.some((q, k) => k > tr.stop && T.data.stations[q.station].name === 'Georgia State')) continue;
        const d = st.s - tr.s;
        if (d < 150 && d > 100) return { id: tr.id, route: tr.route, stop: tr.stop };
      }
      S.step();
    }
    return null;
  }, { fp });
  if (!pick) console.log('no train came in');
  const cam = await sim((S, a) => {
    const T = S.transit;
    const r = T.data.routes[a.route];
    const stop = r.stops[a.stop];
    const pl = T.data.stations[stop.station].platforms[stop.platform];
    const p = T.model.pointAt(a.route, stop.s - 30);
    // across from the track toward the platform, a step in from its edge
    const lx = p.dz * stop.side, lz = -p.dx * stop.side;
    const x = p.x + lx * 3.4, z = p.z + lz * 3.4;
    const pc = S.registry.get(S.playerPedId).controller;
    pc.teleport(x + lx * 1.2 - p.dx * 4, pl.y + 0.1, z + lz * 1.2 - p.dz * 4, Math.atan2(-p.dx, -p.dz));
    return { pos: [x, pl.y + 1.75, z], look: [x - p.dx * 30 - lx * 2.2, pl.y + 1.2, z - p.dz * 30 - lz * 2.2], fov: 62 };
  }, pick);
  await page.evaluate((o) => { window.__hood.game.transitCamera.override = o; }, cam);
  // the train two seconds from its stop
  for (let i = 0; i < 80; i++) {
    const left = await sim((S, a) => { const tr = S.transit.byId.get(a.id); if (!tr) return -1; const st = S.transit.data.routes[tr.route].stops[tr.stop]; return st && tr.phase === 'run' ? st.s - tr.s : 0; }, pick);
    if (left < 45) break;
    await wait(100);
  }
  if (want('platform')) await shot('platform');
  await page.evaluate(() => { window.__hood.game.transitCamera.override = null; });
  // get on at the nearest door once they are open
  await sim((S, a) => {
    const T = S.transit;
    for (let i = 0; i < 60 * 40; i++) {
      const tr = T.byId.get(a.id);
      if (tr && tr.phase === 'open') {
        const o = T.doorOutside(tr, 2, 1, 0.5);
        S.registry.get(S.playerPedId).controller.teleport(o.x, o.y + 0.05, o.z);
        return true;
      }
      S.step();
    }
    return false;
  }, pick);
  await wait(500);
  await page.keyboard.down('KeyE');
  await wait(150);
  await page.keyboard.up('KeyE');
  await wait(1200);
  const riding = await page.evaluate(() => window.__hood.game.view.sample?.b.u32[24] ?? 0);
  console.log('riding train', riding);
  // under way, between stations
  for (let i = 0; i < 300; i++) {
    const v = await sim((S) => { const p = S.registry.get(S.playerPedId); const tr = p.ride && S.transit.byId.get(p.ride.trainId); return tr ? tr.v : 0; });
    if (v > 10) break;
    await wait(200);
  }
  if (want('inside')) {
    // inside the car: a camera standing in the aisle, looking down the car
    for (let k = 0; k < 20; k++) {
      const o = await page.evaluate(() => {
        const g = window.__hood.game;
        const cv = g.transit.trains.ridden[0];
        if (!cv) return null;
        const m = cv.matrix.elements;
        const at = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        return { pos: at(0.25, 2.75, -9.6), look: at(-0.1, 2.35, 6), fov: 70 };
      });
      if (o) await page.evaluate((o) => { window.__hood.game.transitCamera.override = o; }, o);
      await wait(50);
    }
    await shot('inside');
    await page.evaluate(() => { window.__hood.game.transitCamera.override = null; });
  }
  if (want('window') || want('chase')) {
    // on to the open air: out of the tunnel east of Five Points, between stations
    await sim((S) => {
      const T = S.transit;
      const p = S.registry.get(S.playerPedId);
      for (let i = 0; i < 60 * 300; i++) {
        const tr = p.ride && T.byId.get(p.ride.trainId);
        if (!tr) return;
        const q = T.model.pointAt(tr.route, tr.s - 60);
        if (tr.phase === 'run' && tr.v > 8 && !T.underground(q.x, q.y + 1, q.z) && q.y > S.groundAt(q.x, q.z) + 3) return;
        S.step();
      }
    });
    await wait(1500);
  }
  if (want('window')) {
    await page.evaluate(() => { const c = window.__hood.game.transitCamera; c.mode = 'window'; });
    await page.keyboard.down('ArrowRight');
    await wait(1100);
    await page.keyboard.up('ArrowRight');
    await wait(800);
    await shot('window');
  }
  if (want('chase')) {
    await page.keyboard.press('KeyV');
    await wait(3000);
    await shot('chase');
    await page.keyboard.press('KeyV');
  }
}

if (want('minimap')) {
  await page.evaluate(() => { const c = window.__hood.game.transitCamera; if (c) c.mode = 'window'; });
  await sim((S, i) => { const st = S.transit.data.stations[i]; const p = S.registry.get(S.playerPedId); if (p.ride) { p.ride = null; p.controller.setEnabled(true); } const e = st.entrances[1] ?? st.entrances[0]; const x = e.x - Math.sin(e.yaw) * 6, z = e.z - Math.cos(e.yaw) * 6; p.controller.teleport(x, S.groundAt(x, z) + 0.2, z); }, fp);
  await wait(2500);
  await page.screenshot({ path: resolve(root, '.shots/transit-minimap.png'), clip: { x: 0, y: Hh - 300, width: 380, height: 300 } });
  console.log('shot .shots/transit-minimap.png');
}

const stats = await page.evaluate(() => { const g = window.__hood.game; return { fps: Math.round(g.fps), calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles }; });
console.log('stats', JSON.stringify(stats));
console.log(errors.length ? `console errors:\n${errors.slice(0, 12).join('\n')}` : 'no console errors');
await browser.close();
if (server) await server.close();
