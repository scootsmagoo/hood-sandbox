#!/usr/bin/env node
/**
 * Performance budget gate. A scripted player (scripts/lib/page.mjs) stands, walks, drives and looks
 * around Downtown on the baked tile, and the run FAILS (exit code 1) when a number goes over its
 * budget in scripts/perf-budget.json. Port of Skyrome's perf-budget, adapted to this game.
 *
 *   node scripts/perf-budget.mjs [--profile desktop-high,desktop-medium,desktop-low,phone-low]
 *                                [--repeat 2] [--budget scripts/perf-budget.json] [--json out.json]
 *                                [--write-budget] [--headroom 2] [--throttle 4] [--dist] [--url <base>]
 *                                [--uncapped] [--query "tile=tiles/other/"] [--browser chromium|webkit]
 *
 * Phases (each one a window of frames):
 *   idle    4 s standing at the spawn
 *   walk    out along the streets about 60 m and back (on foot)
 *   drive   40 s in the car over a wandering route of real streets
 *   look    6 s standing, the camera turning once round
 * Per phase:
 *   frameP50, frameP95  ms between animation frames, at the display's rate (16.7 ms at 60 Hz, so a
 *                       budget on these catches dropped frames, not headroom)
 *   cpuMean, cpuP95    ms the main thread spends in a frame (systems and the render submit)
 *   gpuP50, gpuP95     ms the GPU spends on the frame's render call (timer queries; the headroom
 *                       number, but only for this machine's GPU, see docs/perf.md)
 *   draws, triangles   the most in any frame (renderer.info: every pass, shadows included)
 *   slowFrames         frames over 33 ms
 * Per run: bootMs, heapMB (JS heap after a forced GC at the end), geometries, textures.
 *
 * The phone profile is a proxy: Chromium with the iPhone 15 Pro viewport (393x659 at 3x), touch, the
 * Low tier and the CPU slowed 4x through CDP. It says nothing about the GPU or Safari; see docs/perf.md.
 * Timings depend on what else the machine is doing; `--repeat n` keeps each timing's best.
 * `--write-budget` writes budgets from this run (timings x headroom, counts x 1.3): use it after a
 * change meant to cost more or less, and say why in your report.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, busyWarning, gc, launch, openProfile, parseArgs, PROFILES, root, startServer } from './lib/harness.mjs';

const args = parseArgs();
const profiles = String(args.profile ?? 'desktop-high,desktop-medium,desktop-low').split(',');
const repeat = Math.max(1, Number(args.repeat ?? 1));
const headroom = Number(args.headroom ?? 2);
const budgetPath = resolve(root, args.budget ?? 'scripts/perf-budget.json');
const budgetFile = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : { profiles: {} };
const PHASE_METRICS = ['frameP50', 'frameP95', 'cpuMean', 'cpuP95', 'gpuP50', 'gpuP95', 'draws', 'triangles', 'slowFrames'];
const RUN_METRICS = ['bootMs', 'heapMB', 'geometries', 'textures'];
const TIMED = new Set(['frameP50', 'frameP95', 'cpuMean', 'cpuP95', 'gpuP50', 'gpuP95', 'slowFrames', 'bootMs']);
const PHASES = ['idle', 'walk', 'drive', 'look'];

const server = await startServer(args);
const browser = await launch({ browserName: args.browser ?? 'chromium', uncapped: !!args.uncapped });
const results = {};
try {
  for (const name of profiles) {
    for (let r = 0; r < repeat; r++) {
      const m = await runProfile(name);
      const prev = results[name];
      results[name] = prev ? merge(prev, m) : m;
    }
  }
} finally {
  await browser.close();
  await server.close();
}

// ---- compare
let failed = 0;
const rows = [];
for (const name of profiles) {
  const m = results[name];
  const b = budgetFile.profiles?.[name] ?? {};
  for (const ph of PHASES) {
    for (const k of PHASE_METRICS) rows.push(row(name, `${ph}.${k}`, m.phases[ph]?.[k], b.phases?.[ph]?.[k]));
  }
  for (const k of RUN_METRICS) rows.push(row(name, k, m[k], b[k]));
  if (m.errors.length) { failed++; rows.push([name, 'page errors', m.errors.join(' | ').slice(0, 50), '0', 'FAIL']); }
}
function row(profile, metric, v, lim) {
  const ok = lim === undefined || lim === null || v === undefined || v <= lim;
  if (!ok) failed++;
  return [profile, metric, v === undefined || v === null ? 'n/a' : fmt(metric, v), lim === undefined || lim === null ? '-' : fmt(metric, lim), ok ? 'ok' : 'OVER'];
}
function fmt(metric, v) {
  if (metric.endsWith('triangles')) return `${(v / 1000).toFixed(0)}k`;
  if (metric === 'bootMs') return `${(v / 1000).toFixed(1)} s`;
  if (metric === 'heapMB') return `${v} MB`;
  if (/frame|cpu|gpu/.test(metric)) return `${v.toFixed(1)} ms`;
  return String(v);
}
console.log(`\nperf budget (${repeat > 1 ? `best of ${repeat}` : 'one run'}; budgets from ${budgetPath.replace(root + '/', '')})`);
const w = [15, 20, 11, 11, 5];
console.log(['profile', 'metric', 'measured', 'budget', ''].map((s, i) => s.padEnd(w[i])).join(' '));
for (const r of rows) console.log(r.map((s, i) => String(s).padEnd(w[i])).join(' '));
for (const name of profiles) console.log(`${name}: ${results[name].gpu}`);

if (args.json) writeFileSync(resolve(root, args.json), JSON.stringify(results, null, 2));
if (args['write-budget'] !== undefined) {
  const out = budgetFile.profiles ? budgetFile : { profiles: {} };
  out.note = 'Budgets for scripts/perf-budget.mjs: what the scripted Downtown run measured, plus headroom (timings x2 (at least 1 ms of slack), counts x1.3, slow frames at least 6, heap x1.4 + 10 MB). Chromium on the dev box (AMD Radeon 8060S, Vulkan), frame-rate limit off. Regenerate with --write-budget after a change that is meant to cost more or less, and say why.';
  for (const name of profiles) {
    const m = results[name];
    const b = { phases: {} };
    for (const ph of PHASES) {
      b.phases[ph] = {};
      for (const k of PHASE_METRICS) {
        const v = m.phases[ph][k];
        b.phases[ph][k] = k === 'draws' ? Math.ceil((v * 1.3) / 10) * 10 : k === 'triangles' ? Math.ceil((v * 1.3) / 1e4) * 1e4 : k === 'slowFrames' ? Math.max(6, Math.ceil(v * 2)) : v === null ? null : +Math.max(v * headroom, v + 1).toFixed(1);
      }
    }
    b.bootMs = Math.round(m.bootMs * 2);
    b.heapMB = Math.ceil(m.heapMB * 1.4 + 10);
    b.geometries = Math.ceil(m.geometries * 1.3);
    b.textures = Math.max(8, Math.ceil(m.textures * 1.5));
    out.profiles[name] = b;
  }
  writeFileSync(budgetPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${budgetPath.replace(root + '/', '')} (x${headroom})`);
}
const warn = busyWarning();
if (warn) console.log(`\n${warn}`);
console.log(failed ? `\nFAIL: ${failed} over budget` : '\nPASS');
process.exit(failed && args['write-budget'] === undefined ? 1 : 0);

async function runProfile(name) {
  const { page, cdp, errors, profile, isCrashed } = await openProfile(browser, name, args);
  try {
    const bootMs = await boot(page, server.base, `graphics=${profile.tier}&start=car${args.query ? `&${args.query}` : ''}`);
    const gpu = await page.evaluate(() => window.__hood.game.gpuName);
    const tierOk = await page.evaluate(() => window.__hood.game.tier.name);
    if (tierOk !== profile.tier) throw new Error(`tier is ${tierOk}, wanted ${profile.tier}`);
    const phases = {};
    const phase = async (ph, fn) => {
      await page.evaluate((n) => window.__h.rec.begin(n), ph);
      await fn();
      phases[ph] = await page.evaluate(() => window.__h.rec.end());
      if (isCrashed()) throw new Error('the page crashed');
    };
    await page.waitForTimeout(3000); // shaders compile, the first snapshots arrive
    await phase('idle', () => page.waitForTimeout(4000));
    await phase('walk', () => page.evaluate(() => window.__h.bot.walkOutAndBack(60)));
    await page.evaluate(() => window.__h.bot.enterCar());
    await phase('drive', async () => {
      const inCar = await page.evaluate(() => window.__hood.game.view.inVehicle);
      if (!inCar) throw new Error('the bot could not get into the car');
      await page.evaluate(() => window.__h.bot.drive(40));
    });
    await page.evaluate(() => window.__h.bot.parkAndExit());
    await phase('look', () => page.evaluate(() => window.__h.bot.spin(6)));
    await gc(cdp);
    const mem = await page.evaluate(() => window.__h.memory());
    const driven = await page.evaluate(() => window.__h.bot.stats);
    return { bootMs, gpu, phases, heapMB: mem.heapMB ?? 0, geometries: mem.geometries, textures: mem.textures, errors, driven };
  } finally {
    await page.context().close();
  }
}

function merge(a, b) {
  const out = { ...b, phases: {} };
  for (const ph of PHASES) {
    out.phases[ph] = {};
    for (const k of Object.keys(b.phases[ph])) out.phases[ph][k] = TIMED.has(k) && typeof b.phases[ph][k] === 'number' ? Math.min(a.phases[ph][k], b.phases[ph][k]) : b.phases[ph][k];
  }
  out.bootMs = Math.min(a.bootMs, b.bootMs);
  out.errors = [...a.errors, ...b.errors];
  return out;
}
