/**
 * Checks of the tree and street-furniture assets (public/assets/props/*.glb, built by `npm run assets`),
 * used by tests/anchorProps.test.ts:
 *
 *   - structure: every tree species has `tree_<name>_lod0` and `_lod1` (mesh with POSITION, NORMAL, TEXCOORD_0, COLOR_0)
 *     and every furniture model its `_mesh` (lamps also an anchor)
 *   - triangle budgets per level
 *   - the body radius over the heights of propDims.json equals the radius the sim's collider uses
 *   - the model's height equals `refH` (trees, lamps) and a lamp's anchor is at its head
 *   - vertex alpha codes: a tree's near level has leaf cards (alpha > 0.5) and its mid level has none
 */
import { readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { HYDRANT, BIN, BOLLARD, LAMP_MODELS, TREE_SPECIES } from '../../../src/shared/props.ts';

type V3 = [number, number, number];
export const TREE_NAMES = ['oak', 'sweetgum', 'pine', 'myrtle', 'redoak'];
export const FURNITURE = ['lamp_cobra', 'lamp_post', 'lamp_mast', 'hydrant', 'bin', 'bollard'];
/** [min, max] triangles per tree level: near, mid. */
export const TREE_TRIS: [number, number][] = [
  [500, 1400],
  [250, 800],
];
export const FURNITURE_MAX_TRIS = 450;
export const MAX_BYTES = { trees: 300_000, furniture: 80_000 };

export async function readProps(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

const apply = (m: number[], x: number, y: number, z: number): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function node(doc: Document, name: string): Node | undefined {
  return doc.getRoot().listNodes().find((n) => n.getName() === name);
}

export function pointsOf(n: Node): V3[] {
  const out: V3[] = [];
  const mesh = n.getMesh();
  if (!mesh) return out;
  const m = n.getWorldMatrix() as unknown as number[];
  const el: number[] = [];
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION')!;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      out.push(apply(m, el[0], el[1], el[2]));
    }
  }
  return out;
}

export function triangles(n: Node): number {
  let t = 0;
  for (const p of n.getMesh()?.listPrimitives() ?? []) t += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3;
  return t;
}

/** The greatest horizontal reach (from the vertical axis through the model's origin, in x and z separately) of the vertices between two heights. */
export function bodyRadius(pts: V3[], y0: number, y1: number): number {
  let r = 0;
  let found = 0;
  for (const [x, y, z] of pts) {
    if (y < y0 || y > y1) continue;
    found++;
    r = Math.max(r, Math.hypot(x, z));
  }
  return found ? r : NaN;
}

export interface PropsCheck {
  problems: string[];
  /** Triangles: trees [near, mid] per species, then the furniture in FURNITURE's order. */
  tris: number[];
  bytes: number;
  radius: Record<string, number>;
  heights: Record<string, number>;
}

function alphaCodes(n: Node): { leaf: number; solid: number } {
  let leaf = 0;
  let solid = 0;
  const el: number[] = [];
  for (const p of n.getMesh()?.listPrimitives() ?? []) {
    const c = p.getAttribute('COLOR_0');
    if (!c) continue;
    for (let i = 0; i < c.getCount(); i++) {
      c.getElement(i, el);
      if (el[3] > 0.5) leaf++;
      else solid++;
    }
  }
  return { leaf, solid };
}

export async function checkProps(treesPath: string, furniturePath: string): Promise<PropsCheck> {
  const problems: string[] = [];
  const tris: number[] = [];
  const radius: Record<string, number> = {};
  const heights: Record<string, number> = {};
  const trees = await readProps(treesPath);
  const furn = await readProps(furniturePath);
  const bytes = readFileSync(treesPath).length + readFileSync(furniturePath).length;
  if (readFileSync(treesPath).length > MAX_BYTES.trees) problems.push(`trees.glb is ${readFileSync(treesPath).length} bytes (limit ${MAX_BYTES.trees})`);
  if (readFileSync(furniturePath).length > MAX_BYTES.furniture) problems.push(`furniture.glb is ${readFileSync(furniturePath).length} bytes (limit ${MAX_BYTES.furniture})`);

  TREE_NAMES.forEach((name, i) => {
    const d = TREE_SPECIES[i];
    for (const lod of [0, 1]) {
      const n = node(trees, `tree_${name}_lod${lod}`);
      if (!n) return void problems.push(`missing tree_${name}_lod${lod}`);
      const prim = n.getMesh()?.listPrimitives()[0];
      for (const sem of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0']) if (!prim?.getAttribute(sem)) problems.push(`${name} lod${lod} has no ${sem}`);
      const t = triangles(n);
      tris.push(t);
      if (t < TREE_TRIS[lod][0] || t > TREE_TRIS[lod][1]) problems.push(`${name} lod${lod}: ${t} triangles, budget ${TREE_TRIS[lod].join('-')}`);
      const codes = alphaCodes(n);
      if (lod === 0 && codes.leaf < 40) problems.push(`${name} lod0 has ${codes.leaf} leaf-card vertices`);
      if (lod === 1 && codes.leaf > 0) problems.push(`${name} lod1 must have no alpha cards (${codes.leaf})`);
      const pts = pointsOf(n);
      const r = bodyRadius(pts, d.solidH > 0 ? 0.9 : 0.9, 1.1);
      if (lod === 1) {
        radius[name] = r;
        if (!(Math.abs(r - d.r) < 0.02)) problems.push(`${name}: trunk radius at 1 m is ${r.toFixed(3)}, propDims.json says ${d.r}`);
      }
      const top = Math.max(...pts.map((p) => p[1]));
      if (lod === 0) {
        heights[name] = top;
        if (Math.abs(top - d.refH) > d.refH * 0.12) problems.push(`${name}: ${top.toFixed(2)} m tall, refH is ${d.refH}`);
      }
      const reach = Math.max(...pts.map((p) => Math.hypot(p[0], p[2])));
      if (Math.abs(reach - d.refR) > d.refR * 0.3) problems.push(`${name} lod${lod}: crown reaches ${reach.toFixed(2)} m, refR is ${d.refR}`);
    }
  });

  const dims: Record<string, { r: number; solidH: number; measure: number[]; refH?: number }> = {
    lamp_cobra: LAMP_MODELS[0] as never,
    lamp_post: LAMP_MODELS[1] as never,
    lamp_mast: LAMP_MODELS[2] as never,
    hydrant: HYDRANT as never,
    bin: BIN as never,
    bollard: BOLLARD as never,
  };
  const lampMeasure = [0.9, 1.1];
  for (const name of FURNITURE) {
    const n = node(furn, `${name}_mesh`);
    if (!n) {
      problems.push(`missing ${name}_mesh`);
      continue;
    }
    const t = triangles(n);
    tris.push(t);
    if (t > FURNITURE_MAX_TRIS) problems.push(`${name}: ${t} triangles (limit ${FURNITURE_MAX_TRIS})`);
    const d = dims[name];
    const m = (d as { measure?: number[] }).measure ?? lampMeasure;
    const pts = pointsOf(n);
    const r = bodyRadius(pts, m[0], m[1]);
    radius[name] = r;
    if (!(Math.abs(r - d.r) < 0.02)) problems.push(`${name}: body radius ${r.toFixed(3)} over ${m.join('-')} m, propDims.json says ${d.r}`);
    const top = Math.max(...pts.map((p) => p[1]));
    heights[name] = top;
    if (d.refH !== undefined && Math.abs(top - d.refH) > 0.35) problems.push(`${name}: ${top.toFixed(2)} m tall, refH is ${d.refH}`);
    if (d.refH === undefined && Math.abs(top - d.solidH) > 0.12) problems.push(`${name}: ${top.toFixed(2)} m tall, solid height is ${d.solidH}`);
    if (name.startsWith('lamp_')) {
      const a = node(furn, `${name}_anchor`);
      if (!a) problems.push(`${name} has no anchor`);
      else {
        const [x, y, z] = apply(a.getWorldMatrix() as unknown as number[], 0, 0, 0);
        if (Math.abs(y - top) > 0.8 || Math.abs(x) > 0.1 || z < -0.01) problems.push(`${name}: anchor at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) is not at the head`);
      }
    }
  }
  return { problems, tris, bytes, radius, heights };
}
