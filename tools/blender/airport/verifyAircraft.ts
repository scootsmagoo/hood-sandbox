/**
 * Checks of the airport's aircraft and airside vehicles (public/assets/airport/ac-*.glb with their sidecars, built by
 * `npm run assets` from tools/blender/airport/aircraft.py and ground.py), used by tests/airportAircraft.test.ts:
 *
 *   aircraft  structure (aircraft > lod0..2 > lodN_body, lodN_gear on the near levels; anchors), material names and their
 *             attributes (COLOR_0 normalised RGBA; the painted skin's livery codes k/7), triangle budgets, bounds against
 *             src/shared/data/aircraft.json (length, span, height, tyres on the ground, the nose gear at the wheelbase),
 *             the anchors on the file's numbers, every collider inside the model, the sidecar agreeing with the file, size
 *   ground    every vehicle a top-level node at the origin with `<name>_lod0` and `<name>_lod1`, budgets, sizes against
 *             aircraft.json `ground`, wheels on the ground, the tug's hitch, the sidecar agreeing with the file, size
 */
import { existsSync, readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node, type Primitive } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

type V3 = [number, number, number];
export const MATERIALS = ['ac_paint', 'ac_grey', 'ac_metal', 'ac_dark', 'ac_window', 'ac_light'];
export const LOD_FROM = [0, 220, 1100];
export const AIRCRAFT_TRIS: Record<string, [number, number][]> = {
  narrowbody: [[6000, 10000], [1200, 2600], [150, 450]],
  widebody: [[8000, 13000], [1200, 2600], [150, 450]],
  regional: [[5000, 9000], [1200, 2600], [150, 450]],
};
export const GROUND_PARTS = ['tug', 'baggageTractor', 'baggageCart', 'beltLoader'];
export const GROUND_TRIS: [number, number][] = [[300, 1200], [1, 299]];
export const MAX_BYTES = 450_000;
export const ANCHORS = ['anchor_doorL1', 'anchor_navLeft', 'anchor_navRight', 'anchor_tail', 'anchor_beaconTop', 'anchor_beaconBottom', 'anchor_landing', 'anchor_strobeLeft', 'anchor_strobeRight', 'anchor_noseGear', 'anchor_tow'];
const LIGHTS: Record<string, string> = { anchor_navLeft: 'navLeft', anchor_navRight: 'navRight', anchor_tail: 'tail', anchor_beaconTop: 'beaconTop', anchor_beaconBottom: 'beaconBottom', anchor_landing: 'landing', anchor_strobeLeft: 'strobeLeft', anchor_strobeRight: 'strobeRight' };

export interface AircraftType {
  length: number;
  span: number;
  height: number;
  noseZ: number;
  tailZ: number;
  wheelbase: number;
  mainGearHalfTrack: number;
  doorL1: { x: number; y: number; z: number };
  colliders: { c: V3; h: V3 }[];
  lights: Record<string, V3>;
}
export interface GroundDims {
  length: number;
  width: number;
  height: number;
  hitchZ?: number;
}

export async function readGlb(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

const apply = (m: number[], x: number, y: number, z: number): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const node = (doc: Document, name: string): Node | undefined => doc.getRoot().listNodes().find((n) => n.getName() === name);
const origin = (n: Node): V3 => apply(n.getWorldMatrix() as unknown as number[], 0, 0, 0);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const fmt = (v: number[]) => `(${v.map((x) => x.toFixed(3)).join(', ')})`;

function meshNodes(n: Node): Node[] {
  return [...(n.getMesh() ? [n] : []), ...n.listChildren().flatMap(meshNodes)];
}

function primitives(n: Node): { node: Node; prim: Primitive }[] {
  return meshNodes(n).flatMap((m) => m.getMesh()!.listPrimitives().map((prim) => ({ node: m, prim })));
}

export function triangles(n: Node): number {
  return primitives(n).reduce((s, { prim }) => s + (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')!.getCount()) / 3, 0);
}

/** World positions of the vertices under n, optionally of one material only. */
export function points(n: Node, material?: string): V3[] {
  const out: V3[] = [];
  const el: number[] = [];
  for (const { node: m, prim } of primitives(n)) {
    if (material && prim.getMaterial()?.getName() !== material) continue;
    const w = m.getWorldMatrix() as unknown as number[];
    const pos = prim.getAttribute('POSITION')!;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      out.push(apply(w, el[0], el[1], el[2]));
    }
  }
  return out;
}

export function bounds(pts: V3[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p[k])), (max[k] = Math.max(max[k], p[k]));
  return { min, max };
}

/** Material names, the attributes every primitive needs, COLOR_0 as normalised RGBA, and the livery codes of the paint. */
function checkPrims(where: string, n: Node, problems: string[]) {
  const el: number[] = [];
  for (const { node: m, prim } of primitives(n)) {
    const mat = prim.getMaterial()?.getName() ?? '';
    if (!MATERIALS.includes(mat)) problems.push(`${where}: ${m.getName()} has material "${mat}"`);
    for (const s of ['POSITION', 'NORMAL', 'COLOR_0']) if (!prim.getAttribute(s)) problems.push(`${where}: ${m.getName()} ${mat} has no ${s}`);
    const col = prim.getAttribute('COLOR_0');
    if (!col) continue;
    if (col.getType() !== 'VEC4') problems.push(`${where}: ${m.getName()} ${mat} COLOR_0 is ${col.getType()}, not RGBA`);
    if (col.getComponentType() !== 5126 && !col.getNormalized()) problems.push(`${where}: ${m.getName()} ${mat} COLOR_0 is not normalised`);
    if (mat === 'ac_paint') {
      let bad = 0;
      for (let i = 0; i < col.getCount(); i++) {
        col.getElement(i, el);
        const k = el[0] * 7;
        if (Math.abs(k - Math.round(k)) > 0.05 || Math.round(k) > 5 || el[1] < 0.97) bad++;
      }
      if (bad) problems.push(`${where}: ${m.getName()} ac_paint has ${bad} vertices whose COLOR_0 is not a livery region (r = k/7, g = 1)`);
    }
  }
}

export interface AircraftCheck {
  problems: string[];
  tris: number[];
  bytes: number;
  bounds: { min: V3; max: V3 };
}

export async function checkAircraft(asset: string, glb: string, json: string, type: string, T: AircraftType): Promise<AircraftCheck> {
  const problems: string[] = [];
  const empty = { min: [0, 0, 0] as V3, max: [0, 0, 0] as V3 };
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${glb} or ${json} is missing (run npm run assets)`], tris: [], bytes: 0, bounds: empty };
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES) problems.push(`${asset}: ${bytes} bytes (limit ${MAX_BYTES})`);
  const side = JSON.parse(readFileSync(json, 'utf8'));
  const doc = await readGlb(glb);
  if (doc.getRoot().listTextures().length) problems.push(`${asset}: has textures`);
  const root = node(doc, 'aircraft');
  if (!root) return { problems: [...problems, `${asset}: no root node "aircraft"`], tris: [], bytes, bounds: empty };
  const ex = root.getExtras() as { asset?: string; type?: string; lod_from?: number[]; lod_tris?: number[] };
  if (ex.asset !== asset || ex.type !== type) problems.push(`${asset}: root extras say asset ${ex.asset}, type ${ex.type}`);
  if (JSON.stringify(ex.lod_from) !== JSON.stringify(LOD_FROM)) problems.push(`${asset}: lod_from is ${JSON.stringify(ex.lod_from)}`);
  if (side.kind !== 'aircraft' || side.type !== type) problems.push(`${asset}: the sidecar's kind/type is ${side.kind}/${side.type}`);

  const tris: number[] = [];
  for (let i = 0; i < 3; i++) {
    const g = node(doc, `lod${i}`);
    if (!g || g.getParentNode() !== root) {
      problems.push(`${asset}: no lod${i} under aircraft`);
      tris.push(0);
      continue;
    }
    const t = triangles(g);
    tris.push(t);
    const [lo, hi] = AIRCRAFT_TRIS[type][i];
    if (t < lo || t > hi) problems.push(`${asset}: lod${i} has ${t} triangles (budget ${lo}..${hi})`);
    if (side.lods?.[i]?.tris !== t) problems.push(`${asset}: lod${i} has ${t} triangles, the sidecar says ${side.lods?.[i]?.tris}`);
    if (side.lods?.[i]?.from !== LOD_FROM[i]) problems.push(`${asset}: the sidecar's lod${i} starts at ${side.lods?.[i]?.from}`);
    checkPrims(`${asset} lod${i}`, g, problems);
    const body = node(doc, `lod${i}_body`);
    if (!body || body.getParentNode() !== g) problems.push(`${asset}: no lod${i}_body under lod${i}`);
    else if (body.getMesh()?.listPrimitives().length !== new Set(body.getMesh()!.listPrimitives().map((p) => p.getMaterial()?.getName())).size) problems.push(`${asset}: lod${i}_body has more than one primitive per material`);
    const gear = node(doc, `lod${i}_gear`);
    if (i < 2 && (!gear || gear.getParentNode() !== g)) problems.push(`${asset}: no lod${i}_gear under lod${i}`);
    const names = g.listChildren().map((c) => c.getName());
    for (const nm of names) if (![`lod${i}_body`, `lod${i}_gear`].includes(nm)) problems.push(`${asset}: unexpected node ${nm} under lod${i}`);
  }
  if (!(tris[0] > tris[1] && tris[1] > tris[2])) problems.push(`${asset}: the levels are not getting cheaper (${tris.join(' / ')})`);
  const lod0 = node(doc, 'lod0');
  if (lod0) {
    const used = new Set(primitives(lod0).map((p) => p.prim.getMaterial()?.getName()));
    for (const m of MATERIALS) if (!used.has(m)) problems.push(`${asset}: lod0 does not use ${m}`);
  }

  // bounds against aircraft.json (gear down)
  const all = lod0 ? points(lod0) : [];
  const b = bounds(all);
  const len = b.max[2] - b.min[2];
  const span = b.max[0] - b.min[0];
  if (!near(len, T.length, 0.02 * T.length)) problems.push(`${asset}: ${len.toFixed(2)} m long, aircraft.json says ${T.length}`);
  if (!near(b.max[2], T.noseZ, 0.02 * T.length) || !near(b.min[2], T.tailZ, 0.02 * T.length)) problems.push(`${asset}: runs z ${b.min[2].toFixed(2)}..${b.max[2].toFixed(2)}, aircraft.json says ${T.tailZ}..${T.noseZ}`);
  if (!near(span, T.span, 0.02 * T.span)) problems.push(`${asset}: span ${span.toFixed(2)} m, aircraft.json says ${T.span}`);
  if (!near(b.max[0] + b.min[0], 0, 0.02)) problems.push(`${asset}: not symmetric (x ${b.min[0].toFixed(3)}..${b.max[0].toFixed(3)})`);
  if (!near(b.max[1], T.height, 0.04 * T.height)) problems.push(`${asset}: ${b.max[1].toFixed(2)} m high, aircraft.json says ${T.height}`);
  if (!near(b.min[1], 0, 0.03)) problems.push(`${asset}: the lowest point is at y ${b.min[1].toFixed(3)}, not on the ground`);
  const gear0 = node(doc, 'lod0_gear');
  if (gear0) {
    const contact = points(gear0).filter((p) => p[1] < 0.03);
    const nose = contact.filter((p) => p[2] > T.wheelbase / 2);
    const mains = contact.filter((p) => p[2] < T.wheelbase / 2);
    if (!nose.length) problems.push(`${asset}: no nose wheel on the ground`);
    else {
      const bn = bounds(nose);
      const z = (bn.min[2] + bn.max[2]) / 2;
      if (!near(z, T.wheelbase, 0.2)) problems.push(`${asset}: the nose gear touches down at z ${z.toFixed(2)}, the wheelbase is ${T.wheelbase}`);
    }
    for (const s of [1, -1]) {
      const m = mains.filter((p) => p[0] * s > 0);
      if (!m.length) problems.push(`${asset}: no main gear on the ground on the ${s > 0 ? 'left' : 'right'}`);
      else {
        const bm = bounds(m);
        const x = (bm.min[0] + bm.max[0]) / 2;
        const z = (bm.min[2] + bm.max[2]) / 2;
        if (!near(Math.abs(x), T.mainGearHalfTrack, 0.15) || !near(z, 0, 0.2)) problems.push(`${asset}: the ${s > 0 ? 'left' : 'right'} main gear touches down at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
  }
  // the levels of detail keep the silhouette
  for (let i = 1; i < 3; i++) {
    const g = node(doc, `lod${i}`);
    if (!g) continue;
    const bi = bounds(points(g));
    for (let k = 0; k < 3; k++) {
      if (!near(bi.max[k], b.max[k], 0.06 * (b.max[k] - b.min[k])) || !near(bi.min[k], b.min[k], 0.06 * (b.max[k] - b.min[k]) + (k === 1 ? 2.5 : 0))) problems.push(`${asset}: lod${i}'s bounds ${fmt(bi.min)}..${fmt(bi.max)} differ from lod0's`);
    }
  }

  // anchors
  const anc = node(doc, 'anchors');
  if (!anc || anc.getParentNode() !== root) problems.push(`${asset}: no anchors under aircraft`);
  for (const a of ANCHORS) {
    const n = node(doc, a);
    if (!n) {
      problems.push(`${asset}: no ${a}`);
      continue;
    }
    if (anc && n.getParentNode() !== anc) problems.push(`${asset}: ${a} is not under anchors`);
    const o = origin(n);
    const want: V3 | undefined = a === 'anchor_doorL1' ? [T.doorL1.x, T.doorL1.y, T.doorL1.z] : a === 'anchor_noseGear' ? [0, 0, T.wheelbase] : LIGHTS[a] ? T.lights[LIGHTS[a]] : undefined;
    if (want && !o.every((v, k) => near(v, want[k], a === 'anchor_doorL1' ? 0.05 : 0.01))) problems.push(`${asset}: ${a} at ${fmt(o)}, aircraft.json says ${fmt(want)}`);
    if (a === 'anchor_tow' && (!near(o[0], 0, 0.01) || !near(o[2], T.wheelbase, 0.6) || o[1] < 0 || o[1] > 1.2)) problems.push(`${asset}: anchor_tow at ${fmt(o)} is not at the nose gear`);
    const sa = side.anchors?.[a];
    if (!sa || !sa.every((v: number, k: number) => near(v, o[k], 0.001))) problems.push(`${asset}: the sidecar's ${a} is ${JSON.stringify(sa)}, the file has ${fmt(o)}`);
  }
  // the door anchor sits on the skin, the lamps on the model (a lens within 30 cm of each light)
  const body0 = node(doc, 'lod0_body');
  if (body0) {
    const paint = points(body0, 'ac_paint');
    const d = T.doorL1;
    const skin = paint.filter((p) => Math.abs(p[2] - d.z) < 0.6 && Math.abs(p[1] - d.y) < 0.6 && p[0] > 0);
    const x = skin.length ? Math.max(...skin.map((p) => p[0])) : 0;
    if (!near(x, d.x, 0.05)) problems.push(`${asset}: the skin at the L1 door is at x ${x.toFixed(3)}, doorL1.x is ${d.x}`);
    const lens = [...points(body0, 'ac_light'), ...(gear0 ? points(gear0, 'ac_light') : [])];
    for (const [a, l] of Object.entries(LIGHTS)) {
      const p = T.lights[l];
      const dmin = Math.min(...lens.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])));
      if (!(dmin < 0.3)) problems.push(`${asset}: no lamp lens at ${a} ${fmt(p)}`);
    }
  }
  // colliders inside the model (a small margin), and the sidecar's copy of them
  for (const [i, c] of T.colliders.entries()) {
    const lo = c.c.map((v, k) => v - c.h[k]);
    const hi = c.c.map((v, k) => v + c.h[k]);
    if (lo.some((v, k) => v < b.min[k] - 0.15) || hi.some((v, k) => v > b.max[k] + 0.15)) problems.push(`${asset}: collider ${i} ${fmt(lo)}..${fmt(hi)} is outside the model ${fmt(b.min)}..${fmt(b.max)}`);
  }
  if (JSON.stringify(side.colliders) !== JSON.stringify(T.colliders)) problems.push(`${asset}: the sidecar's colliders are not aircraft.json's`);
  for (const k of ['length', 'span', 'height'] as const) if (side.dims?.[k] !== T[k]) problems.push(`${asset}: the sidecar's ${k} is ${side.dims?.[k]}, aircraft.json says ${T[k]}`);
  return { problems, tris, bytes, bounds: b };
}

export interface GroundCheck {
  problems: string[];
  tris: Record<string, number[]>;
  bytes: number;
  sizes: Record<string, V3>;
}

export async function checkGround(asset: string, glb: string, json: string, dims: Record<string, GroundDims>): Promise<GroundCheck> {
  const problems: string[] = [];
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${glb} or ${json} is missing (run npm run assets)`], tris: {}, bytes: 0, sizes: {} };
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES) problems.push(`${asset}: ${bytes} bytes (limit ${MAX_BYTES})`);
  const side = JSON.parse(readFileSync(json, 'utf8'));
  if (side.kind !== 'ground') problems.push(`${asset}: the sidecar's kind is ${side.kind}`);
  const doc = await readGlb(glb);
  if (doc.getRoot().listTextures().length) problems.push(`${asset}: has textures`);
  const top = doc.getRoot().listScenes()[0].listChildren();
  const tris: Record<string, number[]> = {};
  const sizes: Record<string, V3> = {};
  for (const p of GROUND_PARTS) {
    const n = top.find((t) => t.getName() === p);
    if (!n) {
      problems.push(`${asset}: no top-level node "${p}"`);
      continue;
    }
    if (!origin(n).every((v) => near(v, 0, 1e-6))) problems.push(`${asset}: ${p} is not at the origin`);
    const t: number[] = [];
    for (let i = 0; i < 2; i++) {
      const l = node(doc, `${p}_lod${i}`);
      if (!l || l.getParentNode() !== n) {
        problems.push(`${asset}: no ${p}_lod${i} under ${p}`);
        t.push(0);
        continue;
      }
      checkPrims(`${asset} ${p}_lod${i}`, l, problems);
      const c = triangles(l);
      t.push(c);
      const [lo, hi] = GROUND_TRIS[i];
      if (c < lo || c > hi) problems.push(`${asset}: ${p}_lod${i} has ${c} triangles (budget ${lo}..${hi})`);
    }
    tris[p] = t;
    if (JSON.stringify(side.parts?.[p]?.tris) !== JSON.stringify(t)) problems.push(`${asset}: ${p} has ${t.join('/')} triangles, the sidecar says ${side.parts?.[p]?.tris}`);
    const l0 = node(doc, `${p}_lod0`);
    if (!l0) continue;
    const b = bounds(points(l0));
    const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    sizes[p] = size;
    const d = dims[p];
    const want: V3 = [d.width, d.height, d.length];
    if (!size.every((v, k) => near(v, want[k], Math.max(0.08 * want[k], 0.12)))) problems.push(`${asset}: ${p} measures ${fmt(size)} (w h l), aircraft.json says ${fmt(want)}`);
    if (!near(b.min[1], 0, 0.02)) problems.push(`${asset}: ${p}'s lowest point is at y ${b.min[1].toFixed(3)}`);
    if (!near(b.min[0] + b.max[0], 0, 0.25)) problems.push(`${asset}: ${p} is not centred on x = 0`);
    if (!(b.min[2] < 0 && b.max[2] > 0)) problems.push(`${asset}: ${p}'s origin is not within its length (the rear axle)`);
    const l1 = node(doc, `${p}_lod1`);
    if (l1) {
      const b1 = bounds(points(l1));
      if (!b1.max.every((v, k) => near(v, b.max[k], 0.15)) || !b1.min.every((v, k) => near(v, b.min[k], 0.15))) problems.push(`${asset}: ${p}_lod1 bounds ${fmt(b1.min)}..${fmt(b1.max)} differ from lod0's`);
    }
  }
  const hitch = node(doc, 'tug_hitch');
  const tug = top.find((t) => t.getName() === 'tug');
  if (!hitch || hitch.getParentNode() !== tug) problems.push(`${asset}: no tug_hitch under tug`);
  else {
    const o = origin(hitch);
    if (!near(o[2], dims.tug.hitchZ ?? 0, 0.001) || !near(o[0], 0, 0.001)) problems.push(`${asset}: tug_hitch at ${fmt(o)}, hitchZ is ${dims.tug.hitchZ}`);
  }
  return { problems, tris, bytes, sizes };
}
