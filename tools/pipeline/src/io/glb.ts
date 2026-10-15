import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export interface MaterialSpec {
  name: string;
  /** linear RGBA */
  baseColor: [number, number, number, number];
  metallic?: number;
  roughness?: number;
}

/** An extra vertex attribute of a part (glTF attribute name such as `TEXCOORD_0` or `_BLD`), already in its storage type. */
export interface GlbAttribute {
  name: string;
  /** Float32Array for floats, Uint8Array or Uint16Array for ids and flags (stored as plain integers, not normalized, unless `normalized`) */
  array: Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;
  width: 1 | 2 | 3 | 4;
  normalized?: boolean;
}

export interface GlbPart {
  name: string;
  material: MaterialSpec;
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  /** linear RGB, or omitted for none */
  colors?: ArrayLike<number>;
  /** the alpha of COLOR_0 (0..1, 1 where omitted): the baked ambient occlusion on the meshes that have one */
  alpha?: ArrayLike<number>;
  attributes?: GlbAttribute[];
  indices: ArrayLike<number>;
  /** glTF node extras (the client reads them from the node's userData) */
  extras?: Record<string, unknown>;
}

export function toRgba8(colors: ArrayLike<number>, alpha?: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const n = colors.length / 3;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.max(0, Math.min(255, Math.round(colors[i * 3 + k] * 255)));
    out[i * 4 + 3] = alpha ? Math.max(0, Math.min(255, Math.round(alpha[i] * 255))) : 255;
  }
  return out;
}

const TYPES = ['SCALAR', 'VEC2', 'VEC3', 'VEC4'] as const;

export function buildDocument(parts: GlbPart[]): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('tile');
  const materials = new Map<string, ReturnType<Document['createMaterial']>>();
  for (const p of parts) {
    if (p.indices.length === 0) continue;
    let mat = materials.get(p.material.name);
    if (!mat) {
      mat = doc
        .createMaterial(p.material.name)
        .setBaseColorFactor(p.material.baseColor)
        .setMetallicFactor(p.material.metallic ?? 0)
        .setRoughnessFactor(p.material.roughness ?? 0.9);
      materials.set(p.material.name, mat);
    }
    const prim = doc
      .createPrimitive()
      .setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(Float32Array.from(p.positions)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(Float32Array.from(p.normals)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(p.indices)).setBuffer(buffer));
    if (p.colors) {
      prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(toRgba8(p.colors, p.alpha)).setNormalized(true).setBuffer(buffer));
    }
    for (const a of p.attributes ?? []) {
      prim.setAttribute(a.name, doc.createAccessor().setType(TYPES[a.width - 1]).setArray(a.array).setNormalized(!!a.normalized).setBuffer(buffer));
    }
    const mesh = doc.createMesh(p.name).addPrimitive(prim);
    const node = doc.createNode(p.name).setMesh(mesh);
    if (p.extras) node.setExtras(p.extras as Record<string, never>);
    scene.addChild(node);
  }
  return doc;
}

let ready = false;
async function initMeshopt(): Promise<void> {
  if (ready) return;
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  ready = true;
}

export async function encodeGlb(parts: GlbPart[]): Promise<Uint8Array> {
  await initMeshopt();
  const doc = buildDocument(parts);
  doc.createExtension(KHRMeshQuantization);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 16, quantizeNormal: 8, quantizeColor: 8 }));
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  return io.writeBinary(doc);
}

export async function decodeGlb(bytes: Uint8Array): Promise<Document> {
  await initMeshopt();
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(bytes);
}
