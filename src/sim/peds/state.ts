/** What an ambient pedestrian remembers between ticks. Lives on `PedEntity.amb`; the sim's brain handles flee and fight. */
import type { ScenarioType } from '../../shared/walk';

export type AmbMode = 'walk' | 'wait' | 'scenario' | 'cower' | 'film' | 'look' | 'flee' | 'fight' | 'calm';

/** What someone does at a scenario point. */
export type ScenarioAction = 'sit' | 'wait' | 'phone' | 'chat' | 'atm' | 'browse' | 'photo';

export interface AmbientState {
  group: string;
  /** Preferred walking speed, m/s. */
  speed: number;
  /** Lateral offset from the middle of a sidewalk, m (positive to the walker's right). */
  lane: number;
  mode: AmbMode;
  /** The player touched them (hit, carjacked, a witness): never removed in view. */
  persistent: boolean;
  /** Graph position: the node last reached, the one before it, and the one walked to (-1 for none). */
  node: number;
  prev: number;
  next: number;
  /** The edge being walked (from `node` or `prev` to `next`), or -1: remembered so the lane can be kept to where the edge is clear. */
  edge: number;
  /** A planned route (nodes) and how far along it. A runner's route is an escape (`graph.escapeRoute`), replanned as it goes. */
  route: number[] | null;
  routeI: number;
  /** Seconds since a runner last planned its escape. */
  fleeT: number;
  /** Heading the body is steering to, rad (direction (sin h, cos h)). */
  heading: number;
  /** The attribute index of the crossing being crossed, or -1. */
  crossAttr: number;
  /** Waiting at a kerb: the crossing edge, and how long. */
  waitEdge: number;
  waitT: number;
  /** An edge not to take for a while (a crossing that never cleared). */
  avoidEdge: number;
  /** The scenario point in use (an index into the scenario index), or -1; where in it; what is done there; seconds left. */
  sc: number;
  scSlot: number;
  scCount: number;
  scAction: ScenarioAction;
  scUntil: number;
  scType: ScenarioType | null;
  /** The pose timer: the pose changes when it runs out. */
  poseT: number;
  /** Cower, film and look end when this many seconds have passed. */
  until: number;
  /** What they look at while cowering, filming or staring. */
  faceX: number;
  faceZ: number;
    /** A reaction decided but not yet begun (people take a moment to react): the tick it starts, its kind, cause and where. */
  reactAt: number;
  reactKind: 'flee' | 'cower' | 'film' | 'look' | 'startle' | '';
  reactCause: string;
  reactX: number;
  reactZ: number;
  calmT: number;
  stuckT: number;
  stuckX: number;
  stuckZ: number;
  stuckN: number;
  /** Seconds before they may stare at, or jump from, something again. */
  lookCool: number;
  startleCool: number;
  /** The last point of interest they stared at. */
  seenPoi: number;
  spawnedAt: number;
  /** Far from the player, or standing still: moved without character-controller queries, at this ground height. */
  lite: boolean;
  liteY: number;
}

export function newAmbientState(group: string, speed: number, lane: number, tick: number): AmbientState {
  return {
    group, speed, lane, mode: 'walk', persistent: false,
    node: -1, prev: -1, next: -1, edge: -1, route: null, routeI: 0, fleeT: 0, heading: 0,
    crossAttr: -1, waitEdge: -1, waitT: 0, avoidEdge: -1,
    sc: -1, scSlot: 0, scCount: 1, scAction: 'wait', scUntil: 0, scType: null, poseT: 0,
    until: 0, faceX: 0, faceZ: 0,
    reactAt: 0, reactKind: '', reactCause: '', reactX: 0, reactZ: 0,
    calmT: 0, stuckT: 0, stuckX: 0, stuckZ: 0, stuckN: 0, lookCool: 0, startleCool: 0, seenPoi: -1, spawnedAt: tick, lite: false, liteY: 0,
  };
}
