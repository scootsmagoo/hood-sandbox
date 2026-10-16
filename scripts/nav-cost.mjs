#!/usr/bin/env node
/**
 * What the GPS costs a frame. Drives the scripted bot over Downtown twice (scripts/lib/page.mjs), once with no waypoint and once with
 * one set, and reports the main-thread CPU and the GPU time of both (the recorder's numbers), the time inside each part of the GPS
 * measured with timers wrapped round it (the radar's route line, the world marker, the turn prompt, `NavCore.update` with its route
 * searches), how long a route search takes, how long joining the tiles' graphs takes, and the draw calls and triangles the marker adds.
 *
 *   node scripts/nav-cost.mjs [--profile desktop-medium] [--seconds 25] [--query "tiles=tiles/atlanta/m2/"]
 */
import { boot, launch, openProfile, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const profileName = String(args.profile ?? 'desktop-medium');
const seconds = Number(args.seconds ?? 25);
const server = await startServer(args);
const browser = await launch({});
const { page, errors, profile } = await openProfile(browser, profileName, args);
await boot(page, server.base, `graphics=${profile.tier}&start=car&traffic=0.5${args.query ? `&${args.query}` : ''}`);
await page.waitForTimeout(3000);
await page.evaluate(() => window.__h.bot.enterCar());

// timers round the GPS's parts
await page.evaluate(() => {
  const h = window.__hood, g = h.game, n = h.nav;
  const T = (window.__t = {});
  const wrap = (obj, key, name) => {
    const f = obj[key].bind(obj);
    T[name] = { n: 0, sum: 0, max: 0 };
    obj[key] = (...a) => {
      const t0 = performance.now();
      const r = f(...a);
      const d = performance.now() - t0;
      const s = T[name];
      s.n++; s.sum += d; if (d > s.max) s.max = d;
      return r;
    };
  };
  const layer = g.mapLayers.list.find((l) => l.id === 'gps');
  wrap(layer, 'radar', 'radar route + pin');
  wrap(n.marker, 'update', 'world marker');
  wrap(n.prompt, 'update', 'turn prompt');
  wrap(n.core, 'update', 'NavCore.update (track + search)');
});

const reset = () => page.evaluate(() => { for (const k of Object.keys(window.__t)) window.__t[k] = { n: 0, sum: 0, max: 0 }; });
const read = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__t)));
const drive = async (name) => {
  await page.evaluate((n) => window.__h.rec.begin(n), name);
  await page.evaluate((s) => window.__h.bot.drive(s), seconds);
  return page.evaluate(() => window.__h.rec.end());
};

await reset();
const base = await drive('without a waypoint');
const baseT = await read();
// a waypoint a long way off (the route is long and is searched again when the bot wanders off it)
await page.evaluate(() => {
  const h = window.__hood, st = h.game.view.controlled;
  h.nav.toggleWaypointAt(st.x + 700, st.z - 600);
});
await page.waitForTimeout(1500);
await reset();
const withWp = await drive('with a waypoint');
const withT = await read();
const info = await page.evaluate(() => {
  const n = window.__hood.nav, c = n.core;
  return { searches: c.stats.searches, routes: c.stats.routes, reroutes: c.stats.reroutes, searchLast: c.stats.lastMs, searchWorst: c.stats.worstMs, assemblies: n.data.assemblies, assembleMs: n.data.assembleMs, edges: c.drive.count, walkNodes: c.walk.nodeCount, routePts: c.route?.count ?? 0 };
});
// the marker's own cost in the draw: calls and triangles with it hidden and shown
const draw = await page.evaluate(async () => {
  const h = window.__hood, g = h.game, n = h.nav;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frame();
  const had = n.core.waypoint;
  const out = {};
  if (had) {
    n.marker.group.visible = true;
    await frame();
    out.shown = { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
    n.marker.group.visible = false;
    const upd = n.marker.update; n.marker.update = () => {};
    await frame();
    out.hidden = { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
    n.marker.update = upd;
  }
  return out;
});
await browser.close();
await server.close();

const f = (x) => (x === undefined || x === null ? 'n/a' : Number(x).toFixed(2));
console.log(`\nprofile ${profileName}, ${seconds} s of driving each`);
console.log('                           cpuMean  cpuP95  gpuP50  gpuP95  draws  triangles');
for (const [name, r] of [['without a waypoint', base], ['with a waypoint', withWp]]) console.log(`${name.padEnd(26)} ${f(r.cpuMean).padStart(7)} ${f(r.cpuP95).padStart(7)} ${f(r.gpuP50).padStart(7)} ${f(r.gpuP95).padStart(7)} ${String(r.draws).padStart(6)} ${String(r.triangles).padStart(10)}`);
console.log('\ntime inside the GPS, ms per frame (mean, worst) with a waypoint set:');
for (const [k, v] of Object.entries(withT)) console.log(`  ${k.padEnd(34)} ${f(v.sum / Math.max(1, v.n)).padStart(7)} ${f(v.max).padStart(7)}   (${v.n} calls; with no waypoint ${f((baseT[k].sum / Math.max(1, baseT[k].n)))} mean)`);
console.log(`\nsearches ${info.searches}, routes ${info.routes}, re-routes ${info.reroutes}; the last search took ${f(info.searchLast)} ms, the worst ${f(info.searchWorst)} ms (spread over frames, 2.5 ms a frame at most)`);
console.log(`graphs: ${info.edges} lane edges, ${info.walkNodes} walk nodes; ${info.assemblies} assembl${info.assemblies === 1 ? 'y' : 'ies'}, last ${f(info.assembleMs.last)} ms, worst ${f(info.assembleMs.worst)} ms; the route has ${info.routePts} points`);
if (draw.shown) console.log(`the world marker: ${draw.shown.calls - draw.hidden.calls} draw calls, ${draw.shown.tris - draw.hidden.tris} triangles`);
if (errors.length) { console.log(`errors: ${errors.join(' | ')}`); process.exit(1); }
