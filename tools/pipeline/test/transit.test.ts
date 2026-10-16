/**
 * The transit layer: chaining a route relation, cutting it to the tile, the track design's grade limit and its structures,
 * and (with the city's network cached and the tile baked) the whole layer on the M1 tile: its stations, levels and depths, every
 * stop on its platform, every platform reachable, and the same output twice.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTileConfig, REPO_ROOT } from '../src/config.js';
import type { V2 } from '../src/geo.js';
import type { OsmElement } from '../src/sources/osm.js';
import { buildTransit } from '../src/world/transit.js';
import { roadQueries } from '../src/world/transitBake.js';
import { checkTransit } from '../src/world/transitCheck.js';
import { chainRoute, displayName, longestRunInside, type RawTrack, type TransitPack } from '../src/world/transitData.js';
import { transitCacheFile, transitQuery, transitBox } from '../src/world/transitFetch.js';
import { buildTrackGraph, designProfile, PROFILE } from '../src/world/transitProfile.js';
import { makeHeightmap, surfaceHeight } from '../src/world/terrain.js';

const track = (id: number, nodes: number[], pts: V2[], o: Partial<RawTrack> = {}): RawTrack => ({ id, nodes, pts, tunnel: false, passage: false, bridge: false, cutting: false, layer: 0, level: 0, name: '', ...o });

describe('route relations', () => {
  it('chains ways in member order, turning the ones mapped against the route', () => {
    const tracks = new Map<number, RawTrack>([
      [1, track(1, [10, 11, 12], [[0, 0], [10, 0], [20, 0]])],
      // mapped backwards
      [2, track(2, [14, 13, 12], [[40, 0], [30, 0], [20, 0]])],
      [3, track(3, [14, 15], [[40, 0], [50, 0]])],
    ]);
    const rel: OsmElement = { type: 'relation', id: 9, tags: { name: 'Test', to: 'Terminus' }, members: [{ type: 'way', ref: 1, role: '' }, { type: 'way', ref: 2, role: '' }, { type: 'way', ref: 3, role: '' }, { type: 'node', ref: 11, role: 'stop' }] };
    const r = chainRoute(rel, tracks, 'red')!;
    expect(r.nodes).toEqual([10, 11, 12, 13, 14, 15]);
    expect(r.pts.map((p) => p[0])).toEqual([0, 10, 20, 30, 40, 50]);
    expect(r.way).toEqual([1, 1, 2, 2, 3]);
    expect(r.stops).toEqual([11]);
    expect(r.to).toBe('Terminus');
  });

  it('keeps the longest run inside a box', () => {
    const pts: V2[] = [[-200, 0], [-50, 0], [50, 0], [80, 0], [300, 0]];
    const run = longestRunInside(pts, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 })!;
    expect(run.i0).toBe(0);
    expect(run.t0).toBeCloseTo(100 / 150, 5);
    expect(run.i1).toBe(3);
    expect(run.t1).toBeCloseTo(20 / 220, 5);
  });

  it('gives a station a brand-free name', () => {
    const pack = { stations: { 'SEC District': { name: 'Stadium District' } } } as unknown as TransitPack;
    expect(displayName('SEC District', pack, [])).toBe('Stadium District');
    expect(displayName('Arena / CNN Center', pack, [{ real: 'CNN Center', parody: 'Newsline Center' }])).toBe('Arena / Newsline Center');
    expect(displayName('Five Points', pack, [])).toBe('Five Points');
  });
});

describe('the track design', () => {
  /** A straight line 1.2 km long over flat ground: a tunnel, a platform held 14 m down in it, then a viaduct over a road. */
  function line(holdY: number) {
    const n = 25;
    const pts: V2[] = Array.from({ length: n }, (_, i) => [i * 50, 0]);
    const nodes = pts.map((_, i) => 100 + i);
    const tracks = new Map<number, RawTrack>([
      [1, track(1, nodes.slice(0, 13), pts.slice(0, 13), { tunnel: true, layer: -1 })],
      [2, track(2, nodes.slice(12), pts.slice(12), { bridge: true, layer: 1 })],
    ]);
    const route = { osm: 1, line: 'red', name: '', from: '', to: '', nodes, pts, way: [...new Array(12).fill(1), ...new Array(12).fill(2)], stops: [] };
    const g = buildTrackGraph({
      routes: [route],
      tracks,
      ground: () => 0,
      roadUnder: (x) => (x > 900 && x < 960 ? 0.2 : -Infinity),
      hold: (x) => (x >= 150 && x <= 350 ? holdY : NaN),
      keep: () => true,
    });
    return { g, prof: designProfile(g, { roadUnder: (x) => (x > 900 && x < 960 ? 0.2 : -Infinity) }) };
  }

  it('holds the platform, keeps the grade and makes the structures from the design', () => {
    const { g, prof } = line(-14);
    // (the relaxation stops within a hair of the limit)
    expect(prof.maxGrade).toBeLessThanOrEqual(PROFILE.grade + 0.0005);
    for (const v of g.verts) if (v.x >= 150 && v.x <= 350) expect(v.y).toBeCloseTo(-14, 6);
    // deep at the platform: a tunnel; over the road: a viaduct that clears it
    const at = (x: number) => g.verts.reduce((b, v) => (Math.abs(v.x - x) < Math.abs(b.x - x) ? v : b));
    expect(at(250).kind).toBe('tunnel');
    expect(at(930).kind).toBe('elevated');
    expect(at(930).y).toBeGreaterThan(0.2 + PROFILE.roadClear - 0.01);
    // and somewhere between, the line comes up through a trench to the ground
    expect(g.verts.some((v) => v.kind === 'trench')).toBe(true);
  });

  it('is the same every time', () => {
    const a = line(-14).g.verts.map((v) => v.y.toFixed(6)).join();
    const b = line(-14).g.verts.map((v) => v.y.toFixed(6)).join();
    expect(a).toBe(b);
  });
});

// The whole layer on the M1 tile, from the cached network and the baked tile (both absent on a fresh clone: skipped then).
const cfg = loadTileConfig();
const packFile = path.join(REPO_ROOT, 'data/cities/atlanta/transit.json');
const pack = JSON.parse(readFileSync(packFile, 'utf8')) as TransitPack;
const cache = transitCacheFile('atlanta', transitQuery(transitBox(pack)));
const have = existsSync(cache) && existsSync(path.join(cfg.outDir, 'tile.json'));

describe.skipIf(!have)('the transit layer of the M1 tile', () => {
  function build() {
    const dir = cfg.outDir;
    const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
    const hb = readFileSync(path.join(dir, tile.heightmap.file));
    const hmj = tile.heightmap;
    const hm = makeHeightmap(hmj.cols, hmj.rows, hmj.cellSize, hmj.minX, hmj.minZ, new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length)));
    const roads = JSON.parse(readFileSync(path.join(dir, 'roads.json'), 'utf8')).roads;
    const rq = roadQueries(roads);
    return buildTransit({
      osm: JSON.parse(readFileSync(cache, 'utf8')),
      projector: cfg.projector,
      bounds: tile.bounds,
      ground: (x, z) => surfaceHeight(hm, x, z),
      roadUnder: rq.roadUnder,
      onRoad: rq.onRoad,
      inBuilding: () => false,
      obstacles: [],
      pack,
      brands: [],
      car: { length: 22.86, gap: 0.9 },
    })!;
  }

  it('finds the lines, the stations and their depths', () => {
    const { file } = build();
    expect(file.routes.length).toBe(8);
    expect(new Set(file.routes.map((r) => file.lines[r.line].id))).toEqual(new Set(['red', 'gold', 'blue', 'green']));
    const byName = new Map(file.stations.map((s) => [s.name, s]));
    for (const n of ['Five Points', 'Peachtree Center', 'Georgia State', 'Garnett', 'SEC District']) expect(byName.has(n), n).toBe(true);
    const fp = byName.get('Five Points')!;
    // two levels: the East-West platform under the concourse, the North-South one under it
    expect(fp.platforms.length).toBe(2);
    const [upper, lower] = [...fp.platforms].sort((a, b) => b.y - a.y);
    expect(upper.y).toBeLessThan(fp.y - 9);
    expect(lower.y).toBeLessThan(upper.y - 5.9);
    // Peachtree Center is the deepest: 37 m under Peachtree Street
    const ptc = byName.get('Peachtree Center')!;
    expect(ptc.y - ptc.platforms[0].y).toBeGreaterThanOrEqual(36.5);
    expect(byName.get('SEC District')!.displayName).toBe('Stadium District');
    // elevated: Georgia State and Garnett stand over the ground
    expect(byName.get('Georgia State')!.underground).toBe(false);
    expect(byName.get('Garnett')!.underground).toBe(false);
    for (const s of file.stations) for (const p of s.platforms) expect(p.halfWidth * 2, `${s.name} platform`).toBeGreaterThanOrEqual(4.4);
  });

  it('passes its checks: grades, stops on platforms, platforms reached', () => {
    const rep = checkTransit(build().file);
    expect(rep.maxGrade).toBeLessThanOrEqual(0.045);
    expect(rep.stopsOff).toEqual([]);
    expect(rep.unreachable).toEqual([]);
    expect(rep.volumes).toBeGreaterThan(200);
  });

  it('is the same every time', () => {
    const a = JSON.stringify(build().file);
    const b = JSON.stringify(build().file);
    expect(a).toBe(b);
  });
});
