#!/usr/bin/env node
/**
 * Leak harness. Boots the game in Chromium, then repeats one activity at a time; after each cycle it
 * forces a full GC (CDP) and counts what should not grow. Port of Skyrome's leaks.mjs.
 *
 *   node scripts/leaks.mjs [--phases reload,vehicle,tiers,drive] [--scale 1] [--heap-slope 1.5]
 *                          [--profile desktop-medium] [--json out.json] [--dist] [--url <base>]
 *
 * Phases (default cycles; `--scale 0.3` for a quick run):
 *   reload   24  drop the drawn tile (every geometry, material and texture of the world) and build it
 *                again from the .glb files: the "tile reload" a streaming world does all the time
 *   vehicle  30  get into the parked car, brake, get out: the sim's enter and exit and the
 *                client's views of them
 *   tiers    18  switch the graphics tier round (shadow maps are made and dropped, the camera's far
 *                plane and the fog change). Needs the dev server (it imports src/client/graphics.ts).
 *   drive    6   drive 20 s of street, park, get out and in: streaming of views and snapshots
 * Counted after each cycle: JS heap, renderer geometries, textures, programs, materials and objects in
 * the scene, entities in the client's view, DOM nodes and event listeners (CDP), and the whole
 * agent cluster's memory in MB including the sim worker (`measureUserAgentSpecificMemory`, when the
 * browser answers).
 * A phase PASSES when, after two warm-up cycles, the second half does not keep growing: the heap by
 * less than --heap-slope MB per cycle, every counter within a small allowance (geometries, textures,
 * programs, materials and objects exactly flat for `reload`).
 * Exit code 1 on growth, a page error, or a crash.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, busyWarning, gc, launch, openProfile, parseArgs, root, startServer } from './lib/harness.mjs';

const args = parseArgs();
const scale = Number(args.scale ?? 1);
const slope = Number(args['heap-slope'] ?? 1.5);
const profileName = String(args.profile ?? 'desktop-medium');
const phases = String(args.phases ?? 'reload,vehicle,tiers,drive').split(',').filter(Boolean);
const CYCLES = { reload: 24, vehicle: 30, tiers: 18, drive: 6 };
const WARM = 2;
/** Allowed growth per counter (absolute, or a fraction of the first sample, whichever is larger), by phase. */
const TOL = {
  reload: { geometries: 0, textures: 0, programs: 0, materials: 0, objects: 0, entities: 3, listeners: 20, domNodes: 20 },
  default: { geometries: 4, textures: 2, programs: 4, materials: 6, objects: 25, entities: 12, listeners: 30, domNodes: 40 },
};
const COUNTERS = ['geometries', 'textures', 'programs', 'materials', 'objects', 'entities', 'listeners', 'domNodes'];

const server = await startServer(args);
const browser = await launch({});
const { page, cdp, errors, profile, isCrashed } = await openProfile(browser, profileName, args);
const bootMs = await boot(page, server.base, `graphics=${profile.tier}&start=car`);
console.log(`booted in ${(bootMs / 1000).toFixed(1)} s (${profileName})`);
await page.waitForTimeout(3000);
await page.keyboard.press('Shift');

async function sample() {
  await gc(cdp);
  await page.waitForTimeout(120);
  await gc(cdp);
  const dom = cdp ? await cdp.send('Memory.getDOMCounters').catch(() => ({})) : {};
  const s = await page.evaluate(() => window.__h.memory());
  s.listeners = dom.jsEventListeners ?? 0;
  s.domNodes = dom.nodes ?? 0;
  // Whole agent cluster (main thread, workers), when the browser can say.
  s.totalMB = await page.evaluate(async () => {
    if (!performance.measureUserAgentSpecificMemory) return null;
    try {
      const r = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((res) => setTimeout(() => res(null), 8000))]);
      return r ? +(r.bytes / 1048576).toFixed(1) : null;
    } catch { return null; }
  });
  return s;
}

const ACTIVITIES = {
  async reload() {
    await page.evaluate(() => window.__hood.reloadWorld());
    await page.waitForTimeout(250);
  },
  async vehicle() {
    await page.evaluate(async () => {
      const b = window.__h.bot;
      await b.enterCar();
      await window.__h.sleep(350);
      await b.parkAndExit();
      await window.__h.sleep(250);
    });
  },
  async tiers(i) {
    const ok = await page.evaluate(async (i) => {
      let TIERS;
      try { ({ TIERS } = await import('/src/client/graphics.ts')); } catch { return false; }
      const order = ['high', 'low', 'medium', 'low', 'high', 'medium'];
      window.__hood.game.applyTier(TIERS[order[i % order.length]]);
      await window.__h.sleep(400);
      return true;
    }, i);
    if (!ok) throw new Error('needs the dev server (no --dist) to import src/client/graphics.ts');
  },
  async drive() {
    await page.evaluate(async () => {
      const b = window.__h.bot;
      await b.enterCar();
      await b.drive(20);
      await b.parkAndExit();
    });
  },
};

const results = [];
for (const phase of phases) {
  const act = ACTIVITIES[phase];
  if (!act) { console.log(`unknown phase ${phase}`); continue; }
  const n = Math.max(6, Math.round(CYCLES[phase] * scale));
  console.log(`\n== ${phase}: ${n} cycles after ${WARM} warm-up`);
  const run = async (i) => {
    try { await act(i); } catch (e) { errors.push(`[${phase} ${i}] ${e.message.split('\n')[0]}`); }
  };
  for (let i = 0; i < WARM && !isCrashed(); i++) await run(i);
  const rows = [await sample()];
  const every = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n && !isCrashed(); i++) {
    await run(i + WARM);
    if ((i + 1) % every === 0 || i === n - 1) {
      let s;
      try { s = await sample(); } catch { break; }
      rows.push(s);
      console.log(`  cycle ${String(i + 1).padStart(3)}: heap ${s.heapMB} MB · total ${s.totalMB ?? '-'} MB · geo ${s.geometries} · tex ${s.textures} · prog ${s.programs} · mat ${s.materials} · obj ${s.objects} · ent ${s.entities} · listeners ${s.listeners} · dom ${s.domNodes}`);
    }
  }
  const first = rows[0], last = rows[rows.length - 1], mid = rows[Math.floor(rows.length / 2)];
  const grew = [];
  if (rows.length >= 3) {
    const per = (last.heapMB - first.heapMB) / n;
    if (per > slope && last.heapMB > mid.heapMB) grew.push(`heap +${(last.heapMB - first.heapMB).toFixed(1)} MB (${per.toFixed(2)} MB/cycle)`);
    const tol = TOL[phase] ?? TOL.default;
    for (const k of COUNTERS) {
      const d1 = last[k] - first[k], d2 = last[k] - mid[k];
      const allow = Math.max(tol[k], phase === 'reload' ? tol[k] : first[k] * 0.05);
      if (d1 > allow && d2 > 0) grew.push(`${k} +${d1}`);
    }
    if (first.totalMB && last.totalMB && last.totalMB - first.totalMB > Math.max(25, first.totalMB * 0.15) && last.totalMB > mid.totalMB) grew.push(`total memory +${(last.totalMB - first.totalMB).toFixed(0)} MB`);
  } else grew.push('too few samples (crashed?)');
  results.push({ phase, cycles: n, first, last, grew });
  console.log(`  ${grew.length ? 'GROWTH: ' + grew.join(', ') : 'flat'}`);
}

if (args.json) writeFileSync(resolve(root, String(args.json)), JSON.stringify(results, null, 1));
console.log('\nSummary (first sample after warm-up -> last):');
for (const r of results) {
  const a = r.first, b = r.last;
  console.log(`  ${r.phase.padEnd(8)} heap ${a.heapMB} -> ${b.heapMB} MB · total ${a.totalMB ?? '-'} -> ${b.totalMB ?? '-'} MB · geo ${a.geometries} -> ${b.geometries} · tex ${a.textures} -> ${b.textures} · prog ${a.programs} -> ${b.programs} · obj ${a.objects} -> ${b.objects} · ${r.grew.length ? 'GROWTH ' + r.grew.join(', ') : 'flat'}`);
}
const pageErrors = [...new Set(errors)];
if (pageErrors.length) console.log(`errors (${pageErrors.length}):\n  ${pageErrors.slice(0, 10).join('\n  ')}`);
const crashed = isCrashed();
await browser.close();
await server.close();
const warn = busyWarning();
if (warn) console.log(warn);
const bad = crashed || pageErrors.length > 0 || results.some((r) => r.grew.length);
console.log(bad ? 'FAIL' : 'PASS');
process.exit(bad ? 1 : 0);
