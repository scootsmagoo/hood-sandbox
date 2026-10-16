#!/usr/bin/env node
/**
 * What streaming costs in the browser (docs/contracts/city-tiles.md; numbers in docs/perf.md, "Streaming"): boots a streamed city
 * per profile, records a settled idle, then a drive across seams while tiles load ahead and drop behind, and reports the frame
 * (main-thread CPU, frame times, draws, triangles), the sim step (worst, from the worker), the client's tile adds (ms per frame
 * spent adding a tile's meshes or rebuilding a city-wide set), what is resident (tiles drawn, far tiles), the JS heap and the
 * whole page's memory (worker included) where Chromium reports it, and the GPU bytes of the drawn tiles.
 *
 *   node scripts/stream-perf.mjs [--tiles fixture:3] [--profile desktop-high,phone-low] [--drive 40] [--url <base>] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { boot, gc, launch, openProfile, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const tileList = String(args.tiles ?? 'fixture:3').split(',');
let tiles = tileList[0];
const profiles = String(args.profile ?? 'desktop-high,phone-low').split(',');
const driveS = Number(args.drive ?? 40);
const server = await startServer(args);
const browser = await launch({});
const out = {};
for (const name of profiles) for (const t of tileList) {
  tiles = t;
  const { page, cdp, errors, profile } = await openProfile(browser, name, args);
  // --tiles m1: the single served tile, the same route (an A/B in the same conditions)
  const single = tiles === 'm1';
  const bootMs = await boot(page, server.base, `graphics=${profile.tier}${single ? '' : `&tiles=${encodeURIComponent(tiles)}`}&start=car&timescale=0${args.query ? `&${args.query}` : ''}`);
  await page.keyboard.press('Shift');
  if (!single) await page.waitForFunction(() => window.__hood.stream?.settled, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const resident = async () => {
    await gc(cdp);
    return page.evaluate(async () => {
      const h = window.__hood;
      const g = h.game;
      // GPU bytes of the drawn city: every geometry under the world groups, counted once
      let bytes = 0;
      const seen = new Set();
      for (const n of ['world', 'world-fixture', 'world-far']) {
        g.scene.getObjectByName(n)?.traverse((o) => {
          const geo = o.geometry;
          if (!geo || seen.has(geo.uuid)) return;
          seen.add(geo.uuid);
          for (const a of Object.values(geo.attributes)) bytes += a.array.byteLength;
          if (geo.index) bytes += geo.index.array.byteLength;
        });
      }
      let totalMB = null;
      if (performance.measureUserAgentSpecificMemory) {
        try {
          totalMB = +((await performance.measureUserAgentSpecificMemory()).bytes / 1048576).toFixed(1);
        } catch { /* not isolated */ }
      }
      return {
        stream: h.stream?.stats() ?? { farBuilt: 0, adds: 0, drops: 0, addMsMax: 0, addMsMean: 0 },
        tilesDrawn: h.stream ? h.stream.builtIds().length : 1,
        cityGpuMB: +(bytes / 1048576).toFixed(1),
        heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
        totalMB,
        geometries: g.renderer.info.memory.geometries,
      };
    });
  };
  const settled = await resident();
  await page.evaluate(() => window.__h.rec.begin('idle'));
  await page.waitForTimeout(4000);
  const idle = await page.evaluate(() => window.__h.rec.end());
  // in the car and away along the street it is parked on (east, across the seams)
  await page.keyboard.down('KeyE'); await page.waitForTimeout(120); await page.keyboard.up('KeyE');
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.__h.rec.begin('drive'));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(driveS * 1000);
  await page.keyboard.up('KeyW');
  const drive = await page.evaluate(() => window.__h.rec.end());
  const after = await resident();
  out[`${name}:${tiles}`] = { bootMs, settled, idle, drive, after, errors: errors.slice(0, 5) };
  console.log(`\n== ${name} (${tiles})`);
  console.log(`  boot ${bootMs} ms · settled: ${settled.tilesDrawn} tiles drawn, ${settled.stream.farBuilt} far · city GPU ${settled.cityGpuMB} MB · heap ${settled.heapMB} MB · total ${settled.totalMB ?? '-'} MB`);
  for (const r of [idle, drive]) console.log(`  ${r.name.padEnd(5)} cpu mean ${r.cpuMean} p95 ${r.cpuP95} ms · frame p50 ${r.frameP50} p95 ${r.frameP95} max ${r.frameMax} ms · slow ${r.slowFrames} · draws ${r.draws} · tris ${(r.triangles / 1000).toFixed(0)}k · sim step max ${r.simStepMax} ms`);
  console.log(`  after the drive: ${after.tilesDrawn} drawn · adds ${after.stream.adds} drops ${after.stream.drops} · add ms max ${after.stream.addMsMax.toFixed(2)} mean ${after.stream.addMsMean.toFixed(2)} · city GPU ${after.cityGpuMB} MB · heap ${after.heapMB} MB · total ${after.totalMB ?? '-'} MB`);
  if (errors.length) console.log('  errors:', errors.slice(0, 3));
  await page.close();
}
if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 1));
await browser.close();
await server.close?.();
