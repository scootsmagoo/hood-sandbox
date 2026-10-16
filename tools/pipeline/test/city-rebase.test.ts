import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeGlb } from '../src/io/glb';
import { meshNodes, readGlb, setWorldPositions, worldPositions, writeGlb } from '../src/city/glbEdit';
import { datumShift, rebaseGlb, rebaseTile } from '../src/city/rebase';
import { readTileFiles } from '../src/city/tileFiles';
import { writeFixtureTile } from './city-fixture';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'hood-rebase-'));

async function worldOf(bytes: Uint8Array) {
  const doc = await readGlb(bytes);
  return meshNodes(doc).map(({ node, prims }) => ({ name: node.getName(), extras: node.getExtras(), w: worldPositions(node, prims[0].getAttribute('POSITION')!), step: node.getScale()[0] / 32767, prim: prims[0] }));
}

describe('rebase into the city frame', () => {
  it('round-trips a glb: positions plus the offset within the quantization step, names and extras kept', async () => {
    const positions = [-500, 3, -500, 500, 7.5, -500, 500, -2, 500, -500, 0, 500];
    const bytes = await encodeGlb([{ name: 'ground_1_2_L0', material: { name: 'ground', baseColor: [1, 1, 1, 1] }, positions, normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], indices: [0, 2, 1, 0, 3, 2], extras: { kind: 'ground', chunk: [1, 2], lod: 0 } }]);
    const d: [number, number, number] = [-7680 + 512, -12.34, 3072 + 512];
    const out = await rebaseGlb(bytes, d);
    const [a] = await worldOf(bytes);
    const [b] = await worldOf(out);
    expect(b.name).toBe('ground_1_2_L0');
    expect(b.extras).toEqual({ kind: 'ground', chunk: [1, 2], lod: 0 });
    expect(b.prim.getMaterial()!.getName()).toBe('ground');
    // the encoder may reorder vertices: every original vertex plus the offset is one of the decoded ones, within a step
    for (let v = 0; v < positions.length / 3; v++) {
      let best = Infinity;
      for (let u = 0; u < b.w.length / 3; u++) best = Math.min(best, Math.max(...[0, 1, 2].map((k) => Math.abs(b.w[u * 3 + k] - (positions[v * 3 + k] + d[k])))));
      expect(best).toBeLessThanOrEqual(a.step * 1.01);
    }
    for (let i = 0; i < a.w.length; i++) expect(Math.abs(b.w[i] - (a.w[i] + d[i % 3]))).toBeLessThan(1e-6);
    // requantizing an edit keeps it within one step too
    const doc = await readGlb(out);
    const [{ node, prims }] = meshNodes(doc);
    const pos = prims[0].getAttribute('POSITION')!;
    const w = worldPositions(node, pos);
    for (let i = 1; i < w.length; i += 3) w[i] += 0.5;
    setWorldPositions(node, pos, w);
    const [c] = await worldOf(await writeGlb(doc));
    for (let i = 0; i < w.length; i++) expect(Math.abs(c.w[i] - w[i])).toBeLessThanOrEqual(c.step * 1.01);
  });

  it('moves every coordinate of every file and keeps only what stands in the cell', async () => {
    const src = tmp();
    const dst = path.join(tmp(), 'out');
    const h = (x: number, z: number) => 0.01 * x - 0.02 * z + 1;
    await writeFixtureTile(src, { minX: -128, minZ: -128, size: 256, height: h, baseElevation: 305.25 });
    const dy = datumShift(305.25, 318.59);
    expect(dy).toBeCloseTo(-13.34, 9);
    const s = { dx: 1024 + 512, dy, dz: -2048 + 512, origin: { lat: 33.7543, lon: -84.3898, E: -8319.964, N: -10611.308 }, baseElevation: 318.59, bounds: { minX: 1536 - 128, minZ: -1536 - 128, maxX: 1536 + 128, maxZ: -1536 + 128 }, id: 'atlanta/m2/1_-2' };
    const r = await rebaseTile(src, dst, s);
    const a = readTileFiles(src);
    const b = readTileFiles(dst);
    const near = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThan(1e-3);
    // tile.json
    expect(b.tile.id).toBe('atlanta/m2/1_-2');
    expect(b.tile.origin).toEqual(s.origin);
    expect(b.tile.baseElevation).toBe(318.59);
    expect(b.tile.bounds).toEqual(s.bounds);
    expect([b.tile.heightmap.minX, b.tile.heightmap.minZ]).toEqual([1408, -1664]);
    expect([b.tile.chunks.minX, b.tile.chunks.minZ]).toEqual([1408, -1664]);
    near(b.tile.spawns.player.x, a.tile.spawns.player.x + s.dx);
    near(b.tile.spawns.vehicle.y, a.tile.spawns.vehicle.y + dy);
    expect(b.tile.spawns.vehicle.heading).toBe(0.5);
    // binaries
    for (let i = 0; i < a.height.length; i++) expect(b.height[i]).toBe(Math.fround(a.height[i] + dy));
    for (let i = 0; i < a.collision.positions.length; i++) near(b.collision.positions[i], a.collision.positions[i] + [s.dx, dy, s.dz][i % 3]);
    expect(Array.from(b.collision.indices)).toEqual(Array.from(a.collision.indices));
    // JSON
    const A = a.json, B = b.json;
    near(B['roads.json'].roads[0].points[1][0], A['roads.json'].roads[0].points[1][0] + s.dx);
    near(B['roads.json'].roads[0].points[1][1], A['roads.json'].roads[0].points[1][1] + dy);
    const ja = A['junctions.json'], jb = B['junctions.json'];
    near(jb.junctions[0].z, ja.junctions[0].z + s.dz);
    near(jb.junctions[0].y, ja.junctions[0].y + dy);
    near(jb.junctions[0].polygon[2][1], ja.junctions[0].polygon[2][1] + s.dz);
    near(jb.junctions[0].legs[0].at[0], ja.junctions[0].legs[0].at[0] + s.dx);
    near(jb.junctions[0].legs[0].stopLine[1], ja.junctions[0].legs[0].stopLine[1] + dy);
    expect(jb.junctions[0].legs[1].stopLine).toBeNull();
    expect(jb.junctions[0].legs[0].dir).toEqual([1, 0]);
    near(jb.signals[0].x, ja.signals[0].x + s.dx);
    near(jb.stops[0].z, ja.stops[0].z + s.dz);
    near(jb.crossings[0].points[1][2], ja.crossings[0].points[1][2] + s.dz);
    const la = A['lanes.json'], lb = B['lanes.json'];
    for (let k = 0; k < la.edges[0].pts.length; k++) near(lb.edges[0].pts[k], la.edges[0].pts[k] + [s.dx, dy, s.dz][k % 3]);
    near(lb.junctions[0].x, la.junctions[0].x + s.dx);
    near(lb.junctions[0].heads[0].y, la.junctions[0].heads[0].y + dy);
    expect(lb.junctions[0].heads.length).toBe(1); // the head east of the cell went
    near(B['paths.json'].nodes[2][2], A['paths.json'].nodes[2][2] + s.dz);
    expect(B['scenarios.json'].points.map((p: { id: string }) => p.id)).toEqual(['s1']);
    near(B['scenarios.json'].points[0].y, A['scenarios.json'].points[0].y + dy);
    // props: half-open cell (x = maxX and z = maxZ are the neighbour's; x = minX is ours)
    const pb = B['props.json'];
    expect(pb.trees.length).toBe(2);
    near(pb.trees[0][0], A['props.json'].trees[0][0] + s.dx);
    expect(pb.trees[0][3]).toBe(10);
    expect(pb.bins.length).toBe(0);
    expect(pb.bollards.length).toBe(0);
    expect(pb.lamps.length).toBe(1);
    expect(r.dropped).toEqual({ trees: 1, bins: 1, bollards: 1, scenarios: 1, signalHeads: 1, landmarks: 1 });
    const lm = B['landmarks.json'].landmarks;
    expect(lm.length).toBe(1);
    near(lm[0].x, A['landmarks.json'].landmarks[0].x + s.dx);
    near(lm[0].hero.y, A['landmarks.json'].landmarks[0].hero.y + dy);
    near(lm[0].ring[0][1], A['landmarks.json'].landmarks[0].ring[0][1] + s.dz);
    // meshes: moved by the offset; the junction surface's TEXCOORD_0 is the world x, z again
    for (const f of ['ground.glb', 'roads.glb', 'buildings.glb']) {
      const wa = await worldOf(readFileSync(path.join(src, f)));
      const wb = await worldOf(readFileSync(path.join(dst, f)));
      expect(wb.map((n) => n.name)).toEqual(wa.map((n) => n.name));
      for (let k = 0; k < wa.length; k++) for (let i = 0; i < wa[k].w.length; i++) expect(Math.abs(wb[k].w[i] - (wa[k].w[i] + [s.dx, dy, s.dz][i % 3]))).toBeLessThan(1e-6);
    }
    const [asphalt] = await worldOf(readFileSync(path.join(dst, 'roads.glb')));
    const uv = asphalt.prim.getAttribute('TEXCOORD_0')!.getArray()!;
    const uv1 = asphalt.prim.getAttribute('TEXCOORD_1')!.getArray()!;
    const [srcAsphalt] = await worldOf(readFileSync(path.join(src, 'roads.glb')));
    const uvA = srcAsphalt.prim.getAttribute('TEXCOORD_0')!.getArray()!;
    let junction = 0;
    for (let i = 0; i < uv1.length / 2; i++) {
      // the junction surface vertex (half width 0) is at the world x, z again; the ribbon's uv is its own
      if (uv1[i * 2] === 0) {
        junction++;
        expect([uv[i * 2], uv[i * 2 + 1]]).toEqual([uvA[i * 2] + s.dx, uvA[i * 2 + 1] + s.dz]);
        expect([uv[i * 2], uv[i * 2 + 1]]).toEqual([0 + s.dx, 0 + s.dz]);
      } else expect([uv[i * 2], uv[i * 2 + 1]]).toEqual([uvA[i * 2], uvA[i * 2 + 1]]);
    }
    expect(junction).toBe(1);
  });
});
