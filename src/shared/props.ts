/**
 * Street furniture: signal poles, benches and bus stops. The client draws them and the sim makes them
 * solid, both from the functions here, so what is drawn is what is hit: one list of where each stands
 * and one list of the boxes it is made of, in the prop's own frame.
 *
 * Local frame of a prop: it stands on its origin; yaw turns it about +Y like a three.js object
 * (`rotation.y`), a bench and a bus stop face +Z. A signal pole's face looks at the cars arriving, its
 * arm reaches toward -X.
 *
 * Pure numbers (no three.js, no Rapier). The sim reads `lanes.json` junction heads and `scenarios.json`
 * points the way the client does.
 */
import type { LaneJunctionData } from './lanes';
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

export type PropKind = 'signal' | 'bench' | 'busstop';

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

export const PROP_SOLIDS: Record<PropKind, readonly PropBox[]> = { signal: SIGNAL_BOXES, bench: BENCH_SOLIDS, busstop: BUSSTOP_SOLIDS };

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
}

/** Everything that is drawn and solid in a tile. */
export function collectProps(junctions: readonly LaneJunctionData[] | undefined, points: readonly ScenarioPoint[] | undefined): PropInstance[] {
  const out: PropInstance[] = [];
  for (const h of signalHeads(junctions ?? [])) out.push({ kind: 'signal', at: h.placement });
  for (const p of points ?? []) {
    if (p.type === 'bench') out.push({ kind: 'bench', at: benchPlacement(p) });
    else if (p.type === 'busstop') out.push({ kind: 'busstop', at: busStopPlacement(p) });
  }
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
  return PROP_SOLIDS[prop.kind].map((b) => ({
    cx: x + b.x * c + b.z * s,
    cy: y + b.y,
    cz: z - b.x * s + b.z * c,
    hx: b.w / 2,
    hy: b.h / 2,
    hz: b.d / 2,
    yaw,
  }));
}
