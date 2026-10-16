import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyToFine, applyToHeights, computeFields, fieldAt, RAMP, seamPass, sideIndex, type SeamTile } from '../src/city/seamPass';
import { meshNodes, readGlb, worldPositions } from '../src/city/glbEdit';
import { readTileFiles } from '../src/city/tileFiles';
import { FootprintIndex } from '../../../src/shared/footprints';
import { writeFixtureTile } from './city-fixture';

const S = 256;
function tile(i: number, j: number, cell: number, h: (x: number, z: number) => number): SeamTile {
  const n = S / cell + 1;
  const height = new Float32Array(n * n);
  const b = { minX: i * S, minZ: j * S, maxX: (i + 1) * S, maxZ: (j + 1) * S };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) height[r * n + c] = h(b.minX + c * cell, b.minZ + r * cell);
  return { id: `${i}_${j}`, i, j, bounds: b, n, cell, height };
}

function run(tiles: SeamTile[]) {
  const before = new Map(tiles.map((t) => [t.id, Float32Array.from(t.height)]));
  const { fields, targets, holders } = computeFields(tiles);
  for (const t of tiles) applyToHeights(t, fields.get(t.id)!, targets, holders);
  return { fields, before };
}

describe('seam pass: heights', () => {
  for (const cell of [4, 2]) {
    it(`makes two tiles' seam samples bit-identical and fades the change out over ${RAMP} m (cell ${cell} m)`, () => {
      const a = tile(0, 0, cell, (x, z) => 1 + 0.001 * z);
      const b = tile(1, 0, cell, (x, z) => 1.6 + 0.002 * z + 0.01 * (x - 256));
      const { fields, before } = run([a, b]);
      const n = a.n;
      expect(n).toBe(S / cell + 1);
      for (let k = 0; k < n; k++) expect(a.height[sideIndex(n, 'e', k)]).toBe(b.height[sideIndex(n, 'w', k)]);
      // half the difference each, on the seam
      const k = 10;
      const da = a.height[sideIndex(n, 'e', k)] - before.get(a.id)![sideIndex(n, 'e', k)];
      const db = b.height[sideIndex(n, 'w', k)] - before.get(b.id)![sideIndex(n, 'w', k)];
      expect(da).toBeCloseTo(-db, 5);
      expect(da).toBeGreaterThan(0.29);
      // zero from 48 m on, half at 24 m, and the grade changes by at most |delta| / 48
      const fa = fields.get(a.id)!;
      expect(fieldAt(fa, 256 - RAMP, 100)).toBe(0);
      expect(fieldAt(fa, 256 - 60, 100)).toBe(0);
      expect(fieldAt(fa, 256 - 24, 100)).toBeCloseTo(fieldAt(fa, 256, 100) / 2, 9);
      const r = Math.floor(n / 2);
      for (let c = 1; c < n; c++) {
        const g0 = (before.get(a.id)![r * n + c] - before.get(a.id)![r * n + c - 1]) / cell;
        const g1 = (a.height[r * n + c] - a.height[r * n + c - 1]) / cell;
        expect(Math.abs(g1 - g0)).toBeLessThanOrEqual(fa.max / RAMP + 1e-5);
      }
      // the far side of a is untouched
      expect(a.height[r * n]).toBe(before.get(a.id)![r * n]);
    });
  }

  it('makes the corner of four tiles agree in all of them, and every seam bit-identical', () => {
    const ts = [tile(0, 0, 4, () => 0), tile(1, 0, 4, () => 1), tile(0, 1, 4, () => 2), tile(1, 1, 4, () => 3.5)];
    run(ts);
    const [nw, ne, sw, se] = ts;
    const n = nw.n;
    const corner = [nw.height[n * n - 1], ne.height[(n - 1) * n], sw.height[n - 1], se.height[0]];
    expect(new Set(corner).size).toBe(1);
    expect(corner[0]).toBe(Math.fround((0 + 1 + 2 + 3.5) / 4));
    for (let k = 0; k < n; k++) {
      expect(nw.height[sideIndex(n, 'e', k)]).toBe(ne.height[sideIndex(n, 'w', k)]);
      expect(sw.height[sideIndex(n, 'e', k)]).toBe(se.height[sideIndex(n, 'w', k)]);
      expect(nw.height[sideIndex(n, 's', k)]).toBe(sw.height[sideIndex(n, 'n', k)]);
      expect(ne.height[sideIndex(n, 's', k)]).toBe(se.height[sideIndex(n, 'n', k)]);
    }
    // along a seam away from the corner it is the two tiles' mean
    expect(nw.height[sideIndex(n, 'e', 5)]).toBe(Math.fround(0.5));
    // a tile with a diagonal neighbour only: its corner is shared, the rest of its edges fade back to its own heights
    const d = [tile(0, 0, 4, () => 0), tile(1, 1, 4, () => 2)];
    run(d);
    expect(d[0].height[n * n - 1]).toBe(1);
    expect(d[1].height[0]).toBe(1);
    expect(d[0].height[sideIndex(n, 'e', n - 1 - 13)]).toBe(0);
  });

  it('moves the fine road-corridor layer with the coarse ground', () => {
    const a = tile(0, 0, 4, () => 0);
    const b = tile(1, 0, 4, () => 1);
    const { fields } = computeFields([a, b]);
    const fine = new Float32Array(2 * 33 * 33);
    const t = { heightmap: { minX: 0, minZ: 0 }, heightmapFine: { file: 'f.bin', cellSize: 1, block: 32, blocks: [[6, 2], [0, 0]] } };
    applyToFine(t, fine, fields.get(a.id)!);
    // block 0 spans x 192..224: 32..64 m from the seam
    expect(fine[32]).toBeCloseTo(fieldAt(fields.get(a.id)!, 224, 64), 6);
    expect(fine[32]).toBeGreaterThan(0);
    expect(fine[33 * 33 + 10]).toBe(0);
  });
});

describe('seam pass: whole tiles', () => {
  it('corrects every file within 48 m of the seam, keeps roofs flat, writes seams.json and matches the ports', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hood-seams-'));
    const ha = (x: number, z: number) => 2 + 0.01 * z;
    const hb = (x: number, z: number) => 2.4 + 0.01 * z;
    const da = path.join(root, '0_0'), db = path.join(root, '1_0');
    await writeFixtureTile(da, { minX: 0, minZ: 0, size: S, height: ha, roadZ: 100 });
    await writeFixtureTile(db, { minX: S, minZ: 0, size: S, height: hb, roadZ: 100 });
    const before = readTileFiles(da);
    const r = await seamPass([{ id: '0_0', i: 0, j: 0, dir: da }, { id: '1_0', i: 1, j: 0, dir: db }], () => {});
    expect(r.rewritten.sort()).toEqual(['0_0', '1_0']);
    expect(r.maxDelta).toBeCloseTo(0.2, 5);
    const A = readTileFiles(da), B = readTileFiles(db);
    // heights: identical at the seam
    const n = A.tile.heightmap.cols;
    for (let k = 0; k < n; k++) expect(A.height[sideIndex(n, 'e', k)]).toBe(B.height[sideIndex(n, 'w', k)]);
    // the road's end on the seam moved by +0.2 in a, its far end not at all
    const ra = A.json['roads.json'].roads[0].points, rb = before.json['roads.json'].roads[0].points;
    expect(ra[1][1] - rb[1][1]).toBeCloseTo(0.2, 3);
    expect(ra[0][1]).toBe(rb[0][1]);
    // lane ports: both lanes match, and their heights agree after the pass
    const seam = r.seams[0];
    expect(seam.lanes.matched).toBe(2);
    expect(seam.lanes.unmatched).toBe(0);
    expect(seam.walk.matched).toBe(1);
    expect(seam.maxPortStep).toBeLessThan(0.002);
    expect(r.totals.unmatched).toBe(0);
    const sj = JSON.parse(readFileSync(path.join(da, 'seams.json'), 'utf8'));
    expect(sj.sides.e.lanes.length).toBe(2);
    // collision: the prism by the east edge moved as one (its roof still flat, so the footprints are intact); the middle one not
    const fa = new FootprintIndex(A.collision.positions, A.collision.indices, A.tile.collision.buildingTriangles);
    const fb = new FootprintIndex(before.collision.positions, before.collision.indices, before.tile.collision.buildingTriangles);
    expect(fa.triangleCount).toBe(fb.triangleCount);
    expect(fa.outlineCount).toBe(fb.outlineCount);
    let moved = 0, kept = 0;
    for (let v = 0; v < A.collision.positions.length / 3; v++) {
      const dy = A.collision.positions[v * 3 + 1] - before.collision.positions[v * 3 + 1];
      if (Math.abs(dy) > 1e-4) moved++;
      else kept++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
    // meshes: the ground vertices on the seam stand on the corrected heights (within the quantization step)
    const doc = await readGlb(readFileSync(path.join(da, 'ground.glb')));
    const [{ node, prims }] = meshNodes(doc);
    const w = worldPositions(node, prims[0].getAttribute('POSITION')!);
    let onSeam = 0;
    for (let v = 0; v < w.length / 3; v++) {
      if (Math.abs(w[v * 3] - S) > 1e-3) continue;
      onSeam++;
      const k = Math.round(w[v * 3 + 2] / 4);
      expect(Math.abs(w[v * 3 + 1] - A.height[sideIndex(n, 'e', k)])).toBeLessThan(node.getScale()[0] / 32767 + 1e-4);
    }
    expect(onSeam).toBeGreaterThan(3);
    // a second pass changes nothing
    const again = await seamPass([{ id: '0_0', i: 0, j: 0, dir: da }, { id: '1_0', i: 1, j: 0, dir: db }], () => {});
    expect(again.rewritten).toEqual([]);
  });
});
