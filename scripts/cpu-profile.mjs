#!/usr/bin/env node
/**
 * Where the main thread's time goes (docs/perf.md, "Main-thread CPU, profiled"). Runs the perf
 * harness's bot (walk, then drive) on a profile, and for each phase records
 *
 *   1. per-system time: every `System.update` and `lateUpdate` and the `renderer.render` call are
 *      wrapped with performance.now(), so the table is ms per frame by system (the wrappers cost a
 *      few microseconds a frame and are identical in every variant);
 *   2. a V8 sampling profile (CDP `Profiler`) of the same frames, from which it prints the inclusive
 *      time of the three.js phases (scene traversal and sort, shadow pass, program and uniform setup,
 *      draw submission), the self time by source file (three.js, our modules, the harness's own
 *      wrappers, GC, idle) and the top self-time functions.
 *
 *   node scripts/cpu-profile.mjs [--profile phone-low|desktop-high|desktop-medium|desktop-low]
 *                                [--query "gfx=classic&cars=box"] [--phases walk,drive] [--drive 25]
 *                                [--interval 200] [--top 25] [--incl 40] [--callers update,setup] [--json out.json] [--throttle 4]
 *
 * Timings are in ms per rendered frame (the CPU throttle, if any, is included). The dev server
 * serves unminified modules, so function names are real. Other jobs on the machine inflate every
 * number: the load average is printed.
 */
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { boot, gc, launch, openProfile, parseArgs, startServer } from './lib/harness.mjs';

const args = parseArgs();
const profileName = String(args.profile ?? 'phone-low');
const phaseNames = String(args.phases ?? 'walk,drive').split(',');
const interval = Number(args.interval ?? 200);
const top = Number(args.top ?? 25);
const driveS = Number(args.drive ?? 25);

const server = await startServer(args);
const browser = await launch({});
const load0 = loadavg()[0];
const out = {};
try {
  const { page, cdp, errors, profile } = await openProfile(browser, profileName, args);
  await boot(page, server.base, `graphics=${profile.tier}&start=car${args.query ? `&${args.query}` : ''}`);
  await page.evaluate(installSystemTimers);
  await page.waitForTimeout(3000);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval });
  for (const ph of phaseNames) {
    if (ph === 'drive') await page.evaluate(() => window.__h.bot.enterCar());
    await page.evaluate(() => window.__sys.reset());
    await cdp.send('Profiler.start');
    if (args.alloc) await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048 });
    if (ph === 'idle') await page.waitForTimeout(5000);
    else if (ph === 'walk') await page.evaluate(() => window.__h.bot.walkOutAndBack(60));
    else if (ph === 'drive') await page.evaluate((s) => window.__h.bot.drive(s), driveS);
    else if (ph === 'look') await page.evaluate(() => window.__h.bot.spin(6));
    const { profile: prof } = await cdp.send('Profiler.stop');
    const sys = await page.evaluate(() => window.__sys.report());
    out[ph] = { sys, prof: analyse(prof, sys.frames) };
    if (args.alloc) out[ph].alloc = allocByFunction((await cdp.send('HeapProfiler.stopSampling')).profile, sys.frames);
    if (ph === 'drive') await page.evaluate(() => window.__h.bot.parkAndExit());
  }
  await gc(cdp);
  if (errors.length) console.log('page errors:', errors.join(' | ').slice(0, 300));
  await page.context().close();
} finally {
  await browser.close();
  await server.close();
}

console.log(`\ncpu profile: ${profileName}${args.query ? `  query: ${args.query}` : ''}  (load average ${load0.toFixed(2)} at start, ${loadavg()[0].toFixed(2)} at end)`);
for (const ph of phaseNames) {
  const r = out[ph];
  console.log(`\n=== ${ph}: ${r.sys.frames} frames, main-thread ${r.sys.tickMs.toFixed(2)} ms/frame (profile: ${r.prof.perFrame.total.toFixed(2)} ms/frame busy, ${r.prof.perFrame.idle.toFixed(2)} idle)`);
  console.log(`-- frame cost p50 ${r.sys.p50.toFixed(2)} p95 ${r.sys.p95.toFixed(2)} p99 ${r.sys.p99.toFixed(2)} max ${r.sys.max.toFixed(2)} ms; the biggest part of the frames at or over p95: ${r.sys.spikeTop.map(([n, c]) => `${n} x${c}`).join(', ')}`);
  for (const w of r.sys.spikeWorst) console.log(`   worst: ${w}`);
  console.log('-- per system, ms/frame (update + lateUpdate)');
  for (const [n, v] of r.sys.systems.slice(0, 18)) console.log(`   ${n.padEnd(28)} ${v.toFixed(3)}`);
  console.log(`   ${'(renderer.render)'.padEnd(28)} ${r.sys.render.toFixed(3)}`);
  console.log('-- inclusive, ms/frame (sampling profile)');
  for (const [n, v] of r.prof.phases) console.log(`   ${n.padEnd(40)} ${v.toFixed(3)}`);
  for (const [fn, list] of Object.entries(r.prof.callers ?? {})) {
    console.log(`-- callers of ${fn}, ms/frame`);
    for (const [n, v] of list) console.log(`   ${n.padEnd(40)} ${v.toFixed(3)}`);
  }
  if (args.incl) {
    console.log('-- top inclusive functions, ms/frame');
    for (const [n, v] of r.prof.topIncl.slice(0, Number(args.incl) || 40)) console.log(`   ${n.padEnd(64)} ${v.toFixed(3)}`);
  }
  if (r.alloc) {
    console.log('-- allocation by function (sampled, KB/frame)');
    for (const [n, v] of r.alloc.slice(0, 22)) console.log(`   ${n.padEnd(64)} ${v.toFixed(2)}`);
  }
  console.log('-- self time by source, ms/frame');
  for (const [n, v] of r.prof.bySource.slice(0, 14)) console.log(`   ${n.padEnd(40)} ${v.toFixed(3)}`);
  console.log('-- top self-time functions, ms/frame');
  for (const [n, v] of r.prof.topSelf.slice(0, top)) console.log(`   ${n.padEnd(64)} ${v.toFixed(3)}`);
}
if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 2));

/** Runs in the page: wraps every system's update and lateUpdate, and the render call. */
function installSystemTimers() {
  const game = window.__hood.game;
  const acc = new Map();
  let cur = new Map();
  const slow = [];
  let allTick = [];
  let frames = 0;
  let render = 0;
  let tick = 0;
  for (const s of game.systems) {
    for (const k of ['update', 'lateUpdate']) {
      const fn = s[k];
      if (typeof fn !== 'function') continue;
      s[k] = function (dt) {
        const t0 = performance.now();
        fn.call(this, dt);
        const d = performance.now() - t0;
        acc.set(s.name, (acc.get(s.name) ?? 0) + d);
        cur.set(s.name, (cur.get(s.name) ?? 0) + d);
      };
    }
  }
  const r = game.renderer.render;
  game.renderer.render = function (...a) {
    const t0 = performance.now();
    r.apply(this, a);
    const d = performance.now() - t0;
    render += d;
    cur.set('(render)', (cur.get('(render)') ?? 0) + d);
  };
  let lastFrame = game.frame;
  const loop = () => {
    requestAnimationFrame(loop);
    if (game.frame !== lastFrame) {
      frames += game.frame - lastFrame;
      lastFrame = game.frame;
      tick += game.cpuMs;
      allTick.push(game.cpuMs);
      if (game.cpuMs > 0) slow.push({ ms: game.cpuMs, sys: [...cur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ') });
      cur = new Map();
    }
  };
  requestAnimationFrame(loop);
  window.__sys = {
    reset() { acc.clear(); frames = 0; render = 0; tick = 0; lastFrame = game.frame; slow.length = 0; allTick = []; cur = new Map(); },
    report() {
      const f = Math.max(1, frames);
      const sorted = allTick.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const spikes = slow.filter((x) => x.ms >= p95).sort((a, b) => b.ms - a.ms);
      const tally = new Map();
      for (const x of spikes) { const k = x.sys.split(',')[0].replace(/ [\d.]+$/, ''); tally.set(k, (tally.get(k) ?? 0) + 1); }
      return { frames, p50: sorted[sorted.length >> 1] ?? 0, p95, p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0, max: sorted[sorted.length - 1] ?? 0, spikeTop: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), spikeWorst: spikes.slice(0, 6).map((x) => `${x.ms.toFixed(1)} ms: ${x.sys}`), tickMs: tick / f, render: render / f, systems: [...acc.entries()].map(([n, v]) => [n, v / f]).sort((a, b) => b[1] - a[1]) };
    },
  };
}

/** Folds a V8 cpuprofile into inclusive phase times, self time by source and the top self-time functions (ms per frame). */
function analyse(prof, frames) {
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const f = Math.max(1, frames);
  const self = new Map(); // node id -> ms
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = (prof.timeDeltas[i + 1] ?? prof.timeDeltas[i]) / 1000;
    self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + dt);
  }
  const fname = (n) => n.callFrame.functionName || '(anonymous)';
  const src = (n) => {
    const u = n.callFrame.url || '';
    if (!u) return fname(n).startsWith('(') ? fname(n) : '(harness/eval)';
    if (/node_modules\/\.vite\/deps\/three|node_modules\/three\//.test(u)) return 'three.js';
    const s = u.match(/\/src\/(.*?)(\?|$)/);
    if (s) return `src/${s[1]}`;
    const c = u.match(/node_modules\/(?:\.vite\/deps\/)?([^?/]*)/);
    if (c) return `lib:${c[1]}`;
    return u.replace(/^https?:\/\/[^/]+/, '').slice(0, 40);
  };
  const bySource = new Map();
  const bySelfFn = new Map();
  let total = 0;
  let idle = 0;
  for (const [id, ms] of self) {
    const n = nodes.get(id);
    const name = fname(n);
    if (name === '(idle)') { idle += ms; continue; }
    total += ms;
    const s = src(n);
    bySource.set(s, (bySource.get(s) ?? 0) + ms);
    const key = `${name} [${s}]`;
    bySelfFn.set(key, (bySelfFn.get(key) ?? 0) + ms);
  }
  // inclusive time per function name, each sample counted once per distinct name on its stack
  const incl = new Map();
  for (const [id, ms] of self) {
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const k = fname(nodes.get(cur));
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + ms);
    }
  }
  const PHASES = [
    ['tick (whole frame)', 'tick'],
    ['renderer.render (three)', 'render'],
    ['  projectObject (traverse/cull/sort)', 'projectObject'],
    ['  list sort', 'sort'],
    ['  shadow pass', 'render$1'],
    ['  renderObjects', 'renderObjects'],
    ['  renderObject', 'renderObject'],
    ['  renderBufferDirect', 'renderBufferDirect'],
    ['  setProgram', 'setProgram'],
    ['  getProgram', 'getProgram'],
    ['  uniforms upload', 'upload'],
    ['  updateMatrixWorld', 'updateMatrixWorld'],
    ['  setRenderTarget', 'setRenderTarget'],
    ['  GC', '(garbage collector)'],
  ];
  // who calls the functions asked for with --callers (a comma list): self+children time by caller, per frame
  const callers = {};
  for (const want of String(args.callers ?? '').split(',').filter(Boolean)) {
    const byCaller = new Map();
    for (const [id, ms] of self) {
      // walk up: find the nearest ancestor named `want`, then its parent's name
      let cur = id;
      let hit = null;
      for (; cur !== undefined; cur = parent.get(cur)) if (fname(nodes.get(cur)) === want) hit = cur;
      if (hit === null) continue;
      const p = parent.get(hit);
      const key = p === undefined ? '(none)' : `${fname(nodes.get(p))}`;
      byCaller.set(key, (byCaller.get(key) ?? 0) + ms);
    }
    callers[want] = [...byCaller.entries()].map(([n, v]) => [n, v / f]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }
  return {
    callers,
    perFrame: { total: total / f, idle: idle / f },
    phases: PHASES.map(([label, key]) => [label, (incl.get(key) ?? 0) / f]),
    bySource: [...bySource.entries()].map(([n, v]) => [n, v / f]).sort((a, b) => b[1] - a[1]),
    topIncl: [...incl.entries()].map(([n, v]) => [n, v / f]).sort((a, b) => b[1] - a[1]),
    topSelf: [...bySelfFn.entries()].map(([n, v]) => [n, v / f]).sort((a, b) => b[1] - a[1]),
  };
}

/** Sampled heap allocation (live and dead: the sampler sees allocations as they happen) by function, KB per frame. */
function allocByFunction(profile, frames) {
  const by = new Map();
  const walk = (n) => {
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} [${(cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/.*\//, '').slice(0, 30)}:${cf.lineNumber + 1}]`;
    by.set(key, (by.get(key) ?? 0) + n.selfSize);
    for (const c of n.children ?? []) walk(c);
  };
  walk(profile.head);
  return [...by.entries()].map(([k, v]) => [k, v / 1024 / Math.max(1, frames)]).sort((a, b) => b[1] - a[1]);
}
