#!/usr/bin/env node
/**
 * Screenshots of the GPS and the full-screen map, into .shots/map-*.png. Real key presses and mouse clicks drive the game.
 *
 *   node scripts/map-shots.mjs [--only name,name] [--url http://127.0.0.1:5180/]
 *
 *   map-downtown      the map over Five Points, landmarks and street names
 *   map-waypoint      a waypoint set with one click, the route to it
 *   map-radar-route   the radar with the route while driving, and the turn prompt
 *   map-marker-day    the beacon in the world by day, map-marker-night at night
 *   map-stream        the streamed city (M2): a route that crosses a tile seam
 */
import { mkdirSync } from 'node:fs';
import { boot, launch, openProfile, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const want = (n) => !only || only.has(n);
mkdirSync('.shots', { recursive: true });

const server = await startServer(args);
const browser = await launch({});
const fails = [];
const wait = (page, ms) => page.waitForTimeout(ms);

async function open(query, w = 1280, h = 720) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e?.message ?? e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await boot(page, server.base, query, { harness: false });
  await wait(page, 2500);
  await page.keyboard.press('Shift');
  return { page, ctx, errors };
}
const shot = async (page, name) => { await page.screenshot({ path: `.shots/${name}.png` }); console.log('shot', `.shots/${name}.png`); };
const mapReady = (page) => page.waitForFunction(() => { const m = window.__hood.bigMap; return m && [...m.data.tiles.values()].every((t) => t.state !== 'loading') && [...m.data.tiles.values()].some((t) => t.state === 'ready'); }, null, { timeout: 30000 });

try {
  if (want('map-downtown')) {
    const { page, ctx, errors } = await open('time=14:00&timescale=0&graphics=high');
    await page.keyboard.press('Tab');
    await wait(page, 300);
    await mapReady(page);
    // wait for the footprints too
    await page.waitForFunction(() => [...window.__hood.bigMap.data.tiles.values()].every((t) => t.buildingsState !== 'loading'), null, { timeout: 30000 });
    // downtown, a little north of Five Points
    await page.evaluate(() => { const m = window.__hood.bigMap; m.view.cx = -250; m.view.cz = -330; m.view.scale = 0.42; m.dirty = true; });
    await wait(page, 500);
    await shot(page, 'map-downtown');
    if (errors.length) fails.push(`map-downtown: ${errors.join(' | ')}`);
    await ctx.close();
  }
  if (want('map-waypoint')) {
    const { page, ctx, errors } = await open('time=14:00&timescale=0&graphics=high');
    await page.keyboard.press('Tab');
    await wait(page, 300);
    await mapReady(page);
    await page.waitForFunction(() => [...window.__hood.bigMap.data.tiles.values()].every((t) => t.buildingsState !== 'loading'), null, { timeout: 30000 });
    await page.evaluate(() => { const m = window.__hood.bigMap; const p = window.__hood.game.view.controlled; m.view.cx = p.x + 120; m.view.cz = p.z - 260; m.view.scale = 0.5; m.dirty = true; });
    await wait(page, 400);
    // one plain click
    await page.mouse.click(930, 150);
    await wait(page, 700);
    await shot(page, 'map-waypoint');
    const st = await page.evaluate(() => { const c = window.__hood.nav.core; return { wp: c.waypoint, status: c.status, len: c.route?.length, steps: c.route?.steps.length }; });
    console.log('waypoint', JSON.stringify(st));
    if (!st.wp || st.status !== 'ok') fails.push(`map-waypoint: ${JSON.stringify(st)}`);
    if (errors.length) fails.push(`map-waypoint: ${errors.join(' | ')}`);
    await ctx.close();
  }
  if (want('map-radar-route') || want('map-turn-prompt')) {
    const { page, ctx, errors } = await open('time=14:00&timescale=0&graphics=high&start=car&traffic=0&ambient=0&parked=0&peds=0');
    await page.keyboard.down('KeyE');
    await wait(page, 120);
    await page.keyboard.up('KeyE');
    await wait(page, 2200);
    await page.keyboard.press('KeyH');
    // a waypoint some way ahead of the car, set the way a player does: open the map and click
    const car = await page.evaluate(() => {
      const g = window.__hood.game, c = g.view.vehicle;
      const yaw = Math.atan2(2 * (c.q.x * c.q.z + c.q.w * c.q.y), 1 - 2 * (c.q.x * c.q.x + c.q.y * c.q.y));
      return { x: c.x, z: c.z, fx: Math.sin(yaw), fz: Math.cos(yaw) };
    });
    await page.keyboard.press('Tab');
    await wait(page, 500);
    await mapReady(page);
    const pos = await page.evaluate((c) => {
      const m = window.__hood.bigMap, v = m.view;
      v.cx = c.x; v.cz = c.z; v.scale = 0.5; m.dirty = true;
      const wx = c.x + c.fx * 330 + c.fz * 200, wz = c.z + c.fz * 330 - c.fx * 200;
      return { x: v.w / 2 + (wx - v.cx) * v.scale, y: v.h / 2 + (wz - v.cz) * v.scale };
    }, car);
    await wait(page, 300);
    await page.mouse.click(pos.x, pos.y);
    await page.evaluate(() => window.__hood.nav.data.settled());
    await wait(page, 700);
    await page.keyboard.press('Tab');
    await wait(page, 400);
    await page.keyboard.down('KeyW');
    await wait(page, 2600);
    await page.keyboard.up('KeyW');
    await wait(page, 300);
    if (want('map-radar-route')) await shot(page, 'map-radar-route');
    if (want('map-turn-prompt')) {
      await page.screenshot({ path: '.shots/map-turn-prompt.png', clip: { x: 0, y: 470, width: 640, height: 250 } });
      console.log('shot .shots/map-turn-prompt.png');
    }
    const st = await page.evaluate(() => { const n = window.__hood.nav; return { status: n.core.status, remaining: n.distanceText(), mode: n.core.route?.mode, prompt: document.querySelector('.hud-nav')?.textContent, speed: window.__hood.game.view.vehicle.speed }; });
    console.log('radar', JSON.stringify(st));
    if (st.mode !== 'drive') fails.push(`map-radar-route: mode ${st.mode}`);
    if (errors.length) fails.push(`map-radar-route: ${errors.join(' | ')}`);
    await ctx.close();
  }
  for (const [name, time] of [['map-marker-day', '13:00'], ['map-marker-night', '22:30']]) {
    if (!want(name)) continue;
    const { page, ctx, errors } = await open(`time=${time}&timescale=0&graphics=high&traffic=0&ambient=0&peds=0`);
    await page.keyboard.press('KeyH');
    await page.evaluate(async () => {
      const h = window.__hood, g = h.game, p = g.view.controlled;
      h.nav.ensureLoaded();
      await h.nav.data.settled();
      const yaw = g.cameraRig.yaw;
      h.nav.toggleWaypointAt(p.x - Math.sin(yaw) * 55, p.z - Math.cos(yaw) * 55);
    });
    await wait(page, 1500);
    await shot(page, name);
    if (errors.length) fails.push(`${name}: ${errors.join(' | ')}`);
    await ctx.close();
  }
  if (want('map-stream')) {
    const { page, ctx, errors } = await open('tiles=tiles/atlanta/m2/&time=14:00&timescale=0&graphics=high&start=car');
    const stats = await page.evaluate(() => { const s = window.__hood.stream; return { built: s.builtIds() }; });
    console.log('m2 built', JSON.stringify(stats));
    await page.keyboard.down('KeyE'); await wait(page, 120); await page.keyboard.up('KeyE');
    await wait(page, 1500);
    await page.keyboard.press('Tab');
    await wait(page, 400);
    await mapReady(page);
    await page.waitForFunction(() => [...window.__hood.bigMap.data.tiles.values()].every((t) => t.buildingsState !== 'loading'), null, { timeout: 40000 });
    await page.evaluate(() => { const m = window.__hood.bigMap; m.view.cx = 120; m.view.cz = 300; m.view.scale = 0.34; m.dirty = true; });
    await wait(page, 600);
    // a click in the next tile to the west: the route runs over the seam at x = 0
    const click = async (wx, wz) => {
      const p = await page.evaluate(([wx, wz]) => { const v = window.__hood.bigMap.view; return { x: v.w / 2 + (wx - v.cx) * v.scale, y: v.h / 2 + (wz - v.cz) * v.scale }; }, [wx, wz]);
      await page.mouse.click(p.x, p.y);
      await page.evaluate(() => window.__hood.nav.data.settled());
      await wait(page, 1200);
    };
    await click(-200, 300);
    await shot(page, 'map-stream');
    const st = await page.evaluate(() => { const n = window.__hood.nav; const c = n.core; return { tiles: c.drive.tileIds, stitched: c.drive.stitched, status: c.status, len: c.route?.length, wp: c.waypoint && [c.waypoint.x, c.waypoint.z, c.waypoint.name], xs: c.route && [Math.min(...c.route.xs), Math.max(...c.route.xs)], zs: c.route && [Math.min(...c.route.zs), Math.max(...c.route.zs)] }; });
    console.log('stream', JSON.stringify(st));
    if (!st.wp || st.status !== 'ok' || !(st.xs[0] < -10 && st.xs[1] > 10)) fails.push(`map-stream: ${JSON.stringify(st)}`);
    if (errors.length) fails.push(`map-stream: ${errors.join(' | ')}`);
    await ctx.close();
  }
  if (want('map-phone')) {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e?.message ?? e}`));
    await boot(page, server.base, 'time=14:00&timescale=0&graphics=low&start=car', { harness: false });
    await wait(page, 2500);
    await page.evaluate(() => { const g = window.__hood.game, p = g.view.controlled; window.__hood.nav.toggleWaypointAt(p.x + 240, p.z - 180); });
    await wait(page, 1500);
    await shot(page, 'map-phone-hud');
    const mb = await page.evaluate(() => { const r = document.querySelector('.touch .b-map').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.touchscreen.tap(mb[0], mb[1]);
    await wait(page, 600);
    await mapReady(page);
    await wait(page, 600);
    await shot(page, 'map-phone');
    if (errors.length) fails.push(`map-phone: ${errors.join(' | ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
