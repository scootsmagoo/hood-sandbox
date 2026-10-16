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
import { HUD, STATE, carPoint, doorStand, walkTo } from './drive-helpers.mjs';

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
  if (args.only === 'map') failures += await mapSuite();
  else if (args.only === 'traffic') failures += await trafficSuite();
  else if (args.only === 'guns') failures += await gunSuite();
  else if (args.only === 'police') failures += await policeSuite();
  else if (args.only === 'transit') failures += await transitSuite();
  else {
  for (const t of transports) failures += await suite(t);
  if (existsSync(resolve(root, 'public/tiles/atlanta/m1-five-points/tile.json'))) failures += await realTile();
  else console.log('\n(no baked tile in public/tiles: skipping the real-tile check)');
  failures += await gunSuite();
  failures += await policeSuite();
  failures += await mapSuite();
  if (existsSync(resolve(root, 'public/tiles/atlanta/m1-five-points/transit.json'))) failures += await transitSuite();
  }
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
    // a heavy car: about 5 m/s after a second and a half from rest (0 to 100 km/h in about 9 s)
    expect(s.car.fwd > 4, `speed ${s.car.fwd.toFixed(1)}`);
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
    await wait(2800);
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
    expect(along > 1.2, `moved ${along.toFixed(2)} m along the camera`);
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
    const run0 = t.peds.find((p) => !p.player && (p.flags & 1024) === 0);
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
    // (the carjack calls the police: officers are not the driver)
    await until(page, (s) => !s.peds.some((p) => !p.player && (p.flags & 1024) === 0), 25000, 'the driver to be despawned');
    const d = await eventsOf(page, 'entity:despawn');
    expect(d.length >= 1, 'no despawn event');
  });
  await check('the stolen car drives', async () => {
    await k.down('KeyW');
    await wait(1500);
    const s = await st();
    await k.up('KeyW');
    expect(s.car.fwd > 4, `speed ${s.car.fwd.toFixed(1)}`);
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
  if (name === 'worker') fails += (await fightSuite()) + (await handlingSuite()) + (await lawSuite('procedural'));
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

/** Car feel in the real game: the pickup, and a donut with smoke from a burnout with the wheel turned. */
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
  await check('Space + W + D from rest is a donut: the spinning rear swings the truck round its front, smoking', async () => {
    await k.down('Space');
    await k.down('KeyW');
    await k.down('KeyD');
    await wait(1500);
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
    await k.up('Space');
    // no assist holds it: the rear tyres spin and the truck pivots round slowly, half a turn or more in 4 s, staying put
    expect(Math.abs(acc) > Math.PI, `turned ${(acc / (2 * Math.PI)).toFixed(2)} turns in 4 s`);
    expect(acc < 0, 'turned the wrong way');
    expect(sawSmoke, 'no skid flag (no smoke)');
    expect(maxDist < 16, `wandered ${maxDist.toFixed(0)} m`);
    expect(maxSpeed < 11, `speed ${minSpeed.toFixed(1)}-${maxSpeed.toFixed(1)}`);
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
    // (a heavy car: about 2 m/s after 1.5 s at four tenths, and a few m/s more after another 1.5 s flat out)
    expect(half > 1.2, `half throttle ${half.toFixed(1)}`);
    expect(full > half + 2.5, `half ${half.toFixed(1)} full ${full.toFixed(1)}`);
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
    expect(Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z) > 5, 'did not move');
    expect(b.car.y > -40 && b.car.y < 100, `y ${b.car.y}`);
    return `${Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z).toFixed(0)} m in 2 s`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails() + (await realCarjack()) + (await realBystanderJack()) + (await trafficSuite()) + (await lawSuite('baked'));
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

/**
 * Ambient traffic on the baked tile (run on the loopback transport so the check can look into the sim):
 * cars are about and drawn as instances, the signals have heads, and a car stopped at a red light can be
 * jacked with real key presses through the same flow as any other car, with the queue behind it waiting.
 */
async function trafficSuite() {
  console.log('--- traffic on the baked tile');
  const { page, errors, ctx } = await open('graphics=low&transport=loopback&time=12:00&timescale=0&ambient=0&seed=3');
  const c = makeChecker(page, 'traffic');
  const { check, tap, wait, st, expect, k } = c;
  await wait(1500);
  await installEventLog(page);
  const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);

  await check('traffic cars are about, flagged and drawn as instances', async () => {
    await wait(4000);
    const info = await page.evaluate(() => {
      const g = window.__hood.game;
      let traffic = 0;
      for (const e of g.view.entities.values()) if (e.kind === 2 && (e.flags & (1 << 13)) !== 0) traffic++;
      const meshes = [];
      g.scene.traverse((o) => { if (o.isInstancedMesh && o.name.startsWith('traffic-')) meshes.push({ name: o.name, count: o.count }); });
      return { traffic, meshes, calls: g.renderer.info.render.calls };
    });
    expect(info.traffic >= 8, `${info.traffic} traffic cars in the snapshot`);
    expect(info.meshes.some((m) => m.count > 0), `no instanced car drawn (${JSON.stringify(info.meshes)})`);
    return `${info.traffic} cars, ${info.meshes.filter((m) => m.count > 0).length} instanced meshes in use, ${info.calls} draws`;
  });
  await check('signal heads stand at the signalised junctions', async () => {
    const info = await page.evaluate(() => {
      let heads = 0;
      window.__hood.game.scene.traverse((o) => { if (o.name === 'signal-heads') heads = o.children.reduce((a, m) => a + (m.count ?? 0), 0); });
      return heads;
    });
    expect(info >= 100, `${info} signal parts`);
    return `${info} parts (poles, housings, lamps)`;
  });

  let jackId = 0;
  await check('a car stops at a red light with a driver at the wheel', async () => {
    // let the world run until some car is standing at a closed signal, then go and stand near it
    let found = null;
    const look = (radius) => sim((s, r) => {
      const t = s.traffic;
      const p = s.registry.get(s.playerPedId).controller;
      let best = null;
      for (const c of t.cars) {
        if (c.veh.car.speed > 0.3 || !c.gateWhy.startsWith('signal closed')) continue;
        const b = c.veh.car.body.translation();
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (d < r && (!best || d < best.d)) best = { id: c.veh.id, x: b.x, z: b.z, d, phys: c.mode === 'phys' && !!c.veh.occupantId };
      }
      return best;
    }, radius);
    for (let i = 0; i < 480 && !found; i++) {
      const cand = await look(900);
      if (cand && cand.phys && cand.d < 60) found = cand;
      else if (cand) {
        await sim((s, c) => {
          const pl = s.registry.get(s.playerPedId).controller;
          pl.teleport(c.x + 22, s.groundAt(c.x + 22, c.z) + 0.3, c.z + 3);
        }, cand);
        await wait(1200);
      } else await wait(250);
    }
    expect(found, 'no car stood at a red light within two minutes');
    jackId = found.id;
    return `car ${jackId} at (${found.x.toFixed(0)}, ${found.z.toFixed(0)})`;
  });
  await check('E at its driver door pulls the driver out and puts the player at the wheel', async () => {
    // put the player on the pavement a few metres from the car, then walk to the door with real keys
    await sim((s, id) => {
      const v = s.registry.get(id);
      const pose = v.car.pose();
      const pl = s.registry.get(s.playerPedId).controller;
      // 4 m behind the driver's door line, on the left of the car
      const yaw = v.car.yaw;
      const x = pose.x + Math.cos(yaw) * 3.2 - Math.sin(yaw) * 5.5;
      const z = pose.z - Math.sin(yaw) * 3.2 - Math.cos(yaw) * 5.5;
      pl.teleport(x, s.groundAt(x, z) + 0.2, z);
    }, jackId);
    await wait(500);
    const r = await walkTo(page, async (s) => { const car = s.cars.find((x) => x.id === jackId); return doorStand(page, car); }, { tol: 0.6, timeoutMs: 15000 });
    expect(r.ok, `did not reach the door (${r.dist?.toFixed(1)} m)`);
    await tap('KeyE');
    const s = await until(page, (x) => x.inCar, 6000, 'the player to be in the car');
    expect(s.car.id === jackId, 'wrong car');
    expect((await eventsOf(page, 'carjack')).length >= 1, 'no carjack event');
    expect((await eventsOf(page, 'crime')).some((e) => e.crime === 'carjack'), 'no crime event');
    const state = await sim((sm, id) => { const v = sm.registry.get(id); return { traffic: !!v.trafficCar, owner: v.owner }; }, jackId);
    expect(!state.traffic && state.owner === 1, `still traffic: ${JSON.stringify(state)}`);
  });
  await check('and the car drives away', async () => {
    const a = await st();
    await k.down('KeyW');
    await wait(2500);
    const b = await st();
    await k.up('KeyW');
    expect(Math.hypot(b.car.x - a.car.x, b.car.z - a.car.z) > 8, 'did not move');
  });
  await check('driving through the traffic: cars keep their lanes and nothing wrecks', async () => {
    await k.down('KeyW');
    await wait(5000);
    await k.up('KeyW');
    const s = await sim((sm) => ({ cars: sm.traffic.cars.length, free: sm.traffic.count('free'), phys: sm.traffic.count('phys') }));
    expect(s.cars > 5, `${s.cars} cars`);
    return `${s.cars} cars, ${s.phys} physical, ${s.free} left behind`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

/**
 * A carjack with people about: the baked tile at lunchtime with ambient pedestrians, four of them put on the
 * sidewalk near the car. The player pulls the driver out and the sim must report the crime from a bystander,
 * not only the driver; the bystanders run; and knocking out a caller stops that call.
 */
async function realBystanderJack() {
  console.log('--- carjack with bystanders on the baked tile');
  const { page, errors, ctx } = await open('graphics=low&driver=flee&transport=loopback&time=12:00&parked=2');
  const c = makeChecker(page, 'bystander-jack');
  const { check, tap, wait, st, expect } = c;
  const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  await wait(1200);
  await installEventLog(page);
  let heroId = 0;
  await check('there are ambient pedestrians, and four are standing near the car', async () => {
    const r = await sim((S) => {
      const A = S.ambient;
      if (!A) return { n: 0, near: 0 };
      const me = S.playerPosition();
      const g = A.graph;
      const gid = Object.keys(A.population.pedGroups)[0];
      // sidewalk nodes 8 to 26 m from the player, nearest first, at least 5 m apart and in sight of the car
      const cands = [];
      for (let i = 0; i < g.nodeCount; i++) {
        const d = Math.hypot(g.x[i] - me.x, g.z[i] - me.z);
        if (d < 8 || d > 26 || !g.edgesAt(i).length || !g.isSpawnEdge(g.edgesAt(i)[0])) continue;
        if (!S.law.clearLine({ x: g.x[i], y: g.y[i] + 1.5, z: g.z[i] }, { x: me.x, y: me.y + 1.2, z: me.z })) continue;
        cands.push({ i, d });
      }
      cands.sort((a, b) => a.d - b.d);
      const used = [];
      let made = 0;
      for (const { i } of cands) {
        if (made >= 4) break;
        if (used.some((j) => Math.hypot(g.x[i] - g.x[j], g.z[i] - g.z[j]) < 5)) continue;
        const p = A.makePed(gid, A.population.pedGroups[gid], g.x[i], g.y[i], g.z[i], i, -1, { yaw: 0, point: -1, slot: 0, count: 1, action: 'wait', dur: 600, type: 'corner' });
        if (p) { used.push(i); made++; }
      }
      return { n: A.count, made };
    });
    expect(r.n > 10, `${r.n} ambient pedestrians`);
    expect(r.made === 4, `${r.made} bystanders placed`);
    heroId = (await st()).car.id;
    return `${r.n} people about`;
  });
  await check('pulling the driver out gets a report from a bystander', async () => {
    expect(await walkToDriverDoor(page, heroId), 'did not reach the door');
    await tap('KeyE');
    await until(page, (x) => x.inCar, 5000, 'the player to be in the car');
    // (calls take 8 to 20 s; of the five or six witnesses a few call)
    await page.waitForFunction(() => window.__events.some((e) => e.type === 'crime:reported' && !e.police), null, { timeout: 35000 });
    await wait(12000);
    const r = await page.evaluate(() => {
      const jack = window.__events.find((e) => e.type === 'carjack');
      const crime = window.__events.find((e) => e.type === 'crime' && e.crime === 'carjack');
      const reports = window.__events.filter((e) => e.type === 'crime:reported' && !e.police);
      return { victim: jack.victimId, witnesses: crime.witnesses, reporters: reports.map((x) => x.reporterId), me: window.__hood.game.view.ped.id };
    });
    expect(r.witnesses >= 3, `${r.witnesses} witnesses`);
    const bystanders = r.reporters.filter((id) => id !== r.victim && id !== r.me);
    expect(bystanders.length >= 1, `reporters ${JSON.stringify(r.reporters)} (victim ${r.victim})`);
    return `${r.witnesses} witnesses, ${r.reporters.length} calls, ${bystanders.length} from bystanders`;
  });
  await check('the bystanders ran, or cowered, or filmed it', async () => {
    const n = await page.evaluate(() => window.__events.filter((e) => e.type === 'ped:react').length);
    expect(n >= 1, `${n} reactions`);
    return `${n} reactions`;
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}

// ------------------------------------------------------------------------------------------------
// Damage, crime, heat and the police

/**
 * Melee, the carjack's heat, running a ped over, and getting busted, with real key presses. The sim runs on the
 * main thread (loopback) so a scene can be set up through it: peds placed, a report raised. `kind` is the ground:
 * 'baked' is the real Five Points tile (the police need its streets, so only it checks the arrest), 'procedural'
 * the flat test ground.
 */
async function lawSuite(kind) {
  console.log(`--- law and damage (${kind})`);
  const tile = kind === 'procedural' ? 'tile=none&' : '';
  // (scripted scenes: no ambient crowd to witness them or get in the way)
  const base = `${tile}graphics=low&transport=loopback&ambient=0`;
  const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  const hud = (page) => page.evaluate(HUD);
  const untilHud = async (page, cond, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      const h = await hud(page);
      if (cond(h)) return h;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label} (hud ${JSON.stringify(h)})`);
      await page.waitForTimeout(WAIT_STEP);
    }
  };
  let fails = 0;

  // ---- melee on an NPC
  {
    const { page, errors, ctx } = await open(`${base}&driver=flee&parked=0`);
    const c = makeChecker(page, `melee-${kind}`);
    const { check, tap, wait, st, expect } = c;
    await wait(800);
    await installEventLog(page);
    let npcId = 0;
    await check('an NPC stands a step ahead', async () => {
      npcId = await sim(page, (S) => {
        const p = S.registry.get(S.playerPedId).controller;
        const x = p.x + Math.sin(p.yaw) * 1.3;
        const z = p.z + Math.cos(p.yaw) * 1.3;
        const n = S.addPed(x, S.groundAt(x, z), z, p.yaw + Math.PI, 3, true);
        n.brain.enter('idle');
        return n.id;
      });
      await wait(400);
      const s = await st();
      expect(s.peds.some((p) => p.id === npcId), 'the NPC is not in the world');
    });
    await check('the HUD shows full health and no stars', async () => {
      const h = await hud(page);
      expect(h.health === 100, `health bar ${h.health}%`);
      expect(!h.starsVisible && h.heat === 0, `stars ${JSON.stringify(h)}`);
    });
    await check('Q punches: the NPC takes damage and goes down', async () => {
      await tap('KeyQ');
      await wait(500);
      const s = await st();
      const n = s.peds.find((p) => p.id === npcId);
      expect((n.flags & 256) !== 0, `NPC flags ${n.flags} (not downed)`);
      const swing = await page.evaluate(() => window.__events.filter((e) => e.type === 'melee:swing').length);
      const dmg = await page.evaluate(() => window.__events.filter((e) => e.type === 'damage'));
      expect(swing === 1, `${swing} swings`);
      expect(dmg.length === 1 && dmg[0].kind === 'melee' && dmg[0].health === 80, `damage events ${JSON.stringify(dmg)}`);
      return `damage ${dmg[0].amount}, health left ${dmg[0].health}`;
    });
    await check('it gets back up after a couple of seconds', async () => {
      await page.waitForFunction(() => window.__events.some((e) => e.type === 'ped:up'), null, { timeout: 6000 });
    });
    await check('punching again right away is on cooldown, a second later it lands', async () => {
      const before = await page.evaluate(() => window.__events.filter((e) => e.type === 'melee:swing').length);
      await tap('KeyQ');
      await tap('KeyQ');
      const mid = await page.evaluate(() => window.__events.filter((e) => e.type === 'melee:swing').length);
      expect(mid - before <= 1, `${mid - before} swings in two taps`);
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- a carjack puts stars in the HUD
  {
    const { page, errors, ctx } = await open(`${base}&driver=flee&parked=0`);
    const c = makeChecker(page, `jack-heat-${kind}`);
    const { check, tap, wait, st, expect } = c;
    await wait(800);
    await installEventLog(page);
    const hero = (await st()).car;
    await check('no stars before the crime', async () => {
      const h = await hud(page);
      expect(!h.starsVisible && h.heat === 0, JSON.stringify(h));
    });
    await check('carjack, and 8 to 20 s later the victim calls it in: one hollow star', async () => {
      // (the victim's call is a roll: this scene wants it to happen)
      await sim(page, (S) => { S.law.rules.victimCallChance = 1; });
      expect(await walkToDriverDoor(page, hero.id), 'did not reach the door');
      await tap('KeyE');
      await until(page, (s) => s.inCar, 5000, 'the player to be in the car');
      const crime = await page.evaluate(() => window.__events.filter((e) => e.type === 'crime'));
      expect(crime.length === 1 && crime[0].crime === 'carjack', `crime events ${JSON.stringify(crime.map((e) => e.crime))}`);
      expect(/^[A-Z]{3}\d{4}$/.test(crime[0].description.vehicle?.plate ?? ''), `plate ${crime[0].description.vehicle?.plate}`);
      const h = await untilHud(page, (x) => x.heat >= 1, 32000, 'a star');
      expect(h.starsVisible, 'stars hidden');
      expect(h.phase === 'reported' || h.phase === 'seen', `phase ${h.phase}`);
      if (h.phase === 'reported') expect(h.starFill === 'none' || /rgba\(0, 0, 0, 0\)|transparent/.test(h.starFill), `hollow star has fill ${h.starFill}`);
      return `heat ${h.heat} (${h.phase})`;
    });
    await check('the call is a crime:reported event from the victim', async () => {
      const rep = await page.evaluate(() => window.__events.filter((e) => e.type === 'crime:reported'));
      const jack = await page.evaluate(() => window.__events.find((e) => e.type === 'carjack'));
      expect(rep.length === 1 && rep[0].reporterId === jack.victimId, JSON.stringify(rep));
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- running a ped over is heat 2
  {
    const { page, errors, ctx } = await open(`${base}&start=car&parked=0`);
    const c = makeChecker(page, `runover-${kind}`);
    const { check, tap, wait, st, expect, k } = c;
    await wait(800);
    await installEventLog(page);
    await check('in the car, a pedestrian ahead on the road and a witness off to the side', async () => {
      await tap('KeyE');
      await wait(400);
      expect((await st()).inCar, 'not in the car');
      await sim(page, (S) => {
        // (a witness's call is a roll: this scene wants it to happen)
        S.law.rules.callChance = 1;
        const v = S.registry.get(S.vehicleId);
        const p = v.car.pose();
        const f = { x: Math.sin(v.car.yaw), z: Math.cos(v.car.yaw) };
        const l = { x: Math.cos(v.car.yaw), z: -Math.sin(v.car.yaw) };
        const at = (d, side) => ({ x: p.x + f.x * d + l.x * side, z: p.z + f.z * d + l.z * side });
        const a = at(8.5, 0);
        const victim = S.addPed(a.x, S.groundAt(a.x, a.z), a.z, 0, 4, true);
        victim.brain.enter('idle');
        const b = at(14, 9);
        const witness = S.addPed(b.x, S.groundAt(b.x, b.z), b.z, 0, 2, true);
        witness.brain.enter('idle');
        window.__victim = victim.id;
      });
      // let the theft of the empty car (nobody saw it from there) pass
      await wait(300);
    });
    await check('driving into the pedestrian hurts them and is a hit_ped, heat 2', async () => {
      await k.down('KeyW');
      await page.waitForFunction(() => window.__events.some((e) => e.type === 'damage' && e.kind === 'vehicle'), null, { timeout: 8000 });
      await k.up('KeyW');
      await k.down('KeyS');
      await wait(900);
      await k.up('KeyS');
      const d = await page.evaluate(() => window.__events.find((e) => e.type === 'damage' && e.kind === 'vehicle'));
      expect(d.amount > 15 && d.sourceId > 0, `damage ${JSON.stringify(d)}`);
      const h = await untilHud(page, (x) => x.heat >= 2, 32000, 'two stars');
      expect(h.heat === 2, `heat ${h.heat}`);
      const crimes = await page.evaluate(() => window.__events.filter((e) => e.type === 'crime').map((e) => e.crime));
      expect(crimes.includes('hit_ped'), `crimes ${crimes}`);
      return `damage ${Math.round(d.amount)}, ${h.heat} stars (${h.phase}), crimes ${crimes}`;
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- busted
  if (kind === 'baked') {
    const { page, errors, ctx } = await open(`${base}&parked=0`);
    const c = makeChecker(page, `busted-${kind}`);
    const { check, wait, st, expect } = c;
    await wait(800);
    await installEventLog(page);
    await check('a reported crime, then a police car arrives and an officer gets out', async () => {
      await sim(page, (S) => {
        const p = S.playerPosition();
        S.law.heat.report(1, 2, p.x, p.z);
      });
      const s = await until(page, (x) => x.cars.some((car) => (car.flags & 2048) !== 0), 40000, 'a police car');
      const cop = s.cars.find((car) => (car.flags & 2048) !== 0);
      expect((cop.flags & 4096) !== 0, 'lightbar off');
      const hh = await hud(page);
      expect(hh.starsVisible && hh.heat === 1, JSON.stringify(hh));
      await page.waitForFunction(() => window.__events.some((e) => e.type === 'police:dismount'), null, { timeout: 75000 });
    });
    await check('standing still within reach for two seconds: BUSTED', async () => {
      await page.waitForFunction(() => window.__events.some((e) => e.type === 'player:busted'), null, { timeout: 40000 });
      const h = await untilHud(page, (x) => x.overlay === 'BUSTED', 3000, 'the BUSTED screen');
      expect(h.overlay === 'BUSTED', h.overlay);
    });
    await check('then back at the spawn with the heat gone', async () => {
      await page.waitForFunction(() => window.__events.some((e) => e.type === 'player:respawn' && e.reason === 'busted'), null, { timeout: 8000 });
      const h = await untilHud(page, (x) => x.heat === 0 && !x.starsVisible && x.overlay === '', 4000, 'the heat to clear');
      const s = await st();
      const sp = await sim(page, (S) => S.tile.manifest.spawns.player);
      expect(Math.hypot(s.ped.x - sp.x, s.ped.z - sp.z) < 3, `respawned ${Math.hypot(s.ped.x - sp.x, s.ped.z - sp.z).toFixed(1)} m from the spawn`);
      expect(h.health === 100, `health ${h.health}`);
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- the flashing stars
  {
    const { page, ctx } = await open(`${base}&parked=0`);
    const c = makeChecker(page, `stars-${kind}`);
    const { check, wait, expect } = c;
    await wait(600);
    await check('stars are hollow when reported, solid when seen, and flash when lost', async () => {
      await sim(page, (S) => { const p = S.playerPosition(); S.law.heat.report(3, 3, p.x, p.z); });
      await wait(400);
      const reported = await hud(page);
      expect(reported.heat === 3 && reported.phase === 'reported', JSON.stringify(reported));
      expect(reported.starFill === 'none' || /rgba\(0, 0, 0, 0\)|transparent/.test(reported.starFill), `reported fill ${reported.starFill}`);
      await sim(page, (S) => { const p = S.playerPosition(); S.law.heat.sight(p.x, p.z); });
      await wait(400);
      const seen = await hud(page);
      expect(seen.phase === 'seen' && /255, 210, 74/.test(seen.starFill), JSON.stringify(seen));
      await sim(page, (S) => S.law.heat.step(2, false));
      await wait(200);
      const seenOpacity = new Set();
      for (let i = 0; i < 24; i++) {
        const h = await hud(page);
        expect(h.phase === 'lost', `phase ${h.phase}`);
        seenOpacity.add(h.starFillOpacity > 0.5 ? 'on' : 'off');
        await wait(70);
      }
      expect(seenOpacity.size === 2, `the stars did not flash (${[...seenOpacity]})`);
    });
    await ctx.close();
    fails += c.fails();
  }
  return fails;
}

// ------------------------------------------------------------------------------------------------
// Guns: switch weapon, aim and fire at a ped, reload, a gamepad aim with lock-on, cover, a drive-by, and the touch buttons

async function gunSuite() {
  console.log('\n=== guns ===');
  const qs = 'tile=none&graphics=low&transport=loopback&ambient=0&traffic=0&parked=0';
  const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  const game = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game, ${JSON.stringify(arg ?? null)})`);
  const aim = (page) => game(page, (g) => ({ active: g.aim.active, weapon: g.aim.weapon?.id ?? null, mag: g.aim.mag, reserve: g.aim.reserve, lock: g.aim.lock, reload: g.aim.reload, inCover: g.aim.inCover, crouched: g.aim.crouched, fov: g.camera.fov, owned: g.aim.owned }));
  const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);
  /** Looks along +Z (a camera at yaw PI) and stands a ped ahead: `dist` metres on, `side` metres to the camera's right. */
  const look = (page) => game(page, (g) => { g.cameraRig.yaw = Math.PI; g.cameraRig.pitch = 0; });
  const putNpc = (page, dist, side) => sim(page, (S, a) => {
    const c = S.registry.get(S.playerPedId).controller;
    // The camera's right at yaw PI is -X; it looks along +Z.
    const x = c.x - a.side;
    const z = c.z + a.dist;
    const n = S.addPed(x, S.groundAt(x, z), z, Math.PI, 3, true);
    n.brain.enter('idle');
    return n.id;
  }, { dist, side });
  const healthOf = (page, id) => sim(page, (S, i) => { const n = S.registry.get(i); return n ? { health: n.health, life: n.life } : null; }, id);
  const SHOULDER = 0.85;
  let fails = 0;

  // ---- the keyboard
  {
    const { page, errors, ctx } = await open(`${qs}&weapons=all&driver=flee`);
    const c = makeChecker(page, 'guns-keys');
    const { check, tap, wait, expect, k } = c;
    await wait(800);
    await installEventLog(page);
    await look(page);
    await page.keyboard.press('KeyH');
    await check('starts armed: a pistol with a full magazine and spare rounds', async () => {
      const a = await aim(page);
      expect(a.weapon === 'pistol', `weapon ${a.weapon}`);
      // The player's spare rounds never run out (weapons.json player.infiniteReserve): 255 in the snapshot, ∞ on the HUD.
      expect(a.mag === 12 && a.reserve === 255, `ammo ${a.mag} / ${a.reserve}`);
      const res = await page.evaluate(() => document.querySelector('.gun-ammo .res')?.textContent);
      expect(res === '/ ∞', `HUD reserve shows ${res}`);
      expect(a.owned === 15, `owned mask ${a.owned} (?weapons=all)`);
      const hud = await page.evaluate(() => document.querySelector('.gun-ammo .mag')?.textContent);
      expect(hud === '12', `HUD shows ${hud}`);
    });
    await check('number keys switch weapon, the brackets and the wheel (aiming) cycle', async () => {
      for (const [key, id] of [['Digit2', 'smg'], ['Digit3', 'shotgun'], ['Digit4', 'rifle'], ['Digit1', 'pistol']]) {
        await tap(key);
        await wait(150);
        expect((await aim(page)).weapon === id, `${key} gave ${(await aim(page)).weapon}, wanted ${id}`);
      }
      await tap('BracketRight');
      await wait(150);
      expect((await aim(page)).weapon === 'smg', '] did not go to the next weapon');
      await tap('BracketLeft');
      await wait(150);
      expect((await aim(page)).weapon === 'pistol', '[ did not go back');
      // The wheel zooms the camera, except while aiming, when it changes weapon.
      await k.down('KeyZ');
      await wait(250);
      await page.mouse.move(500, 300);
      await page.mouse.wheel(0, 240);
      await wait(300);
      const w = (await aim(page)).weapon;
      await k.up('KeyZ');
      expect(w === 'smg', `scrolling while aiming gave ${w}`);
      await tap('Digit1');
      await wait(700);
    });
    await check('Z aims: the camera narrows its view, the crosshair appears, the player raises the gun', async () => {
      const before = await aim(page);
      await k.down('KeyZ');
      await wait(600);
      const a = await aim(page);
      const x = await page.evaluate(() => document.querySelector('.xhair')?.classList.contains('on'));
      const flag = await page.evaluate((id) => !!(window.__hood.game.view.entities.get(id).flags & (1 << 14)), await sim(page, (S) => S.playerPedId));
      await k.up('KeyZ');
      expect(a.active && !before.active, 'the aim camera did not come up');
      expect(a.fov < before.fov - 8, `fov ${before.fov} -> ${a.fov}`);
      expect(x, 'no crosshair');
      expect(flag, 'the ped is not aiming in the snapshot');
      await wait(500);
      expect(!(await aim(page)).active, 'the camera stayed in aim mode');
      return `fov ${before.fov.toFixed(0)} -> ${a.fov.toFixed(0)}`;
    });
    let npc = 0;
    await check('aim and fire at a ped: it takes damage from a bullet, the magazine counts down, the ped flinches or falls', async () => {
      // (a witness's call is a roll: this scene wants it to happen)
      await sim(page, (S) => { S.law.rules.callChance = S.law.rules.victimCallChance = S.law.rules.heardCallChance = 1; });
      npc = await putNpc(page, 12, SHOULDER);
      await wait(300);
      await look(page);
      await k.down('KeyZ');
      await wait(700);
      await tap('KeyG');
      await wait(300);
      await k.up('KeyZ');
      const fires = await events(page, 'weapon:fire');
      const dmg = (await events(page, 'damage')).filter((d) => d.kind === 'bullet' && d.targetId === npc);
      const a = await aim(page);
      expect(fires.length === 1, `${fires.length} shots`);
      expect(dmg.length >= 1, `no bullet damage on the ped (impacts ${JSON.stringify(fires[0]?.impacts?.map((i) => i.kind))})`);
      expect(a.mag === 11, `magazine ${a.mag}`);
      const n = await healthOf(page, npc);
      expect(n.health < 100, `health ${n.health}`);
      return `damage ${dmg[0].amount}, ped health ${n.health.toFixed(0)}, ${a.mag} / ${a.reserve}`;
    });
    await check('the shot is a crime: the stars come up once someone calls it in', async () => {
      await page.waitForFunction(() => window.__hood.game.view.heat >= 1, null, { timeout: 32000 });
    });
    await check('T reloads: the click, the bar, then a full magazine from the spare rounds', async () => {
      // Two shots first, then T at once (a part magazine also reloads by itself after a pause in the shooting).
      await tap('KeyG');
      await wait(350);
      await tap('KeyG');
      await wait(250);
      const before = await aim(page);
      await tap('KeyT');
      await wait(400);
      const mid = await aim(page);
      await wait(1500);
      const after = await aim(page);
      expect(before.mag < 12, `magazine was ${before.mag}`);
      expect(mid.reload > 0 && mid.reload < 1, `reload progress ${mid.reload}`);
      expect(after.mag === 12 && after.reload === 0, `after: ${after.mag} reload ${after.reload}`);
      expect(before.reserve === 255 ? after.reserve === 255 : after.reserve === before.reserve - (12 - before.mag), `reserve ${before.reserve} -> ${after.reserve}`);
      expect((await events(page, 'weapon:reload')).length >= 1, 'no weapon:reload event');
    });
    await check('the SMG fires on while the key is held, and bloom widens the crosshair', async () => {
      await tap('Digit2');
      await wait(800);
      await look(page);
      await k.down('KeyZ');
      await wait(500);
      const gap0 = await page.evaluate(() => parseFloat(document.querySelector('.xhair').style.getPropertyValue('--gap')));
      const f0 = (await events(page, 'weapon:fire')).length;
      await k.down('KeyG');
      await wait(700);
      const gap1 = await page.evaluate(() => parseFloat(document.querySelector('.xhair').style.getPropertyValue('--gap')));
      await k.up('KeyG');
      await k.up('KeyZ');
      const n = (await events(page, 'weapon:fire')).length - f0;
      expect(n >= 5, `${n} shots in 0.7 s`);
      expect(gap1 > gap0, `crosshair gap ${gap0} -> ${gap1}`);
      return `${n} shots, gap ${gap0}px -> ${gap1}px`;
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- a pad: LT aims and a threat near the crosshair is locked, RT fires and hits it; the mouse gets almost none of that help
  {
    const { page, errors, ctx } = await open(`${qs}&driver=flee`, true);
    const c = makeChecker(page, 'guns-pad');
    const { check, wait, expect, k } = c;
    const trigger = (i, v) => page.evaluate(([i, v]) => { window.__pad.buttons[i] = { pressed: v > 0.5, touched: v > 0, value: v }; }, [i, v]);
    const press = (i, on) => page.evaluate(([i, on]) => { window.__pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; }, [i, on]);
    await wait(800);
    await installEventLog(page);
    await look(page);
    await page.keyboard.press('KeyH');
    // A ped about 9 degrees off the crosshair: far outside what a mouse would be pulled to.
    const npc = await putNpc(page, 20, SHOULDER + 3.2);
    await wait(500);
    await check('LT aims; a pad wakes the strong lock-on and marks the target', async () => {
      await trigger(6, 1);
      await wait(900);
      const a = await aim(page);
      const marker = await page.evaluate(() => document.querySelector('.gun-lock')?.classList.contains('on'));
      expect(a.active, 'LT did not aim');
      expect(a.lock === npc, `locked ${a.lock}, wanted ${npc}`);
      expect(marker, 'no lock-on marker on screen');
    });
    await check('RT fires and the lock-on carries the shot to the target', async () => {
      await trigger(7, 1);
      await wait(120);
      await trigger(7, 0);
      await wait(400);
      const dmg = (await events(page, 'damage')).filter((d) => d.kind === 'bullet' && d.targetId === npc);
      expect(dmg.length >= 1, 'the shot missed the locked target');
    });
    await check('X while aiming reloads; D-pad right draws the next weapon; LT up lowers the gun', async () => {
      await wait(500);
      await press(2, true);
      await wait(120);
      await press(2, false);
      await wait(300);
      expect((await events(page, 'weapon:reload')).length >= 1, 'X did not reload');
      await trigger(6, 0);
      await wait(1800);
      const owned = (await aim(page)).weapon;
      await press(15, true);
      await wait(120);
      await press(15, false);
      await wait(300);
      // Only the pistol is carried (no ?weapons=all here), so the cycle stays put.
      expect((await aim(page)).weapon === owned, 'the weapon changed with only one carried');
      expect(!(await aim(page)).active, 'still aiming after LT came up');
    });
    await check('with the mouse and keys the same target 9 degrees away is not locked', async () => {
      await k.down('KeyZ');
      await wait(700);
      const a = await aim(page);
      await k.up('KeyZ');
      expect(a.lock === 0, `locked ${a.lock} on a keyboard`);
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- cover: X at a wall crouches behind the low one on the test ground, Z stands up over it, X leaves
  {
    const { page, errors, ctx } = await open(`${qs}&driver=flee`);
    const c = makeChecker(page, 'guns-cover');
    const { check, tap, wait, expect, k } = c;
    await wait(800);
    await installEventLog(page);
    await page.keyboard.press('KeyH');
    // The test ground has a 1 m wall at (-14, 10), 6 m long, 0.6 m thick: stand 1.5 m south of it.
    await sim(page, (S) => { S.registry.get(S.playerPedId).controller.teleport(-14, 0.1, 8.2, 0); });
    await look(page);
    await wait(500);
    await check('X at a low wall crouches behind it', async () => {
      await tap('KeyX');
      await wait(500);
      const a = await aim(page);
      expect(a.crouched && !a.inCover, `crouched ${a.crouched} inCover ${a.inCover}`);
      expect((await events(page, 'cover:enter')).length === 1, 'no cover:enter');
      const prompt = await page.evaluate(() => document.querySelector('.gun-cover')?.textContent);
      expect(/In cover/.test(prompt), `prompt "${prompt}"`);
    });
    await check('A and D slide along the wall, and it stops at the end', async () => {
      const x0 = (await page.evaluate(STATE)).ped.x;
      await k.down('KeyD');
      await wait(1200);
      await k.up('KeyD');
      const x1 = (await page.evaluate(STATE)).ped.x;
      const z1 = (await page.evaluate(STATE)).ped.z;
      expect(Math.abs(x1 - x0) > 0.8, `moved ${(x1 - x0).toFixed(2)} m along the wall`);
      expect(Math.abs(z1 - 9.28) < 0.3, `drifted off the wall to z ${z1.toFixed(2)} (its face is at 9.7)`);
      await k.down('KeyD');
      await wait(5000);
      await k.up('KeyD');
      const x2 = (await page.evaluate(STATE)).ped.x;
      expect(x2 > -17.3 && x2 < -10.7, `walked off the wall's end to x ${x2.toFixed(2)}`);
    });
    await check('Z stands up to shoot over the wall (the crouch ends while aiming)', async () => {
      await look(page);
      await k.down('KeyZ');
      await wait(600);
      const a = await aim(page);
      await k.up('KeyZ');
      expect(a.active && !a.crouched && a.inCover === false, `aim ${JSON.stringify(a)}`);
      await wait(400);
      expect((await aim(page)).crouched, 'did not crouch again after lowering the gun');
    });
    await check('X leaves cover', async () => {
      await tap('KeyX');
      await wait(400);
      const a = await aim(page);
      expect(!a.crouched && !a.inCover, 'still in cover');
      expect((await events(page, 'cover:exit')).length === 1, 'no cover:exit');
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- a drive-by: Z from the driver's seat with a pistol; a rifle will not come out
  {
    const { page, errors, ctx } = await open(`${qs}&start=car&weapons=all`);
    const c = makeChecker(page, 'guns-driveby');
    const { check, tap, wait, expect, k } = c;
    await wait(800);
    await installEventLog(page);
    await page.keyboard.press('KeyH');
    await tap('KeyE');
    await wait(500);
    await check('in the car, aim brings up the camera inside the cabin', async () => {
      expect((await page.evaluate(STATE)).inCar, 'not in the car');
      await k.down('KeyZ');
      await wait(700);
      const a = await aim(page);
      await k.up('KeyZ');
      expect(a.active, 'no aim camera from the car');
      expect(a.fov < 55, `fov ${a.fov}`);
    });
    await check('a drive-by shoots out of the window at a ped beside the car', async () => {
      // Put a ped 8 m off the car's right and aim along the line to it.
      const id = await sim(page, (S) => {
        const v = S.registry.get(S.vehicleId);
        const q = v.car.pose();
        const rx = -(1 - 2 * (q.q.y * q.q.y + q.q.z * q.q.z));
        const rz = -(2 * (q.q.x * q.q.z - q.q.w * q.q.y));
        const x = q.x + rx * 8;
        const z = q.z + rz * 8;
        const n = S.addPed(x, S.groundAt(x, z), z, 0, 3, true);
        n.brain.enter('idle');
        return n.id;
      });
      await wait(400);
      await game(page, (g, id) => {
        const S = g.transport.host.simulation;
        const n = S.registry.get(id).controller;
        const p = S.registry.get(S.playerPedId).controller;
        g.cameraRig.yaw = Math.atan2(-(n.x - p.x), -(n.z - p.z));
        g.cameraRig.pitch = Math.atan2(n.y + 1.2 - (p.y + 1.35), Math.hypot(n.x - p.x, n.z - p.z));
      }, id);
      await k.down('KeyZ');
      await wait(700);
      await tap('KeyG');
      await wait(300);
      await k.up('KeyZ');
      const fires = await events(page, 'weapon:fire');
      const dmg = (await events(page, 'damage')).filter((d) => d.kind === 'bullet' && d.targetId === id);
      expect(fires.length >= 1, 'no shot from the car');
      expect(dmg.length >= 1, `the drive-by missed (impacts ${JSON.stringify(fires[0]?.impacts?.map((i) => i.kind))})`);
    });
    await check('a rifle will not come out of the window, and a held aim draws the pistol or SMG instead', async () => {
      await tap('Digit4');
      await wait(400);
      expect((await aim(page)).weapon !== 'rifle', 'the rifle was drawn in a car');
      await tap('Digit3');
      await wait(400);
      expect((await aim(page)).weapon !== 'shotgun', 'the shotgun was drawn in a car');
      await tap('Digit2');
      await wait(400);
      expect((await aim(page)).weapon === 'smg', 'the SMG is allowed from a car');
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- a touch screen: the gun buttons, aim as a toggle, fire with a lock-on
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 480 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}?${qs}&driver=flee`);
    await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
    const c = makeChecker(page, 'guns-touch');
    const { check, wait, expect } = c;
    await wait(800);
    await installEventLog(page);
    await look(page);
    const centre = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
    const tapBtn = async (sel) => { const p = await centre(sel); await page.touchscreen.tap(p.x, p.y); };
    const npc = await putNpc(page, 14, SHOULDER + 2.4);
    await wait(500);
    await check('the touch screen shows the gun buttons', async () => {
      for (const sel of ['.b-fire', '.b-aim', '.b-reload', '.b-weapon', '.b-cover']) expect(await page.evaluate((s) => !!document.querySelector(s) && document.querySelector(s).offsetWidth > 0, sel), `${sel} is not on screen`);
    });
    await check('Aim is a toggle: a tap raises the gun and a tap lowers it', async () => {
      await tapBtn('.b-aim');
      await wait(700);
      expect((await aim(page)).active, 'the aim button did not raise the gun');
      expect(await page.evaluate(() => document.querySelector('.b-aim').classList.contains('on')), 'the button does not show it is on');
    });
    await check('Fire with the finger lock-on hits a ped a few degrees off the crosshair', async () => {
      await tapBtn('.b-fire');
      await wait(500);
      const dmg = (await events(page, 'damage')).filter((d) => d.kind === 'bullet' && d.targetId === npc);
      expect(dmg.length >= 1, 'the lock-on did not carry the shot');
      expect((await aim(page)).lock === npc, 'no lock');
    });
    await check('Reload works from its button, and a second tap on Aim lowers the gun', async () => {
      await tapBtn('.b-reload');
      await wait(300);
      expect((await events(page, 'weapon:reload')).length >= 1, 'no reload');
      await tapBtn('.b-aim');
      await wait(500);
      expect(!(await aim(page)).active, 'the gun is still up');
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }
  return fails;
}

// ------------------------------------------------------------------------------------------------
// The police escalation: a roadblock and a helicopter at heat 3, a PIT on the freeway, being shot at

/**
 * On the baked tile with the sim on the main thread, stepped by hand (`host.advance`) so each scene is exact: the player's car is driven
 * by commands through the real input path (`host.input`: throttle, brake and steer axes from the police's own route prediction), and what
 * the client sees (the entities and flags of its interpolated view, the HUD) is read back from the page.
 */
async function policeSuite() {
  console.log('\n=== police escalation ===');
  if (!existsSync(resolve(root, 'public/tiles/atlanta/m1-five-points/tile.json'))) {
    console.log('(no baked tile in public/tiles: skipping)');
    return 0;
  }
  const qs = 'graphics=low&transport=loopback&ambient=0&traffic=0&parked=0&time=14:00&timescale=0';
  const sim = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host, window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  const bot = () => {
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
        S.registry.get(S.playerPedId).armour = 1e9;
      },
      run(host, S, ticks, until) {
        for (let i = 0; i < ticks; i++) {
          this.step(host, S);
          if (until && until()) return i;
        }
        return -1;
      },
      park(host, S, ticks) {
        for (let i = 0; i < ticks; i++) {
          host.input({ tick: ++this.n, buttons: 8, axes: [0, 0, 0, 0, 0, 0, 0, 14, 0] });
          host.advance(1);
        }
      },
    };
  };
  const sceneOpen = async (extra = '') => {
    const o = await open(`${qs}${extra}`);
    await o.page.evaluate(() => window.__hood.game.transport.host.stop());
    await o.page.evaluate(bot);
    await installEventLog(o.page);
    return o;
  };
  const getIn = async (page) => {
    await page.keyboard.down('KeyE');
    await page.waitForTimeout(100);
    await page.keyboard.up('KeyE');
    await sim(page, (host) => host.advance(40));
  };
  let fails = 0;

  // ---- heat 3: a roadblock laid ahead of the car, and a helicopter overhead
  {
    const { page, errors, ctx } = await sceneOpen('&start=car');
    const c = makeChecker(page, 'police-heat3');
    const { check, wait, expect } = c;
    await getIn(page);
    let info = null;
    await check('heat 3 with the police in sight: a roadblock is laid 150 to 250 m ahead, out of view', async () => {
      info = await sim(page, (host, S) => {
        S.police.spikes.enabled = true;
        const p = S.registry.get(S.playerPedId).controller;
        S.law.heat.report(3, 4, p.x, p.z, true);
        // wait where they are until the police arrive and see them, then go
        for (let i = 0; i < 60 * 70 && !S.police.seesPlayer; i += 10) window.__bot.park(host, S, 10);
        window.__bot.speed = 13;
        let at = null;
        const t = window.__bot.run(host, S, 60 * 50, () => {
          const b = S.police.roadblocks.blocks[0];
          if (b && !at) {
            // how far along the route the player is on it (the nearest point of the predicted route to the block)
            const pl = S.police.predicted();
            let along = -1;
            if (pl) {
              let best = Infinity;
              for (let k = 0; k < pl.pts.length; k++) {
                const d = Math.hypot(pl.pts[k].x - b.x, pl.pts[k].z - b.z);
                if (d < best) {
                  best = d;
                  along = pl.cum[k];
                }
              }
            }
            const q = S.registry.get(S.vehicleId).car.pose();
            at = { straight: Math.hypot(b.x - q.x, b.z - q.z), along, cars: b.unitIds.length };
          }
          return !!at;
        });
        // The air unit is scrambled about 30 s after the third star, so keep driving until it is up.
        window.__bot.run(host, S, 60 * 40, () => S.police.heli.count >= 1);
        return { t, at, seen: S.police.seesPlayer };
      });
      expect(info.at, `no roadblock within 50 s (${JSON.stringify(info)})`);
      const d = info.at.along;
      expect(d > 145 && d < 260, `laid ${d.toFixed(0)} m along the route (${info.at.straight.toFixed(0)} m in a straight line)`);
      expect(info.at.cars >= 1 && info.at.cars <= 3, `${info.at.cars} cars`);
      return `${d.toFixed(0)} m along the route (${info.at.straight.toFixed(0)} m straight), ${info.at.cars} cars`;
    });
    await wait(700);
    await check('the client has the roadblock: flagged cars with officers behind them, a spike strip, the counts in the header', async () => {
      const v = await page.evaluate(() => {
        const g = window.__hood.game;
        const ents = [...g.view.entities.values()];
        return { blockCars: ents.filter((e) => e.kind === 2 && (e.flags & (1 << 14)) !== 0).length, strips: ents.filter((e) => e.kind === 4).length, header: { rb: g.view.roadblocks, he: g.view.helicopters, st: g.view.strips } };
      });
      expect(v.blockCars >= 1, `no roadblock car flagged in the client's view (${JSON.stringify(v)})`);
      expect(v.header.rb >= 1, `header roadblocks ${v.header.rb}`);
      return `${v.blockCars} cars, ${v.strips} strips, header ${JSON.stringify(v.header)}`;
    });
    await check('the helicopter came about 30 s after the third star, not at once', async () => {
      const r = await page.evaluate(() => {
        const ev = window.__events;
        const three = ev.find((e) => e.type === 'heat:change' && e.level === 3);
        const heli = ev.find((e) => e.type === 'police:helicopter' && e.state === 'inbound');
        return { three: three?.tick, heli: heli?.tick };
      });
      expect(r.three !== undefined && r.heli !== undefined, JSON.stringify(r));
      const s = (r.heli - r.three) / 60;
      expect(s >= 24 && s <= 36, `${s.toFixed(1)} s after heat 3`);
      return `${s.toFixed(1)} s after heat 3`;
    });
    await check('a helicopter is up, kinematic, drawn from the snapshot with its definition', async () => {
      const v = await page.evaluate(() => {
        const g = window.__hood.game;
        const h = [...g.view.entities.values()].find((e) => e.kind === 3);
        return h && { agl: h.aux1, def: g.view.defs.get(h.id)?.typeId, header: g.view.helicopters };
      });
      expect(v, 'no helicopter entity in the client view');
      expect(v.def === 'helicopter' && v.header >= 1, JSON.stringify(v));
      return `agl ${v.agl.toFixed(0)} m`;
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- a PIT by the Highway Patrol on the freeway
  {
    const { page, errors, ctx } = await sceneOpen('&start=car');
    const c = makeChecker(page, 'police-pit');
    const { check, wait, expect } = c;
    await getIn(page);
    await check('on the freeway the Highway Patrol (GHP) runs alongside, matches speed and PITs: the car is spun', async () => {
      const r = await sim(page, (host, S) => {
        const v = S.registry.get(S.vehicleId);
        // The Downtown Connector northbound at (842, -734) (osm:way/337901445), where this check has always run. It used to take the
        // longest straight motorway in roads.json, and a bake that turned a bridge the pipeline made into an embankment made that the
        // southbound Connector at (781, 387): seven lanes beside a diverging exit ramp, where the cruiser, put down at 19 m/s on the
        // centreline, takes its route onto the ramp at full lock and spins off the road before it ever gets alongside (a set-up the
        // game does not make: a patrol car joins the motorway from a lane). Falls back to the old rule on a tile without that way.
        const motorways = S.tile.roads.filter((x) => x.class === 'motorway' && !x.bridge && x.points.length > 6);
        const rd = motorways.find((x) => x.id === 'osm:way/337901445') ?? motorways.sort((a, b) => Math.hypot(b.points[b.points.length - 1][0] - b.points[0][0], b.points[b.points.length - 1][2] - b.points[0][2]) - Math.hypot(a.points[a.points.length - 1][0] - a.points[0][0], a.points[a.points.length - 1][2] - a.points[0][2]))[0];
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
        let maxDev = 0;
        let alignAtStrike = -1;
        window.__bot.run(host, S, 60 * 20, () => {
          if (u.pit?.struck && alignAtStrike < 0) alignAtStrike = u.pit.alignT;
          maxDev = Math.max(maxDev, Math.abs(Math.atan2(Math.sin(v.car.yaw - h0.yaw), Math.cos(v.car.yaw - h0.yaw))));
          return u.pit === null && S.police.stats.pitHits > 0 && maxDev > 2.4;
        });
        return { agency: u.agency.id, hits: S.police.stats.pitHits, attempts: S.police.stats.pitAttempts, maxDevDeg: Math.round((maxDev * 180) / Math.PI), alignAtStrike };
      });
      expect(r.agency === 'ghp', `agency ${r.agency}`);
      expect(r.attempts >= 1 && r.hits >= 1, `PIT attempts ${r.attempts}, hits ${r.hits}`);
      expect(r.alignAtStrike >= 1.3, `struck after only ${r.alignAtStrike}s alongside`);
      expect(r.maxDevDeg > 100, `the car turned only ${r.maxDevDeg} degrees`);
      return `spun ${r.maxDevDeg} degrees, ${r.alignAtStrike.toFixed(1)} s alongside before the strike`;
    });
    await wait(500);
    await check('the client heard it: police:pit attempt and hit, and the cruiser is in the Highway Patrol livery', async () => {
      const ev = await page.evaluate(() => window.__events.filter((e) => e.type === 'police:pit').map((e) => e.phase));
      expect(ev.includes('attempt') && ev.includes('hit'), `events ${ev}`);
      const liv = await page.evaluate(() => [...window.__hood.game.view.defs.values()].find((d) => d.police && d.police.agency === 'ghp')?.police.body);
      expect(liv === 0x1f4d3a, `GHP body colour ${liv}`);
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }

  // ---- being shot at
  {
    const { page, errors, ctx } = await sceneOpen('');
    const c = makeChecker(page, 'police-shot-at');
    const { check, wait, expect } = c;
    let r = null;
    await check('heat 3 and an officer in the open with a clear line: he shoots through the weapons API, after a reaction time, and the player is hit', async () => {
      r = await sim(page, (host, S) => {
        const me = S.registry.get(S.playerPedId);
        const c = me.controller;
        S.police.roadblocks.enabled = false;
        S.police.heli.enabled = false;
        let spot = null;
        for (let k = 0; k < 16 && !spot; k++) {
          const a = (k / 16) * Math.PI * 2;
          const x = c.x + Math.sin(a) * 13;
          const z = c.z + Math.cos(a) * 13;
          if (S.law.clearLine({ x: c.x, y: c.y + 1.4, z: c.z }, { x, y: S.groundAt(x, z) + 1.4, z }) && Math.abs(S.groundAt(x, z) - c.y) < 0.6) spot = { x, z };
        }
        const ag = S.law.data.agencies.find((x) => x.id === 'acp');
        const block = { id: 99, x: spot.x, z: spot.z, dirX: 1, dirZ: 0, width: 8, unitIds: [], t0: 0, passedAt: 0, gap: null, stripId: 0 };
        const u = S.police.spawnStatic(ag, 'pistol', { x: spot.x + 3, z: spot.z + 3, yaw: 0 }, { x: spot.x, z: spot.z, yaw: Math.atan2(c.x - spot.x, c.z - spot.z) }, block);
        const o = S.registry.get(u.officerIds[0]);
        S.law.heat.report(3, 4, c.x, c.z, true);
        let sees = -1;
        let fire = -1;
        let hit = -1;
        const emit = S.emit.bind(S);
        S.emit = (e) => {
          if (e.type === 'police:fire' && fire < 0) fire = S.tick;
          if (e.type === 'damage' && e.kind === 'bullet' && e.targetId === me.id && hit < 0) hit = S.tick;
          emit(e);
        };
        for (let i = 0; i < 60 * 20 && hit < 0; i++) {
          host.advance(1);
          me.armour = 0;
          if (sees < 0 && o.officer.sees) sees = S.tick;
        }
        return { sees, fire, hit, officer: o.id, shots: S.police.fire.stats.shots, health: me.health };
      });
      expect(r.hit > 0, `the player was never hit (${JSON.stringify(r)})`);
      const react = (r.fire - r.sees) / 60;
      expect(react >= 0.45 && react <= 3, `first shot ${react.toFixed(2)} s after he saw them`);
      return `first shot ${react.toFixed(2)} s after the sighting, ${r.shots} shots, health ${r.health.toFixed(0)}`;
    });
    await wait(700);
    await check('the client saw the shots: police:fire from the officer, the weapons API\'s weapon:fire, and a bullet damage event on the player', async () => {
      const ev = await page.evaluate((id) => ({
        fired: window.__events.filter((e) => e.type === 'police:fire' && e.officerId === id).length,
        bullets: window.__events.filter((e) => e.type === 'weapon:fire' && e.shooterId === id).length,
        damage: window.__events.filter((e) => e.type === 'damage' && e.kind === 'bullet' && e.targetId === window.__hood.game.ready.playerId).length,
      }), r.officer);
      expect(ev.fired >= 1 && ev.bullets >= ev.fired && ev.damage >= 1, JSON.stringify(ev));
      const h = await page.evaluate(HUD);
      expect(h.health < 100, `HUD health ${h.health}`);
      return JSON.stringify(ev);
    });
    await check('no console errors', async () => {
      expect(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
    fails += c.fails();
  }
  return fails;
}

await main();

// ------------------------------------------------------------------------------------------------
// The full-screen map and the GPS: on the procedural streamed city (?tiles=fixture, a 3 x 3 grid of 384 m tiles with a street grid
// across every seam), the sim on the main thread so a car can be put where the check wants it.

/** Runs in the page. The map, the waypoint and the route as the player sees them. */
function NAV() {
  const h = window.__hood;
  const n = h.nav, c = n.core, m = h.bigMap;
  const radar = document.querySelector('.hud-radar');
  return {
    open: m.isOpen,
    enabled: h.game.input.enabled,
    brake: h.game.input.parkBrake,
    visible: !document.querySelector('.bigmap').hidden,
    wp: c.waypoint && { x: c.waypoint.x, z: c.waypoint.z, name: c.waypoint.name, snapped: c.waypoint.snapped },
    status: c.status,
    mode: c.route?.mode ?? null,
    routeId: c.route?.id ?? 0,
    len: c.route?.length ?? 0,
    partial: c.route?.partial ?? false,
    xs: c.route ? [Math.min(...c.route.xs), Math.max(...c.route.xs)] : null,
    first: c.route && c.route.count ? [c.route.xs[0], c.route.zs[0]] : null,
    remaining: n.distanceLeft(),
    progress: c.track?.s ?? 0,
    reroutes: c.stats.reroutes,
    routes: c.stats.routes,
    tiles: c.drive.tileIds.length,
    stitched: c.drive.stitched,
    marker: n.marker.visible,
    prompt: document.querySelector('.hud-nav')?.style.display !== 'none' ? (document.querySelector('.hud-nav')?.textContent ?? '') : '',
    view: { cx: m.view.cx, cz: m.view.cz, scale: m.view.scale, w: m.view.w, h: m.view.h },
    radarRect: radar ? (({ x, y, width, height }) => ({ x, y, width, height }))(radar.getBoundingClientRect()) : null,
  };
}

/** Runs in the page. Pixels of the route's colour on the radar. */
function RADAR_ROUTE_PIXELS() {
  const cv = document.querySelector('.hud-radar');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] < 110 && d[i + 2] > 170 && d[i + 3] > 200) n++;
  return n;
}

async function mapSuite() {
  console.log('\n=== map and GPS ===');
  const { page, errors, ctx } = await open('tiles=fixture&graphics=low&start=car&ambient=0&traffic=0&parked=0&time=14:00&timescale=0&transport=loopback', true);
  const c = makeChecker(page, 'map');
  const { check, hold, tap, wait, expect, k } = c;
  const nav = () => page.evaluate(NAV);
  const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  const mapRect = () => page.evaluate(() => { const r = document.querySelector('.bigmap canvas').getBoundingClientRect(); return { x: r.x, y: r.y }; });
  /** Screen position of a world point on the open map. */
  const screenOf = async (x, z) => {
    const n = await nav();
    const r = await mapRect();
    return { x: r.x + n.view.w / 2 + (x - n.view.cx) * n.view.scale, y: r.y + n.view.h / 2 + (z - n.view.cz) * n.view.scale };
  };
  const player = () => page.evaluate(() => { const p = window.__hood.game.view.controlled; return { x: p.x, z: p.z }; });
  const settle = async (ms = 1200) => { await wait(ms); await page.evaluate(() => window.__hood.nav.data.settled()); };
  const chimes = () => page.evaluate(() => window.__chimes.slice());
  const padPress = (i, on) => page.evaluate(([i, on]) => { window.__pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; }, [i, on]);
  await wait(1500);
  await page.evaluate(() => {
    window.__chimes = [];
    const a = window.__hood.game.audio;
    if (a) { const f = a.chime.bind(a); a.chime = (kind) => { window.__chimes.push(kind); f(kind); }; }
  });

  // ---- opening and closing
  await check('Tab opens the map: the game waits, the handbrake is on', async () => {
    await tap('Tab');
    await wait(300);
    const n = await nav();
    expect(n.open && n.visible, 'not open');
    expect(!n.enabled, 'the controls are still on');
    expect(n.brake, 'no handbrake');
    expect(!(await page.evaluate(() => window.__hood.game.input.pointerLocked)), 'the mouse is still captured');
  });
  await check('the map draws roads', async () => {
    await page.waitForFunction(() => [...window.__hood.bigMap.data.tiles.values()].some((t) => t.state === 'ready' && t.groups.length), null, { timeout: 15000 });
    await wait(300);
    const lit = await page.evaluate(() => {
      const cv = document.querySelector('.bigmap canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) if (d[i] > 70) n++;
      return n;
    });
    expect(lit > 800, `only ${lit} bright samples`);
    return `${lit} bright samples`;
  });
  await check('Tab closes it and the controls come back', async () => {
    await tap('Tab');
    await wait(300);
    const n = await nav();
    expect(!n.open && !n.visible && n.enabled && !n.brake, JSON.stringify({ open: n.open, enabled: n.enabled, brake: n.brake }));
  });
  await check('P opens it and Esc closes it', async () => {
    await tap('KeyP');
    await wait(250);
    expect((await nav()).open, 'P did not open');
    await tap('Escape');
    await wait(250);
    expect(!(await nav()).open, 'Esc did not close');
  });
  await check('a click on the radar opens it (a one-button mouse needs no key), the X button closes it', async () => {
    const r = (await nav()).radarRect;
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await wait(300);
    expect((await nav()).open, 'the radar click did not open the map');
    await page.click('.bigmap button[aria-label="Close the map"]');
    await wait(250);
    expect(!(await nav()).open, 'the X did not close it');
  });

  // ---- pan and zoom
  await check('drag pans, the wheel and a pinch zoom, keys pan and zoom', async () => {
    await tap('Tab');
    await wait(300);
    const a = await nav();
    const r = await mapRect();
    const cx = r.x + a.view.w / 2, cy = r.y + a.view.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 60, { steps: 6 });
    await page.mouse.up();
    const b = await nav();
    expect(b.view.cx < a.view.cx - 20 && b.view.cz < a.view.cz - 10, `drag: ${a.view.cx.toFixed(0)},${a.view.cz.toFixed(0)} -> ${b.view.cx.toFixed(0)},${b.view.cz.toFixed(0)}`);
    expect(!b.wp, 'a drag set a waypoint');
    await page.mouse.wheel(0, -300);
    await wait(150);
    const z1 = await nav();
    expect(z1.view.scale > b.view.scale * 1.2, `wheel in ${b.view.scale.toFixed(3)} -> ${z1.view.scale.toFixed(3)}`);
    await k.down('Control');
    await page.mouse.wheel(0, 40);
    await k.up('Control');
    await wait(150);
    const z2 = await nav();
    expect(z2.view.scale < z1.view.scale * 0.85, `pinch out ${z1.view.scale.toFixed(3)} -> ${z2.view.scale.toFixed(3)}`);
    await hold(['ArrowRight'], 400);
    const p1 = await nav();
    expect(p1.view.cx > z2.view.cx + 20, `arrow right ${z2.view.cx.toFixed(0)} -> ${p1.view.cx.toFixed(0)}`);
    await hold(['KeyS'], 300);
    const p2 = await nav();
    expect(p2.view.cz > p1.view.cz + 10, 'S did not pan south');
    await hold(['KeyE'], 300);
    const q1 = await nav();
    expect(q1.view.scale > p2.view.scale * 1.2, 'E did not zoom in');
    await tap('Minus');
    const q2 = await nav();
    expect(q2.view.scale < q1.view.scale, '- did not zoom out');
    await tap('KeyC');
    const home = await nav();
    const pl = await player();
    expect(Math.hypot(home.view.cx - pl.x, home.view.cz - pl.z) < 5, 'C did not centre on the player');
  });

  // ---- a waypoint by one click
  let wp1 = null;
  await check('one click sets a waypoint on the nearest road and finds the route', async () => {
    const pl = await player();
    // somewhere in a block, off the streets, a way from the player
    const pos = await screenOf(pl.x + 130, pl.z + 120);
    await page.mouse.click(pos.x, pos.y);
    await settle(900);
    const n = await nav();
    expect(n.wp && n.wp.snapped, `not snapped ${JSON.stringify(n.wp)}`);
    expect(n.wp.name.length > 0, 'no street name');
    expect(n.status === 'ok' && n.len > 100, `route ${n.status} ${n.len}`);
    expect(n.mode === 'walk', `mode ${n.mode}`);
    expect(n.marker, 'no marker in the world');
    expect((await chimes()).includes('set'), 'no chime');
    wp1 = n.wp;
    return `${n.wp.name}, ${n.len.toFixed(0)} m on foot`;
  });
  await check('the route and the waypoint are on the radar', async () => {
    await tap('Tab');
    await wait(400);
    const px = await page.evaluate(RADAR_ROUTE_PIXELS);
    expect(px > 25, `${px} route pixels on the radar`);
    const n = await nav();
    expect(n.prompt.length > 0, 'no turn prompt');
    return `${px} px, "${n.prompt.slice(0, 50)}"`;
  });
  await check('clicking the waypoint again clears it', async () => {
    await tap('Tab');
    await wait(300);
    const pos = await screenOf(wp1.x, wp1.z);
    await page.mouse.click(pos.x + 4, pos.y - 3);
    await wait(300);
    const n = await nav();
    expect(!n.wp && n.status === 'none' && !n.marker, JSON.stringify(n.wp));
    expect((await chimes()).includes('clear'), 'no clear chime');
  });
  await check('without the mouse: the cross in the middle sets a waypoint with Enter and clears it with Enter', async () => {
    await tap('KeyC');
    await hold(['ArrowRight'], 500);
    await hold(['ArrowDown'], 350);
    const n0 = await nav();
    await tap('Enter');
    await settle(700);
    const n1 = await nav();
    expect(n1.wp, 'Enter set nothing');
    expect(Math.hypot(n1.wp.x - n0.view.cx, n1.wp.z - n0.view.cz) < 160, 'the waypoint is not where the cross is');
    expect(n1.status === 'ok' || n1.status === 'partial', `route ${n1.status}`);
    await tap('Enter');
    await wait(250);
    expect(!(await nav()).wp, 'Enter did not clear it');
    await tap('Enter');
    await wait(300);
    expect((await nav()).wp, 'Enter did not set it again');
    await tap('Delete');
    await wait(250);
    expect(!(await nav()).wp, 'Delete did not clear it');
  });
  await check('a plain click is all a one-button mouse needs: set, clear, and Ctrl-click does the same', async () => {
    const pl = await player();
    let pos = await screenOf(pl.x - 100, pl.z + 60);
    await page.mouse.click(pos.x, pos.y);
    await wait(300);
    const a = await nav();
    expect(a.wp, 'click set nothing');
    pos = await screenOf(a.wp.x, a.wp.z);
    await k.down('Control');
    await page.mouse.click(pos.x, pos.y);
    await k.up('Control');
    await wait(250);
    expect(!(await nav()).wp, 'Ctrl-click did not clear it');
  });

  // ---- driving
  await check('in the car the route is a driving one; driving along it brings the distance down', async () => {
    await tap('Tab');
    await wait(300);
    await tap('KeyE');
    await wait(800);
    expect((await page.evaluate(() => window.__hood.game.view.inVehicle)), 'not in the car');
    await tap('Tab');
    await wait(300);
    const pl = await player();
    const pos = await screenOf(pl.x + 320, pl.z + 20);
    await page.mouse.click(pos.x, pos.y);
    await settle(900);
    const a = await nav();
    expect(a.wp && a.mode === 'drive' && a.status === 'ok', `mode ${a.mode} ${a.status}`);
    await tap('Tab');
    await wait(300);
    await hold(['KeyW'], 3200);
    const b = await nav();
    expect(b.remaining < a.remaining - 15, `remaining ${a.remaining.toFixed(0)} -> ${b.remaining.toFixed(0)}`);
    return `${a.remaining.toFixed(0)} m -> ${b.remaining.toFixed(0)} m, prompt "${b.prompt.slice(0, 44)}"`;
  });
  await check('a wrong turn finds a new route', async () => {
    const before = await nav();
    // the car to a street well off the route
    const at = await sim((S) => {
      const car = S.registry.get(S.vehicleId).car;
      const p = car.pose();
      const x = p.x - 60, z = p.z + 192;
      car.teleport(x, S.groundAt(x, z) + 0.7, z, 0);
      return { x, z };
    });
    await wait(4200);
    const after = await nav();
    expect(after.reroutes > before.reroutes, `reroutes ${before.reroutes} -> ${after.reroutes}`);
    expect(after.routeId !== before.routeId, 'the route did not change');
    expect(Math.hypot(after.first[0] - at.x, after.first[1] - at.z) < 60, `the new route starts ${Math.hypot(after.first[0] - at.x, after.first[1] - at.z).toFixed(0)} m from the car`);
    expect(after.status === 'ok', after.status);
  });
  await check('getting out finds a walking route', async () => {
    await sim((S) => { S.registry.get(S.vehicleId).car.setHandbrake?.(true); });
    await hold(['Space'], 100);
    await wait(2200);
    await tap('KeyE');
    await wait(1200);
    const n = await nav();
    if (n.mode === 'drive') {
      // (the car may still have been moving: stop it first and try again)
      await hold(['KeyS'], 1500);
      await tap('KeyE');
      await wait(1200);
    }
    const m = await nav();
    expect(!(await page.evaluate(() => window.__hood.game.view.inVehicle)), 'still in the car');
    expect(m.mode === 'walk' && m.wp, `mode ${m.mode}`);
  });
  await check('arriving within 15 m clears the waypoint with a chime', async () => {
    const n = await nav();
    await sim((S, w) => { S.registry.get(S.playerPedId).controller.teleport(w.x + 6, S.groundAt(w.x + 6, w.z) + 0.2, w.z); }, n.wp);
    await wait(600);
    const m = await nav();
    expect(!m.wp && m.status === 'none' && !m.marker, JSON.stringify(m.wp));
    expect((await chimes()).includes('arrive'), `chimes ${(await chimes()).join(',')}`);
    expect(await page.evaluate(() => document.querySelector('.hud-toast')?.textContent === 'You have arrived'), 'no toast');
  });

  // ---- across a seam
  await check('a waypoint two tiles away routes over the seams', async () => {
    await sim((S) => { S.registry.get(S.playerPedId).controller.teleport(60, S.groundAt(60, 96) + 0.2, 98); });
    await wait(900);
    await tap('Tab');
    await wait(300);
    await page.evaluate(() => window.__hood.nav.ensureLoaded());
    await settle(600);
    const pos = await screenOf(700, 96);
    await page.mouse.click(pos.x, pos.y);
    await settle(900);
    const n = await nav();
    expect(n.tiles >= 4 && n.stitched > 0, `tiles ${n.tiles} stitched ${n.stitched}`);
    expect(n.wp && n.wp.x > 600, `waypoint ${JSON.stringify(n.wp)}`);
    expect(n.status === 'ok' && !n.partial, `status ${n.status}`);
    expect(n.xs[0] < 384 && n.xs[1] > 600, `route spans x ${n.xs.map((v) => v.toFixed(0)).join('..')}`);
    await tap('Tab');
    await wait(200);
  });

  // ---- the pad and the touch screen
  await check('the last waypoint is remembered across a reload (and a cleared one stays cleared)', async () => {
    await page.evaluate(() => window.__hood.nav.clearWaypoint());
    const pl = await player();
    await tap('Tab');
    await wait(300);
    const pos = await screenOf(pl.x + 100, pl.z + 90);
    await page.mouse.click(pos.x, pos.y);
    await settle(500);
    const before = await nav();
    expect(before.wp, 'no waypoint to remember');
    await page.reload();
    await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
    await wait(1500);
    const after = await nav();
    expect(after.wp, 'the waypoint was not restored');
    expect(Math.hypot(after.wp.x - before.wp.x, after.wp.z - before.wp.z) < 25, `restored ${after.wp.x.toFixed(0)},${after.wp.z.toFixed(0)} vs ${before.wp.x.toFixed(0)},${before.wp.z.toFixed(0)}`);
    // clearing it forgets it
    await page.evaluate(() => window.__hood.nav.clearWaypoint());
    await page.reload();
    await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
    await wait(1200);
    expect(!(await nav()).wp, 'a cleared waypoint came back');
  });
  await check('D-pad down opens the map; A sets a waypoint at the cross, B closes', async () => {
    await page.evaluate(() => window.__hood.nav.clearWaypoint());
    await padPress(13, true);
    await wait(150);
    await padPress(13, false);
    await wait(300);
    expect((await nav()).open, 'D-pad down did not open it');
    // the left stick moves the cross (a waypoint under your own feet is reached at once)
    const x0 = (await nav()).view.cx;
    await page.evaluate(() => { window.__pad.axes[0] = 1; });
    await wait(500);
    await page.evaluate(() => { window.__pad.axes[0] = 0; });
    expect((await nav()).view.cx > x0 + 40, 'the stick did not pan the map');
    await padPress(0, true);
    await wait(150);
    await padPress(0, false);
    await settle(500);
    expect((await nav()).wp, 'A set nothing');
    await padPress(1, true);
    await wait(150);
    await padPress(1, false);
    await wait(300);
    expect(!(await nav()).open, 'B did not close it');
    await page.evaluate(() => window.__hood.nav.clearWaypoint());
  });
  await check('the Map button on a touch screen opens it', async () => {
    await page.evaluate(() => window.__hood.game.touch.show(true));
    await wait(200);
    await page.click('.touch .b-map', { timeout: 5000 });
    await wait(400);
    expect((await nav()).open, 'the Map button did not open it');
    await page.click('.bigmap button[aria-label="Close the map"]');
    await wait(250);
    await page.evaluate(() => window.__hood.game.touch.show(false));
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails() + (await mapTouch());
}

/** Real touch events (CDP): a tap sets a waypoint, two fingers pinch and a drag pans. */
async function mapTouch() {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}?tiles=fixture&graphics=low&start=car&ambient=0&traffic=0&parked=0&time=14:00&timescale=0&transport=loopback`);
  await page.waitForFunction(() => window.__hood?.ready || window.__hood?.error, null, { timeout: 120000 });
  const cdp = await ctx.newCDPSession(page);
  const c = makeChecker(page, 'map-touch');
  const { check, wait, expect } = c;
  const nav = () => page.evaluate(NAV);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  await wait(2500);
  console.log('--- on a phone-sized touch screen');
  await check('tap the Map button, drag to pan, pinch to zoom, tap to set a waypoint and tap it to clear', async () => {
    const mb = await page.evaluate(() => { const r = document.querySelector('.touch .b-map').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await touch('touchStart', [mb]);
    await wait(60);
    await touch('touchEnd', []);
    await wait(500);
    let n = await nav();
    expect(n.open, 'the Map button did not open it');
    await page.waitForFunction(() => [...window.__hood.bigMap.data.tiles.values()].some((t) => t.state === 'ready'), null, { timeout: 15000 });
    // pan
    const a = n.view;
    await touch('touchStart', [[400, 200]]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [[400 + i * 20, 200 + i * 10]]); await wait(16); }
    await touch('touchEnd', []);
    await wait(150);
    n = await nav();
    expect(n.view.cx < a.cx - 10, `pan ${a.cx.toFixed(0)} -> ${n.view.cx.toFixed(0)}`);
    expect(!n.wp, 'a drag set a waypoint');
    // pinch out and in
    const s0 = n.view.scale;
    await touch('touchStart', [[360, 200], [480, 200]]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [[360 - i * 20, 200], [480 + i * 20, 200]]); await wait(16); }
    await touch('touchEnd', []);
    await wait(150);
    n = await nav();
    expect(n.view.scale > s0 * 1.5, `pinch ${s0.toFixed(3)} -> ${n.view.scale.toFixed(3)}`);
    // tap
    await touch('touchStart', [[300, 250]]);
    await wait(50);
    await touch('touchEnd', []);
    await page.evaluate(() => window.__hood.nav.data.settled());
    await wait(500);
    n = await nav();
    expect(n.wp, 'a tap set no waypoint');
    const wp = n.wp;
    const sx = n.view.w / 2 + (wp.x - n.view.cx) * n.view.scale, sy = n.view.h / 2 + (wp.z - n.view.cz) * n.view.scale;
    await touch('touchStart', [[sx, sy]]);
    await wait(50);
    await touch('touchEnd', []);
    await wait(300);
    expect(!(await nav()).wp, 'a tap on the pin did not clear it');
  });
  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}


/**
 * The trains, GTA IV style, with real keys: from the street down a Five Points entrance to the East-West platform (walking the
 * station's way: stairs, corridor, fare gates, escalators), the departures board, to an open door, E to get on, V for the chase
 * view and back, N to skip to the next station (the fade), E to get off there, standing on its platform.
 */
async function transitSuite() {
  console.log('\n=== transit (the Five Points tile) ===');
  const { page, errors, ctx } = await open('graphics=low&ambient=0&traffic=0&parked=0&time=13:00&timescale=0&transport=loopback', true);
  const c = makeChecker(page, 'transit');
  const { check, tap, wait, expect } = c;
  const sim = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__hood.game.transport.host.simulation, ${JSON.stringify(arg ?? null)})`);
  const header = () => page.evaluate(() => { const b = window.__hood.game.view.sample.b; return { train: b.u32[24], info: b.u32[25], flags: b.u32[4] }; });
  await wait(1500);
  await tap('KeyH');

  await check('walks into Five Points from the street', async () => {
    // the street end of an entrance, then the station's walk network down to the East-West platform
    const path = await sim((S) => {
      const T = S.transit;
      const st = T.data.stations.find((s) => s.name === 'Five Points');
      const e = st.entrances[0];
      const pl = st.platforms[0];
      const W = T.data.walk;
      const near = (x, y, z) => { let b = -1, bd = 1e9; W.nodes.forEach((n, i) => { const d = Math.hypot(n[0] - x, (n[1] - y) * 3, n[2] - z); if (d < bd) { bd = d; b = i; } }); return b; };
      const from = near(e.x - Math.sin(e.yaw) * 1.5, e.y, e.z - Math.cos(e.yaw) * 1.5), to = near(pl.c[0], pl.y, pl.c[1]);
      const adj = W.nodes.map(() => []);
      for (let i = 0; i < W.edges.length; i += 3) { adj[W.edges[i]].push(W.edges[i + 1]); adj[W.edges[i + 1]].push(W.edges[i]); }
      const dist = W.nodes.map(() => Infinity), prev = W.nodes.map(() => -1);
      dist[from] = 0;
      const open = new Set([from]);
      while (open.size) {
        let u = -1;
        for (const k of open) if (u < 0 || dist[k] < dist[u]) u = k;
        open.delete(u);
        for (const v of adj[u]) {
          const d = dist[u] + Math.hypot(W.nodes[u][0] - W.nodes[v][0], W.nodes[u][1] - W.nodes[v][1], W.nodes[u][2] - W.nodes[v][2]);
          if (d < dist[v]) { dist[v] = d; prev[v] = u; open.add(v); }
        }
      }
      const out = [];
      for (let v = to; v >= 0; v = prev[v]) out.push(W.nodes[v]);
      out.reverse();
      const p = S.registry.get(S.playerPedId).controller;
      p.teleport(out[0][0], out[0][1] + 0.2, out[0][2]);
      return { nodes: out, platformY: pl.y };
    });
    await wait(600);
    for (const [i, n] of path.nodes.entries()) {
      const r = await walkTo(page, () => ({ x: n[0], z: n[2] }), { tol: 0.8, timeoutMs: 45000, sprint: true });
      expect(r.ok, `stuck before node ${i} of ${path.nodes.length} at ${r.state.ped.x.toFixed(1)}, ${r.state.ped.y.toFixed(1)}, ${r.state.ped.z.toFixed(1)}`);
    }
    const s = await page.evaluate(STATE);
    expect(Math.abs(s.ped.y - path.platformY) < 0.7, `at y ${s.ped.y.toFixed(2)}, the platform is ${path.platformY}`);
    const h = await header();
    expect(((h.info & 0xff) - 1) >= 0, 'not in a station');
    return `${path.nodes.length} waypoints down to y ${s.ped.y.toFixed(1)}`;
  });

  await check('the platform shows the next trains', async () => {
    await wait(1200);
    const board = await page.evaluate(() => { const b = document.querySelector('.transit-board'); return { on: b?.classList.contains('on'), text: b?.textContent ?? '' }; });
    expect(board.on && /Five Points/.test(board.text), `board ${JSON.stringify(board)}`);
    return board.text.replace(/\s+/g, ' ').slice(0, 80);
  });

  let trainId = 0;
  await check('E gets on a train with its doors open', async () => {
    // the next train to open its doors at this platform: walk to its nearest door
    let door = null;
    for (let i = 0; i < 400 && !door; i++) {
      door = await sim((S) => {
        const T = S.transit;
        const p = S.registry.get(S.playerPedId).controller;
        let best = null, bd = 1e9;
        for (const tr of T.model.trains) {
          if (tr.phase !== 'open' || tr.t > 6) continue;
          for (let k = 0; k < 6; k++) for (let d = 0; d < 3; d++) {
            const o = T.doorOutside(tr, k, d, 0.5);
            const dd = Math.hypot(o.x - p.x, o.z - p.z);
            if (Math.abs(o.y - p.y) < 1 && dd < bd) { bd = dd; best = { x: o.x, z: o.z, id: tr.id }; }
          }
        }
        return best && bd < 60 ? best : null;
      });
      if (!door) await wait(150);
    }
    expect(door, 'no train opened its doors here');
    const r = await walkTo(page, () => door, { tol: 0.6, timeoutMs: 30000, sprint: true });
    expect(r.ok, 'did not reach the door');
    const prompt = await page.evaluate(() => document.querySelector('.transit-prompt')?.textContent ?? '');
    expect(/Board/.test(prompt), `prompt "${prompt}"`);
    await tap('KeyE');
    await wait(600);
    const h = await header();
    expect(h.train === door.id && (h.flags & 2) !== 0, `not on the train (train ${h.train}, flags ${h.flags})`);
    trainId = h.train;
    return `train ${trainId}`;
  });

  await check('V switches the window and the chase view', async () => {
    const mode = () => page.evaluate(() => window.__hood.game.transitCamera.mode);
    expect((await mode()) === 'window', `starts in ${await mode()}`);
    await tap('KeyV');
    expect((await mode()) === 'chase', 'V did not switch to the chase view');
    await wait(700);
    await tap('KeyV');
    expect((await mode()) === 'window', 'V did not switch back');
  });

  await check('N skips to the next station (a fade), E gets off there', async () => {
    await tap('KeyN');
    await wait(400);
    const dark = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.transit-fade')).opacity));
    expect(dark > 0.2, `no fade (${dark})`);
    // there: the doors open
    let at = null;
    for (let i = 0; i < 80 && (!at || at === 'Five Points'); i++) {
      at = await sim((S, id) => { const tr = S.transit.byId.get(id); if (!tr || (tr.phase !== 'open' && tr.phase !== 'opening') || tr.doors < 0.8) return null; return S.transit.data.stations[S.transit.data.routes[tr.route].stops[tr.stop].station].name; }, trainId);
      if (!at || at === 'Five Points') await wait(150);
    }
    expect(at && at !== 'Five Points', `at ${at}`);
    await wait(300);
    const prompt = await page.evaluate(() => document.querySelector('.transit-prompt')?.textContent ?? '');
    expect(/Get off/.test(prompt), `prompt "${prompt}"`);
    await tap('KeyE');
    await wait(900);
    const h = await header();
    expect(h.train === 0 && (h.flags & 2) === 0, 'still on the train');
    const s = await page.evaluate(STATE);
    const ok = await sim((S, y) => S.transit.data.stations.some((st) => st.platforms.some((p) => Math.abs(p.y - y) < 0.6)), s.ped.y);
    expect(ok, `not on a platform (y ${s.ped.y.toFixed(2)})`);
    return `off at ${at}`;
  });

  await check('no console errors', async () => {
    expect(errors.length === 0, errors.join(' | '));
  });
  await ctx.close();
  return c.fails();
}
