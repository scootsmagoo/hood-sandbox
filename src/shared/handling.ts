/**
 * Vehicle handling data, in the spirit of GTA's handling.meta but in SI units so the numbers mean
 * something: masses in kg, lengths in m, speeds in m/s, forces as accelerations in m/s^2 (multiplied
 * by the mass in the sim), angles in degrees in the file and radians in the sim. Axes are the
 * model's: +Z forward, +Y up, +X to the left.
 *
 * The model behind the numbers (docs/physics.md): a sprung body on four long-travel raycast
 * wheels, tyres with a load-sensitive slip curve that peaks and falls off, a friction ellipse shared
 * between cornering and driving or braking, and no assists that hold a slide. The feel comes from
 * mass, the height of the centre of mass, the springs and the tyres.
 */
import raw from './data/handling.json';

type V3 = [number, number, number];

export interface HandlingData {
  id: string;
  name: string;
  /** Which stand-in body the client draws: `sedan` (also the coupe) or `pickup`. */
  body: string;
  /** kg. */
  mass: number;
  /** Relative to the body origin (the chassis box's anchor). The body origin rides about 0.3 m above the road, so y 0.2 is a centre of mass about half a metre up. */
  centreOfMass: V3;
  /** Scales the inertia of a box of the chassis' size (pitch x, yaw y, roll z). Above 1 is lazier to turn, pitch or roll. */
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
    /** Sprung natural frequency, Hz: about 1.1 a soft truck, 1.4 a soft sedan, 1.8 a sports car. */
    frequencyHz: number;
    /** Damping ratio while the spring compresses (bump) and while it extends (rebound). Low numbers float and wallow. */
    bumpDamping: number;
    reboundDamping: number;
    /** Anti-roll bars, front and rear: m/s^2 of the wheel's sprung mass per metre of left/right difference. More at one end moves grip away from it. */
    antiRollFront: number;
    antiRollRear: number;
    /** Roll centre heights above the road, m, front and rear: the cornering force acts on the body there. Lower rolls more. */
    rollCentreFront: number;
    rollCentreRear: number;
  };
  drive: {
    /** Full-throttle acceleration from rest (the gearing's low-speed push), m/s^2. */
    driveForce: number;
    /** Engine power at the wheels per kg, W/kg: above a few m/s the push is this over the speed. */
    powerPerKg: number;
    /** Speed at which the engine runs out of push (the rev limiter in top gear), m/s. */
    maxFlatVel: number;
    /** 0 rear-wheel drive, 1 front-wheel drive, 0.5 all-wheel drive. */
    driveBiasFront: number;
    reverseMaxVel: number;
    /** Brake demand at full pedal, m/s^2 (the tyres limit what arrives), and the share on the front axle. */
    brakeForce: number;
    brakeBiasFront: number;
    /** Deceleration with the foot off the throttle, m/s^2. */
    engineBrake: number;
    /** Rolling resistance, m/s^2. */
    rolling: number;
    /** Quadratic air drag, in m/s^2 per (m/s)^2. */
    drag: number;
  };
  steering: {
    /** Full lock at a standstill. */
    lockDeg: number;
    /** Full lock at `lockRefSpeed` and above. */
    lockHighSpeedDeg: number;
    lockRefSpeed: number;
    /** How fast the front wheels turn toward the target and back, degrees per second, at a crawl. */
    rateDeg: number;
    returnRateDeg: number;
    /** The rack's rate at `lockRefSpeed` as a share of the crawl rate: the steering eases off at speed. */
    rateHighSpeed: number;
    /** Caster: with the wheel let go, the front wheels trail toward the direction of travel by this share (0 to 1). */
    selfAlign: number;
  };
  traction: {
    /** Peak friction coefficient at the nominal (static) load. */
    mu: number;
    /** Friction left once the tyre slides, as a share of the peak. Below about 0.8 a slide feeds itself. */
    slideRatio: number;
    /** Slip angle of the grip peak, degrees: where the slip curve tops out. */
    peakSlipDeg: number;
    /** Slip angle (as a multiple of the peak) by which the curve has fallen to the sliding value. */
    falloff: number;
    /** Load sensitivity: the friction coefficient falls this share per 100% extra load. Weight transfer costs grip through this. */
    loadSensitivity: number;
    /** Grip at the front and rear axles relative to `mu` (tyre widths, compounds). */
    frontGrip: number;
    rearGrip: number;
    /** Longitudinal grip relative to lateral. */
    longitudinalMult: number;
    /** A spinning driven wheel keeps this share of its lateral grip (power oversteer). */
    spinLateral: number;
    /** Lateral grip lost by a spinning driven wheel at a standstill (0 to 1), fading out by `lowSpeedLossSpeed` (burnouts). */
    lowSpeedLossMult: number;
    lowSpeedLossSpeed: number;
    /** Friction of a rear tyre locked by the handbrake, as a share of the peak. */
    handbrakeGrip: number;
  };
  extras: {
    /** Extra downward force, m/s^2 per (m/s)^2. */
    downforce: number;
    /** Burnout (throttle with the brake or the handbrake, nearly stopped): the front brakes' base deceleration (m/s^2, more past the creep speed) and the creep speed (m/s). */
    burnoutHold: number;
    burnoutCreep: number;
  };
  /** GTA-style damage multipliers (1 is the sedan) and the health a new car starts with. */
  damage: {
    /** Body damage from collisions. */
    collisionMult: number;
    /** Engine damage from collisions (front impacts count most). */
    engineMult: number;
    /** Damage from gunfire and explosions (no weapons yet). */
    weaponMult: number;
    /** How far a hit dents the body (render). */
    deformMult: number;
    bodyHealth: number;
    engineHealth: number;
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
  need(h.traction.mu > 0.2 && h.traction.mu < 3, 'traction.mu out of range');
  need(h.traction.slideRatio > 0 && h.traction.slideRatio <= 1, 'traction.slideRatio must be in (0, 1]');
  need(h.traction.peakSlipDeg > 1 && h.traction.peakSlipDeg < 30, 'traction.peakSlipDeg out of range');
  need(h.traction.falloff > 1, 'traction.falloff must be above 1');
  need(h.suspension.bumpDamping > 0 && h.suspension.reboundDamping > 0, 'damping must be positive');
  need(h.steering.rateHighSpeed > 0 && h.steering.rateHighSpeed <= 1, 'steering.rateHighSpeed must be in (0, 1]');
  need(h.damage.bodyHealth > 0 && h.damage.engineHealth > 0, 'damage health must be positive');
  need(h.damage.collisionMult >= 0 && h.damage.engineMult >= 0, 'damage multipliers cannot be negative');
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
