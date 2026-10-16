/**
 * The ground audit's runner: drives every lane at each speed in worker threads (one region of the tile per worker), scans
 * the surfaces and the buildings, and writes `ground-audit.json` and `ground-heat.png`. `scripts/ground-audit.mjs` bundles
 * this file and runs it (`npm run audit:ground`); the same bundle is the worker script.
 *
 *   --tile <dir>       the tile (default public/tiles/atlanta/m1-five-points)
 *   --speeds 15,25,35  target speeds, m/s
 *   --out <dir>        where the report and the heat map go (default .shots/ground)
 *   --workers <n>      threads (default: the cores less two, at most 30)
 *   --quick            a sample: every 12th edge, at 25 m/s
 *   --gate             exit 1 when a gate fails (see GATES)
 *   --no-edge-fix      build the ground and the trimesh without FIX_INTERNAL_EDGES (the physics before the fix)
 *   --no-guard         keep the cars' crash guard on (soft CCD and the crash restitution always: the physics before round four)
 *   --trace            write every launch's last 45 ticks (wheels, springs, tyres, the hull's pushes) to ground-traces.json
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadBakedTile, type TileData } from '../../../src/shared/tile';
import { initRapier } from '../../../src/sim/physics/rapier';
import { clusterSpots, countEvents, driveLanes, Graph, GroundWorld, scanBuildings, scanProps, scanSurfaces, shardEdges, type DriveStats, type GroundEvent } from './core';
import { Raster } from './png';

/**
 * What `--gate` (and `npm run verify` in tools/pipeline) fails on. No lane, junction curve or main road may run into a building,
 * and no launch may happen on smooth road (`classifyLaunch`: a launch where the ground was continuous under every wheel and the
 * hull clear of it is a physics bug). The rest is a ratchet at what the tile measures now (2026-10-16, round four, the crash guard:
 * 131 launches over 1292 km, every one at a seam, a crest or a crash; round three 247 and 225 on this bake, round two 255, round
 * one 778), a few percent over it so a new bake's spread passes and a regression does not; lower them as the residuals go
 * (docs/ground-audit.md lists them). The goal is zero launches.
 */
export const GATES = {
  launches: 145,
  smoothLaunches: 0,
  mainRoadsInBuildings: 0,
  lanesInBuildings: 0,
  /** lanes with a step in the surface under a wheel track over 4 cm */
  steps: 135,
  /** hard jolts and pitch or roll kicks per 10 km driven */
  joltsPer10km: 12.5,
  /** pushes of the hull by static collision that is not a wall, per 10 km */
  contactsPer10km: 2.2,
  /** routes given up (stuck, off the road, upside down) while measuring a lane, share */
  abortShare: 0.075,
};

export const fsFetch = async (url: string) => {
  const p = existsSync(url) ? url : url.replace(/^\/?/, '');
  const ok = existsSync(p);
  const buf = ok ? readFileSync(p) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

export async function loadTile(dir: string): Promise<TileData> {
  return loadBakedTile(dir, fsFetch as never);
}

interface Job { tile: string; speed: number; targets: number[]; maxRoutes?: number; fixInternalEdges?: boolean; trace?: boolean; noGuard?: boolean }
interface JobResult { events: GroundEvent[]; stats: DriveStats }

async function runJob(job: Job): Promise<JobResult> {
  const R = await initRapier();
  const tile = await loadTile(job.tile);
  const gw = new GroundWorld(R, tile, { fixInternalEdges: job.fixInternalEdges });
  const g = new Graph(tile);
  return driveLanes(gw, g, { speed: job.speed, targets: job.targets, maxRoutes: job.maxRoutes, trace: job.trace, noGuard: job.noGuard });
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const KIND_COLOR: Record<string, [number, number, number]> = {
  air: [255, 40, 40], launch: [255, 0, 120], jolt: [255, 150, 0], kick: [255, 230, 0], contact: [230, 60, 255], abort: [255, 255, 255],
  building: [0, 220, 255], step: [60, 255, 90], crest: [40, 140, 255], mismatch: [150, 255, 200], prop: [255, 160, 220],
};

/** A top-down heat map: footprints dark, lanes grey, every event a dot coloured by kind and sized by speed. */
export function heatMap(tile: TileData, events: GroundEvent[], scale = 2): Uint8Array {
  const b = tile.manifest.bounds;
  const W = Math.ceil((b.maxX - b.minX) / scale), H = Math.ceil((b.maxZ - b.minZ) / scale);
  const img = new Raster(W, H, [18, 20, 24]);
  const X = (x: number) => (x - b.minX) / scale, Z = (z: number) => (z - b.minZ) / scale;
  const P = tile.collisionPositions, I = tile.collisionIndices;
  const nb = tile.manifest.collision.buildingTriangles ?? 0;
  for (let t = 0; t < nb; t++) {
    const a = I[t * 3] * 3, c = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
    if (Math.abs(P[a + 1] - P[c + 1]) > 1e-3 || Math.abs(P[c + 1] - P[d + 1]) > 1e-3) continue;
    img.triangle(X(P[a]), Z(P[a + 2]), X(P[c]), Z(P[c + 2]), X(P[d]), Z(P[d + 2]), [62, 64, 74]);
  }
  for (const e of tile.lanes?.edges ?? []) {
    const p = e.pts;
    const col: [number, number, number] = (e as { bridge?: number }).bridge ? [120, 110, 150] : [96, 100, 104];
    for (let k = 0; k + 3 < p.length; k += 3) img.line(X(p[k]), Z(p[k + 2]), X(p[k + 3]), Z(p[k + 5]), col, 0.8);
  }
  const order = ['mismatch', 'step', 'crest', 'prop', 'contact', 'kick', 'jolt', 'building', 'abort', 'launch', 'air'];
  for (const kind of order) {
    for (const e of events) {
      if (e.kind !== kind) continue;
      const c = KIND_COLOR[kind] ?? [255, 255, 255];
      const r = e.speed ? 1.5 + e.speed / 12 : 2.5;
      img.disc(X(e.x), Z(e.z), r, c, 0.75);
      if (kind === 'air' || kind === 'launch' || kind === 'building') img.ring(X(e.x), Z(e.z), r + 3, c, 0.9);
    }
  }
  // legend: one swatch per kind along the top edge, in `order`
  order.forEach((k, i) => { for (let y = 4; y < 14; y++) for (let x = 4 + i * 16; x < 14 + i * 16; x++) img.plot(x, y, KIND_COLOR[k]); });
  return img.png();
}

export interface GroundReport {
  tile: string;
  speeds: number[];
  quick: boolean;
  drive: DriveStats[];
  counts: ReturnType<typeof countEvents>;
  /** the numbers the gates judge */
  gate: Record<string, number>;
  failed: string[];
  spots: ReturnType<typeof clusterSpots>;
  events: GroundEvent[];
  seconds: number;
}

/** Turns the events into the gate numbers. */
export function gateNumbers(events: GroundEvent[], drive: DriveStats[]): { gate: Record<string, number>; failed: string[] } {
  const metres = drive.reduce((s, d) => s + d.metres, 0);
  const routes = drive.reduce((s, d) => s + d.routes, 0);
  const n = (f: (e: GroundEvent) => boolean) => events.filter(f).length;
  const gate = {
    launches: n((e) => e.kind === 'air' || e.kind === 'launch'),
    /** launches and airborne episodes where the ground was smooth (see `classifyLaunch`): physics bugs, none allowed */
    smoothLaunches: n((e) => (e.kind === 'air' || e.kind === 'launch') && e.ground === 'smooth'),
    mainRoadsInBuildings: n((e) => e.kind === 'building' && (e.cause === 'main-road-in-building' || e.cause === 'main-road-dead-ends-at-building')),
    lanesInBuildings: n((e) => e.kind === 'building' && e.edge >= 0),
    steps: n((e) => e.kind === 'step'),
    joltsPer10km: metres > 0 ? (n((e) => e.kind === 'jolt' || e.kind === 'kick') / metres) * 10000 : 0,
    contactsPer10km: metres > 0 ? (n((e) => e.kind === 'contact' && !/^building/.test(e.detail ?? '')) / metres) * 10000 : 0,
    // (a route given up while the car was measuring a lane on the tile: one that leaves the tile, or fails on the way to a lane
    // it was sent to, is not the ground's fault and is not counted)
    abortShare: routes > 0 ? n((e) => e.kind === 'abort') / routes : 0,
  };
  const failed = Object.entries(gate).filter(([k, v]) => v > GATES[k as keyof typeof GATES] + 1e-9).map(([k, v]) => `${k} ${Math.round(v * 1000) / 1000} > ${GATES[k as keyof typeof GATES]}`);
  return { gate, failed };
}

export async function main(argv: string[]): Promise<GroundReport> {
  const t0 = performance.now();
  const tileDir = arg('tile', argv) ?? 'public/tiles/atlanta/m1-five-points';
  const quick = argv.includes('--quick');
  // the physics as it was before the internal-edge fix (for a before-and-after on one tile)
  const noEdgeFix = argv.includes('--no-edge-fix');
  // every launch's last ticks (each wheel's query, spring and tyre; the hull's solver contacts) into ground-traces.json
  const trace = argv.includes('--trace');
  // the physics before the crash guard (RaycastCar's GUARD), for a before-and-after
  const noGuard = argv.includes('--no-guard');
  const speeds = (arg('speeds', argv) ?? (quick ? '25' : '15,25,35')).split(',').map(Number);
  const out = arg('out', argv) ?? '.shots/ground';
  const workers = Number(arg('workers', argv) ?? Math.max(1, Math.min(30, os.cpus().length - 2)));
  const log = (m: string) => console.log(`[ground ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const tile = await loadTile(tileDir);
  const g = new Graph(tile);
  const all = g.edges.map((_, i) => i).filter((i) => !quick || i % 12 === 0);
  const perSpeed = Math.max(1, Math.floor(workers / speeds.length));
  const shards = shardEdges(g, perSpeed).map((s) => s.filter((i) => all.includes(i)));
  log(`${tileDir}: ${g.edges.length} edges, ${all.length} to drive at ${speeds.join(', ')} m/s on ${perSpeed * speeds.length} threads`);

  const self = fileURLToPath(import.meta.url);
  const jobs: Promise<JobResult>[] = [];
  for (const speed of speeds) {
    for (const targets of shards) {
      if (!targets.length) continue;
      jobs.push(new Promise<JobResult>((resolve, reject) => {
        const w = new Worker(self, { workerData: { tile: tileDir, speed, targets, fixInternalEdges: !noEdgeFix, trace, noGuard } satisfies Job });
        w.once('message', (r: JobResult) => resolve(r));
        w.once('error', reject);
        w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
      }));
    }
  }
  // the static scans, here, while the cars drive
  const R = await initRapier();
  const gw = new GroundWorld(R, tile, { fixInternalEdges: !noEdgeFix });
  const surfaces = scanSurfaces(gw, g, speeds, all);
  const buildings = scanBuildings(gw, g).filter((e) => e.edge < 0 || all.includes(e.edge));
  const props = scanProps(gw, g).filter((e) => all.includes(e.edge));
  log(`static scans: ${surfaces.length} surface findings, ${buildings.length} building findings, ${props.length} props in lanes`);
  const results = await Promise.all(jobs);
  const drive: DriveStats[] = speeds.map((speed) => {
    const rs = results.filter((r) => r.stats.speed === speed).map((r) => r.stats);
    const ticks = rs.reduce((s, r) => s + r.ticks, 0);
    return {
      speed, edges: rs.reduce((s, r) => s + r.edges, 0), covered: rs.reduce((s, r) => s + r.covered, 0), routes: rs.reduce((s, r) => s + r.routes, 0),
      aborted: rs.reduce((s, r) => s + r.aborted, 0), metres: Math.round(rs.reduce((s, r) => s + r.metres, 0)), ticks,
      vMax: Math.max(...rs.map((r) => r.vMax)), vMean: ticks ? rs.reduce((s, r) => s + r.vMean * r.ticks, 0) / ticks : 0, ms: Math.max(...rs.map((r) => r.ms)),
    };
  });
  const events = [...results.flatMap((r) => r.events), ...surfaces, ...buildings, ...props];
  const counts = countEvents(events);
  const { gate, failed } = gateNumbers(events, drive);
  const spots = clusterSpots(events.filter((e) => e.kind !== 'mismatch'));
  const report: GroundReport = { tile: tileDir, speeds, quick, drive, counts, gate, failed, spots: spots.slice(0, 200), events, seconds: (performance.now() - t0) / 1000 };
  mkdirSync(out, { recursive: true });
  const traced = events.filter((e) => e.trace);
  if (trace) writeFileSync(path.join(out, 'ground-traces.json'), JSON.stringify(traced));
  writeFileSync(path.join(out, 'ground-audit.json'), JSON.stringify({ ...report, events: events.map(({ trace: _t, ...e }) => e) }, null, 1));
  writeFileSync(path.join(out, 'ground-heat.png'), heatMap(tile, events));
  for (const d of drive) log(`drive ${d.speed} m/s: ${d.covered}/${d.edges} edges, ${(d.metres / 1000).toFixed(1)} km, ${d.routes} routes (${d.aborted} given up), mean ${d.vMean.toFixed(1)} m/s, max ${d.vMax.toFixed(1)}`);
  log(`by kind ${JSON.stringify(counts.byKind)}`);
  for (const [k, c] of Object.entries(counts.byKindCause)) log(`  ${k}: ${JSON.stringify(Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1])))}`);
  log(`by speed ${JSON.stringify(counts.bySpeed)}`);
  log(`launches by ground ${JSON.stringify(counts.launchGround)}`);
  log(`launches by origin ${JSON.stringify(counts.launchOrigin)}`);
  for (const e of events.filter((x) => x.ground === 'smooth')) log(`  on smooth road: ${e.kind} ${e.origin} at (${e.x.toFixed(0)}, ${e.z.toFixed(0)}) ${e.speed} m/s (${e.v.toFixed(1)}) ${e.road} ${e.cause}`);
  log(`worst spots:`);
  for (const s of spots.slice(0, 15)) log(`  (${s.x}, ${s.z}) n=${s.n} ${JSON.stringify(s.kinds)} ${JSON.stringify(s.causes)} ${s.roads.join(' ')}`);
  log(`gate ${JSON.stringify(Object.fromEntries(Object.entries(gate).map(([k, v]) => [k, Math.round(v * 1000) / 1000])))}`);
  log(failed.length ? `GATE FAILED: ${failed.join('; ')}` : 'gate passed');
  log(`wrote ${path.join(out, 'ground-audit.json')} and ${path.join(out, 'ground-heat.png')}`);
  return report;
}

if (!isMainThread && workerData) {
  runJob(workerData as Job).then((r) => parentPort!.postMessage(r));
}
