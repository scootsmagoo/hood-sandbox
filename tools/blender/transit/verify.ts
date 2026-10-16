/**
 * Checks of the transit assets (public/assets/transit/railcar.glb and station-kit.glb with their sidecars, built by
 * `npm run assets` from tools/blender/transit), used by tests/transitAssets.test.ts:
 *
 *   railcar  structure (lod0/lod1/lod2, body, interior, bogies, twelve door leaves a level, anchors), triangle budgets,
 *            material names, bounds against src/shared/data/railcar.json (length, width, roof, floor, skirt, couplers),
 *            each door leaf on its closed centre and clear of its opening when slid open, door and camera anchors, a seat
 *            drawn under every seat of railcar.json, sign faces with 0..1 UVs, the sidecar and the file agreeing
 *   kit      every part a top-level node with `<part>_lod0` (and `_lod1` where the sidecar has two levels), budgets,
 *            material names, sizes against the brief (column 4.5 m, fare gate 0.26 x 0.85 x 1.6, sign faces...), the
 *            sidecar's sizes against the file
 */
import { existsSync, readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node, type Primitive } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

type V3 = [number, number, number];
export const CAR_MATERIALS = ['tr_steel', 'tr_band', 'tr_cab', 'tr_glass', 'tr_dark', 'tr_interior', 'tr_floor', 'tr_light', 'tr_head', 'tr_tail', 'tr_sign'];
export const KIT_MATERIALS = ['tr_steel', 'tr_dark', 'tr_glass', 'tr_interior', 'tr_light', 'tr_concrete', 'tr_tile', 'tr_signface', 'tr_screen', 'tr_lightface'];
export const CAR_MAX_TRIS = [16000, 3500, 500];
export const MAX_BYTES = { railcar: 600_000, kit: 400_000 };
export const KIT_PARTS = ['column', 'bench', 'sign_name', 'screen', 'fare_gate', 'pylon', 'canopy', 'railing', 'lamp_tube', 'tunnel_bay', 'signal', 'bin', 'map_board'];
/** [lod0, lod1] triangle limits per kit part (the default for the rest). */
export const KIT_MAX_TRIS: Record<string, number[]> = { canopy: [2000, 500], tunnel_bay: [600, 300], default: [800, 400] };

export interface RailcarDims {
  length: number;
  gap: number;
  halfWidth: number;
  floorY: number;
  roofY: number;
  skirtY: number;
  bogieZ: number;
  wheelR: number;
  doors: { z: number[]; width: number; height: number; leafTravel: number };
  seats: number[][];
}

export async function readGlb(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

const apply = (m: number[], x: number, y: number, z: number): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const node = (doc: Document, name: string): Node | undefined => doc.getRoot().listNodes().find((n) => n.getName() === name);
const origin = (n: Node): V3 => apply(n.getWorldMatrix() as unknown as number[], 0, 0, 0);

/** Every node under (and including) n that has a mesh. */
function meshNodes(n: Node): Node[] {
  return [...(n.getMesh() ? [n] : []), ...n.listChildren().flatMap(meshNodes)];
}

export function triangles(n: Node): number {
  return meshNodes(n).reduce((t, m) => t + m.getMesh()!.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3, 0), 0);
}

/** World positions of the vertices under n, optionally only those of one material. */
export function points(n: Node, material?: string): V3[] {
  const out: V3[] = [];
  const el: number[] = [];
  for (const m of meshNodes(n)) {
    const w = m.getWorldMatrix() as unknown as number[];
    for (const p of m.getMesh()!.listPrimitives()) {
      if (material && p.getMaterial()?.getName() !== material) continue;
      const pos = p.getAttribute('POSITION')!;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        out.push(apply(w, el[0], el[1], el[2]));
      }
    }
  }
  return out;
}

function bounds(pts: V3[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p[k])), (max[k] = Math.max(max[k], p[k]));
  return { min, max };
}

function primitives(n: Node): { node: Node; prim: Primitive }[] {
  return meshNodes(n).flatMap((m) => m.getMesh()!.listPrimitives().map((prim) => ({ node: m, prim })));
}

function checkPrims(where: string, n: Node, allowed: string[], problems: string[]) {
  const el: number[] = [];
  for (const { node: m, prim } of primitives(n)) {
    const mat = prim.getMaterial()?.getName() ?? '';
    if (!allowed.includes(mat)) problems.push(`${where}: ${m.getName()} has material "${mat}"`);
    for (const s of ['POSITION', 'NORMAL', 'COLOR_0', 'TEXCOORD_0']) if (!prim.getAttribute(s)) problems.push(`${where}: ${m.getName()} ${mat} has no ${s}`);
    if (['tr_sign', 'tr_signface', 'tr_screen'].includes(mat)) {
      // a face the game draws on: 0..1 across it
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!uv) continue;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, el);
        lo = Math.min(lo, el[0], el[1]);
        hi = Math.max(hi, el[0], el[1]);
      }
      if (lo < -0.002 || hi > 1.002 || lo > 0.002 || hi < 0.998) problems.push(`${where}: ${m.getName()} ${mat} UVs span ${lo.toFixed(3)}..${hi.toFixed(3)}, not 0..1`);
    }
  }
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export interface RailcarCheck {
  problems: string[];
  tris: number[];
  bytes: number;
  bounds: { min: V3; max: V3 };
}

export async function checkRailcar(glb: string, json: string, dims: RailcarDims): Promise<RailcarCheck> {
  const problems: string[] = [];
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${glb} or ${json} is missing (run npm run assets)`], tris: [], bytes: 0, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES.railcar) problems.push(`railcar.glb is ${bytes} bytes (limit ${MAX_BYTES.railcar})`);
  const side = JSON.parse(readFileSync(json, 'utf8'));
  const doc = await readGlb(glb);
  if (doc.getRoot().listTextures().length) problems.push('railcar: has textures');
  if (!node(doc, 'railcar')) problems.push('railcar: no root node "railcar"');
  const tris: number[] = [];
  for (let i = 0; i < 3; i++) {
    const g = node(doc, `lod${i}`);
    if (!g) {
      problems.push(`railcar: no lod${i}`);
      tris.push(0);
      continue;
    }
    const t = triangles(g);
    tris.push(t);
    if (t > CAR_MAX_TRIS[i]) problems.push(`railcar: lod${i} has ${t} triangles (limit ${CAR_MAX_TRIS[i]})`);
    if (side.lods?.[i]?.tris !== t) problems.push(`railcar: lod${i} has ${t} triangles, the sidecar says ${side.lods?.[i]?.tris}`);
    if (i > 0 && !(side.lods[i].from > side.lods[i - 1].from)) problems.push(`railcar: lod${i} starts at ${side.lods[i].from} m`);
    checkPrims(`railcar lod${i}`, g, CAR_MATERIALS, problems);
    if (!node(doc, `lod${i}_body`)) problems.push(`railcar: no lod${i}_body`);
  }
  if (!(tris[0] > tris[1] && tris[1] > tris[2])) problems.push(`railcar: the levels are not getting cheaper (${tris.join(' / ')})`);
  if (!node(doc, 'lod0_interior')) problems.push('railcar: no lod0_interior');
  // every material is used by the near level
  const used = new Set(primitives(node(doc, 'lod0') ?? doc.getRoot().listNodes()[0]).map((p) => p.prim.getMaterial()?.getName()));
  for (const m of CAR_MATERIALS) if (!used.has(m)) problems.push(`railcar: lod0 does not use ${m}`);

  // bounds against railcar.json
  const lod0 = node(doc, 'lod0');
  const all = lod0 ? points(lod0) : [];
  const b = bounds(all);
  const HL = dims.length / 2;
  const w = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
  if (!(w >= dims.halfWidth - 0.01 && w <= dims.halfWidth + 0.03)) problems.push(`railcar: half width ${w.toFixed(3)}, railcar.json says ${dims.halfWidth}`);
  if (!near(b.max[1], dims.roofY, 0.02)) problems.push(`railcar: roof at ${b.max[1].toFixed(3)}, railcar.json says ${dims.roofY}`);
  const above = all.filter((p) => p[1] > dims.floorY + 0.05);
  const zb = bounds(above);
  // the shell's ends at +-length/2; lamps and grab handles may stand a few cm proud (couplers, below the floor, reach into the gap)
  if (!near(zb.max[2], HL, 0.06) || !near(zb.min[2], -HL, 0.06)) problems.push(`railcar: body runs ${zb.min[2].toFixed(3)}..${zb.max[2].toFixed(3)}, railcar.json says +-${HL}`);
  if (Math.max(-b.min[2], b.max[2]) > HL + dims.gap / 2 + 0.005) problems.push(`railcar: reaches ${Math.max(-b.min[2], b.max[2]).toFixed(3)} m from the middle, more than half the gap past the end`);
  const body = node(doc, 'lod0_body');
  if (body) {
    const bb = bounds(points(body));
    if (!near(bb.min[1], dims.skirtY, 0.03)) problems.push(`railcar: the body's bottom is at ${bb.min[1].toFixed(3)}, skirtY is ${dims.skirtY}`);
  }
  const interior = node(doc, 'lod0_interior');
  if (interior) {
    const fl = bounds(points(interior, 'tr_floor'));
    if (!near(fl.max[1], dims.floorY, 0.01) || !near(fl.min[1], dims.floorY, 0.01)) problems.push(`railcar: the floor spans y ${fl.min[1].toFixed(3)}..${fl.max[1].toFixed(3)}, floorY is ${dims.floorY}`);
    // a seat drawn under every seated hip point of railcar.json
    const ip = points(interior, 'tr_interior');
    for (const [x, y, z] of dims.seats) {
      const hit = ip.some((p) => Math.abs(p[0] - x) < 0.24 && Math.abs(p[2] - z) < 0.35 && p[1] > y - 0.03 && p[1] < y + 0.04);
      if (!hit) problems.push(`railcar: no seat cushion under the seat at (${x}, ${y}, ${z})`);
    }
    const light = points(interior, 'tr_light');
    if (light.length < 8) problems.push('railcar: no ceiling light strips');
  }
  if (lod0 && b.min[1] < -0.05) problems.push(`railcar: something hangs ${(-b.min[1]).toFixed(3)} m below the rail top`);

  // bogies on their pivots
  for (let lod = 0; lod < 2; lod++) {
    for (const [tag, z] of [['F', dims.bogieZ], ['R', -dims.bogieZ]] as const) {
      const n = node(doc, `lod${lod}_bogie_${tag}`);
      if (!n) {
        problems.push(`railcar: no lod${lod}_bogie_${tag}`);
        continue;
      }
      const o = origin(n);
      if (!near(o[0], 0, 0.001) || !near(o[1], 0, 0.001) || !near(o[2], z, 0.001)) problems.push(`railcar: lod${lod}_bogie_${tag} at (${o.join(', ')}), not on its pivot`);
      const bb = bounds(points(n));
      if (!near(bb.max[2] - bb.min[2], 2 * 1.45, 0.4)) problems.push(`railcar: lod${lod}_bogie_${tag} is ${(bb.max[2] - bb.min[2]).toFixed(2)} m long`);
    }
  }

  // door leaves: on their closed centres, clear of the opening when slid open
  const dhw = dims.doors.width / 2;
  const top = dims.floorY + dims.doors.height;
  for (let lod = 0; lod < 2; lod++) {
    for (const [sideName, s] of [['L', 1], ['R', -1]] as const) {
      dims.doors.z.forEach((c, i) => {
        for (const leaf of ['a', 'b'] as const) {
          const name = `lod${lod}_door_${sideName}${i}_${leaf}`;
          const n = node(doc, name);
          if (!n) return void problems.push(`railcar: no ${name}`);
          if (!(side.doors?.nodes?.[`lod${lod}`] ?? []).includes(name)) problems.push(`railcar: the sidecar does not list ${name}`);
          const want: V3 = [s * 1.545, (dims.floorY + top) / 2, leaf === 'a' ? c - dhw / 2 : c + dhw / 2];
          const o = origin(n);
          if (!o.every((v, k) => near(v, want[k], 0.01))) problems.push(`railcar: ${name} at (${o.map((v) => v.toFixed(3)).join(', ')}), its closed centre is (${want.join(', ')})`);
          const bb = bounds(points(n));
          const zc = (bb.min[2] + bb.max[2]) / 2;
          if (!near(zc, want[2], 0.012) || !near(bb.max[2] - bb.min[2], dhw, 0.03)) problems.push(`railcar: ${name} spans z ${bb.min[2].toFixed(3)}..${bb.max[2].toFixed(3)}`);
          if (!near(bb.min[1], dims.floorY, 0.01) || !near(bb.max[1], top, 0.01)) problems.push(`railcar: ${name} spans y ${bb.min[1].toFixed(3)}..${bb.max[1].toFixed(3)}`);
          const ax = [Math.abs(bb.min[0]), Math.abs(bb.max[0])];
          if (Math.min(...ax) < 1.5 || Math.max(...ax) > dims.halfWidth) problems.push(`railcar: ${name} is not in the wall cavity (|x| ${Math.min(...ax).toFixed(3)}..${Math.max(...ax).toFixed(3)})`);
          const dz = leaf === 'a' ? -dims.doors.leafTravel : dims.doors.leafTravel;
          const open = [bb.min[2] + dz, bb.max[2] + dz];
          const intrude = leaf === 'a' ? open[1] - (c - dhw) : c + dhw - open[0];
          if (intrude > 0.02) problems.push(`railcar: ${name} open stands ${intrude.toFixed(3)} m into the doorway`);
          if (!primitives(n).some((p) => p.prim.getMaterial()?.getName() === 'tr_glass')) problems.push(`railcar: ${name} has no glass`);
        }
      });
    }
  }

  // anchors
  for (const [sideName, s] of [['L', 1], ['R', -1]] as const) {
    dims.doors.z.forEach((c, i) => {
      const a = node(doc, `anchor_door_${sideName}${i}`);
      if (!a) return void problems.push(`railcar: no anchor_door_${sideName}${i}`);
      const o = origin(a);
      if (!near(o[0], s * dims.halfWidth, 0.001) || !near(o[1], dims.floorY, 0.001) || !near(o[2], c, 0.001)) problems.push(`railcar: anchor_door_${sideName}${i} at (${o.join(', ')})`);
    });
  }
  const cam = node(doc, 'anchor_cam_window');
  if (!cam) problems.push('railcar: no anchor_cam_window');
  else {
    const o = origin(cam);
    const yaw = (cam.getExtras() as { yaw?: number }).yaw;
    if (typeof yaw !== 'number') problems.push('railcar: anchor_cam_window has no yaw');
    if (!(o[0] > 0.8 && o[0] < dims.halfWidth - 0.2 && o[1] > dims.floorY + 1.0 && o[1] < dims.floorY + 1.4 && Math.abs(o[2]) < HL)) problems.push(`railcar: anchor_cam_window at (${o.join(', ')}) is not a seated eye by a left window`);
  }
  const head = node(doc, 'anchor_headlight');
  if (!head) problems.push('railcar: no anchor_headlight');
  else if (!near(origin(head)[2], HL, 0.06)) problems.push('railcar: anchor_headlight is not at the cab front');

  // the sidecar
  for (const k of ['length', 'halfWidth', 'floorY', 'roofY', 'skirtY', 'bogieZ', 'wheelR'] as const) if (side.dims?.[k] !== dims[k]) problems.push(`railcar: the sidecar's ${k} is ${side.dims?.[k]}, railcar.json says ${dims[k]}`);
  return { problems, tris, bytes, bounds: b };
}

export interface KitCheck {
  problems: string[];
  tris: Record<string, number[]>;
  bytes: number;
  sizes: Record<string, V3>;
}

export async function checkKit(glb: string, json: string): Promise<KitCheck> {
  const problems: string[] = [];
  if (!existsSync(glb) || !existsSync(json)) return { problems: [`${glb} or ${json} is missing (run npm run assets)`], tris: {}, bytes: 0, sizes: {} };
  const bytes = readFileSync(glb).length;
  if (bytes > MAX_BYTES.kit) problems.push(`station-kit.glb is ${bytes} bytes (limit ${MAX_BYTES.kit})`);
  const side = JSON.parse(readFileSync(json, 'utf8'));
  const doc = await readGlb(glb);
  if (doc.getRoot().listTextures().length) problems.push('kit: has textures');
  const tris: Record<string, number[]> = {};
  const sizes: Record<string, V3> = {};
  const rootNames = doc.getRoot().listScenes()[0].listChildren().flatMap((r) => [r.getName(), ...r.listChildren().map((c) => c.getName())]);
  for (const p of KIT_PARTS) {
    const top = node(doc, p);
    if (!top || !rootNames.includes(p)) {
      problems.push(`kit: no top-level part "${p}"`);
      continue;
    }
    const sp = side.parts?.[p];
    if (!sp) {
      problems.push(`kit: the sidecar has no ${p}`);
      continue;
    }
    const o = origin(top);
    if (!o.every((v) => near(v, 0, 1e-6))) problems.push(`kit: ${p} is not at the origin`);
    const t: number[] = [];
    for (let i = 0; i < sp.tris.length; i++) {
      const n = node(doc, `${p}_lod${i}`);
      if (!n) {
        problems.push(`kit: no ${p}_lod${i}`);
        continue;
      }
      if (n.getParentNode() !== top) problems.push(`kit: ${p}_lod${i} is not under ${p}`);
      checkPrims(`kit ${p}_lod${i}`, n, KIT_MATERIALS, problems);
      t.push(triangles(n));
    }
    tris[p] = t;
    const lim = KIT_MAX_TRIS[p] ?? KIT_MAX_TRIS.default;
    t.forEach((v, i) => v > lim[i] && problems.push(`kit: ${p}_lod${i} has ${v} triangles (limit ${lim[i]})`));
    if (t.length === 2 && !(t[1] < t[0])) problems.push(`kit: ${p}_lod1 (${t[1]}) is not cheaper than lod0 (${t[0]})`);
    if (JSON.stringify(t) !== JSON.stringify(sp.tris)) problems.push(`kit: ${p} has ${t.join('/')} triangles, the sidecar says ${sp.tris.join('/')}`);
    const n0 = node(doc, `${p}_lod0`);
    if (!n0) continue;
    const b = bounds(points(n0));
    const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    sizes[p] = size;
    if (!size.every((v, k) => near(v, sp.size[k], 0.01))) problems.push(`kit: ${p} measures ${size.map((v) => v.toFixed(3)).join(' x ')}, the sidecar says ${sp.size.join(' x ')}`);
    checkPart(p, n0, b, problems);
  }
  return { problems, tris, bytes, sizes };
}

function faceSize(n: Node, mat: string): { min: V3; max: V3 } {
  return bounds(points(n, mat));
}

function checkPart(p: string, n: Node, b: { min: V3; max: V3 }, problems: string[]) {
  const want = (what: string, got: number, value: number, tol: number) => {
    if (!near(got, value, tol)) problems.push(`kit: ${p} ${what} is ${got.toFixed(3)}, want ${value}`);
  };
  const floorStanding = ['column', 'bench', 'fare_gate', 'pylon', 'railing', 'bin'];
  if (floorStanding.includes(p)) {
    want('bottom', b.min[1], 0, 0.002);
    want('centre x', (b.min[0] + b.max[0]) / 2, 0, 0.02);
  }
  const at = (y0: number, y1: number) => points(n).filter((q) => q[1] > y0 && q[1] < y1);
  switch (p) {
    case 'column': {
      want('height', b.max[1], 4.5, 0.01);
      const shaft = bounds(at(1.15, 3.95));
      want('shaft width', shaft.max[0] - shaft.min[0], 0.7, 0.01);
      break;
    }
    case 'bench': {
      want('length', b.max[0] - b.min[0], 2.0, 0.01);
      const seat = bounds(points(n, 'tr_steel').filter((q) => q[1] < 0.5));
      want('seat top', seat.max[1], 0.45, 0.005);
      break;
    }
    case 'sign_name':
    case 'screen': {
      const [fw, fh, rods] = p === 'sign_name' ? [3.0, 0.55, 0.8] : [1.2, 0.4, 0.6];
      const f = faceSize(n, p === 'sign_name' ? 'tr_signface' : 'tr_screen');
      want('face width', f.max[0] - f.min[0], fw, 0.005);
      want('face height', f.max[1] - f.min[1], fh, 0.005);
      want('face centre', (f.min[1] + f.max[1]) / 2, 0, 0.005);
      if (!(f.max[2] > 0 && f.min[2] < 0)) problems.push(`kit: ${p} is not double-sided`);
      const frameTop = bounds(points(n, 'tr_dark')).max[1];
      want('rods', b.max[1] - frameTop, rods, 0.06);
      break;
    }
    case 'fare_gate': {
      const body = faceSize(n, 'tr_steel');
      want('cabinet width', body.max[0] - body.min[0], 0.26, 0.01);
      want('cabinet height', body.max[1], 0.85, 0.005);
      want('cabinet length', body.max[2] - body.min[2], 1.6, 0.01);
      if (!points(n, 'tr_screen').length) problems.push('kit: fare_gate has no reader display');
      break;
    }
    case 'pylon': {
      want('height', b.max[1], 4.2, 0.01);
      const shaft = bounds(at(0.32, 3.36));
      want('shaft width', shaft.max[0] - shaft.min[0], 0.6, 0.01);
      const f = faceSize(n, 'tr_signface');
      if (!(f.max[0] > 0.25 && f.min[0] < -0.25 && f.max[2] > 0.25 && f.min[2] < -0.25 && f.min[1] > 3.0)) problems.push('kit: pylon has no sign box faces on all four sides at the top');
      break;
    }
    case 'canopy': {
      const inner = points(n, 'tr_concrete').filter((q) => q[1] < 1.0 && q[2] > 0.5 && q[2] < 8.5);
      const clear = Math.min(...inner.map((q) => Math.abs(q[0])));
      if (!(clear >= 1.6 - 0.001)) problems.push(`kit: canopy walls stand ${clear.toFixed(3)} m from the centre, inside the 3.2 m stair`);
      const front = bounds(points(n).filter((q) => q[2] < 0.5));
      if (!(front.max[1] > 2.85 && front.max[1] < 3.25)) problems.push(`kit: canopy is ${front.max[1].toFixed(2)} m high at the open end, want about 3.0`);
      if (!(b.max[2] >= 9.0 && b.min[2] < 0)) problems.push(`kit: canopy spans z ${b.min[2].toFixed(2)}..${b.max[2].toFixed(2)}, the stair runs 0..9`);
      if (!points(n, 'tr_glass').length) problems.push('kit: canopy has no glass');
      break;
    }
    case 'railing':
      want('length', b.max[0] - b.min[0], 1.0, 0.005);
      want('height', b.max[1], 1.0, 0.005);
      break;
    case 'lamp_tube': {
      want('length', b.max[0] - b.min[0], 1.5, 0.01);
      want('top', b.max[1], 0, 0.001);
      const lens = faceSize(n, 'tr_lightface');
      if (!(lens.min[1] <= b.min[1] + 1e-3)) problems.push('kit: lamp_tube lens is not its bottom');
      break;
    }
    case 'tunnel_bay':
      want('wall plane', b.min[0], 0, 0.001);
      if (b.max[0] > 0.4 + 0.001) problems.push(`kit: tunnel_bay stands ${b.max[0].toFixed(3)} m off the wall (limit 0.4)`);
      want('length', b.max[2] - b.min[2], 12, 0.01);
      if (!points(n, 'tr_lightface').length) problems.push('kit: tunnel_bay has no lamp lens');
      break;
    case 'signal':
      want('height', b.max[1] - b.min[1], 0.9, 0.01);
      want('foot', b.min[1], 0, 0.001);
      want('wall', b.min[0], 0, 0.001);
      if (points(n, 'tr_lightface').length < 9) problems.push('kit: signal has no lenses');
      break;
    case 'bin':
      want('height', b.max[1], 0.9, 0.01);
      break;
    case 'map_board': {
      want('width', b.max[0] - b.min[0], 2.0, 0.005);
      want('height', b.max[1] - b.min[1], 1.2, 0.005);
      want('bottom', b.min[1], 0, 0.001);
      want('wall', b.min[2], 0, 0.001);
      const f = faceSize(n, 'tr_signface');
      if (!(f.max[2] > 0.02)) problems.push('kit: map_board face is not toward +Z');
      break;
    }
  }
}
