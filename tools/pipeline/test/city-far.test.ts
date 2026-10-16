import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capRing, farBuildings, farGround, writeFar } from '../src/city/far';
import { decodeFarTile } from '../../../src/shared/farTile';
import type { V2 } from '../src/geo';
import { fixtureCollision, writeFixtureTile } from './city-fixture';

describe('far.bin', () => {
  it('recovers each building prism from collision: footprint, base, top; courtyards and decks left out', () => {
    const square: V2[] = [[0, 0], [30, 0], [30, 20], [0, 20]];
    const circle: V2[] = Array.from({ length: 40 }, (_, k) => [100 + 15 * Math.cos((k / 40) * 2 * Math.PI), 50 + 15 * Math.sin((k / 40) * 2 * Math.PI)] as V2);
    const c = fixtureCollision([square, circle], 1.7, 31.7, [200, 5, 0, 220, 5, 0, 220, 5, 10, 200, 5, 10]);
    const b = farBuildings(Float32Array.from(c.positions), Uint32Array.from(c.indices), c.buildingTriangles);
    expect(b.length).toBe(2);
    expect(b[0].baseY).toBeCloseTo(1.7, 5);
    expect(b[0].topY).toBeCloseTo(31.7, 5);
    expect(b[0].ring.length / 2).toBe(4);
    const xs = b[0].ring.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(30);
    expect(b[1].ring.length / 2).toBeLessThanOrEqual(12);
    expect(b[1].ring.length / 2).toBeGreaterThanOrEqual(6);
    expect(b[0].kind).toBe(0);
  });

  it('caps a ring at 12 vertices', () => {
    const ring: V2[] = Array.from({ length: 200 }, (_, k) => [Math.cos(k / 31.8) * (50 + (k % 7)), Math.sin(k / 31.8) * 50] as V2);
    expect(capRing(ring).length).toBeLessThanOrEqual(12);
  });

  it('samples a 33 x 33 ground grid over the cell at any cell size', () => {
    for (const cell of [4, 2]) {
      const n = 1024 / cell + 1;
      const h = new Float32Array(n * n);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = c * cell * 0.01 + r * cell;
      const g = farGround(h, n, n, cell, 1024, -2048, { minX: 1024, minZ: -2048, maxX: 2048, maxZ: -1024 });
      expect(g.n).toBe(33);
      expect(g.size).toBe(1024);
      expect(g.heights[0]).toBe(0);
      expect(g.heights[32]).toBeCloseTo(10.24, 4);
      expect(g.heights[32 * 33]).toBe(1024);
    }
  });

  it('writes a far.bin that decodes, with kinds from the drawn buildings', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hood-far-'));
    await writeFixtureTile(dir, { minX: 0, minZ: 0, size: 256, height: () => 1 });
    const r = await writeFar(dir);
    expect(r.buildings).toBe(2);
    const buf = readFileSync(path.join(dir, 'far.bin'));
    const t = decodeFarTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(t.buildings.length).toBe(2);
    expect(t.buildings.every((b) => b.kind === 3)).toBe(true);
    expect(t.grid.n).toBe(33);
    expect(t.buildings[0].topY).toBeCloseTo(16, 4);
  });
});
