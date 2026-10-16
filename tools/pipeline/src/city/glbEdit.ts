/**
 * Editing the tile bake's .glb files in place: read with meshopt decoding, move nodes or vertices, write back with the same
 * extensions (EXT_meshopt_compression, KHR_mesh_quantization) the bake writes (io/glb.ts). Node names, extras, materials and
 * every attribute other than the ones edited are kept as they are.
 *
 * Positions are 16-bit normalized integers with one uniform scale and a translation per mesh node (world = t + s * q / 32767),
 * so a vertex edit dequantizes a node's positions, edits them in the world, and requantizes them over their new bounds.
 */
import { Document, NodeIO, type Accessor, type Node, type Primitive } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

let io: NodeIO | null = null;
async function getIo(): Promise<NodeIO> {
  if (io) return io;
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  return io;
}

export async function readGlb(bytes: Uint8Array): Promise<Document> {
  return (await getIo()).readBinary(bytes);
}

/** Writes a document the way the tile bake does (meshopt-compressed buffers, quantized attributes kept). */
export async function writeGlb(doc: Document): Promise<Uint8Array> {
  const root = doc.getRoot();
  let ext = root.listExtensionsUsed().find((e) => e.extensionName === EXTMeshoptCompression.EXTENSION_NAME) as EXTMeshoptCompression | undefined;
  if (!ext) ext = doc.createExtension(EXTMeshoptCompression);
  ext.setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  if (!root.listExtensionsUsed().some((e) => e.extensionName === KHRMeshQuantization.EXTENSION_NAME)) doc.createExtension(KHRMeshQuantization).setRequired(true);
  return (await getIo()).writeBinary(doc);
}

/** The top-level nodes of every scene. */
export const rootNodes = (doc: Document): Node[] => doc.getRoot().listScenes().flatMap((s) => s.listChildren());

/** Adds an offset to the translation of every top-level node (moves the whole file; no vertex changes). */
export function translateRoots(doc: Document, d: [number, number, number]): void {
  for (const n of rootNodes(doc)) {
    const t = n.getTranslation();
    n.setTranslation([t[0] + d[0], t[1] + d[1], t[2] + d[2]]);
  }
}

/** Every mesh node with its world matrix pieces (the bake writes no rotations and no nesting; anything else is refused). */
export function meshNodes(doc: Document): { node: Node; prims: Primitive[] }[] {
  const out: { node: Node; prims: Primitive[] }[] = [];
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    const r = n.getRotation();
    if (Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) > 1e-9 || n.listChildren().length || n.getParentNode()) throw new Error(`glb node ${n.getName()}: rotated or nested nodes are not supported`);
    out.push({ node: n, prims: mesh.listPrimitives() });
  }
  return out;
}

/** World positions of a mesh node's primitive (float64, xyz). */
export function worldPositions(node: Node, pos: Accessor): Float64Array {
  const t = node.getTranslation();
  const s = node.getScale();
  const n = pos.getCount();
  const out = new Float64Array(n * 3);
  const el: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, el); // denormalized
    out[i * 3] = t[0] + s[0] * el[0];
    out[i * 3 + 1] = t[1] + s[1] * el[1];
    out[i * 3 + 2] = t[2] + s[2] * el[2];
  }
  return out;
}

/**
 * Stores world positions back into a node's POSITION accessor: 16-bit normalized over the positions' own bounds with a uniform
 * scale (as the bake's quantization does), the node's translation and scale set to match. The step is the largest extent / 65534.
 */
export function setWorldPositions(node: Node, pos: Accessor, world: Float64Array): void {
  const n = world.length / 3;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = world[i * 3 + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const s = Math.max(1e-6, ...[0, 1, 2].map((k) => (hi[k] - lo[k]) / 2));
  const arr = pos.getArray();
  if (pos.getNormalized() && arr instanceof Int16Array) {
    const q = new Int16Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) q[i * 3 + k] = Math.max(-32767, Math.min(32767, Math.round(((world[i * 3 + k] - c[k]) / s) * 32767)));
    pos.setArray(q);
    node.setTranslation([c[0], c[1], c[2]]).setScale([s, s, s]);
  } else {
    // a float accessor (an unquantized file): store relative to the node's centre
    const f = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = world[i * 3 + k] - c[k];
    pos.setArray(f).setNormalized(false);
    node.setTranslation([c[0], c[1], c[2]]).setScale([1, 1, 1]);
  }
}

/**
 * Applies `fn` to the world positions of every vertex of every mesh node. A POSITION accessor shared by two nodes is refused
 * (the bake never shares them).
 */
export function mapVertices(doc: Document, fn: (world: Float64Array, node: Node, prim: Primitive) => boolean): number {
  const seen = new Set<Accessor>();
  let changed = 0;
  for (const { node, prims } of meshNodes(doc)) {
    for (const prim of prims) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      if (seen.has(pos)) throw new Error(`glb node ${node.getName()}: a shared POSITION accessor`);
      seen.add(pos);
      const w = worldPositions(node, pos);
      if (fn(w, node, prim)) {
        setWorldPositions(node, pos, w);
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Adds an offset to the translation of every top-level node by editing the GLB's JSON chunk only: the binary chunk (the
 * meshopt-compressed buffers) is kept byte for byte, so nothing is decoded or re-encoded.
 */
export function translateGlbJson(bytes: Uint8Array, d: [number, number, number]): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB: the first chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const roots = new Set<number>();
  for (const sc of json.scenes ?? []) for (const n of sc.nodes ?? []) roots.add(n);
  for (const n of roots) {
    const node = json.nodes[n];
    if (Array.isArray(node.matrix)) {
      node.matrix[12] += d[0];
      node.matrix[13] += d[1];
      node.matrix[14] += d[2];
    } else {
      const t = node.translation ?? [0, 0, 0];
      node.translation = [t[0] + d[0], t[1] + d[1], t[2] + d[2]];
    }
  }
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) {
    const p = new Uint8Array(text.length + pad).fill(0x20);
    p.set(text);
    text = p;
  }
  const rest = bytes.subarray(20 + jsonLen);
  const out = new Uint8Array(20 + text.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, text.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.set(rest, 20 + text.length);
  return out;
}
