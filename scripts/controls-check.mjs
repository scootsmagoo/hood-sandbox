#!/usr/bin/env node
/**
 * Controls check: drives the real game with REAL keyboard events (page.keyboard, so every DOM
 * listener runs) and a fake standard gamepad, and asserts what each control does. A minimal port of
 * Skyrome's check, on the procedural test ground (flat, open, deterministic) for the controls and on
 * the baked tile for a short boot-and-drive. The carjack flow (start on the sidewalk, walk round to
 * the driver's door, pull the driver out, drive off, get out and back in, take a parked car, donut)
 * runs on every transport and again on the baked tile.
 *
 *   node scripts/controls-check.mjs [--url http://127.0.0.1:5180/] [--transports worker,shared0,loopback] [--browser chromium|webkit]
 *
 * `--browser webkit` runs the same checks in Playwright's WebKit (the engine of Safari and every iOS
 * browser), as a proxy for Safari: it catches API and layout differences, not Safari's GPU or its
 * memory limits (docs/perf.md). Exposed as `npm run check:controls:webkit`.
 *
 * Without --url it starts its own Vite server on a free port. Exit code 1 if any check fails.
 */
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { STATE, carPoint, doorStand, walkTo } from './drive-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const transports = (typeof args.transports === 'string' ? args.transports : 'worker,shared0,loopback').split(',');
const browserName = typeof args.browser === 'string' ? args.browser : 'chromium';
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
  browser = browserName === 'webkit'
    ? await webkit.launch({ headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) })
    : await chromium.launch({
        headless: true,
        args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'])],
      });
  console.log(`browser: ${browserName} ${browser.version()}`);
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
  const { page, errors, ctx } = await open(`tile=none&start=car&parked=0&graphics=low${QUERY[name]}`, true);
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
  return c.fails() + (await carjackSuite(name)) + (await gamepadSuite(name));
}

// ------------------------------------------------------------------------------------------------
// The carjack flow

const WAIT_STEP = 60;
/** Polls the page state until `cond(state)` holds. Returns the last state. */
async function until(page, cond, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(STATE);
    if (cond(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await page.waitForTimeout(WAIT_STEP);
  }
}

const HALF = { sedan: [0.92, 2.2], coupe: [0.92, 2.2], pickup: [1.0, 2.65] };

/** Walks from the sidewalk round the rear of a parked car to its driver's door. */
async function walkToDriverDoor(page, carId) {
  const find = (s) => s.cars.find((c) => c.id === carId);
  const [hx, hz] = HALF[find(await page.evaluate(STATE)).type] ?? HALF.sedan;
  const r1 = await walkTo(page, (s) => carPoint(find(s), -(hx + 1.5), -(hz + 1.7)), { tol: 1.0, sprint: true });
  const r2 = await walkTo(page, (s) => carPoint(find(s), hx + 1.5, -(hz + 1.7)), { tol: 1.0, sprint: true });
  const r3 = await walkTo(page, async (s) => doorStand(page, find(s)), { tol: 0.55 });
  return r1.ok && r2.ok && r3.ok;
}

async function installEventLog(page) {
  await page.evaluate(() => {
    window.__events = [];
    window.__hood.game.onSimEvent((e) => window.__events.push(e));
  });
}
const eventsOf = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);

async function carjackSuite(name) {
  console.log(`--- carjack (${name})`);
  const { page, errors, ctx } = await open(`tile=none&graphics=low&driver=flee${QUERY[name]}`);
  const c = makeChecker(page, `jack-${name}`);
  const { check, tap, wait, st, expect, k } = c;
  await wait(800);
  await installEventLog(page);
  let heroId = 0;

  await check('starts on foot, car occupied nearby', async () => {
    const s = await st();
    heroId = s.car.id;
    expect(!s.inCar, 'started in a car');
    const d = Math.hypot(s.car.x - s.ped.x, s.car.z - s.ped.z);
    expect(d > 4 && d < 12, `car ${d.toFixed(1)} m away`);
    expect((s.car.flags & 1) !== 0, 'the car has nobody in it');
    return `${d.toFixed(1)} m from the car`;
  });
  await check('parked empty cars of mixed types', async () => {
    const s = await st();
    const parked = s.cars.filter((x) => x.id !== heroId);
    expect(parked.length >= 4, `only ${parked.length} parked cars`);
    expect(parked.every((x) => (x.flags & 1) === 0), 'a parked car is occupied');
    const types = new Set(s.cars.map((x) => x.type));
    expect(types.size >= 3, `types ${[...types]}`);
    return `${parked.length} parked, types ${[...types].join('/')}`;
  });
  await check('E far from the car does nothing', async () => {
    await tap('KeyE');
    await wait(300);
    const s = await st();
    expect(!s.inCar, 'got in from the sidewalk');
    expect((s.ped.flags & 128) === 0, 'the sequence started');
  });
  await check('E on the passenger side does nothing', async () => {
    const s0 = await st();
    const car = s0.cars.find((x) => x.id === heroId);
    const r = await walkTo(page, () => carPoint(car, -1.6, 0.05), { tol: 0.5 });
    expect(r.ok, `could not reach the passenger side (${r.dist.toFixed(1)} m)`);
    const s1 = await st();
    expect(!s1.prompt.includes('Carjack'), `prompt "${s1.prompt}"`);
    await tap('KeyE');
    await wait(500);
    const s2 = await st();
    expect(!s2.inCar && (s2.ped.flags & 128) === 0, 'something happened');
    expect((await eventsOf(page, 'carjack')).length === 0, 'carjack event');
  });
  await check('walking round to the driver door shows the carjack prompt', async () => {
    expect(await walkToDriverDoor(page, heroId), 'did not reach the door');
    const s = await st();
    expect(s.prompt.includes('Carjack'), `prompt "${s.prompt}"`);
    return s.prompt;
  });
  await check('E at the door pulls the driver out and puts the player at the wheel', async () => {
    await tap('KeyE');
    await until(page, (s) => (s.ped.flags & 128) !== 0, 2000, 'the sequence to start');
    // the door opens and the driver is dragged out while the player has no control
    await until(page, (s) => (s.cars.find((x) => x.id === heroId).flags & 64) !== 0, 2000, 'the door to open');
    await until(page, (s) => s.peds.some((p) => !p.player && (p.flags & 64) !== 0), 2000, 'the driver to be dragged');
    // movement is ignored while it runs
    await k.down('KeyW');
    const done = await until(page, (s) => s.inCar, 4000, 'the player to be in the car');
    await k.up('KeyW');
    expect(done.car.id === heroId, 'in some other car');
    const ev = await eventsOf(page, 'carjack');
    expect(ev.length === 1, `${ev.length} carjack events`);
    expect(ev[0].reaction === 'flee', `reaction ${ev[0].reaction}`);
    const entered = (await eventsOf(page, 'vehicle:enter')).length;
    expect(entered >= 1, 'no enter event');
    return `carjack event, reaction ${ev[0].reaction}`;
  });
  await check('the driver runs away from the car', async () => {
    const t = await until(page, (s) => s.peds.some((p) => !p.player && p.speed > 5), 3000, 'the driver to run');
    const run0 = t.peds.find((p) => !p.player);
    await wait(1200);
    const s = await st();
    const now = s.peds.find((p) => p.id === run0.id);
    expect(now, 'the driver vanished too soon');
    const d0 = Math.hypot(run0.x - s.car.x, run0.z - s.car.z);
    const d1 = Math.hypot(now.x - s.car.x, now.z - s.car.z);
    expect(d1 > d0 + 3, `distance ${d0.toFixed(1)} -> ${d1.toFixed(1)}`);
    return `${d0.toFixed(1)} -> ${d1.toFixed(1)} m, ${now.speed.toFixed(1)} m/s`;
  });
  await check('and is removed from the world once far away', async () => {
    await until(page, (s) => !s.peds.some((p) => !p.player), 25000, 'the driver to be despawned');
    const d = await eventsOf(page, 'entity:despawn');
    expect(d.length >= 1, 'no despawn event');
  });
  await check('the stolen car drives', async () => {
    await k.down('KeyW');
    await wait(1500);
    const s = await st();
    await k.up('KeyW');
    expect(s.car.fwd > 6, `speed ${s.car.fwd.toFixed(1)}`);
    for (let i = 0; i < 30 && (await st()).car.speed > 2; i++) { await k.down('KeyS'); await wait(200); }
    await k.up('KeyS');
  });
  await check('E gets out; E gets back into the same (now empty) car', async () => {
    await wait(600);
    await tap('KeyE');
    await wait(500);
    expect(!(await st()).inCar, 'did not get out');
    const s = await st();
    expect(s.prompt.includes('Get in'), `prompt "${s.prompt}"`);
    await tap('KeyE');
    await wait(400);
    const s2 = await st();
    expect(s2.inCar && s2.car.id === heroId, 'not back in the same car');
    await tap('KeyE');
    await wait(500);
  });
  await check('E gets into a different, empty parked car', async () => {
    const s0 = await st();
    const here = s0.car;
    const other = s0.cars.filter((x) => x.id !== heroId && Math.hypot(x.x - s0.ped.x, x.z - s0.ped.z) < 70).sort((a, b) => Math.hypot(a.x - s0.ped.x, a.z - s0.ped.z) - Math.hypot(b.x - s0.ped.x, b.z - s0.ped.z))[0];
    expect(other, 'no parked car near enough');
    const r = await walkTo(page, async (s) => doorStand(page, s.cars.find((x) => x.id === other.id)), { tol: 0.8, sprint: true, timeoutMs: 30000 });
    expect(r.ok, `could not reach it (${r.dist.toFixed(1)} m)`);
    const s1 = await st();
    expect(s1.prompt.includes('Get in'), `prompt "${s1.prompt}"`);
    await tap('KeyE');
    await wait(400);
    const s2 = await st();
    expect(s2.inCar && s2.car.id === other.id, `in car ${s2.car?.id}, wanted ${other.id}`);
    expect(s2.car.id !== here.id, 'same car');
    return `got into a ${other.type}`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  let fails = c.fails();
  if (name === 'worker') fails += (await fightSuite()) + (await handlingSuite());
  return fails;
}

/** The driver who fights back: stands up to the player, throws punches, then runs. */
async function fightSuite() {
  console.log('--- carjack, fighting driver');
  const { page, errors, ctx } = await open('tile=none&graphics=low&driver=fight&start=jack');
  const c = makeChecker(page, 'fight');
  const { check, tap, wait, st, expect } = c;
  await wait(800);
  await installEventLog(page);
  await check('start=jack: beside the door of an occupied car', async () => {
    const s = await st();
    expect(s.prompt.includes('Carjack'), `prompt "${s.prompt}"`);
  });
  await check('the driver fights back after the pull-out, then runs', async () => {
    await tap('KeyE');
    await until(page, (s) => s.inCar, 4000, 'the player to be in the car');
    const ev = await eventsOf(page, 'carjack');
    expect(ev[0]?.reaction === 'fight', `reaction ${ev[0]?.reaction}`);
    // get out so there is something to punch
    await wait(500);
    await tap('KeyE');
    await until(page, (s) => s.peds.some((p) => !p.player && (p.flags & 32) !== 0), 3000, 'the driver to square up');
    const hit = await page.waitForFunction(() => window.__events.some((e) => e.type === 'ped:attack'), null, { timeout: 8000 }).then(() => true, () => false);
    expect(hit, 'no punch landed');
    await until(page, (s) => s.peds.some((p) => !p.player && (p.flags & 16) !== 0), 9000, 'the driver to run');
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

/** Car feel in the real game: a donut with smoke, the pickup, a handbrake drift. */
async function handlingSuite() {
  console.log('--- handling');
  const { page, errors, ctx } = await open('tile=none&graphics=low&start=car&car=pickup&parked=0');
  const c = makeChecker(page, 'handling');
  const { check, tap, wait, st, expect, k } = c;
  await wait(800);
  await check('?car=pickup picks the pickup', async () => {
    const s = await st();
    expect(s.car.type === 'pickup', `type ${s.car.type}`);
    await tap('KeyE');
    await wait(300);
    expect((await st()).inCar, 'not in the car');
  });
  await check('W + D from rest is a donut: a steady circle, smoking', async () => {
    await k.down('KeyW');
    await k.down('KeyD');
    await wait(3500);
    const a = await st();
    const turns = [];
    let sawSmoke = false;
    let prev = a.car.yaw;
    let acc = 0;
    const t0 = Date.now();
    let maxDist = 0;
    let minSpeed = 99;
    let maxSpeed = 0;
    while (Date.now() - t0 < 4000) {
      const s = await st();
      let d = s.car.yaw - prev;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      acc += d;
      prev = s.car.yaw;
      sawSmoke ||= (s.car.flags & 16) !== 0;
      maxDist = Math.max(maxDist, Math.hypot(s.car.x - a.car.x, s.car.z - a.car.z));
      minSpeed = Math.min(minSpeed, s.car.speed);
      maxSpeed = Math.max(maxSpeed, s.car.speed);
      await wait(40);
    }
    await k.up('KeyD');
    await k.up('KeyW');
    // a pickup donut turns at about 1.4 rad/s: three quarters of a turn or more in 4 s
    expect(Math.abs(acc) > 1.5 * Math.PI, `turned ${(acc / (2 * Math.PI)).toFixed(2)} turns in 4 s`);
    expect(acc < 0, 'turned the wrong way');
    expect(sawSmoke, 'no skid flag (no smoke)');
    expect(maxDist < 16, `wandered ${maxDist.toFixed(0)} m`);
    expect(minSpeed > 5 && maxSpeed < 11, `speed ${minSpeed.toFixed(1)}-${maxSpeed.toFixed(1)}`);
    return `${(Math.abs(acc) / (2 * Math.PI)).toFixed(1)} turns in 4 s, speed ${minSpeed.toFixed(1)}-${maxSpeed.toFixed(1)}, within ${maxDist.toFixed(0)} m`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

async function gamepadSuite(name) {
  if (name !== 'worker') return 0;
  console.log('--- gamepad');
  const { page, errors, ctx } = await open('tile=none&start=car&parked=0&graphics=low', true);
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
    expect(info.tris > 50000, `only ${info.tris} triangles drawn`);
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
  return c.fails() + (await realCarjack());
}

/** The same flow on the real Five Points tile: sidewalk start, round the car, jack it, drive off. */
async function realCarjack() {
  console.log('--- carjack on the baked tile');
  const { page, errors, ctx } = await open('graphics=low&driver=flee');
  const c = makeChecker(page, 'real-jack');
  const { check, tap, wait, st, expect, k } = c;
  await wait(1000);
  await installEventLog(page);
  let heroId = 0;
  await check('starts on the sidewalk by a parked, occupied car', async () => {
    const s = await st();
    heroId = s.car.id;
    const d = Math.hypot(s.car.x - s.ped.x, s.car.z - s.ped.z);
    expect(!s.inCar && d > 4 && d < 12, `inCar ${s.inCar}, ${d.toFixed(1)} m`);
    expect((s.car.flags & 1) !== 0, 'nobody in the car');
    expect(s.cars.length >= 5, `${s.cars.length} cars`);
    return `${d.toFixed(1)} m, ${s.cars.length} cars (${[...new Set(s.cars.map((x) => x.type))].join('/')})`;
  });
  await check('walks round to the driver door and jacks the car', async () => {
    expect(await walkToDriverDoor(page, heroId), 'did not reach the door');
    expect((await st()).prompt.includes('Carjack'), 'no prompt');
    await tap('KeyE');
    const s = await until(page, (x) => x.inCar, 5000, 'the player to be in the car');
    expect(s.car.id === heroId, 'wrong car');
    expect((await eventsOf(page, 'carjack')).length === 1, 'no carjack event');
  });
  await check('drives off down the street', async () => {
    const a = await st();
    await wait(1800);
    await k.down('KeyW');
    await wait(2200);
    const b = await st();
    await k.up('KeyW');
    expect(Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z) > 8, 'did not move');
    expect(b.car.y > -40 && b.car.y < 100, `y ${b.car.y}`);
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

await main();
