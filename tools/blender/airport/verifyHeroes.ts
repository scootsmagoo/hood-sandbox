/**
 * Checks of the Hartsfield-Jackson hero buildings (public/assets/airport/<id>.glb and <id>.json, built by `npm run assets` from
 * tools/blender/airport/), used by tests/airportHeroes.test.ts. Every manifest entry of kind `hero` is checked:
 *
 *   - structure: groups `lod0`, `lod1`... as the sidecar says; every mesh one of the landmark kit's materials (lm.py MATERIALS,
 *     the interior ones included); facade meshes carry the look's attributes (`_WALL`, `_BLD`, `_BID`, `TEXCOORD_0`); no
 *     texture, no NaN
 *   - budgets: LOD0 up to 45k triangles, LOD1 6k, LOD2 1.5k; 700 KB a file; each level cheaper than the one before
 *   - the sidecar: anchor (x, z, lat, lon), `elevation` finite, the model's height equal to the sidecar's, hull prisms (a valid
 *     ring: 3 or more finite points, an area, no crossing edges; a height above 0 and no taller than the model), a cut-out
 *     ring, `flatten` rings (required unless the hero is a guideway, which levels nothing) with a margin, the level distances
 *     rising
 *   - the model stays within its outline (airport.json rings, else the cut-out) grown by 80 m: jet bridges reach out to the
 *     stands, nothing more (a unit or frame mistake would put it hundreds of metres off)
 *   - a walk-in hero (`interior`): walk nodes inside the model's bounds (a door node up to 3 m outside them), edges between valid nodes with a width, door indices
 *     valid, scenario types one of seat, corner, shopfront, eatery, plaza
 */
import { existsSync, readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

export const MATERIALS = ['bld_wall', 'bld_glass', 'bld_roof', 'lm_stone', 'lm_flood', 'lm_lit', 'lm_metal', 'lm_gold', 'lm_glass', 'lm_glow', 'lm_dark', 'lm_water', 'lm_interior', 'lm_floor', 'lm_window', 'lm_screen'];
export const MAX_TRIS = [45000, 6000, 1500];
export const MAX_BYTES = 700_000;
export const REACH = 80;
export const SCENARIOS = ['seat', 'corner', 'shopfront', 'eatery', 'plaza'];
/** How far past the model's bounds a door node may stand (m): outside its doorway, where it joins the street. */
export const DOOR_MARGIN = 3;

type V2 = [number, number];
type V3 = [number, number, number];

export interface HeroSidecar {
  id: string;
  anchor: { x: number; z: number; lat: number; lon: number };
  yaw: number;
  elevation: number;
  height: number;
  bounds: { min: V3; max: V3 };
  radius: number;
  model: string;
  hash: string;
  bytes: number;
  lods: { tris: number; from: number }[];
  hull: { ring: V2[]; height: number }[];
  cutout: V2[];
  flatten?: { ring: V2[]; margin: number }[];
  replaces: { osm?: string[]; overlap?: number };
  interior?: {
    walk?: { nodes: V3[]; edges: [number, number, number][]; doors: number[] };
    scenarios?: { type: string; x: number; y: number; z: number; yaw: number; cap?: number }[];
  };
}

export interface HeroOutline {
  kind?: string;
  rings: V2[][];
  alsoRings?: V2[][];
}

export interface HeroCheck {
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

const area = (r: V2[]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
};

/** Do two edges of the ring cross (other than neighbours meeting at their shared point)? */
export function selfCrossing(r: V2[]): boolean {
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = r[j], d = r[(j + 1) % n];
      const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [d[0] - c[0], d[1] - c[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * d2[1] - (c[1] - a[1]) * d2[0]) / den;
      const s = ((c[0] - a[0]) * d1[1] - (c[1] - a[1]) * d1[0]) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && s > 1e-6 && s < 1 - 1e-6) return true;
    }
  }
  return false;
}

const ringOk = (r: unknown, minArea: number): string | null => {
  if (!Array.isArray(r) || r.length < 3) return 'fewer than 3 points';
  if (!r.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return 'a non-finite point';
  if (area(r as V2[]) < minArea) return `area ${area(r as V2[]).toFixed(2)} m2`;
  if (selfCrossing(r as V2[])) return 'crossing edges';
  return null;
};

export async function checkHero(id: string, glb: string, json: string, outline?: HeroOutline): Promise<HeroCheck> {
  const problems: string[] = [];
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${id}: ${glb} or ${json} is missing (run npm run assets)`], tris: [], bytes: 0, height: 0 };
  const side = JSON.parse(readFileSync(json, 'utf8')) as HeroSidecar;
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES) problems.push(`${id}: ${bytes} bytes (limit ${MAX_BYTES})`);
  if (side.id !== id) problems.push(`${id}: the sidecar says ${side.id}`);
  const a = side.anchor;
  if (![a?.x, a?.z, a?.lat, a?.lon].every(Number.isFinite)) problems.push(`${id}: the sidecar's anchor is incomplete`);
  if (!Number.isFinite(side.elevation)) problems.push(`${id}: elevation ${side.elevation} is not a number`);
  const doc = await read(glb);
  if (doc.getRoot().listTextures().length) problems.push(`${id}: has textures`);
  const tris: number[] = [];
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
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
          let bad = false;
          for (let k = 0; k < pos.getCount(); k++) {
            pos.getElement(k, el);
            if (!el.every(Number.isFinite)) bad = true;
            if (i === 0) {
              // quantised positions carry their scale and offset on the node
              const w: V3 = [
                m[0] * el[0] + m[4] * el[1] + m[8] * el[2] + m[12],
                m[1] * el[0] + m[5] * el[1] + m[9] * el[2] + m[13],
                m[2] * el[0] + m[6] * el[1] + m[10] * el[2] + m[14],
              ];
              for (let c = 0; c < 3; c++) {
                lo[c] = Math.min(lo[c], w[c]);
                hi[c] = Math.max(hi[c], w[c]);
              }
            }
          }
          if (bad) problems.push(`${id}: lod${i} ${n.getName()} has a non-finite position`);
        }
      }
      n.listChildren().forEach(visit);
    };
    visit(grp);
    tris.push(t);
    const cap = MAX_TRIS[Math.min(i, MAX_TRIS.length - 1)];
    if (t > cap) problems.push(`${id}: lod${i} has ${t} triangles (limit ${cap})`);
    if (t !== side.lods[i].tris) problems.push(`${id}: lod${i} has ${t} triangles, the sidecar says ${side.lods[i].tris}`);
    if (i > 0 && !(side.lods[i].from > side.lods[i - 1].from)) problems.push(`${id}: lod${i} starts at ${side.lods[i].from} m, not beyond lod${i - 1}`);
    if (i > 0 && !(t < tris[i - 1])) problems.push(`${id}: lod${i} (${t}) is not cheaper than lod${i - 1} (${tris[i - 1]})`);
  }
  if (side.lods[0]?.from !== 0) problems.push(`${id}: lod0 does not start at 0 m`);
  const top = hi[1];
  if (Math.abs(top - side.height) > 0.6) problems.push(`${id}: the model is ${top.toFixed(1)} m tall, the sidecar says ${side.height}`);
  // hull, cut-out, flatten
  if (!side.hull?.length) problems.push(`${id}: no hull`);
  for (const [k, h] of (side.hull ?? []).entries()) {
    const e = ringOk(h.ring, 0.4);
    if (e) problems.push(`${id}: hull ${k}: ${e}`);
    if (!(h.height > 0 && h.height <= side.height + 0.5)) problems.push(`${id}: hull ${k} is ${h.height} m high (the model is ${side.height})`);
  }
  const ce = ringOk(side.cutout, 1);
  if (ce) problems.push(`${id}: cut-out: ${ce}`);
  if (side.flatten) {
    for (const [k, f] of side.flatten.entries()) {
      const e = ringOk(f.ring, 1);
      if (e) problems.push(`${id}: flatten ${k}: ${e}`);
      if (!(f.margin >= 0 && f.margin <= 200)) problems.push(`${id}: flatten ${k} has margin ${f.margin}`);
    }
  } else if (outline?.kind !== 'guideway') problems.push(`${id}: no flatten rings`);
  // the model within its outline grown by REACH
  const rings = outline ? [...outline.rings, ...(outline.alsoRings ?? [])] : [side.cutout];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (const p of r) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  if (lo[0] < x0 - REACH || hi[0] > x1 + REACH || lo[2] < z0 - REACH || hi[2] > z1 + REACH) {
    problems.push(`${id}: the model spans x ${lo[0].toFixed(0)}..${hi[0].toFixed(0)}, z ${lo[2].toFixed(0)}..${hi[2].toFixed(0)}, beyond its outline (x ${x0.toFixed(0)}..${x1.toFixed(0)}, z ${z0.toFixed(0)}..${z1.toFixed(0)}) + ${REACH} m`);
  }
  if (lo[1] < -15) problems.push(`${id}: reaches ${lo[1].toFixed(1)} m under its floor`);
  // a walk-in hero's interior
  const walk = side.interior?.walk;
  if (side.interior) {
    if (!walk || !Array.isArray(walk.nodes) || !walk.nodes.length) problems.push(`${id}: interior without walk nodes`);
    else {
      const n = walk.nodes.length;
      const doors = new Set(walk.doors ?? []);
      for (const [k, p] of walk.nodes.entries()) {
        // a door node may stand just outside the doorway (DOOR_MARGIN), where it meets the street's network
        const m = doors.has(k) ? DOOR_MARGIN : 1;
        if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) problems.push(`${id}: walk node ${k} is not a point`);
        else if (p[0] < lo[0] - m || p[0] > hi[0] + m || p[1] < lo[1] - 1 || p[1] > hi[1] + 1 || p[2] < lo[2] - m || p[2] > hi[2] + m) problems.push(`${id}: walk node ${k} (${p.map((v) => v.toFixed(1))}) is outside the model`);
      }
      for (const [k, e] of (walk.edges ?? []).entries()) {
        if (!Array.isArray(e) || !Number.isInteger(e[0]) || !Number.isInteger(e[1]) || e[0] < 0 || e[1] < 0 || e[0] >= n || e[1] >= n || e[0] === e[1]) problems.push(`${id}: walk edge ${k} (${e}) does not join two nodes`);
        else if (!(e[2] > 0)) problems.push(`${id}: walk edge ${k} has width ${e[2]}`);
      }
      for (const d of walk.doors ?? []) if (!Number.isInteger(d) || d < 0 || d >= n) problems.push(`${id}: door ${d} is not a node`);
    }
    for (const [k, s] of (side.interior.scenarios ?? []).entries()) {
      if (!SCENARIOS.includes(s.type)) problems.push(`${id}: scenario ${k} has type "${s.type}"`);
      if (![s.x, s.y, s.z].every(Number.isFinite)) problems.push(`${id}: scenario ${k} has no position`);
    }
  }
  return { problems, tris, bytes, height: top };
}
