import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mergeable, mergeMeshes } from './mergeChunks';

/** A chunk the way the tile has it: 16-bit normalised positions and normals, a node matrix that scales and offsets, a colour, a custom attribute. */
function chunk(offset: [number, number, number], scale = 100, extra: 'u8' | 'f32' = 'u8'): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  // a triangle at (0,0,0), (0.5,0,0), (0,0.5,0) in quantised units, a quad's worth of indices
  g.setAttribute('position', new THREE.BufferAttribute(new Int16Array([0, 0, 0, 16384, 0, 0, 0, 16384, 0, 16384, 16384, 0]), 3, true));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int16Array([0, 0, 32767, 0, 0, 32767, 0, 0, 32767, 0, 0, 32767]), 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 9]), 4, true));
  g.setAttribute('_bld', new THREE.BufferAttribute(extra === 'u8' ? new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]) : new Float32Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]), 4, false));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.position.set(...offset);
  m.scale.set(scale, scale / 2, scale);
  m.updateMatrixWorld(true);
  return m;
}

describe('merging chunk meshes', () => {
  it('bakes the node matrices into float positions and offsets the indices', () => {
    const a = chunk([0, 0, 0]);
    const b = chunk([300, 10, -50]);
    expect(mergeable([a, b])).toBe(true);
    const g = mergeMeshes([a, b]);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    expect(p.array).toBeInstanceOf(Float32Array);
    expect(p.count).toBe(8);
    // (16384/32767) * 100 = 50.0015 in x, * 50 = 25.0008 in y
    expect(p.getX(1)).toBeCloseTo(50.0015, 3);
    expect(p.getY(2)).toBeCloseTo(25.0008, 3);
    expect(p.getX(5)).toBeCloseTo(300 + 50.0015, 3);
    expect(p.getY(5)).toBeCloseTo(10, 3);
    expect(p.getZ(5)).toBeCloseTo(-50, 3);
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
    expect(g.index!.array).toBeInstanceOf(Uint16Array);
    expect(g.boundingSphere!.radius).toBeGreaterThan(100);
  });

  it('keeps normalised integer normals and the other attributes as they were', () => {
    const g = mergeMeshes([chunk([0, 0, 0]), chunk([10, 0, 0])]);
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    expect(n.array).toBeInstanceOf(Int16Array);
    expect(n.normalized).toBe(true);
    expect(n.getZ(0)).toBeCloseTo(1, 3);
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    expect(c.array).toBeInstanceOf(Uint8Array);
    expect(c.normalized).toBe(true);
    expect(c.getX(0)).toBeCloseTo(1, 5);
    expect(c.getW(3)).toBeCloseTo(9 / 255, 5);
    const bld = g.getAttribute('_bld') as THREE.BufferAttribute;
    expect(bld.array).toBeInstanceOf(Uint8Array);
    expect(bld.normalized).toBe(false);
    expect(Array.from(bld.array.slice(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('widens an attribute to float32 when the sources differ in type', () => {
    const g = mergeMeshes([chunk([0, 0, 0], 100, 'u8'), chunk([10, 0, 0], 100, 'f32')]);
    const bld = g.getAttribute('_bld') as THREE.BufferAttribute;
    expect(bld.array).toBeInstanceOf(Float32Array);
    expect(Array.from(bld.array.slice(16, 20))).toEqual([1, 2, 3, 4]);
  });

  it('transforms the normals by the inverse transpose when the node scales unevenly', () => {
    const a = chunk([0, 0, 0]);
    const g0 = a.geometry;
    // a normal tilted in x and z, squashed in y by the node: stays unit length and tips toward the squashed axis
    (g0.getAttribute('normal') as THREE.BufferAttribute).setXYZ(0, Math.SQRT1_2, Math.SQRT1_2, 0);
    a.scale.set(1, 4, 1);
    a.updateMatrixWorld(true);
    const b = chunk([5, 0, 0]);
    const g = mergeMeshes([a, b]);
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const len = Math.hypot(n.getX(0), n.getY(0), n.getZ(0));
    expect(len).toBeCloseTo(1, 3);
    // y is scaled by 4, so the normal's y component shrinks (by 1/4 before normalising)
    expect(n.getY(0)).toBeLessThan(n.getX(0));
  });

  it('uses 32-bit indices past 65,535 vertices', () => {
    const big = (n: number) => {
      const m = chunk([0, 0, 0]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Int16Array(n * 3), 3, true));
      g.setAttribute('normal', new THREE.BufferAttribute(new Int16Array(n * 3), 3, true));
      g.setIndex([0, 1, n - 1]);
      return new THREE.Mesh(g, m.material);
    };
    const a = big(40000);
    const b = big(40000);
    a.updateMatrixWorld(true);
    b.updateMatrixWorld(true);
    const g = mergeMeshes([a, b]);
    expect(g.index!.array).toBeInstanceOf(Uint32Array);
    expect(Array.from(g.index!.array)).toEqual([0, 1, 39999, 40000, 40001, 79999]);
  });

  it('refuses meshes whose layouts differ, or that are not indexed', () => {
    const a = chunk([0, 0, 0]);
    const b = chunk([5, 0, 0]);
    b.geometry.deleteAttribute('_bld');
    expect(mergeable([a, b])).toBe(false);
    const c = chunk([5, 0, 0]);
    c.geometry.setIndex(null);
    expect(mergeable([a, c])).toBe(false);
    expect(mergeable([a])).toBe(false);
  });

  it('reads interleaved attributes', () => {
    const a = chunk([0, 0, 0]);
    const b = chunk([5, 0, 0]);
    // the same colours, but in an interleaved buffer with another attribute beside them
    const src = b.geometry.getAttribute('color') as THREE.BufferAttribute;
    const buf = new THREE.InterleavedBuffer(new Uint8Array(src.count * 8), 8);
    for (let i = 0; i < src.count; i++) for (let k = 0; k < 4; k++) buf.array[i * 8 + 4 + k] = src.array[i * 4 + k];
    b.geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(buf, 4, 4, true));
    const g = mergeMeshes([a, b]);
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    expect(Array.from(c.array.slice(16, 32))).toEqual(Array.from(src.array));
  });
});
