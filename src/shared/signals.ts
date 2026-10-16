/**
 * Traffic signal phases as a pure function of time: no state, no snapshot bandwidth. The sim (cars
 * stopping at red), the client (lamps changing colour) and the pedestrians (walk and don't-walk at
 * crosswalks) all call these with the same junction record and the same time, and so always agree.
 *
 * A signalised junction has two approach groups. Legs whose direction lies within 45 degrees of the
 * axis of the junction's first approach leg are group 0, the others group 1. Each junction picks one
 * of a few fixed cycle tables and a start offset from a hash of its id, so neighbouring junctions
 * are not in step.
 *
 *   one cycle:  group 0 green -> group 0 amber -> all red -> group 1 green -> group 1 amber -> all red
 *
 * Usage (time is simulation seconds: `sim.tick * SIM_DT` in the sim, the interpolated snapshot tick on
 * the client):
 *
 *   phaseOf(junction, t)            -> { groups: [state, state], stage, stageT, stageLeft }
 *   legState(junction, legIndex, t) -> the lamp a car on that leg's approach sees
 *   walkState(junction, legIndex, t)-> the pedestrian signal for the crosswalk across that leg
 *   greenLeft(junction, group, t)   -> seconds of green left for a group (0 when not green)
 *
 * `junction` is a record from `junctions.json` (or `lanes.json`'s `junctions`): only `id` and `legs[].dir`
 * and `legs[].approach` are read, and `legIndex` indexes `legs` as listed there.
 */

export type SignalState = 'green' | 'amber' | 'red';
export type WalkState = 'walk' | 'flash' | 'dont';

/** The part of a junction record these functions read. */
export interface SignalJunction {
  id: string;
  legs: readonly { readonly dir: readonly [number, number] | readonly number[]; readonly approach: boolean }[];
}

export interface SignalPlan {
  /** Green time of group 0 and group 1, s. */
  green: readonly [number, number];
  amber: number;
  /** Both groups red between the amber of one and the green of the other, s. */
  allRed: number;
}

export const SIGNAL_PLANS: readonly SignalPlan[] = [
  { green: [26, 20], amber: 3.5, allRed: 1.5 },
  { green: [32, 22], amber: 3.5, allRed: 2 },
  { green: [20, 20], amber: 3, allRed: 2 },
];

/** A pedestrian is told to clear the crossing when the cross street's green has this long left, s. */
export const WALK_FLASH_S = 7;

interface Timing {
  plan: SignalPlan;
  /** The six stage lengths: green 0, amber, all red, green 1, amber, all red. */
  len: readonly number[];
  cycle: number;
  offset: number;
  axis: number;
  groups: Uint8Array;
}

const cache = new WeakMap<object, Timing>();

function hashId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

function timingOf(j: SignalJunction): Timing {
  let t = cache.get(j);
  if (t) return t;
  const h = hashId(j.id);
  const plan = SIGNAL_PLANS[h % SIGNAL_PLANS.length];
  const cycle = plan.green[0] + plan.green[1] + 2 * (plan.amber + plan.allRed);
  const offset = ((h >>> 8) % 1000) / 1000 * cycle;
  const first = j.legs.find((l) => l.approach) ?? j.legs[0];
  const axis = first ? Math.atan2(first.dir[0], first.dir[1]) : 0;
  const groups = new Uint8Array(j.legs.length);
  j.legs.forEach((l, i) => {
    const a = Math.atan2(l.dir[0], l.dir[1]);
    groups[i] = Math.abs(Math.sin(a - axis)) < Math.SQRT1_2 ? 0 : 1;
  });
  t = { plan, len: [plan.green[0], plan.amber, plan.allRed, plan.green[1], plan.amber, plan.allRed], cycle, offset, axis, groups };
  cache.set(j, t);
  return t;
}

/** The approach group (0 or 1) of a leg. */
export function groupOfLeg(j: SignalJunction, legIndex: number): 0 | 1 {
  return timingOf(j).groups[legIndex] === 1 ? 1 : 0;
}

export interface SignalPhase {
  /** The lamp each group sees. */
  groups: [SignalState, SignalState];
  /** 0 group 0 green, 1 group 0 amber, 2 all red, 3 group 1 green, 4 group 1 amber, 5 all red. */
  stage: number;
  /** Seconds into the stage, and seconds left in it. */
  stageT: number;
  stageLeft: number;
}

const out: SignalPhase = { groups: ['red', 'red'], stage: 0, stageT: 0, stageLeft: 0 };

/**
 * The phase at time `t` seconds. The returned object is reused by the next call; copy what you keep.
 */
export function phaseOf(j: SignalJunction, t: number): SignalPhase {
  const { len, cycle, offset } = timingOf(j);
  let c = (t + offset) % cycle;
  if (c < 0) c += cycle;
  let stage = 0;
  while (stage < 5 && c >= len[stage]) {
    c -= len[stage];
    stage++;
  }
  out.stage = stage;
  out.stageT = c;
  out.stageLeft = len[stage] - c;
  out.groups[0] = stage === 0 ? 'green' : stage === 1 ? 'amber' : 'red';
  out.groups[1] = stage === 3 ? 'green' : stage === 4 ? 'amber' : 'red';
  return out;
}

/** The lamp a car on the approach of leg `legIndex` sees. */
export function legState(j: SignalJunction, legIndex: number, t: number): SignalState {
  return phaseOf(j, t).groups[groupOfLeg(j, legIndex)];
}

/** Seconds of green left for `group` (0 when it is not green). */
export function greenLeft(j: SignalJunction, group: 0 | 1, t: number): number {
  const p = phaseOf(j, t);
  return p.groups[group] === 'green' ? p.stageLeft : 0;
}

/**
 * The pedestrian signal for the crosswalk across leg `legIndex`'s road. Walkers cross while the cars on
 * that leg are stopped and the cross street has the green; the hand flashes for the last seconds of it.
 */
export function walkState(j: SignalJunction, legIndex: number, t: number): WalkState {
  const g = groupOfLeg(j, legIndex);
  const cross = (1 - g) as 0 | 1;
  const p = phaseOf(j, t);
  if (p.groups[cross] !== 'green') return 'dont';
  return p.stageLeft <= WALK_FLASH_S ? 'flash' : 'walk';
}

/** Length of one full cycle of a junction, s (for tests and tools). */
export function cycleLength(j: SignalJunction): number {
  return timingOf(j).cycle;
}
