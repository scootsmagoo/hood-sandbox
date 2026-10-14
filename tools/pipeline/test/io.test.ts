import { describe, expect, it } from 'vitest';
import { collisionBytes, heightmapBytes, readCollision, readHeightmap } from '../src/io/binary';
import { decodeGlb, encodeGlb } from '../src/io/glb';

describe('binary writers', () => {
  it('writes the heightmap as little-endian float32', () => {
    const b = heightmapBytes(Float32Array.from([1, -2.5, 300.25]));
    expect(b.length).toBe(12);
    expect(Array.from(b.slice(0, 4))).toEqual([0, 0, 128, 63]); // 1.0f little-endian
    expect(Array.from(readHeightmap(b))).toEqual([1, -2.5, 300.25]);
  });
  it('writes collision as positions then indices', () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const idx = [0, 1, 2];
    const b = collisionBytes(pos, idx);
    expect(b.length).toBe(9 * 4 + 3 * 4);
    const dv = new DataView(b.buffer);
    expect(dv.getFloat32(12, true)).toBe(1);
    expect(dv.getUint32(36 + 8, true)).toBe(2);
    const r = readCollision(b, 3, 3);
    expect(Array.from(r.positions)).toEqual(pos);
    expect(Array.from(r.indices)).toEqual(idx);
    expect(() => readCollision(b, 3, 4)).toThrow();
  });
});

describe('glb', () => {
  it('round-trips a meshopt compressed quad within quantization error', async () => {
    const positions = [-1000, 0, -1000, 1000, 0, -1000, 1000, 12.345, 1000, -1000, 0, 1000];
    const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    const colors = [0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3];
    const bytes = await encodeGlb([
      { name: 'a', material: { name: 'm', baseColor: [1, 1, 1, 1] }, positions, normals, colors, indices: [0, 2, 1, 0, 3, 2] },
    ]);
    const doc = await decodeGlb(bytes);
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(prim.getIndices()!.getCount()).toBe(6);
    const pos = prim.getAttribute('POSITION')!;
    const node = doc.getRoot().listNodes()[0];
    const sc = node.getScale();
    const tr = node.getTranslation();
    const maxY = Math.max(...Array.from({ length: pos.getCount() }, (_, i) => pos.getElement(i, [0, 0, 0])[1] * sc[1] + tr[1]));
    const maxX = Math.max(...Array.from({ length: pos.getCount() }, (_, i) => pos.getElement(i, [0, 0, 0])[0] * sc[0] + tr[0]));
    expect(Math.abs(maxY - 12.345)).toBeLessThan(0.01);
    expect(Math.abs(maxX - 1000)).toBeLessThan(0.05);
    expect(prim.getAttribute('COLOR_0')).toBeTruthy();
  });
});
