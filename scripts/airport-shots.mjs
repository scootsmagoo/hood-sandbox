#!/usr/bin/env node
/**
 * Screenshots of Hartsfield-Jackson (?spawn=airport) into .shots/airport-<view>.png: the terminal complex and the runways from
 * the air by day and at night (the runway lights), an aircraft landing (the camera waits for one on short final), aircraft at
 * their gates with the jet bridges, the Atrium and a concourse from inside, the control tower.
 *
 *   node scripts/airport-shots.mjs [--only aerial-day,landing] [--url http://127.0.0.1:5195/] [--size 1280x720] [--graphics high]
 *
 * Static views put the camera at `eye` looking at `look` (game metres); the dynamic ones read the aircraft the client draws
 * (`window.__hood.airport.aircraft`). The player is moved (teleported through the sim's debug hook when there is one, else left
 * where it spawned) only for the interior views, which need the tiles round them loaded in the sim too.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []));
const base = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:5195/';
const tier = typeof args.graphics === 'string' ? args.graphics : 'high';
const [w, h] = (typeof args.size === 'string' ? args.size : '1280x720').split('x').map(Number);
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;

const ap = JSON.parse(readFileSync('tools/blender/airport/airport.json', 'utf8'));
const H = (id) => ap.heroes[id].anchor;
const y0 = -9; // the airfield's ground, roughly (city datum 318.6 m; the field is at 300 to 312 m)

/** Views: eye and look in game metres, a time of day, a field of view. */
/** A hero's floor in game metres (its elevation above the city datum, 318.59 m). */
const Y = (id) => ap.heroes[id].elevation - 318.59;
const tw = H('atl-control-tower');
const dt = H('atl-domestic-terminal');
const ct = H('atl-concourse-t');
const VIEWS = {
  'aerial-day': { time: '14:00', eye: [-6300, 650, 14300], look: [-4000, y0, 12500], fov: 55, haze: 9000 },
  'aerial-night': { time: '23:30', eye: [-6300, 650, 14300], look: [-4000, y0, 12500], fov: 55, haze: 9000 },
  'runways-night': { time: '23:30', eye: [-1900, 260, 13900], look: [-4200, y0, 13250], fov: 50, haze: 7000 },
  'terminal-day': { time: '15:00', eye: [dt.x - 420, 170, dt.z + 330], look: [dt.x + 120, y0, dt.z - 20], fov: 55, haze: 4000 },
  gates: { time: '13:30', eye: [ct.x + 130, 28, ct.z - 120], look: [ct.x + 10, y0 + 6, ct.z - 10], fov: 58 },
  'gates-b': { time: '16:30', eye: [H('atl-concourse-b').x + 140, 36, H('atl-concourse-b').z + 40], look: [H('atl-concourse-b').x, y0 + 4, H('atl-concourse-b').z - 60], fov: 58 },
  tower: { time: '17:30', eye: [tw.x - 60, Y('atl-control-tower') + 40, tw.z + 330], look: [tw.x, Y('atl-control-tower') + 70, tw.z], fov: 55, haze: 4000 },
  'tower-night': { time: '22:00', eye: [tw.x - 60, Y('atl-control-tower') + 40, tw.z + 330], look: [tw.x, Y('atl-control-tower') + 75, tw.z], fov: 55, haze: 4000 },
  'atrium-interior': { time: '14:00', interior: true, eye: [dt.x - 95, Y('atl-domestic-terminal') + 2.8, dt.z + 12], look: [dt.x + 60, Y('atl-domestic-terminal') + 3, dt.z - 4], fov: 70 },
  'security-interior': { time: '14:00', interior: true, eye: [dt.x + 38, Y('atl-domestic-terminal') + 2.6, dt.z + 14], look: [dt.x + 92, Y('atl-domestic-terminal') + 1.2, dt.z - 2], fov: 66 },
  'ticketing-interior': { time: '14:00', interior: true, eye: [dt.x - 140, Y('atl-domestic-terminal') + 2.6, dt.z - 48], look: [dt.x - 40, Y('atl-domestic-terminal') + 1.4, dt.z - 62], fov: 66 },
  'baggage-interior': { time: '14:00', interior: true, eye: [dt.x + 20, Y('atl-domestic-terminal') + 2.6, dt.z - 45], look: [dt.x + 110, Y('atl-domestic-terminal') + 1.0, dt.z - 62], fov: 66 },
  'concourse-interior': { time: '14:00', interior: true, eye: [ct.x + 2, Y('atl-concourse-t') + 2.6, ct.z + 168], look: [ct.x + 30, Y('atl-concourse-t') + 2.2, ct.z + 182], fov: 70 },
  'concourse-corridor': { time: '14:00', interior: true, eye: [ct.x + 4, Y('atl-concourse-t') + 2.4, ct.z + 300], look: [ct.x + 4, Y('atl-concourse-t') + 2.0, ct.z + 120], fov: 66 },
  landing: { time: '15:30', dynamic: 'landing', fov: 50 },
  'landing-night': { time: '22:30', dynamic: 'landing', fov: 50 },
};

mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const errors = [];

async function open(time) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.__time = time;
  await setup(page, time);
  return page;
}

async function setup(page, time) {
  page.on('console', (m) => { if (m.type() === 'error' || /\[aircraft\]|\[landmarks\]|airport:/.test(m.text())) errors.push(`${time}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${time}: pageerror ${e}`));
  await page.goto(`${base}?spawn=airport&graphics=${tier}&time=${time}&timescale=0`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 180000 });
  await page.keyboard.press('Shift');
  await page.keyboard.press('KeyH');
  await page.evaluate(() => {
    const g = window.__hood.game;
    window.__apCam = null;
    g.addSystem({
      name: 'airport-shots-camera',
      priority: 900,
      lateUpdate: () => {
        const c = window.__apCam;
        if (!c) return;
        if (c.follow) {
          const av = window.__hood.airport?.aircraft;
          const d = av ? av.drawn.find((x) => x.seed === c.follow) : null;
          if (d) {
            c.look = [d.x, d.y + 3, d.z];
          }
        }
        // aerial views see further than the street's haze
        if (c.haze && g.scene.fog) g.scene.fog.far = Math.max(g.scene.fog.far, c.haze);
        g.camera.fov = c.fov;
        g.camera.position.set(c.eye[0], c.eye[1], c.eye[2]);
        g.camera.lookAt(c.look[0], c.look[1], c.look[2]);
        g.camera.far = Math.max(g.camera.far, 9000);
        g.camera.updateProjectionMatrix();
        g.camera.updateMatrixWorld(true);
        // the sky dome follows the camera (Atmosphere moved it to the camera the rig had)
        const dome = g.scene.children.find((o) => o.isMesh && o.geometry?.type === 'SphereGeometry' && o.scale.x > 500);
        if (dome) dome.position.copy(g.camera.position);
      },
    });
    for (const sel of ['.hud', '.hud-prompt', '#hud', '.hud-street', 'canvas:not(#view)']) document.querySelectorAll(sel).forEach((e) => (e.style.visibility = 'hidden'));
  });
}

/** The dev server reloads the page when a source file changes (another agent's edit): set up again. */
async function ensure(page) {
  for (let tries = 0; tries < 5; tries++) {
    const ok = await page.evaluate(() => window.__apCam !== undefined && !!window.__hood?.ready).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(3000);
    const still = await page.evaluate(() => window.__apCam !== undefined && !!window.__hood?.ready).catch(() => false);
    if (!still) await setup(page, page.__time).catch(() => {});
    await page.waitForTimeout(4000);
  }
}

/** Puts the player (in the sim) at a point, so the sim's tiles there load (the loopback transport's sim, when the page has it). */
async function teleport(page, x, z) {
  return page.evaluate(([x, z]) => {
    const t = window.__hood.game.transport;
    const sim = t.sim ?? t.host?.simulation ?? null;
    if (!sim) return false;
    const ped = sim.registry.get(sim.playerPedId);
    ped.controller.teleport(x, sim.groundAt(x, z) + 0.2, z);
    return true;
  }, [x, z]);
}

const byTime = new Map();
for (const [name, v] of Object.entries(VIEWS)) {
  if (only && !only.has(name)) continue;
  if (!byTime.has(v.time)) byTime.set(v.time, []);
  byTime.get(v.time).push([name, v]);
}
for (const [time, list] of byTime) {
  const page = await open(time);
  await page.waitForTimeout(4000);
  for (const [name, v] of list) {
    await ensure(page);
    if (v.interior) await teleport(page, v.eye[0], v.eye[2]);
    if (v.dynamic === 'landing') {
      // beside the touchdown zone of 26R (the north arrival runway): the tiles there in full first, then wait for an aircraft
      // 150 to 600 m short of the threshold, descending, and shoot it with the camera on it
      const end = await page.evaluate(() => {
        const ad = window.__hood.airport?.data;
        for (const r of ad?.runways ?? []) for (const e of r.ends) if (e.ref.replace(/^0/, '') === '26R') return { thr: e.threshold, dir: e.dir };
        return null;
      });
      if (!end) { console.warn(`${name}: no runway 26R`); continue; }
      const [tx, ty, tz] = end.thr;
      const rx = -end.dir[1], rz = end.dir[0];
      // (on the north side, the field's edge: no taxiway between the camera and the runway)
      const eye = [tx + end.dir[0] * 260 + rx * 150, ty + 9, tz + end.dir[1] * 260 + rz * 150];
      const look0 = [tx - end.dir[0] * 600, ty + 40, tz - end.dir[1] * 600];
      await page.evaluate(([c, o]) => { const st = window.__hood.stream; if (st) st.centreOverride = o; window.__apCam = c; }, [{ eye, look: look0, fov: v.fov }, { x: eye[0], z: eye[2] }]);
      await page.waitForTimeout(9000);
      let got = null;
      for (let tries = 0; tries < 900 && !got; tries++) {
        got = await page.evaluate(([thr, dir]) => {
          const av = window.__hood.airport?.aircraft;
          if (!av) return null;
          for (const d of av.drawn) {
            if (d.phase !== 1) continue;
            const along = -((d.x - thr[0]) * dir[0] + (d.z - thr[2]) * dir[1]);
            const off = Math.abs((d.x - thr[0]) * -dir[1] + (d.z - thr[2]) * dir[0]);
            if (along > 120 && along < 420 && off < 40) return { seed: d.seed, x: d.x, y: d.y, z: d.z };
          }
          return null;
        }, [end.thr, end.dir]);
        if (!got) await page.waitForTimeout(200);
      }
      if (!got) { console.warn(`${name}: no aircraft on short final`); continue; }
      await page.evaluate((c) => { window.__apCam = c; }, { eye, look: [got.x, got.y, got.z], fov: v.fov, follow: got.seed });
      await page.waitForTimeout(250);
      console.log(name, 'following', JSON.stringify(await page.evaluate((seed) => { const d = window.__hood.airport.aircraft.drawn.find((x) => x.seed === seed); return d && { x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch, phase: d.phase, gear: d.gear, cls: d.cls }; }, got.seed)), 'eye', eye);
    } else {
      // an aerial needs the tiles under it in full, not their skyline: a wider near ring for the shot
      await page.evaluate(([r, c]) => { const st = window.__hood.stream; if (st) { st.rings = r; st.centreOverride = c; } }, [v.haze ? { near: 4200, drop: 5000, far: 9000 } : null, { x: (v.eye[0] + v.look[0]) / 2, z: (v.eye[2] + v.look[2]) / 2 }]);
      await page.evaluate((c) => { window.__apCam = c; }, { eye: v.eye, look: v.look, fov: v.fov, haze: v.haze });
      await page.waitForTimeout(v.interior ? 9000 : v.haze ? 16000 : 6000);
    }
    // a reload during the wait (the dev server) leaves the default camera: take this view again
    const kept = await page.evaluate(() => !!window.__apCam).catch(() => false);
    if (!kept && !v.retried) {
      v.retried = true;
      list.push([name, v]);
      console.warn(`${name}: the page reloaded; again`);
      continue;
    }
    const file = `.shots/airport-${name}.png`;
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
  await page.close();
}
await browser.close();
console.log(errors.length ? `console messages:\n${[...new Set(errors)].join('\n')}` : 'no console errors');
process.exit(0);
