/**
 * Vehicle handling data, in the spirit of GTA's handling.meta (mass, drive force, traction curve,
 * low-speed traction loss, suspension, anti-roll) but in SI units so the numbers mean something:
 * forces are accelerations in m/s^2 (multiplied by the mass in the sim), speeds are m/s, angles
 * are degrees in the file and radians in the sim. Axes are the model's: +Z forward, +Y up,
 * +X to the left.
 */
import raw from './data/handling.json';

type V3 = [number, number, number];

export interface HandlingData {
  id: string;
  name: string;
  /** kg. */
  mass: number;
  /** Relative to the body origin (the chassis box's anchor). Lower is steadier. */
  centreOfMass: V3;
  /** Scales the inertia of a box of the chassis' size (pitch x, yaw y, roll z). Below 1 turns quicker. */
  inertiaScale: V3;
  chassis: { halfExtents: V3; offset: V3; cabin: { halfExtents: V3; offset: V3 } };
  wheels: {
    radius: number;
    width: number;
    /** Axle positions along +Z from the body origin. */
    frontZ: number;
    rearZ: number;
    /** Distance between the wheel centres of an axle. */
    trackFront: number;
    trackRear: number;
    /** Height of the suspension hardpoints (the top of the travel) from the body origin. */
    mountY: number;
  };
  suspension: {
    /** Metres from fully compressed to fully extended. */
    travel: number;
    /** Where the spring is relaxed, as a fraction of the travel from the compressed end. */
    restRatio: number;
    /** Sprung natural frequency, Hz. */
    frequencyHz: number;
    dampingRatio: number;
    /** Anti-roll bar: m/s^2 of the sprung mass per metre of left/right difference. */
    antiRoll: number;
  };
  drive: {
    /** Full-throttle acceleration at a standstill, m/s^2. */
    driveForce: number;
    /** Speed at which the engine runs out of push, m/s. */
    maxFlatVel: number;
    /** 0 rear-wheel drive, 1 front-wheel drive, 0.5 all-wheel drive. */
    driveBiasFront: number;
    reverseMaxVel: number;
    brakeForce: number;
    handbrakeForce: number;
    /** Deceleration with the foot off the throttle, m/s^2. */
    engineBrake: number;
    /** Quadratic air drag, in m/s^2 per (m/s)^2. */
    drag: number;
  };
  steering: {
    /** Full lock at a standstill. */
    lockDeg: number;
    /** Full lock at `lockRefSpeed` and above. */
    lockHighSpeedDeg: number;
    lockRefSpeed: number;
    /** How fast the wheels turn toward the target, and how fast they come back. */
    rateDeg: number;
    returnRateDeg: number;
  };
  traction: {
    /** Friction coefficient at the best slip angle, and once sliding. */
    curveMax: number;
    curveMin: number;
    /** Slip angle of the grip peak, degrees. */
    curveLateralDeg: number;
    /** How hard a tyre pulls its lateral slip velocity to zero (0 to 1 per step). */
    lateralStiffness: number;
    /** Longitudinal grip relative to the curve. */
    longitudinalMult: number;
    /** Lateral grip lost by a spinning driven wheel at a standstill (0 to 1), fading out by `lowSpeedLossSpeed`. */
    lowSpeedLossMult: number;
    lowSpeedLossSpeed: number;
    /** Rear lateral grip with the handbrake held. */
    handbrakeGripMult: number;
    /** Where the tyre forces act: 0 at the ground, 1 at the centre of mass height. Higher rolls less. */
    forceHeight: number;
  };
  assists: {
    /** How much the front wheels turn toward the direction of travel in a slide (0 to 1). */
    counterSteer: number;
    /** How strongly the drift assist works (0 to 1). */
    yawAssist: number;
    /** Slide angle that full steering asks for during a drift, degrees. */
    maxSlideDeg: number;
    /** Cap on the yaw rate the assist asks for, rad/s. */
    yawRateMax: number;
    /** Extra downward force, m/s^2 per (m/s)^2. */
    downforce: number;
  };
}

const DEFAULT_ID = 'sedan';

function checkNumbers(path: string, value: unknown) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`handling ${path}: not finite`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkNumbers(`${path}[${i}]`, v));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) checkNumbers(`${path}.${k}`, v);
  }
}

function merge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** Validates one entry of handling.json; fields it leaves out come from the `sedan` entry. */
export function parseHandling(id: string, entry: unknown, base?: HandlingData): HandlingData {
  const h = (base ? merge(base, entry) : entry) as HandlingData;
  h.id = id;
  checkNumbers(id, h);
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`handling ${id}: ${msg}`);
  };
  need(h.mass > 100, 'mass must be above 100 kg');
  need(h.wheels.radius > 0.1, 'wheel radius too small');
  need(h.suspension.travel > 0.05, 'suspension travel too small');
  need(h.suspension.restRatio > 0 && h.suspension.restRatio < 1, 'restRatio must be between 0 and 1');
  need(h.suspension.frequencyHz > 0.3 && h.suspension.frequencyHz < 8, 'suspension frequency out of range');
  need(h.drive.maxFlatVel > 5, 'maxFlatVel too low');
  need(h.drive.driveBiasFront >= 0 && h.drive.driveBiasFront <= 1, 'driveBiasFront must be 0 to 1');
  need(h.traction.curveMax >= h.traction.curveMin && h.traction.curveMin > 0, 'traction curve must fall from max to min');
  need(h.traction.lateralStiffness > 0 && h.traction.lateralStiffness <= 1, 'lateralStiffness must be in (0, 1]');
  return h;
}

export function loadHandlingTable(table: Record<string, unknown>): Record<string, HandlingData> {
  const out: Record<string, HandlingData> = {};
  const baseEntry = table[DEFAULT_ID];
  if (!baseEntry) throw new Error(`handling table has no "${DEFAULT_ID}" entry`);
  const base = parseHandling(DEFAULT_ID, baseEntry);
  out[DEFAULT_ID] = base;
  for (const [id, entry] of Object.entries(table)) {
    if (id === DEFAULT_ID || id.startsWith('_')) continue;
    out[id] = parseHandling(id, entry, base);
  }
  return out;
}

export const HANDLING: Record<string, HandlingData> = loadHandlingTable(raw as Record<string, unknown>);
export const DEFAULT_VEHICLE = DEFAULT_ID;
