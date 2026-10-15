/**
 * Checks a built vehicle asset (.glb) against the game's own numbers. Used by tests/carAssets.test.ts,
 * which `npm run assets` runs after building.
 *
 *   - structure: a root `car` with `lod0`, `lod1`, `lod2` and `anchors`, and the parts the game needs
 *     in each level of detail (body, wheel, lamps; door, bonnet and bumpers near; the police kit)
 *   - triangles per level of detail (the one wheel counted four times) within the budgets
 *   - material names from the allowed slots, and the ones every car needs
 *   - the body's bounds against the physics hull in handling.json, the wheel's size against its
 *     radius and width, the wheel anchors where the sim puts the wheels at rest
 *   - the seat, door and standing anchors equal to doorGeometry() in src/shared/doors.ts
 */
import { readFileSync } from 'node:fs';
import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import type { HandlingData } from '../../src/shared/handling.ts';
import { doorGeometry } from '../../src/shared/doors.ts';

export const MATERIALS = ['paint', 'livery', 'trim', 'chrome', 'glass', 'interior', 'tyre', 'light_head', 'light_tail', 'light_reverse', 'light_bar_a', 'light_bar_b'] as const;
const REQUIRED_MATERIALS = ['paint', 'trim', 'chrome', 'glass', 'interior', 'tyre', 'light_head', 'light_tail', 'light_reverse'];
/** Triangles per level of detail, the wheel counted four times: [min, max]. */
export const TRI_BUDGET: [number, number][] = [
  [5000, 9000],
  [1000, 2200],
  [200, 600],
];
const PARTS_NEAR = ['body', 'door', 'hood', 'bumper_F', 'bumper_R', 'wheel', 'light_head', 'light_tail', 'light_reverse'];
const PARTS_FAR = ['body', 'wheel', 'light_head', 'light_tail'];
const PARTS_POLICE = ['police', 'light_bar_a', 'light_bar_b'];
/** Largest .glb we accept for one vehicle (all three levels of detail). */
export const MAX_BYTES = 320_000;

type V3 = [number, number, number];

export interface AssetStats {
  tris: number[];
  materials: string[];
  bytes: number;
  /** Body bounds at LOD0 (body, door, bonnet, bumpers; no wheel, no police kit). */
  min: V3;
  max: V3;
  /** Half-width of the body below the belt (no mirrors). */
  lowHalfWidth: number;
  anchors: Record<string, V3>;
  wheel: { radius: number; width: number; centre: V3 };
}

export interface CheckResult {
  problems: string[];
  stats: AssetStats;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const fmt = (v: number[]) => `(${v.map((x) => x.toFixed(3)).join(', ')})`;

/** Rest suspension length, as RaycastCar.restHeight works it out. */
export function restLength(h: HandlingData): number {
  const omega = 2 * Math.PI * h.suspension.frequencyHz;
  return Math.max(0.04, h.suspension.travel * h.suspension.restRatio - 9.81 / (omega * omega));
}

/** Where the sim puts wheel `i` (snapshot order FL, FR, RL, RR) at rest, in the body frame. */
export function wheelRest(h: HandlingData, i: number): V3 {
  const front = i < 2;
  const left = i % 2 === 0;
  const track = front ? h.wheels.trackFront : h.wheels.trackRear;
  return [(left ? 1 : -1) * track * 0.5, h.wheels.mountY - restLength(h), front ? h.wheels.frontZ : h.wheels.rearZ];
}

export async function readAsset(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

function worldMatrix(n: Node): number[] {
  return n.getWorldMatrix() as unknown as number[];
}

function apply(m: number[], x: number, y: number, z: number): V3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Every vertex of a node's mesh in the car's frame. */
function points(n: Node, out: V3[] = []): V3[] {
  const mesh = n.getMesh();
  if (!mesh) return out;
  const m = worldMatrix(n);
  const el: number[] = [];
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      out.push(apply(m, el[0], el[1], el[2]));
    }
  }
  return out;
}

function triangles(n: Node): number {
  let t = 0;
  for (const p of n.getMesh()?.listPrimitives() ?? []) {
    const idx = p.getIndices();
    t += (idx ? idx.getCount() : (p.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
  }
  return t;
}

export async function checkAsset(path: string, h: HandlingData, opts: { police?: boolean } = {}): Promise<CheckResult> {
  const problems: string[] = [];
  const fail = (msg: string) => problems.push(msg);
  const bytes = readFileSync(path).length;
  const doc = await readAsset(path);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const nodes = doc.getRoot().listNodes();
  const byName = new Map(nodes.map((n) => [n.getName(), n]));
  const car = scene?.listChildren().find((n) => n.getName() === 'car');
  if (!car) fail('no root node `car`');
  for (const n of nodes) {
    const s = n.getScale();
    const r = n.getRotation();
    if (n.getMesh() && (Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) > 1e-6)) fail(`${n.getName()}: rotated node (transforms must be applied)`);
    if (!n.getMesh() && (Math.abs(s[0] - 1) + Math.abs(s[1] - 1) + Math.abs(s[2] - 1) > 1e-6)) fail(`${n.getName()}: scaled empty`);
  }

  // ---- materials
  const mats = doc.getRoot().listMaterials().map((m) => m.getName());
  for (const m of mats) if (!(MATERIALS as readonly string[]).includes(m)) fail(`material "${m}" is not one of the slots (${MATERIALS.join(', ')})`);
  for (const m of REQUIRED_MATERIALS) if (!mats.includes(m)) fail(`material "${m}" missing`);
  if (opts.police) for (const m of ['livery', 'light_bar_a', 'light_bar_b']) if (!mats.includes(m)) fail(`police material "${m}" missing`);

  // ---- parts and triangles
  const tris: number[] = [];
  for (let lod = 0; lod < 3; lod++) {
    const grp = byName.get(`lod${lod}`);
    if (!grp) {
      fail(`lod${lod} missing`);
      tris.push(0);
      continue;
    }
    const kids = new Map(grp.listChildren().map((c) => [c.getName().replace(`lod${lod}_`, ''), c]));
    const need = [...(lod < 2 ? PARTS_NEAR : PARTS_FAR), ...(opts.police ? PARTS_POLICE : [])];
    for (const p of need) if (!kids.has(p)) fail(`lod${lod}_${p} missing`);
    let t = 0;
    for (const [name, c] of kids) t += triangles(c) * (name === 'wheel' ? 4 : 1);
    tris.push(t);
    const [lo, hi] = TRI_BUDGET[lod];
    if (t < lo || t > hi) fail(`lod${lod}: ${t} triangles, budget ${lo}..${hi}`);
  }

  // ---- anchors
  const anchors: Record<string, V3> = {};
  for (const n of byName.get('anchors')?.listChildren() ?? []) anchors[n.getName()] = apply(worldMatrix(n), 0, 0, 0);
  const want = (name: string, v: V3, tol: number, axes: number[] = [0, 1, 2]) => {
    const a = anchors[name];
    if (!a) return fail(`anchor ${name} missing`);
    for (const k of axes) if (!near(a[k], v[k], tol)) return fail(`anchor ${name} at ${fmt(a)}, expected ${fmt(v)}`);
  };
  const d = doorGeometry(h);
  want('anchor_seat', [d.seat.x, d.seat.y, d.seat.z], 0.002);
  want('anchor_door', [d.door.x, 0, d.door.z], 0.002, [0, 2]);
  want('anchor_stand', [d.stand.x, 0, d.stand.z], 0.002, [0, 2]);
  ['FL', 'FR', 'RL', 'RR'].forEach((n, i) => want(`anchor_wheel_${n}`, wheelRest(h, i), 0.002));
  for (const n of ['anchor_hinge_door', 'anchor_hinge_hood', 'anchor_engine', 'anchor_bumper_F', 'anchor_bumper_R', 'anchor_ground']) if (!anchors[n]) fail(`anchor ${n} missing`);

  // ---- body bounds against the hull
  const c = h.chassis;
  const hullBottom = c.offset[1] - c.halfExtents[1];
  const hullTop = c.offset[1] + c.halfExtents[1];
  const cabinTop = c.cabin.offset[1] + c.cabin.halfExtents[1];
  const ground = wheelRest(h, 0)[1] - h.wheels.radius;
  const pts: V3[] = [];
  for (const p of ['body', 'door', 'hood', 'bumper_F', 'bumper_R']) {
    const n = byName.get(`lod0_${p}`);
    if (n) points(n, pts);
  }
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  let lowHalf = 0;
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    if (p[1] < hullTop - 0.06) lowHalf = Math.max(lowHalf, Math.abs(p[0]));
  }
  const [hx, , hz] = c.halfExtents;
  if (!(lowHalf >= hx - 0.06 && lowHalf <= hx + 0.08)) fail(`body half-width ${lowHalf.toFixed(3)} below the belt, hull ${hx}`);
  if (Math.max(-min[0], max[0]) > hx + 0.22) fail(`body (with mirrors) ${Math.max(-min[0], max[0]).toFixed(3)} wide, hull ${hx}`);
  if (!(max[2] >= hz - 0.05 && max[2] <= hz + 0.12)) fail(`front at z ${max[2].toFixed(3)}, hull ${hz}`);
  if (!(min[2] <= -hz + 0.05 && min[2] >= -hz - 0.12)) fail(`rear at z ${min[2].toFixed(3)}, hull ${-hz}`);
  if (!(max[1] >= cabinTop - 0.12 && max[1] <= cabinTop + 0.05)) fail(`roof at y ${max[1].toFixed(3)}, hull cabin top ${cabinTop}`);
  if (min[1] < ground + 0.08) fail(`body bottom ${min[1].toFixed(3)} within 8 cm of the road (${ground.toFixed(3)})`);
  if (min[1] > hullBottom + 0.12) fail(`body bottom ${min[1].toFixed(3)} far above the hull bottom ${hullBottom}`);

  // ---- the wheel
  const wp = points(byName.get('lod0_wheel')!, []);
  const wmin: V3 = [Infinity, Infinity, Infinity];
  const wmax: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of wp) for (let k = 0; k < 3; k++) {
    wmin[k] = Math.min(wmin[k], p[k]);
    wmax[k] = Math.max(wmax[k], p[k]);
  }
  const wheel = {
    radius: (wmax[1] - wmin[1]) / 2,
    width: wmax[0] - wmin[0],
    centre: [(wmin[0] + wmax[0]) / 2, (wmin[1] + wmax[1]) / 2, (wmin[2] + wmax[2]) / 2] as V3,
  };
  if (!near(wheel.radius, h.wheels.radius, 0.012)) fail(`wheel radius ${wheel.radius.toFixed(3)}, handling ${h.wheels.radius}`);
  if (!near(wheel.width, h.wheels.width, 0.03)) fail(`wheel width ${wheel.width.toFixed(3)}, handling ${h.wheels.width}`);
  const fl = wheelRest(h, 0);
  for (let k = 0; k < 3; k++) if (!near(wheel.centre[k], fl[k], 0.015)) fail(`wheel centred at ${fmt(wheel.centre)}, the front-left hub is at ${fmt(fl)}`);
  if (!near(wmin[1], ground, 0.015)) fail(`tyre bottom ${wmin[1].toFixed(3)}, road ${ground.toFixed(3)}`);

  // ---- the door covers its anchor, hinged at its front edge
  const doorPts = points(byName.get('lod0_door')!, []);
  if (doorPts.length) {
    const dz0 = Math.min(...doorPts.map((p) => p[2]));
    const dz1 = Math.max(...doorPts.map((p) => p[2]));
    if (!(dz0 < d.door.z && d.door.z < dz1)) fail(`door spans z ${dz0.toFixed(2)}..${dz1.toFixed(2)}, the door anchor is at ${d.door.z}`);
    const hinge = anchors.anchor_hinge_door;
    if (hinge && !(near(hinge[2], dz1, 0.12) && near(hinge[0], hx, 0.1))) fail(`door hinge ${fmt(hinge)} is not at the door's front edge (z ${dz1.toFixed(2)})`);
  }
  if (bytes > MAX_BYTES) fail(`${bytes} bytes, limit ${MAX_BYTES}`);

  return { problems, stats: { tris, materials: mats, bytes, min, max, lowHalfWidth: lowHalf, anchors, wheel } };
}
