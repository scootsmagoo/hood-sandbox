#!/usr/bin/env node
/**
 * Controls check: drives the real game with REAL keyboard events (page.keyboard, so every DOM
 * listener runs) and a fake standard gamepad, and asserts what each control does. A minimal port of
 * Skyrome's check, on the procedural test ground (flat, open, deterministic) for the controls and on
 * the baked tile for a short boot-and-drive.
 *
 *   node scripts/controls-check.mjs [--url http://127.0.0.1:5180/] [--transports worker,shared0,loopback]
 *
 * Without --url it starts its own Vite server on a free port. Exit code 1 if any check fails.
 */
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const transports = (typeof args.transports === 'string' ? args.transports : 'worker,shared0,loopback').split(',');
const QUERY = { worker: '', shared0: '&shared=0', loopback: '&transport=loopback' };

let server = null;
let base = typeof args.url === 'string' ? args.url : null;
if (!base) {
  const { createServer } = await import('vite');
  const port = await new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  server = await createServer({ root, logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false } });
  await server.listen();
  base = `http://127.0.0.1:${port}/`;
}

let browser;
async function main() {
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
  });
  let failures = 0;
  for (const t of transports) failures += await suite(t);
  if (existsSync(resolve(root, 'public/tiles/atlanta/m1-five-points/tile.json'))) failures += await realTile();
  else console.log('\n(no baked tile in public/tiles: skipping the real-tile check)');
  await browser.close();
  if (server) await server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll controls checks passed');
  process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------

async function open(query, withPad = false) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  if (withPad) {
    await ctx.addInitScript(() => {
      const pad = { id: 'Xbox Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), timestamp: 0 };
      window.__pad = pad;
      navigator.getGamepads = () => [window.__pad];
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__hood.error);
  if (err) throw new Error(`boot error: ${err}`);
  return { page, errors, ctx };
}

const STATE = () => {
  const g = window.__hood.game;
  const v = g.view;
  const yawOf = (q) => Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
  const car = v.vehicle;
  return {
    inCar: v.inVehicle,
    ped: { x: v.ped.x, y: v.ped.y, z: v.ped.z, speed: v.ped.speed },
    car: car && { x: car.x, y: car.y, z: car.z, fwd: car.speed, speed: Math.hypot(car.vx, car.vz), yaw: yawOf(car.q), flags: car.flags },
    camYaw: g.cameraRig.yaw,
    preset: g.cameraRig.preset,
    tick: v.tick,
  };
};

function makeChecker(page, label) {
  let fails = 0;
  const k = page.keyboard;
  const wait = (ms) => page.waitForTimeout(ms);
  const st = () => page.evaluate(STATE);
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  async function check(name, fn) {
    let line;
    try {
      const detail = await fn();
      line = `PASS  ${name.padEnd(30)} ${detail ?? ''}`;
    } catch (e) {
      fails++;
      line = `FAIL  ${name.padEnd(30)} ${e.message}`;
    }
    console.log(line.slice(0, 190));
  }
  async function hold(keys, ms) {
    for (const key of keys) await k.down(key);
    await wait(ms);
    for (const key of [...keys].reverse()) await k.up(key);
  }
  const tap = async (key) => { await k.down(key); await wait(90); await k.up(key); await wait(120); };
  return { check, hold, tap, wait, st, expect, k, fails: () => fails };
}

async function suite(name) {
  console.log(`\n=== ${name} ===`);
  const { page, errors, ctx } = await open(`tile=none&start=car&graphics=low${QUERY[name]}`, true);
  const c = makeChecker(page, name);
  const { check, hold, tap, wait, st, expect, k } = c;
  await wait(800);

  await check('boots isolated, no errors', async () => {
    const info = await page.evaluate(() => ({ iso: crossOriginIsolated, kind: window.__hood.game.transport.kind, shared: window.__hood.game.transport.shared, tile: window.__hood.game.ready.tileSource, fps: window.__hood.game.fps }));
    expect(info.iso, 'page is not cross-origin isolated');
    expect(info.tile === 'procedural', `tile ${info.tile}`);
    const wantKind = name === 'loopback' ? 'loopback' : 'worker';
    expect(info.kind === wantKind, `transport ${info.kind}`);
    expect(info.shared === (name === 'worker'), `shared=${info.shared}`);
    expect(info.fps > 20, `fps ${info.fps}`);
    return `${info.kind} shared=${info.shared} fps=${Math.round(info.fps)}`;
  });

  await check('E gets into the car', async () => {
    await tap('KeyE');
    await wait(300);
    const s = await st();
    expect(s.inCar, 'not in the car');
  });
  await check('W accelerates', async () => {
    await hold(['KeyW'], 1500);
    const s = await st();
    expect(s.car.fwd > 6, `speed ${s.car.fwd.toFixed(1)}`);
    return `${s.car.fwd.toFixed(1)} m/s`;
  });
  await check('D steers right, A steers left', async () => {
    await k.down('KeyW');
    await wait(600);
    const y0 = (await st()).car.yaw;
    await k.down('KeyD');
    await wait(700);
    await k.up('KeyD');
    const y1 = (await st()).car.yaw;
    await k.down('KeyA');
    await wait(1100);
    await k.up('KeyA');
    const y2 = (await st()).car.yaw;
    await k.up('KeyW');
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    expect(wrap(y1 - y0) < -0.1, `right: ${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
    expect(wrap(y2 - y1) > 0.1, `left: ${y1.toFixed(2)} -> ${y2.toFixed(2)}`);
  });
  await check('E at speed is refused', async () => {
    await k.down('KeyW');
    await wait(1800);
    await tap('KeyE');
    await wait(200);
    const s = await st();
    await k.up('KeyW');
    expect(s.car.speed > 9, `only ${s.car.speed.toFixed(1)} m/s`);
    expect(s.inCar, 'got out at speed');
  });
  await check('S brakes, then reverses', async () => {
    await k.down('KeyS');
    for (let i = 0; i < 25 && (await st()).car.fwd > 3; i++) await wait(200);
    const mid = await st();
    await wait(2000);
    const end = await st();
    await k.up('KeyS');
    expect(mid.car.fwd < 3, `still rolling ${mid.car.fwd.toFixed(1)}`);
    expect(end.car.fwd < -2, `not reversing ${end.car.fwd.toFixed(1)}`);
  });
  await check('Space + W burns out', async () => {
    await wait(800);
    await k.down('Space');
    await k.down('KeyW');
    await wait(600);
    const s = await st();
    await k.up('KeyW');
    await k.up('Space');
    expect((s.car.flags & 16) !== 0, `flags ${s.car.flags}`);
  });
  await check('arrow keys look around', async () => {
    const a = (await st()).camYaw;
    await hold(['ArrowLeft'], 400);
    const b = (await st()).camYaw;
    await hold(['ArrowRight'], 800);
    const d = (await st()).camYaw;
    expect(b !== a, 'camera did not move');
    expect(Math.abs(b - a) > 0.05, `left turned ${(b - a).toFixed(3)}`);
    expect(d < b, 'right did not undo left');
  });
  await check('V and the wheel change distance', async () => {
    const a = (await st()).preset;
    await tap('KeyV');
    const b = (await st()).preset;
    expect(a !== b, `V: ${a} -> ${b}`);
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, -240);
    await wait(150);
    const c2 = (await st()).preset;
    expect(c2 !== b, `wheel: ${b} -> ${c2}`);
  });
  await check('R stands the car up (no jump)', async () => {
    await tap('KeyR');
    await wait(500);
    const s = await st();
    expect(s.car.y < 2, `y ${s.car.y}`);
  });

  // Park, get out, walk.
  await hold(['KeyS'], 200);
  await check('E gets out when stopped', async () => {
    for (let i = 0; i < 30 && (await st()).car.speed > 2; i++) await wait(200);
    await wait(500);
    await tap('KeyE');
    await wait(500);
    const s = await st();
    expect(!s.inCar, 'still in the car');
  });
  await check('W walks forward (camera-relative)', async () => {
    const a = await st();
    // look direction: camera yaw
    await hold(['KeyW'], 700);
    const b = await st();
    const dx = b.ped.x - a.ped.x;
    const dz = b.ped.z - a.ped.z;
    const along = dx * -Math.sin(a.camYaw) + dz * -Math.cos(a.camYaw);
    expect(along > 1.5, `moved ${along.toFixed(2)} m along the camera`);
  });
  await check('Shift sprints faster', async () => {
    await k.down('KeyW');
    await wait(900);
    const jog = (await st()).ped.speed;
    await k.down('ShiftLeft');
    await wait(900);
    const run = (await st()).ped.speed;
    await k.up('ShiftLeft');
    await k.up('KeyW');
    expect(run > jog + 1.5, `jog ${jog.toFixed(1)} sprint ${run.toFixed(1)}`);
    return `${jog.toFixed(1)} -> ${run.toFixed(1)} m/s`;
  });
  await check('Space jumps', async () => {
    await wait(400);
    const y0 = (await st()).ped.y;
    await k.down('Space');
    let top = y0;
    for (let i = 0; i < 12; i++) { await wait(50); top = Math.max(top, (await st()).ped.y); }
    await k.up('Space');
    expect(top > y0 + 0.4, `rose ${(top - y0).toFixed(2)} m`);
  });
  await check('Cmd+W does nothing', async () => {
    await wait(400);
    const a = await st();
    await k.down('Meta');
    await k.down('KeyW');
    await wait(500);
    await k.up('KeyW');
    await k.up('Meta');
    const b = await st();
    expect(Math.hypot(b.ped.x - a.ped.x, b.ped.z - a.ped.z) < 0.5, 'moved');
  });
  await check('no stuck keys after blur', async () => {
    await k.down('KeyW');
    await wait(300);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await wait(600);
    const a = await st();
    await wait(500);
    const b = await st();
    await k.up('KeyW');
    expect(Math.hypot(b.ped.x - a.ped.x, b.ped.z - a.ped.z) < 0.3, 'kept walking');
  });

  // Gamepad: back to the car (teleport-free: walk is awkward, so reset by reloading a fresh page).
  await ctx.close();
  return c.fails() + (await gamepadSuite(name));
}

async function gamepadSuite(name) {
  if (name !== 'worker') return 0;
  console.log('--- gamepad');
  const { page, errors, ctx } = await open('tile=none&start=car&graphics=low', true);
  const c = makeChecker(page, 'pad');
  const { check, wait, st, expect } = c;
  const press = (i, on) => page.evaluate(([i, on]) => { window.__pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; }, [i, on]);
  const axis = (i, v) => page.evaluate(([i, v]) => { window.__pad.axes[i] = v; }, [i, v]);
  const trigger = (i, v) => page.evaluate(([i, v]) => { window.__pad.buttons[i] = { pressed: v > 0.5, touched: v > 0, value: v }; }, [i, v]);
  await wait(600);
  await check('Y gets into the car', async () => {
    await press(3, true);
    await wait(150);
    await press(3, false);
    await wait(300);
    expect((await st()).inCar, 'not in the car');
  });
  await check('RT is an analog throttle', async () => {
    await trigger(7, 0.4);
    await wait(1500);
    const half = (await st()).car.fwd;
    await trigger(7, 1);
    await wait(1500);
    const full = (await st()).car.fwd;
    expect(half > 2, `half throttle ${half.toFixed(1)}`);
    expect(full > half + 4, `half ${half.toFixed(1)} full ${full.toFixed(1)}`);
    return `${half.toFixed(1)} -> ${full.toFixed(1)} m/s`;
  });
  await check('left stick steers', async () => {
    const y0 = (await st()).car.yaw;
    await axis(0, 1);
    await wait(700);
    const y1 = (await st()).car.yaw;
    await axis(0, 0);
    expect(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0)) < -0.1, `${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
  });
  await check('LT brakes', async () => {
    await trigger(7, 0);
    await trigger(6, 1);
    await wait(2500);
    const s = await st();
    await trigger(6, 0);
    expect(s.car.speed < 4 || s.car.fwd < 1, `speed ${s.car.speed.toFixed(1)}`);
  });
  await ctx.close();
  return c.fails();
}

async function realTile() {
  console.log('\n=== baked tile ===');
  const { page, errors, ctx } = await open('start=car&graphics=low');
  const c = makeChecker(page, 'real');
  const { check, hold, tap, wait, st, expect, k } = c;
  await wait(1000);
  await check('boots on the baked tile', async () => {
    const info = await page.evaluate(() => ({ tile: window.__hood.game.ready.tileSource, calls: window.__hood.game.renderer.info.render.calls, tris: window.__hood.game.renderer.info.render.triangles }));
    expect(info.tile === 'baked', `tile ${info.tile}`);
    expect(info.tris > 100000, `only ${info.tris} triangles drawn`);
    return `${info.calls} draws, ${(info.tris / 1000).toFixed(0)}k triangles`;
  });
  await check('gets in and drives on the street', async () => {
    await tap('KeyE');
    await wait(300);
    const a = await st();
    expect(a.inCar, 'not in the car');
    await hold(['KeyW'], 2000);
    const b = await st();
    expect(Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z) > 8, 'did not move');
    expect(b.car.y > -40 && b.car.y < 100, `y ${b.car.y}`);
    return `${Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z).toFixed(0)} m in 2 s`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

await main();
