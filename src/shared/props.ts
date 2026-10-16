/**
 * Street furniture: signal poles, benches and bus stops. The client draws them and the sim makes them
 * solid, both from the functions here, so what is drawn is what is hit: one list of where each stands
 * and one list of the boxes it is made of, in the prop's own frame.
 *
 * Local frame of a prop: it stands on its origin; yaw turns it about +Y like a three.js object
 * (`rotation.y`), a bench and a bus stop face +Z. A signal pole's face looks at the cars arriving, its
 * arm reaches toward -X.
 *
 * The anchors of `props.json` (street lamps, trees, hydrants, bins, bollards) work the same way: their
 * sizes are in `data/propDims.json`, which tools/blender/props/*.py reads to build the models and this
 * file reads to make the trunks and poles solid (tests/anchorProps.test.ts measures the exported
 * .glb against it). Only the pole or trunk is solid: no collider for a crown or a lamp arm.
 *
 * Pure numbers (no three.js, no Rapier). The sim reads `lanes.json` junction heads and `scenarios.json`
 * points the way the client does.
 */
import DIMS from './data/propDims.json';
import type { LaneJunctionData } from './lanes';
import type { PropsData } from './tile';
import type { ScenarioPoint } from './walk';

/** A box in a prop's frame: its centre, its full size, and the colour it is drawn in. */
export interface PropBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rgb: number;
}

export type PropKind = 'signal' | 'bench' | 'busstop' | 'lamp' | 'tree' | 'hydrant' | 'bin' | 'bollard';

export interface PropPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const SIGNAL_POLE_H = 5.4;
export const SIGNAL_ARM = 2.6;

const box = (w: number, h: number, d: number, x: number, y: number, z: number, rgb: number): PropBox => ({ w, h, d, x, y, z, rgb });

/** A signal pole: the pole, the arm that reaches over the lane, and the housing of the lamps hanging from its end. */
export const SIGNAL_BOXES: readonly PropBox[] = [
  box(0.2, SIGNAL_POLE_H, 0.2, 0, SIGNAL_POLE_H / 2, 0, 0x3b3f44),
  box(SIGNAL_ARM, 0.12, 0.12, -SIGNAL_ARM / 2, SIGNAL_POLE_H - 0.3, 0, 0x3b3f44),
  box(0.44, 1.18, 0.34, -SIGNAL_ARM, SIGNAL_POLE_H - 0.3, 0.05, 0x17191b),
];

const WOOD = 0x7a5a3a;
const IRON = 0x2a2c30;

/** A park bench: slatted seat and back on two iron ends. Seat height 0.45 m. */
export const BENCH_BOXES: readonly PropBox[] = [
  box(1.7, 0.06, 0.46, 0, 0.45, 0, WOOD),
  box(1.7, 0.36, 0.05, 0, 0.74, -0.2, WOOD),
  box(0.06, 0.45, 0.46, -0.78, 0.22, 0, IRON),
  box(0.06, 0.45, 0.46, 0.78, 0.22, 0, IRON),
];

/** What of a bench is solid: the seat down to the ground (nobody walks under it), and the back. */
export const BENCH_SOLIDS: readonly PropBox[] = [box(1.7, 0.48, 0.46, 0, 0.24, 0, WOOD), box(1.7, 0.4, 0.05, 0, 0.72, -0.2, WOOD)];

/** A bus stop: a pole with a blue sign, and a bench under a small roof beside it. Local +Z is toward the road. */
export const BUSSTOP_BOXES: readonly PropBox[] = [
  box(0.07, 2.5, 0.07, 0, 1.25, 1.4, 0x30343a),
  box(0.55, 0.4, 0.04, 0, 2.2, 1.4, 0x1f4f9a),
  box(0.5, 0.12, 0.05, 0, 2.2, 1.425, 0xf0f0f0),
  box(2.0, 0.06, 0.8, 0, 2.3, -0.4, 0x3b4048),
  box(0.06, 2.3, 0.06, -0.95, 1.15, -0.7, 0x30343a),
  box(0.06, 2.3, 0.06, 0.95, 1.15, -0.7, 0x30343a),
  box(1.9, 1.5, 0.03, 0, 1.3, -0.74, 0x9fb3c2),
  box(1.5, 0.05, 0.4, 0, 0.45, -0.4, 0x6b6f76),
];

/** The bus stop's solid parts: the sign's lettering is a decal on the sign, so it is left out. */
export const BUSSTOP_SOLIDS: readonly PropBox[] = BUSSTOP_BOXES.filter((_, i) => i !== 2);

// ---- the anchors of props.json

/** A tree species of propDims.json: the model's reference height and crown radius, and the trunk radius at 1 m on a tree of that crown. */
export interface TreeSpecies {
  name: string;
  class: number;
  refH: number;
  refR: number;
  r: number;
  solidH: number;
}
export const TREE_SPECIES: readonly TreeSpecies[] = DIMS.trees;
/** A lamp model (`kind` of props.json): built `refH` tall, its pole `r` thick at 1 m, solid up to `solidH`. */
export interface LampModel {
  name: string;
  kind: number;
  refH: number;
  r: number;
  solidH: number;
}
export const LAMP_MODELS: readonly LampModel[] = DIMS.lamps;
export const HYDRANT = DIMS.hydrant;
export const BIN = DIMS.bin;
export const BOLLARD = DIMS.bollard;

const hash2 = (x: number, z: number): number => {
  let h = Math.imul(Math.round(x * 16) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(z * 16) ^ 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};
/** A stable 0..1 number per place: tree species, lean, autumn tint. The client and the sim both ask for it. */
export const placeHash = hash2;

/**
 * Which species a tree of the anchors' class is: broadleaf (class 0) is a willow oak, a sweetgum or a red oak, by a
 * hash of where it stands (street trees mix, as Atlanta's do); conifers are loblolly pines; ornamentals are crape myrtles.
 */
export function treeSpecies(x: number, z: number, cls: number): number {
  if (cls === 1) return 2;
  if (cls === 2) return 3;
  const h = hash2(x, z);
  return h < 0.42 ? 0 : h < 0.72 ? 1 : 4;
}

/** The scale of a tree instance: across (X and Z) from the crown radius, up from the height, both within a sane range of the model. */
export function treeScale(species: number, height: number, crownR: number): { xz: number; y: number } {
  const sp = TREE_SPECIES[species];
  const clamp = (v: number) => Math.min(1.6, Math.max(0.55, v));
  return { xz: clamp(crownR / sp.refR), y: clamp(height / sp.refH) };
}

/** A lamp instance is its model scaled evenly, to the anchor's pole height. */
export function lampScale(kind: number, height: number): number {
  const m = LAMP_MODELS[Math.min(2, Math.max(0, kind))];
  return Math.min(1.4, Math.max(0.6, height / m.refH));
}

/** What of a tree is solid: a trunk, `r` (scaled by the crown) across, `solidH` high. Nobody collides with a crown. */
export function treeTrunk(species: number, crownR: number): PropBox {
  const sp = TREE_SPECIES[species];
  const r = sp.r * treeScale(species, sp.refH, crownR).xz;
  return box(2 * r, sp.solidH, 2 * r, 0, sp.solidH / 2, 0, 0x4b4339);
}

/** What of a lamp is solid: its pole. */
export function lampPole(kind: number, height: number): PropBox {
  const m = LAMP_MODELS[Math.min(2, Math.max(0, kind))];
  const r = m.r * lampScale(kind, height);
  return box(2 * r, m.solidH, 2 * r, 0, m.solidH / 2, 0, 0x74777a);
}

const stub = (d: { r: number; solidH: number }, rgb: number): PropBox => box(2 * d.r, d.solidH, 2 * d.r, 0, d.solidH / 2, 0, rgb);
export const HYDRANT_SOLID: PropBox = stub(HYDRANT, 0x8f2a22);
export const BIN_SOLID: PropBox = stub(BIN, 0x2c3a32);
export const BOLLARD_SOLID: PropBox = stub(BOLLARD, 0x3b3e41);

/** The solid boxes of the props with a fixed shape. Lamps and trees depend on the instance (`solidBoxes`). */
export const PROP_SOLIDS: Record<'signal' | 'bench' | 'busstop' | 'hydrant' | 'bin' | 'bollard', readonly PropBox[]> = {
  signal: SIGNAL_BOXES,
  bench: BENCH_SOLIDS,
  busstop: BUSSTOP_SOLIDS,
  hydrant: [HYDRANT_SOLID],
  bin: [BIN_SOLID],
  bollard: [BOLLARD_SOLID],
};

/** The signal heads of `lanes.json`: the junctions that draw poles, and for each head where it stands. Same order for the client and the sim. */
export function signalHeads(junctions: readonly LaneJunctionData[]): { junction: LaneJunctionData; leg: number; placement: PropPlacement }[] {
  const out: { junction: LaneJunctionData; leg: number; placement: PropPlacement }[] = [];
  for (const j of junctions) {
    if (j.control !== 'signals' || !j.legs || !j.heads) continue;
    for (const h of j.heads) out.push({ junction: j, leg: h.leg, placement: { x: h.x, y: h.y, z: h.z, yaw: h.yaw } });
  }
  return out;
}

/** A bench stands where its sitters sit, a little behind. */
export function benchPlacement(p: ScenarioPoint): PropPlacement {
  return { x: p.x - Math.sin(p.yaw) * 0.12, y: p.y - 0.05, z: p.z - Math.cos(p.yaw) * 0.12, yaw: p.yaw };
}

/** A stop's shelter stands behind where people queue. */
export function busStopPlacement(p: ScenarioPoint): PropPlacement {
  return { x: p.x - Math.sin(p.yaw) * 0.3, y: p.y - 0.05, z: p.z - Math.cos(p.yaw) * 0.3, yaw: p.yaw };
}

export interface PropInstance {
  kind: PropKind;
  at: PropPlacement;
  /** A lamp's kind (0 cobra-head, 1 post-top, 2 mast), or a tree's species (`treeSpecies`). */
  variant?: number;
  /** A lamp's pole height, or a tree's crown radius, m: what its size depends on. */
  size?: number;
}

/** The boxes (in the prop's frame) that are solid for this instance. */
export function solidBoxes(prop: PropInstance): readonly PropBox[] {
  if (prop.kind === 'lamp') return [lampPole(prop.variant ?? 0, prop.size ?? 9)];
  if (prop.kind === 'tree') return [treeTrunk(prop.variant ?? 0, prop.size ?? 4)];
  return PROP_SOLIDS[prop.kind];
}

/** The anchors of `props.json` as props: lamps, trees, hydrants, bins and bollards, in the file's order. Same list for the client and the sim. */
export function anchorProps(a: PropsData | undefined): PropInstance[] {
  const out: PropInstance[] = [];
  if (!a) return out;
  for (const l of a.lamps) out.push({ kind: 'lamp', at: { x: l[0], y: l[1], z: l[2], yaw: l[3] }, variant: Math.min(2, Math.max(0, l[5] | 0)), size: l[4] });
  for (const t of a.trees) out.push({ kind: 'tree', at: { x: t[0], y: t[1], z: t[2], yaw: 0 }, variant: treeSpecies(t[0], t[2], t[5]), size: t[4] });
  for (const h of a.hydrants) out.push({ kind: 'hydrant', at: { x: h[0], y: h[1], z: h[2], yaw: 0 } });
  for (const b of a.bins) out.push({ kind: 'bin', at: { x: b[0], y: b[1], z: b[2], yaw: 0 } });
  for (const b of a.bollards) out.push({ kind: 'bollard', at: { x: b[0], y: b[1], z: b[2], yaw: 0 } });
  return out;
}

/** Everything that is drawn and solid in a tile. */
export function collectProps(junctions: readonly LaneJunctionData[] | undefined, points: readonly ScenarioPoint[] | undefined, anchors?: PropsData): PropInstance[] {
  const out: PropInstance[] = [];
  for (const h of signalHeads(junctions ?? [])) out.push({ kind: 'signal', at: h.placement });
  for (const p of points ?? []) {
    if (p.type === 'bench') out.push({ kind: 'bench', at: benchPlacement(p) });
    else if (p.type === 'busstop') out.push({ kind: 'busstop', at: busStopPlacement(p) });
  }
  for (const a of anchorProps(anchors)) out.push(a);
  return out;
}

/** A solid box in world space: its centre, half sizes, and the yaw about +Y. */
export interface WorldBox {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
}

/** The solid boxes of a prop in world space. */
export function worldSolids(prop: PropInstance): WorldBox[] {
  const { x, y, z, yaw } = prop.at;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return solidBoxes(prop).map((b) => ({
    cx: x + b.x * c + b.z * s,
    cy: y + b.y,
    cz: z - b.x * s + b.z * c,
    hx: b.w / 2,
    hy: b.h / 2,
    hz: b.d / 2,
    yaw,
  }));
}
