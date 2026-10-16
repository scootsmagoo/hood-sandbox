/**
 * Checks of the hero landmark models (public/assets/landmarks/<id>.glb and <id>.json, built by `npm run assets`), used by
 * tests/landmarkAssets.test.ts:
 *
 *   - structure: groups `lod0`, `lod1`... as the sidecar says; every mesh a known material; facade meshes carry the look's
 *     attributes (`_WALL`, `_BLD`, `_BID`, `TEXCOORD_0`); no texture, no NaN
 *   - budgets: triangles per level (a big LOD0 up to 40k, a far level up to 4k), bytes
 *   - the sidecar: anchor, hull prisms (a ring of 3 or more points, a height no taller than the model), a cut-out ring, the
 *     level distances rising, the model's height equal to the sidecar's
 *   - the model stays near its anchor (nothing 400 m off: a unit mistake)
 */
import { existsSync, readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

export const MATERIALS = ['bld_wall', 'bld_glass', 'bld_roof', 'lm_stone', 'lm_flood', 'lm_lit', 'lm_metal', 'lm_gold', 'lm_glass', 'lm_glow', 'lm_dark'];
export const MAX_TRIS = [40000, 4000, 1500];
export const MAX_BYTES = 400_000;

export interface Sidecar {
  id: string;
  anchor: { x: number; z: number; lat: number; lon: number };
  yaw: number;
  height: number;
  radius: number;
  model: string;
  hash: string;
  bytes: number;
  lods: { tris: number; from: number }[];
  hull: { ring: [number, number][]; height: number }[];
  cutout: [number, number][];
  replaces: { overture?: string[]; also?: string[]; overlap?: number };
}

export interface LandmarkCheck {
  problems: string[];
  tris: number[];
  bytes: number;
  height: number;
}

async function read(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

const area = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
};

export async function checkLandmark(id: string, glb: string, json: string): Promise<LandmarkCheck> {
  const problems: string[] = [];
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${id}: ${glb} or ${json} is missing (run npm run assets)`], tris: [], bytes: 0, height: 0 };
  const side = JSON.parse(readFileSync(json, 'utf8')) as Sidecar;
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES) problems.push(`${id}: ${bytes} bytes (limit ${MAX_BYTES})`);
  if (side.id !== id) problems.push(`${id}: the sidecar says ${side.id}`);
  if (!Number.isFinite(side.anchor?.lat) || !Number.isFinite(side.anchor?.lon)) problems.push(`${id}: sidecar has no anchor lat/lon`);
  const doc = await read(glb);
  if (doc.getRoot().listTextures().length) problems.push(`${id}: has textures`);
  const tris: number[] = [];
  let top = -Infinity;
  let reach = 0;
  const el: number[] = [];
  for (let i = 0; i < side.lods.length; i++) {
    const grp = doc.getRoot().listNodes().find((n) => n.getName() === `lod${i}`);
    if (!grp) {
      problems.push(`${id}: no lod${i} group`);
      tris.push(0);
      continue;
    }
    let t = 0;
    const visit = (n: Node) => {
      const mesh = n.getMesh();
      if (mesh) {
        for (const p of mesh.listPrimitives()) {
          const mat = p.getMaterial()?.getName() ?? '';
          if (!MATERIALS.includes(mat)) problems.push(`${id}: lod${i} mesh ${n.getName()} has material "${mat}"`);
          const need = mat === 'bld_wall' || mat === 'bld_glass' ? ['POSITION', 'NORMAL', 'COLOR_0', '_WALL', '_BLD', '_BID', 'TEXCOORD_0'] : ['POSITION', 'NORMAL', 'COLOR_0'];
          for (const s of need) if (!p.getAttribute(s)) problems.push(`${id}: lod${i} ${n.getName()} has no ${s}`);
          const pos = p.getAttribute('POSITION')!;
          t += (p.getIndices()?.getCount() ?? pos.getCount()) / 3;
          const m = n.getWorldMatrix() as unknown as number[];
          for (let k = 0; k < pos.getCount(); k++) {
            pos.getElement(k, el);
            if (!el.every(Number.isFinite)) problems.push(`${id}: lod${i} has a non-finite position`);
            if (i === 0) {
              // quantised positions carry their scale and offset on the node
              const x = m[0] * el[0] + m[4] * el[1] + m[8] * el[2] + m[12];
              const y = m[1] * el[0] + m[5] * el[1] + m[9] * el[2] + m[13];
              const z = m[2] * el[0] + m[6] * el[1] + m[10] * el[2] + m[14];
              top = Math.max(top, y);
              reach = Math.max(reach, Math.hypot(x, z));
            }
          }
        }
      }
      n.listChildren().forEach(visit);
    };
    visit(grp);
    tris.push(t);
    if (t > MAX_TRIS[Math.min(i, MAX_TRIS.length - 1)]) problems.push(`${id}: lod${i} has ${t} triangles (limit ${MAX_TRIS[Math.min(i, MAX_TRIS.length - 1)]})`);
    if (t !== side.lods[i].tris) problems.push(`${id}: lod${i} has ${t} triangles, the sidecar says ${side.lods[i].tris}`);
    if (i > 0 && !(side.lods[i].from > side.lods[i - 1].from)) problems.push(`${id}: lod${i} starts at ${side.lods[i].from} m, not beyond lod${i - 1}`);
  }
  if (side.lods.length >= 2 && tris[1] >= tris[0]) problems.push(`${id}: the far level (${tris[1]}) is not cheaper than the near one (${tris[0]})`);
  if (Math.abs(top - side.height) > 0.6) problems.push(`${id}: model is ${top.toFixed(1)} m tall, the sidecar says ${side.height}`);
  if (reach > 400) problems.push(`${id}: reaches ${reach.toFixed(0)} m from its anchor`);
  for (const h of side.hull) {
    if (h.ring.length < 3 || area(h.ring) < 6) problems.push(`${id}: a hull ring is degenerate`);
    if (!(h.height > 1 && h.height <= side.height + 1)) problems.push(`${id}: a hull prism is ${h.height} m high (the model is ${side.height})`);
  }
  if (side.cutout.length < 3 && side.hull.length) problems.push(`${id}: no cut-out ring`);
  return { problems, tris, bytes, height: top };
}
