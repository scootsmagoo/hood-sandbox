/**
 * The ground audit across tile seams (docs/ground-audit.md, docs/contracts/city-tiles.md section 4): a physics sedan drives every
 * lane that crosses a seam of the streamed fixture city, at 15, 25 and 35 m/s, with the ground audit's own driver and checks
 * (`driveLanes`: air, launch, jolt, kick, hull pushes), on the streamed physics: a heightfield per tile for the wheels and people,
 * and the car-ground window, cut again round the car as it drives (the swap happens under it), for its hull. Nothing may happen at a
 * seam; and the same drive on the city baked as one tile (one heightfield, no seams) is the control.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpTileSource } from '../../src/sim/stream/TileSource';
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import type { LaneEdgeAny, LanesData } from '../../src/shared/lanes';
import type { TileData } from '../../src/shared/tile';
import { initRapier } from '../../src/sim/physics/rapier';
import { TileStreamer } from '../../src/sim/stream/TileStreamer';
import { CAR_GROUND } from '../../src/sim/stream/StreamPhysics';
import { FixtureTileSource } from '../../src/sim/stream/TileSource';
import { driveLanes, Graph, GroundWorld, type GroundEvent } from '../audit/ground/core';

const BAD = new Set(['air', 'launch', 'jolt', 'kick', 'contact']);

/** The fixture's tiles as one tile: one heightmap over the whole city, the lane graph as the streamer stitched it. */
function mergedTile(st: TileStreamer, opts: { collision?: boolean } = {}): TileData {
  const tiles = [...st.tiles.values()].map((r) => r.data!.tile);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const t of tiles) {
    const b = t.manifest.bounds;
    minX = Math.min(minX, b.minX); minZ = Math.min(minZ, b.minZ); maxX = Math.max(maxX, b.maxX); maxZ = Math.max(maxZ, b.maxZ);
  }
  const cell = tiles[0].manifest.heightmap.cellSize;
  const cols = Math.round((maxX - minX) / cell) + 1, rows = Math.round((maxZ - minZ) / cell) + 1;
  const heights = new Float32Array(cols * rows);
  for (const t of tiles) {
    const hm = t.manifest.heightmap;
    const c0 = Math.round((hm.minX - minX) / cell), r0 = Math.round((hm.minZ - minZ) / cell);
    for (let r = 0; r < hm.rows; r++) for (let c = 0; c < hm.cols; c++) heights[(r0 + r) * cols + c0 + c] = t.heights[r * hm.cols + c];
  }
  const edges: LaneEdgeAny[] = [];
  for (const r of st.tiles.values()) {
    const range = r.lanes!;
    r.data!.tile.lanes!.edges.forEach((e, i) => {
      const gi = range.base + i;
      const next = Array.from(st.lanes.next[gi]);
      edges[gi] = e.t === 0 ? { ...e, next } : { ...e, next, from: e.from + range.base, to: e.to + range.base, c: [], y: [], m: [] };
    });
  }
  const lanes: LanesData = { format: 'hood-lanes', version: 1, edges, junctions: [] };
  const base = tiles[0];
  // the collision meshes, buildings of every tile first, then every tile's decks (as one tile's)
  const pos: number[] = [];
  const bIdx: number[] = [], dIdx: number[] = [];
  for (const t of tiles) {
    const v0 = pos.length / 3;
    for (const v of t.collisionPositions) pos.push(v);
    const bt = t.manifest.collision.buildingTriangles ?? t.collisionIndices.length / 3;
    t.collisionIndices.forEach((v, k) => (k < bt * 3 ? bIdx : dIdx).push(v + v0));
  }
  const withMesh = opts.collision ?? false;
  return {
    ...base,
    manifest: { ...base.manifest, bounds: { minX, minZ, maxX, maxZ }, heightmap: { ...base.manifest.heightmap, cols, rows, minX, minZ }, collision: withMesh ? { file: '', vertexCount: pos.length / 3, indexCount: bIdx.length + dIdx.length, buildingTriangles: bIdx.length / 3 } : { file: '', vertexCount: 0, indexCount: 0, buildingTriangles: 0 } },
    heights,
    collisionPositions: withMesh ? new Float32Array(pos) : new Float32Array(0),
    collisionIndices: withMesh ? new Uint32Array([...bIdx, ...dIdx]) : new Uint32Array(0),
    lanes,
    anchors: undefined,
    scenarios: undefined,
  };
}

/**
 * The ground audit's world, over the streamer's physics (the audit builds its own from one tile): the same object with the
 * streamed world in it, whose `step` cuts the car-ground window again round the audit's car when it has gone 192 m from its centre.
 */
/** Where the car was when the window was cut again (diagnostics). */
export const swapAt: [number, number][] = [];

function streamedGroundWorld(R: typeof RAPIER, st: TileStreamer, merged: TileData): { gw: GroundWorld; swaps: () => number } {
  const world = st.pw.world;
  let swaps = 0;
  const step = () => {
    world.forEachRigidBody((b) => {
      if (!b.isDynamic()) return;
      const t = b.translation();
      const at = st.physics.carGroundAt;
      if (Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z)) > CAR_GROUND.recentre) {
        st.physics.buildCarGround(t.x, t.z);
        swaps++;
        swapAt.push([t.x, t.z]);
      }
    });
    world.step();
  };
  const proxy = new Proxy(world, {
    get(target, k) {
      if (k === 'step') return step;
      const v = (target as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const gw = Object.create(GroundWorld.prototype) as GroundWorld;
  Object.assign(gw, {
    R,
    tile: merged,
    physics: st.pw,
    world: proxy,
    trimesh: null,
    footprints: st.pw.footprints,
    buildingTris: 0,
    triKind: new Uint8Array(0),
    ray: new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }),
    meshFirst: new Map(),
    triCells: new Map(),
  });
  return { gw, swaps: () => swaps };
}

const nearSeam = (e: GroundEvent, lines: number[]) => lines.some((l) => Math.abs(e.x - l) < 25) || lines.some((l) => Math.abs(e.z - l) < 25);

describe('cars across tile seams', () => {
  it('drive every seam-crossing lane at 15, 25 and 35 m/s with no bump or launch', async () => {
    const R = await initRapier();
    const source = new FixtureTileSource({ hills: 4 });
    const st = new TileStreamer(R, source, { rings: { near: 5000, drop: 6000, far: 9000 } });
    await st.preload(source.index.spawn.player.x, source.index.spawn.player.z);
    expect(st.readyIds().length).toBe(9);
    const merged = mergedTile(st);
    const graph = new Graph(merged);
    // the lanes that leave a tile across a seam, and the lanes they continue into
    const targets = new Set<number>();
    for (const [out, into] of st.lanes.seamLinks()) {
      targets.add(out);
      targets.add(into);
    }
    expect(targets.size).toBeGreaterThan(80);
    const lines = [0, 384];
    const { gw, swaps } = streamedGroundWorld(R, st, merged);
    const control = new GroundWorld(R, merged);
    const report: Record<string, { seamEvents: number; events: number; controlEvents: number; covered: number; metres: number }> = {};
    for (const speed of [15, 25, 35]) {
      const run = driveLanes(gw, graph, { speed, targets });
      const ctl = driveLanes(control, new Graph(merged), { speed, targets });
      const bad = run.events.filter((e) => BAD.has(e.kind));
      const atSeam = bad.filter((e) => nearSeam(e, lines));
      report[speed] = { seamEvents: atSeam.length, events: bad.length, controlEvents: ctl.events.filter((e) => BAD.has(e.kind)).length, covered: run.stats.covered, metres: Math.round(run.stats.metres) };
      if (atSeam.length) console.log(speed, atSeam.slice(0, 5).map((e) => `${e.kind} ${e.cause} at ${e.x.toFixed(0)},${e.z.toFixed(0)} ${e.detail}`));
      expect(atSeam.length, `events at a seam at ${speed} m/s`).toBe(0);
      // the seams change nothing anywhere else either
      expect(bad.length).toBeLessThanOrEqual(report[speed].controlEvents + 1);
      expect(run.stats.covered / targets.size).toBeGreaterThan(0.85);
    }
    console.log('seam audit', JSON.stringify(report), 'car-ground swaps', swaps());
    expect(swaps()).toBeGreaterThan(0);
  }, 300_000);

  it('catches a seam whose two sides disagree (a 12 cm step at the east seam of the centre tile)', async () => {
    const R = await initRapier();
    const fixture = new FixtureTileSource({ hills: 4 });
    const broken = {
      index: fixture.index,
      load: (e: Parameters<FixtureTileSource['load']>[0]) => {
        const t = fixture.load(e);
        if (e.id === '1_0') for (let i = 0; i < t.tile.heights.length; i++) t.tile.heights[i] += 0.12;
        return t;
      },
    };
    const st = new TileStreamer(R, broken, { rings: { near: 5000, drop: 6000, far: 9000 } });
    await st.preload(fixture.index.spawn.player.x, fixture.index.spawn.player.z);
    const merged = mergedTile(st);
    const targets = new Set<number>();
    for (const [out, into] of st.lanes.seamLinks()) {
      const p = st.lanes.pts[out];
      // the lanes across x = 384 between 0_0 and 1_0
      if (Math.abs(p[p.length - 3] - 384) < 1 && p[p.length - 1] > 0 && p[p.length - 1] < 384) {
        targets.add(out);
        targets.add(into);
      }
    }
    expect(targets.size).toBeGreaterThan(4);
    const { gw } = streamedGroundWorld(R, st, merged);
    const run = driveLanes(gw, new Graph(merged), { speed: 25, targets });
    const atSeam = run.events.filter((e) => BAD.has(e.kind) && Math.abs(e.x - 384) < 25);
    expect(atSeam.length).toBeGreaterThan(0);
  }, 120_000);
});

/** The baked M2 tiles, when there are some (build output): `STREAM_REAL=1 npx vitest run tests/stream/seam-audit.test.ts`. */
describe.skipIf(!process.env.STREAM_REAL || !existsSync('public/tiles/atlanta/m2/index.json'))('cars across the seams of the baked M2 tiles', () => {
  it('drive every lane that crosses a baked seam at 15, 25 and 35 m/s', async () => {
    const R = await initRapier();
    const fileFetch = async (url: string) => {
      const path = url.replace(/^file:\/\//, '');
      if (!existsSync(path)) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
      const b = readFileSync(path);
      return { ok: true, status: 200, json: async () => JSON.parse(b.toString()), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
    };
    const source = await HttpTileSource.open(`file://${process.cwd()}/public/tiles/atlanta/m2/index.json`, fileFetch as never);
    const ids = (process.env.STREAM_REAL_TILES ?? '').split(',').filter(Boolean);
    const index = ids.length ? { ...source.index, tiles: source.index.tiles.filter((t) => ids.includes(t.id)) } : source.index;
    const src = { index, load: (e: Parameters<typeof source.load>[0]) => source.load(e) };
    const st = new TileStreamer(R, src, { rings: { near: 1e6, drop: 2e6, far: 3e6 } });
    await st.preload(index.spawn.player.x, index.spawn.player.z);
    const merged = mergedTile(st);
    const targets = new Set<number>();
    for (const [out, into] of st.lanes.seamLinks()) {
      targets.add(out);
      targets.add(into);
    }
    const lines = new Set<number>();
    for (const t of index.tiles) for (const v of [t.bounds.minX, t.bounds.maxX]) lines.add(v);
    const zl = new Set<number>();
    for (const t of index.tiles) for (const v of [t.bounds.minZ, t.bounds.maxZ]) zl.add(v);
    const { gw } = streamedGroundWorld(R, st, merged);
    // the control: the same tiles as one tile (one heightfield, one collision mesh), the M1 physics
    const control = new GroundWorld(R, mergedTile(st, { collision: true }));
    const near = (e: GroundEvent) => [...lines].some((l) => Math.abs(e.x - l) < 25) || [...zl].some((l) => Math.abs(e.z - l) < 25);
    const out: Record<number, unknown> = {};
    for (const speed of [15, 25, 35]) {
      const run = driveLanes(gw, new Graph(merged), { speed, targets });
      const ctl = driveLanes(control, new Graph(merged), { speed, targets });
      const bad = run.events.filter((e) => BAD.has(e.kind) && near(e));
      const cbad = ctl.events.filter((e) => BAD.has(e.kind) && near(e));
      out[speed] = { seamLanes: targets.size, covered: run.stats.covered, km: +(run.stats.metres / 1000).toFixed(1), atSeam: bad.length, controlAtSeam: cbad.length, kinds: bad.map((e) => `${e.kind}:${e.cause}@${e.x.toFixed(0)},${e.z.toFixed(0)}`).slice(0, 8), control: cbad.map((e) => `${e.kind}:${e.cause}@${e.x.toFixed(0)},${e.z.toFixed(0)}`).slice(0, 8) };
    }
    console.log('M2 seam audit', JSON.stringify(out), JSON.stringify(st.stats().seams));
    console.log('window swaps near (-5,-249):', swapAt.filter(([x, z]) => Math.hypot(x + 5, z + 249) < 30).map(([x, z]) => `${x.toFixed(0)},${z.toFixed(0)}`).join(' '), 'of', swapAt.length);
  }, 0); // no limit: an opt-in audit, and the 80 tiles of the M2 slice take longer than any fixed one
});
