#!/usr/bin/env node
/**
 * Soak: a scripted player plays Downtown for N minutes (default 5): out of the car and on foot,
 * back in, driving the streets, parking, again and again. FAILS when the page crashes or logs an
 * error, when frame cost drifts up, or when memory keeps growing. Port of Skyrome's soak.
 *
 *   node scripts/soak.mjs [--minutes 5] [--profile desktop-medium] [--warmup 1] [--interval 15]
 *                         [--uncapped] [--budget scripts/perf-budget.json] [--dist] [--url <base>]
 *
 * Every `--interval` seconds (default 15) it forces a full GC (CDP) and records, for the window just
 * ended: frame time p50/p95 (between animation frames), main-thread CPU ms per frame (mean, p95),
 * slow frames, the JS heap, the renderer's geometries and textures, scene objects and entities.
 * Verdict, with limits from the `soak` section of scripts/perf-budget.json:
 *   frame drift   the lowest main-thread cost per draw call (CPU ms per frame / draws per frame, in
 *                 microseconds) among the windows of the last third is at most `cpuDriftRatio` x the lowest
 *                 of the first third (after the warm-up), plus `cpuDriftSlackUs`. Best windows, because other
 *                 programs on the machine only ever add to a window's cost.
 *   heap growth   the same medians of the JS heap grew by at most `heapGrowthMB` (and less than
 *                 `heapSlopeMBPerMin` a minute, over the whole run after the warm-up)
 *   GPU objects   geometries the renderer holds that the scene no longer draws (uploaded, then removed without
 *                 dispose) and textures grew by at most `gpuObjectGrowth`. The raw geometry count is not judged: it
 *                 rises once for every chunk the camera first sees (see page.mjs, memory()).
 *   progress      the bot drove at least `minDriveMetresPerMin` metres a minute
 * Chromium only (performance.memory). It plays at the display's rate; the CPU ms per frame is the number
 * that shows drift (frame time stays at 16.7 until the frame cost reaches it).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, busyWarning, gc, launch, median, openProfile, parseArgs, root, startServer } from './lib/harness.mjs';

const args = parseArgs();
const minutes = Number(args.minutes ?? 5);
const warmup = Number(args.warmup ?? Math.min(1, minutes / 4));
const interval = Number(args.interval ?? 15);
const profileName = String(args.profile ?? 'desktop-medium');
const budgetPath = resolve(root, args.budget ?? 'scripts/perf-budget.json');
const budget = { cpuDriftRatio: 1.3, cpuDriftSlackUs: 1.5, heapGrowthMB: 30, heapSlopeMBPerMin: 6, gpuObjectGrowth: 8, minDriveMetresPerMin: 60, ...(existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')).soak : {}) };

const server = await startServer(args);
const browser = await launch({ uncapped: !!args.uncapped });
const { page, cdp, errors, profile, isCrashed } = await openProfile(browser, profileName, args);
const t0 = Date.now();
const bootMs = await boot(page, server.base, `graphics=${profile.tier}&start=car`);
console.log(`booted in ${(bootMs / 1000).toFixed(1)} s (${profileName}, ${minutes} min, a sample every ${interval} s)`);
await page.waitForTimeout(2000);

// The bot, looping: in, drive, park, out, walk out and back, look round.
await page.evaluate(() => {
  const s = (window.__soak = { stop: false, cycles: 0, error: null });
  const b = window.__h.bot;
  (async () => {
    try {
      while (!s.stop) {
        await b.enterCar();
        await b.drive(45);
        await b.parkAndExit();
        await b.walkOutAndBack(50);
        await b.spin(4);
        s.cycles++;
      }
    } catch (e) {
      s.error = String(e && e.stack || e);
    }
  })();
});

const rows = [];
const total = Math.round((minutes * 60) / interval);
for (let w = 1; w <= total; w++) {
  await page.evaluate(() => window.__h.rec.begin('w'));
  await page.waitForTimeout(interval * 1000);
  if (isCrashed()) break;
  let r;
  try {
    r = await page.evaluate(() => window.__h.rec.end());
    await gc(cdp);
    const mem = await page.evaluate(() => window.__h.memory());
    const bot = await page.evaluate(() => ({ ...window.__h.bot.stats, cycles: window.__soak.cycles, error: window.__soak.error }));
    r = { ...r, ...mem, bot };
  } catch (e) {
    console.log(`window ${w}: the page is gone (${e.message.split('\n')[0]})`);
    break;
  }
  r.cpuPerDraw = +((r.cpuMean / Math.max(1, r.drawsMean)) * 1000).toFixed(2);
  rows.push({ w, t: (w * interval) / 60, ...r });
  console.log(`${(rows.at(-1).t).toFixed(2).padStart(5)} min: frame p50 ${r.frameP50} p95 ${r.frameP95} ms (${r.frames} frames, ${r.slowFrames} slow) · cpu ${r.cpuMean}/${r.cpuP95} ms (${r.cpuPerDraw} us/draw) · draws ${r.drawsMean}/${r.draws} · heap ${r.heapMB} MB · geo ${r.geometries} (unused ${r.unusedGeometries}) tex ${r.textures} obj ${r.objects} ent ${r.entities} · sim step max ${r.simStepMax} ms · driven ${Math.round(r.bot.driven)} m walked ${Math.round(r.bot.walked)} m cycles ${r.bot.cycles} stuck ${r.bot.stuckEvents}`);
}
const botError = await page.evaluate(() => window.__soak.error).catch(() => null);
const crashed = isCrashed();
await browser.close();
await server.close();

// ---- verdict
const fails = [];
if (crashed) fails.push('the page crashed');
if (rows.length < total) fails.push(`only ${rows.length} of ${total} windows ran`);
if (botError) fails.push(`the bot failed: ${botError.split('\n')[0]}`);
const pageErrors = [...new Set(errors)];
if (pageErrors.length) fails.push(`${pageErrors.length} page error(s): ${pageErrors[0].slice(0, 120)}`);
const after = rows.filter((r) => r.t > warmup);
let summary = '';
if (after.length >= 6) {
  const third = Math.max(3, Math.floor(after.length / 3));
  const first = after.slice(0, third);
  const last = after.slice(-third);
  const m = (a, k) => median(a.map((r) => r[k]));
  // What a view costs depends on where the bot is (150 draws in a quiet street, 500 at a crossing), so judge the cost per draw call.
  // Other programs on the machine only ever add to a window's cost, so compare each third's best window.
  const cpu0 = Math.min(...first.map((r) => r.cpuPerDraw)), cpu1 = Math.min(...last.map((r) => r.cpuPerDraw));
  const heap0 = m(first, 'heapMB'), heap1 = m(last, 'heapMB');
  const minsSpan = Math.max(1 / 60, after.at(-1).t - after[0].t);
  const slope = (heap1 - heap0) / minsSpan;
  const geo = last.at(-1).geometries - first[0].geometries;
  const unused = last.at(-1).unusedGeometries - first[0].unusedGeometries;
  const tex = last.at(-1).textures - first[0].textures;
  const driven = rows.at(-1).bot.driven / (rows.at(-1).t || 1);
  summary = `cpu ${cpu0} -> ${cpu1} us/draw (limit ${(cpu0 * budget.cpuDriftRatio + budget.cpuDriftSlackUs).toFixed(2)}), frame p50 ${m(first, 'frameP50')} -> ${m(last, 'frameP50')} ms, heap ${heap0} -> ${heap1} MB (${slope.toFixed(1)} MB/min, limits ${budget.heapGrowthMB} MB and ${budget.heapSlopeMBPerMin}/min), geometries ${geo >= 0 ? '+' : ''}${geo} (${unused >= 0 ? '+' : ''}${unused} unused), textures ${tex >= 0 ? '+' : ''}${tex}, driven ${driven.toFixed(0)} m/min`;
  if (cpu1 > cpu0 * budget.cpuDriftRatio + budget.cpuDriftSlackUs) fails.push(`frame cost drifted up (${cpu0} -> ${cpu1} us per draw call)`);
  if (heap1 - heap0 > budget.heapGrowthMB || slope > budget.heapSlopeMBPerMin) fails.push(`heap grew ${(heap1 - heap0).toFixed(1)} MB (${slope.toFixed(1)} MB/min)`);
  if (unused > budget.gpuObjectGrowth) fails.push(`${unused} geometries uploaded and left out of the scene (not disposed)`);
  if (tex > budget.gpuObjectGrowth) fails.push(`textures grew by ${tex}`);
  if (minutes >= 2 && driven < budget.minDriveMetresPerMin) fails.push(`the bot drove only ${driven.toFixed(0)} m/min (stuck?)`);
} else {
  summary = `too few windows after the ${warmup} min warm-up to judge drift (${after.length}; need 6): run longer`;
  if (minutes >= 3) fails.push('not enough windows to judge');
}
console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${minutes} min on ${profileName} in ${((Date.now() - t0) / 60000).toFixed(1)} min wall · ${summary}`);
for (const f of fails) console.log(`  - ${f}`);
const warn = busyWarning();
if (warn) console.log(warn);
process.exit(fails.length ? 1 : 0);
