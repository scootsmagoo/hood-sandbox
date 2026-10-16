/**
 * Merging the tile's chunk meshes into bigger blocks, once, at load.
 *
 * The baked tile has one mesh per 256 m chunk and material, so frustum culling is fine-grained. On a
 * phone that is the wrong trade: each mesh costs about the same main-thread time to cull, sort, bind and
 * draw whether it holds 50 triangles or 5,000, while the GPU has time to spare (a frame is a fifth of a
 * millisecond of GPU against several of CPU). Merging 2 x 2 chunks per material cuts the world's draws
 * by about 60% for roughly 40% more triangles drawn.
 *
 * `mergeMeshes` makes one indexed geometry from meshes that share a material and an attribute layout. The
 * positions and normals are baked to the meshes' common frame (the tile's chunks come quantised, each node
 * carrying its scale and offset), everything else is copied as it is, so the look's shaders, which read
 * the pipeline's custom attributes, see the same values.
 */
import * as THREE from 'three';

type Typed = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray;
type Ctor = new (n: number) => Typed;

interface Source {
  /** Where the values are: the attribute's own array, or the interleaved buffer it reads. */
  array: Typed;
  stride: number;
  offset: number;
  size: number;
  count: number;
  normalized: boolean;
}

function sourceOf(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Source {
  if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const ia = a as THREE.InterleavedBufferAttribute;
    return { array: ia.data.array as Typed, stride: ia.data.stride, offset: ia.offset, size: ia.itemSize, count: ia.count, normalized: ia.normalized };
  }
  const ba = a as THREE.BufferAttribute;
  return { array: ba.array as Typed, stride: ba.itemSize, offset: 0, size: ba.itemSize, count: ba.count, normalized: ba.normalized };
}

/** The value of component `k` of vertex `i` as the shader would read it (normalised integers are scaled to 0..1 or -1..1). */
function read(s: Source, i: number, k: number): number {
  const v = s.array[i * s.stride + s.offset + k];
  if (!s.normalized) return v;
  switch (s.array.constructor) {
    case Int16Array:
      return Math.max(v / 32767, -1);
    case Uint16Array:
      return v / 65535;
    case Int8Array:
      return Math.max(v / 127, -1);
    case Uint8Array:
    case Uint8ClampedArray:
      return v / 255;
    default:
      return v;
  }
}

/** True when `meshes` can be merged as they are: indexed, the same attributes with the same sizes, a right-handed matrix. */
export function mergeable(meshes: THREE.Mesh[]): boolean {
  if (meshes.length < 2) return false;
  const first = meshes[0].geometry;
  const names = Object.keys(first.attributes).sort().join();
  for (const m of meshes) {
    const g = m.geometry;
    if (!g.index || g.groups.length > 0 || Object.keys(g.morphAttributes).length > 0) return false;
    if (Object.keys(g.attributes).sort().join() !== names) return false;
    for (const n of Object.keys(first.attributes)) if (g.attributes[n].itemSize !== first.attributes[n].itemSize) return false;
    if (m.matrixWorld.determinant() <= 0) return false;
  }
  return !!first.attributes.position && !!first.attributes.normal;
}

/**
 * One geometry from `meshes` (see `mergeable`), in the frame their world matrices put them in: use it with an identity
 * matrix. `position` becomes float32; `normal` keeps a normalised integer type when its sources had one; any other
 * attribute keeps its type when every source has the same, and is widened to float32 when they differ.
 * The sources' geometries are not touched.
 */
export function mergeMeshes(meshes: THREE.Mesh[]): THREE.BufferGeometry {
  const first = meshes[0].geometry;
  let total = 0;
  let indices = 0;
  for (const m of meshes) {
    total += m.geometry.getAttribute('position').count;
    indices += m.geometry.index!.count;
  }
  const out = new THREE.BufferGeometry();
  const v = new THREE.Vector3();
  const normal = new THREE.Matrix3();

  for (const name of Object.keys(first.attributes)) {
    const srcs = meshes.map((m) => sourceOf(m.geometry.attributes[name]));
    const size = srcs[0].size;
    let Arr: Ctor;
    let normalized = srcs[0].normalized;
    if (name === 'position') {
      Arr = Float32Array;
      normalized = false;
    } else if (srcs.every((s) => s.array.constructor === srcs[0].array.constructor && s.normalized === srcs[0].normalized)) {
      Arr = srcs[0].array.constructor as Ctor;
    } else {
      Arr = Float32Array;
      normalized = false;
    }
    const dst = new Arr(total * size);
    let at = 0;
    for (let n = 0; n < meshes.length; n++) {
      const s = srcs[n];
      const world = meshes[n].matrixWorld;
      if (name === 'position' || name === 'normal') {
        const isPos = name === 'position';
        if (!isPos) normal.getNormalMatrix(world);
        // the same conversions in and out as the shader's: a normalised integer reads as -1..1 and is written back scaled
        const scale = !isPos && normalized ? (Arr === Int16Array ? 32767 : Arr === Int8Array ? 127 : 1) : 1;
        for (let i = 0; i < s.count; i++) {
          v.set(read(s, i, 0), read(s, i, 1), read(s, i, 2));
          if (isPos) v.applyMatrix4(world);
          else v.applyMatrix3(normal).normalize();
          const o = (at + i) * size;
          // (typed arrays truncate on assignment: round the integer ones)
          dst[o] = scale === 1 ? v.x : Math.round(v.x * scale);
          dst[o + 1] = scale === 1 ? v.y : Math.round(v.y * scale);
          dst[o + 2] = scale === 1 ? v.z : Math.round(v.z * scale);
        }
      } else if (s.array.constructor === Arr && s.normalized === normalized) {
        for (let i = 0; i < s.count; i++) {
          const from = i * s.stride + s.offset;
          const o = (at + i) * size;
          for (let k = 0; k < size; k++) dst[o + k] = s.array[from + k];
        }
      } else {
        for (let i = 0; i < s.count; i++) {
          const o = (at + i) * size;
          for (let k = 0; k < size; k++) dst[o + k] = read(s, i, k);
        }
      }
      at += s.count;
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, size, normalized));
  }

  const index = total > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let ip = 0;
  let base = 0;
  for (const m of meshes) {
    const src = m.geometry.index!;
    for (let i = 0; i < src.count; i++) index[ip++] = src.getX(i) + base;
    base += m.geometry.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}
