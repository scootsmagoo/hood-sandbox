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
 *   gunfire  30  raise the gun (the aim camera and the crosshair) and send 120 shots through the client's event path
 *                (tracers, flashes, puffs, sparks, blood, bullet holes, the gunshot sounds): the pooled effects must not grow
 *   police   20  a helicopter and a spike strip appear (heat 3, a strip laid) and are taken away: their models, beam and glow are made and
 *                disposed with the entities. Needs the sim on the main thread: `--query transport=loopback`.
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
const phases = String(args.phases ?? 'reload,vehicle,tiers,drive,crowd,gunfire').split(',').filter(Boolean);
const CYCLES = { reload: 24, vehicle: 30, tiers: 18, drive: 6, crowd: 12, gunfire: 30, police: 20 };
const WARM = 2;
/** Longest a single cycle may take before it is counted as stuck. */
const CYCLE_LIMIT_S = Number(args['cycle-limit'] ?? 180);
/** Allowed growth per counter (absolute, or a fraction of the first sample, whichever is larger), by phase. */
const TOL = {
  reload: { geometries: 0, textures: 0, programs: 0, materials: 0, objects: 0, entities: 3, listeners: 20, domNodes: 20 },
  // The live phases (`drive`, `crowd`) run with traffic. A traffic car swaps to a full model (55 scene objects, about 10 materials)
  // while it is touched, smoking or has a door open, and back after, so there the counts step by whole cars: allow three at once.
  // The frozen phases stay exact, and the soak watches the long run.
  crowd: { geometries: 4, textures: 2, programs: 4, materials: 36, objects: 170, entities: 90, listeners: 30, domNodes: 40 },
  drive: { geometries: 4, textures: 2, programs: 4, materials: 36, objects: 170, entities: 90, listeners: 30, domNodes: 40 },
  default: { geometries: 4, textures: 2, programs: 4, materials: 6, objects: 25, entities: 12, listeners: 30, domNodes: 40 },
};
const COUNTERS = ['geometries', 'textures', 'programs', 'materials', 'objects', 'entities', 'listeners', 'domNodes'];

// (the clock is frozen: the first night-sky draw at dusk would show up as a geometry that appears mid-run)
const server = await startServer(args);
const browser = await launch({});
const { page, cdp, errors, profile, isCrashed } = await openProfile(browser, profileName, args);
const bootMs = await boot(page, server.base, `graphics=${profile.tier}&start=car&timescale=0&pedbudget=40&traffic=${args.traffic ?? 0.75}${args.query ? `&${args.query}` : ""}`);
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
  /** People appear and are removed again: the budget goes between none and the tier's, so the street fills and empties. */
  async crowd(i) {
    await page.evaluate(async (full) => {
      const g = window.__hood.game;
      g.transport.config?.({ pedBudget: full ? 40 : 0 });
      await window.__h.sleep(full ? 2500 : 3500);
    }, i % 2 === 0);
  },
  /**
   * Gunfire. The shots are events fed to the client's own listeners (the sim is not asked to shoot: that would be a crime and bring the
   * police), so the effects, the camera and the sound run exactly as they do in play. Every weapon, every kind of hit.
   */
  async gunfire() {
    await page.evaluate(async () => {
      const g = window.__hood.game;
      const listeners = g.net.listeners;
      g.input.holdAction('aim', true);
      await window.__h.sleep(350);
      const cam = g.camera.position;
      const f = { x: -Math.sin(g.cameraRig.yaw), z: -Math.cos(g.cameraRig.yaw) };
      const weapons = ['pistol', 'smg', 'shotgun', 'rifle'];
      const kinds = ['world', 'ped', 'vehicle', 'none'];
      let n = 0;
      for (let burst = 0; burst < 8; burst++) {
        for (let k = 0; k < 15; k++, n++) {
          const w = weapons[burst % 4];
          const pellets = w === 'shotgun' ? 8 : 1;
          const impacts = [];
          for (let p = 0; p < pellets; p++) {
            const d = 8 + ((n * 7 + p * 3) % 40);
            const side = ((n + p) % 9) - 4;
            impacts.push({ kind: kinds[(n + p) % 4], x: cam.x + f.x * d - f.z * side, y: cam.y - 1 + ((n + p) % 3) * 0.5, z: cam.z + f.z * d + f.x * side, nx: -f.x, ny: 0, nz: -f.z, targetId: 0, headshot: false });
          }
          const e = { type: 'weapon:fire', tick: 0, shooterId: 0, weapon: w, x: cam.x + f.x * 0.8, y: cam.y - 0.3, z: cam.z + f.z * 0.8, dx: f.x, dy: 0, dz: f.z, impacts };
          for (const fn of listeners) fn(e);
          await window.__h.sleep(35);
        }
        for (const fn of listeners) fn({ type: 'weapon:reload', tick: 0, pedId: g.view.ped.id, weapon: weapons[burst % 4], durationS: 1.2 });
        for (const fn of listeners) fn({ type: 'weapon:empty', tick: 0, pedId: g.view.ped.id, weapon: weapons[burst % 4] });
      }
      g.input.holdAction('aim', false);
      await window.__h.sleep(300);
    });
  },
  /** A helicopter (heat 3) and a spike strip come into the world and go again; the client makes a model for each and must drop it. */
  async police() {
    await page.evaluate(async () => {
      const S = window.__hood.game.transport.host?.simulation;
      if (!S) throw new Error('the police phase needs the sim on the main thread: --query transport=loopback');
      const p = S.playerPosition();
      S.police.roadblocks.enabled = false;
      S.law.heat.report(3, 4, p.x, p.z, true);
      S.police.spikes.lay(p.x + 12, p.z, 0, 6);
      await window.__h.sleep(600);
      S.police.heli.clearAll();
      S.police.spikes.clearAll();
      S.law.heat.clear('cooldown');
      S.police.clearAll();
      await window.__h.sleep(400);
    });
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

// The street is part of the scene: cars and people come and go, and each car is a few dozen scene objects and a few geometries. The
// tile, the player's own car and the tier switches are what these phases measure, so they run with the population frozen (nobody new is
// made; whoever is in view stays). `drive` and `crowd` run with it. The population does not follow the tier here (`pedbudget` and
// `traffic` are fixed in the URL); each phase sets it, then waits for it to settle.
const FROZEN = { pedBudget: 0, traffic: 0 };
const LIVE = { pedBudget: 40, traffic: 0.75 };
const POPULATION = { reload: FROZEN, vehicle: FROZEN, tiers: FROZEN, drive: LIVE, crowd: LIVE, gunfire: FROZEN, police: FROZEN };
const setPopulation = (c) => page.evaluate((c) => window.__hood.game.transport.config?.(c), c);
let population = null;
const results = [];
for (const phase of phases) {
  const act = ACTIVITIES[phase];
  if (!act) { console.log(`unknown phase ${phase}`); continue; }
  const n = Math.max(6, Math.round(CYCLES[phase] * scale));
  console.log(`\n== ${phase}: ${n} cycles after ${WARM} warm-up`);
  const want = POPULATION[phase] ?? LIVE;
  if (want !== population) {
    population = want;
    await setPopulation(want);
    await page.waitForTimeout(14000);
  }
  const run = async (i) => {
    // A stuck bot (it once hung the drive phase for 50 minutes) fails its cycle instead of the whole run.
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`cycle took over ${CYCLE_LIMIT_S} s`)), CYCLE_LIMIT_S * 1000); });
    try { await Promise.race([act(i), limit]); } catch (e) { errors.push(`[${phase} ${i}] ${e.message.split('\n')[0]}`); } finally { clearTimeout(timer); }
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
      console.log(`  cycle ${String(i + 1).padStart(3)}: heap ${s.heapMB} MB · total ${s.totalMB ?? '-'} MB · geo ${s.geometries} (unused ${s.unusedGeometries}) · tex ${s.textures} · prog ${s.programs} · mat ${s.materials} · obj ${s.objects} · ent ${s.entities} · listeners ${s.listeners} · dom ${s.domNodes}`);
    }
  }
  const first = rows[0], last = rows[rows.length - 1], mid = rows[Math.floor(rows.length / 2)];
  const grew = [];
  if (rows.length >= 3) {
    const per = (last.heapMB - first.heapMB) / n;
    if (per > slope && last.heapMB > mid.heapMB) grew.push(`heap +${(last.heapMB - first.heapMB).toFixed(1)} MB (${per.toFixed(2)} MB/cycle)`);
    const tol = TOL[phase] ?? TOL.default;
    for (const k of COUNTERS) {
      // Outside `reload`, the raw geometry count also rises once for each chunk or part first drawn as the camera moves, and holds
      // after: judge the uploaded geometries that nothing in the scene draws any more, as the soak does. `reload` keeps the raw count.
      if (k === 'geometries' && phase !== 'reload' && first.unusedGeometries !== undefined) {
        const u1 = last.unusedGeometries - first.unusedGeometries, u2 = last.unusedGeometries - mid.unusedGeometries;
        if (u1 > tol.geometries && u2 > 0) grew.push(`unused geometries +${u1}`);
        continue;
      }
      const d1 = last[k] - first[k], d2 = last[k] - mid[k];
      const allow = Math.max(tol[k], phase === 'reload' ? tol[k] : first[k] * 0.05);
      if (d1 > allow && d2 > 0) grew.push(`${k} +${d1}`);
    }
    if (first.totalMB && last.totalMB && last.totalMB - first.totalMB > Math.max(25, first.totalMB * 0.15) && last.totalMB > mid.totalMB) grew.push(`total memory +${(last.totalMB - first.totalMB).toFixed(0)} MB`);
  } else grew.push('too few samples (crashed?)');
  if (phase === 'crowd') await setPopulation(LIVE);
  results.push({ phase, cycles: n, first, last, grew });
  console.log(`  ${grew.length ? 'GROWTH: ' + grew.join(', ') : 'flat'}`);
}

if (args.json) writeFileSync(resolve(root, String(args.json)), JSON.stringify(results, null, 1));
console.log('\nSummary (first sample after warm-up -> last):');
for (const r of results) {
  const a = r.first, b = r.last;
  console.log(`  ${r.phase.padEnd(8)} heap ${a.heapMB} -> ${b.heapMB} MB · total ${a.totalMB ?? '-'} -> ${b.totalMB ?? '-'} MB · geo ${a.geometries} -> ${b.geometries} (unused ${a.unusedGeometries} -> ${b.unusedGeometries}) · tex ${a.textures} -> ${b.textures} · prog ${a.programs} -> ${b.programs} · obj ${a.objects} -> ${b.objects} · ${r.grew.length ? 'GROWTH ' + r.grew.join(', ') : 'flat'}`);
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
