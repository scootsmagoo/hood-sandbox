/**
 * The decisions of a police chase as pure functions: who takes which role, where a blocker should
 * wait to meet a fleeing car, how to line up and strike a PIT, how a roadblock is laid across a road,
 * where a spike strip catches a wheel, how well an officer shoots and whether a civilian is in the
 * line. No physics and no sim in here, so the numbers test on their own.
 *
 * Conventions are the car's: a car with yaw `a` faces (sin a, cos a), its left is (cos a, -sin a).
 */
import { clamp, wrapAngle } from '../../shared/math';
import type { Rng } from '../../shared/rng';
import type { FireLoadout, PoliceRules } from '../../shared/policeRules';
import { pointAlong, type Polyline } from './nav';
import type { PathPoint } from './roadGraph';

// -------------------------------------------------------------------------------------------------
// Roles

export type Role = 'responder' | 'chaser' | 'flanker' | 'blocker';

export interface RoleCandidate {
  id: number;
  /** Straight-line distance to the target, m. */
  dist: number;
  /** Metres ahead of the target along its heading (negative: behind it). */
  ahead: number;
  /** The role it has now, and for how long (s). */
  role: Role;
  heldFor: number;
  /** In the chase: it may pursue a car at all (a restrictive agency's unit on a minor crime is only a responder). */
  engaged: boolean;
}

/**
 * Splits the units in a chase into chasers (the closest, behind the target: they follow and PIT),
 * flankers (come at it down a parallel street) and blockers (get ahead of it). A unit keeps its role
 * for `holdS` seconds, so the roles do not flicker as the cars shuffle.
 */
export function assignRoles(cands: readonly RoleCandidate[], rules: Readonly<PoliceRules['roles']>): Map<number, Role> {
  const out = new Map<number, Role>();
  const live = cands.filter((c) => c.engaged).sort((a, b) => a.dist - b.dist || a.id - b.id);
  for (const c of cands) if (!c.engaged) out.set(c.id, 'responder');
  if (live.length === 0) return out;

  const maxChasers = Math.min(rules.maxChasers, Math.max(1, Math.ceil(live.length / 2)));
  let chasers = 0;
  // Units that were given a role recently keep it, if it still makes sense.
  const rest: RoleCandidate[] = [];
  for (const c of live) {
    if (c.heldFor < rules.holdS && c.role !== 'responder') {
      if (c.role === 'chaser' && chasers < maxChasers && c.ahead < 40) {
        out.set(c.id, 'chaser');
        chasers++;
        continue;
      }
      if ((c.role === 'flanker' || c.role === 'blocker') && c.dist > rules.flankerMinGapM * 0.4) {
        out.set(c.id, c.role);
        continue;
      }
    }
    rest.push(c);
  }
  let blockers = [...out.values()].filter((r) => r === 'blocker').length;
  let flip = [...out.values()].filter((r) => r === 'flanker').length <= [...out.values()].filter((r) => r === 'blocker').length;
  for (const c of rest) {
    if (chasers < maxChasers && c.ahead < 25) {
      out.set(c.id, 'chaser');
      chasers++;
    } else if (c.ahead >= 25 && blockers < rules.maxBlockers) {
      out.set(c.id, 'blocker');
      blockers++;
    } else if (c.ahead >= 25) {
      out.set(c.id, 'flanker');
    } else if (c.dist < rules.flankerMinGapM) {
      // Right on top of the target already: join the chase.
      out.set(c.id, 'chaser');
      chasers++;
    } else {
      const role: Role = flip || blockers >= rules.maxBlockers ? 'flanker' : 'blocker';
      if (role === 'blocker') blockers++;
      out.set(c.id, role);
      flip = !flip;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Intercept

export interface InterceptOptions {
  /** The target's speed along its route, m/s (floored at 3: a stopped target is about to move). */
  playerSpeed: number;
  /** Look no nearer than this far along the route, m, and step this finely. */
  minAhead?: number;
  step?: number;
  /** The unit must arrive this many seconds before the target (a blocker needs time to set up; a flanker wants to arrive with it, so negative). */
  margin: number;
  /** How long the unit needs to reach a point on the route, s. */
  eta(p: PathPoint, s: number): number;
}

export interface Intercept {
  /** Metres along the target's route. */
  s: number;
  point: PathPoint & { dx: number; dz: number };
  tPlayer: number;
  tUnit: number;
}

/**
 * The first point along the target's predicted route that the unit can reach with `margin` seconds to
 * spare: it sweeps outward from the target, comparing the target's arrival (distance over speed)
 * with the unit's. Null when the unit cannot get ahead anywhere on the route.
 */
export function interceptAlong(route: Polyline, o: InterceptOptions): Intercept | null {
  if (route.length < 10) return null;
  const vp = Math.max(3, o.playerSpeed);
  const step = o.step ?? 10;
  for (let s = o.minAhead ?? 25; s <= route.length; s += step) {
    const p = pointAlong(route, s);
    const tP = s / vp;
    const tU = o.eta(p, s);
    if (tU + o.margin <= tP) return { s, point: p, tPlayer: tP, tUnit: tU };
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// PIT

export interface Kin {
  x: number;
  z: number;
  yaw: number;
  /** Signed speed along the nose, m/s. */
  speed: number;
  halfLen: number;
  halfWid: number;
}

export type PitPhase = 'approach' | 'align' | 'strike' | 'abort';

export interface PitPlan {
  phase: PitPhase;
  /** The point to steer for. */
  aim: PathPoint;
  /** The speed to hold, m/s. */
  speed: number;
  /** Cop position in the target's frame: metres ahead of its centre, and to the PIT side. */
  long: number;
  lat: number;
  /** Longitudinal gap between the cop's nose and the target's tail (negative: overlapping). */
  gap: number;
}

const rel = (cop: Kin, tgt: Kin) => {
  const fx = Math.sin(tgt.yaw);
  const fz = Math.cos(tgt.yaw);
  const dx = cop.x - tgt.x;
  const dz = cop.z - tgt.z;
  return { long: dx * fx + dz * fz, left: dx * fz - dz * fx };
};

/** Which side of a target to come at it from: the side the cop is already on. +1 left, -1 right. */
export function pitSide(cop: Kin, tgt: Kin): 1 | -1 {
  return rel(cop, tgt).left >= 0 ? 1 : -1;
}

/**
 * Where to steer for a PIT from `side`. The cop runs up the target's flank a little outside its
 * width, closes until its nose is at the target's rear quarter with the speeds matched, then turns
 * in to push the tail sideways. `rules.pit` holds the offsets; `phase` is where in that it is. Until
 * `commit` is set (the warning time has run) it stays alongside and does not strike.
 */
export function planPit(cop: Kin, tgt: Kin, side: 1 | -1, rules: Readonly<PoliceRules['pit']>, commit = true): PitPlan {
  const { long, left } = rel(cop, tgt);
  const lat = left * side;
  const bumper = tgt.halfLen + cop.halfLen;
  const gap = -long - bumper;
  const fx = Math.sin(tgt.yaw);
  const fz = Math.cos(tgt.yaw);
  const lx = Math.cos(tgt.yaw) * side;
  const lz = -Math.sin(tgt.yaw) * side;
  const at = (l: number, w: number): PathPoint => ({ x: tgt.x + fx * l + lx * w, z: tgt.z + fz * l + lz * w });
  const flank = tgt.halfWid + cop.halfWid + 0.35 + rules.sideOffsetM * 0.2;

  let phase: PitPhase;
  if (gap > 14 || lat < -1.5 || Math.abs(cop.speed - tgt.speed) > 14) phase = gap > 14 ? 'approach' : 'abort';
  else if (gap > 1.4 || Math.abs(lat - flank) > 1.1) phase = 'approach';
  else if (!commit || gap > 0.25) phase = 'align';
  else phase = 'strike';
  if (phase === 'abort') return { phase, aim: at(long + 8, flank), speed: Math.max(0, tgt.speed - 3), long, lat, gap };

  // The cop aims a few metres ahead of itself on the line it wants (never past the point it is closing on),
  // so the steering stays gentle and it cannot aim at a spot behind its own nose.
  if (phase === 'approach') {
    return { phase, aim: at(Math.min(long + 9, -bumper + 1.0), flank), speed: tgt.speed + clamp(gap * 0.9, 1.2, 8), long, lat, gap };
  }
  if (phase === 'align') {
    // Close the last metres level with the flank, no faster than a walking pace over the target's.
    // (once level with the quarter it holds station: the strike waits for the warning time)
    return { phase, aim: at(long + 6, flank - 0.1), speed: tgt.speed + (!commit && gap <= 0.3 ? 0.2 : clamp(gap * 1.5 + 1.0, 0.8, 3.5)), long, lat, gap };
  }
  // Strike: aim at the tail's far corner so the nose turns into the quarter panel and shoves it.
  return { phase, aim: at(-tgt.halfLen + 0.4, -tgt.halfWid * 0.5), speed: tgt.speed + 1.5, long, lat, gap };
}

// -------------------------------------------------------------------------------------------------
// Roadblock layout

export interface RoadblockLayout {
  cars: { x: number; z: number; yaw: number }[];
  /** Where an officer stands behind each car (the far side from the oncoming target). */
  officers: { x: number; z: number; yaw: number }[];
  /** The opening left to thread, when there is one: centre and width. */
  gap: { x: number; z: number; width: number } | null;
}

/**
 * Lays cars across a road. `c` is the centre of the road and `dir` the unit direction the target travels
 * along it; the cars lie slanted across the lanes (the targets sees their flanks), `width` is the paved
 * width. With `gap`, one opening of `gapWidth` is left at the side `gapSide` (-1 right of travel, +1 left).
 */
export function layoutRoadblock(
  c: PathPoint,
  dir: { x: number; z: number },
  width: number,
  carLen: number,
  carWid: number,
  cars: number,
  gap: { width: number; side: 1 | -1 } | null,
  rng: Rng,
): RoadblockLayout {
  // Lateral axis: left of travel.
  const lx = dir.z;
  const lz = -dir.x;
  // The cars all lean the same way, 40 degrees off straight across, like a diagonal wall: side by side they
  // are far enough apart not to touch (a perpendicular gap of one car width) and each covers about 4.5 m of road.
  const slant = (40 * Math.PI) / 180;
  const cover = carLen * Math.cos(slant) + carWid * Math.sin(slant);
  const dMin = (carWid + 0.3) / Math.sin(slant);
  // An opening is only left where the cars that remain can still close the rest of the road.
  if (gap && width - gap.width < cover) gap = null;
  const blocked = gap ? width - gap.width : width;
  const half = width / 2;
  // How many cars it takes to close `blocked` metres: their outer edges touch the kerb and the gap's edge.
  let n = blocked <= cover ? 1 : Math.ceil((blocked - cover) / (cover * 0.9)) + 1;
  n = Math.max(1, Math.min(cars, n, blocked <= cover ? 1 : 3));
  const spacing = n > 1 ? Math.max(dMin, (blocked - cover) / (n - 1)) : 0;
  // The group sits against the kerb opposite the gap (or centred when there is none); lateral offsets run from the left.
  const groupWidth = n > 1 ? (n - 1) * spacing + cover : cover;
  const start = gap ? (gap.side > 0 ? -half + groupWidth / 2 : half - groupWidth / 2 - (n - 1) * spacing) : -((n - 1) * spacing) / 2;
  void rng;
  const yawBase = Math.atan2(lx, lz); // nose pointing left across the road
  const yaw = yawBase + slant;
  const out: RoadblockLayout = { cars: [], officers: [], gap: null };
  const first = gap ? (gap.side > 0 ? -half + cover / 2 : half - cover / 2 - (n - 1) * spacing) : start;
  for (let i = 0; i < n; i++) {
    const off = first + i * spacing;
    const x = c.x + lx * off;
    const z = c.z + lz * off;
    out.cars.push({ x, z, yaw });
    // The officer stands behind the car, away from the target (further along `dir`).
    out.officers.push({ x: x + dir.x * 2.8, z: z + dir.z * 2.8, yaw: Math.atan2(-dir.x, -dir.z) });
  }
  if (gap) {
    const off = gap.side > 0 ? half - gap.width / 2 : -half + gap.width / 2;
    out.gap = { x: c.x + lx * off, z: c.z + lz * off, width: gap.width };
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Spike strips

export interface StripGeometry {
  x: number;
  z: number;
  /** The direction along the strip's length. */
  yaw: number;
  length: number;
  depth: number;
}

/**
 * Whether a wheel that moved from `a` to `b` this tick passed over a strip: the segment against the
 * strip's rectangle, so a car at 40 m/s (0.7 m a tick) cannot skip a strip 0.8 m deep.
 */
export function crossesStrip(s: StripGeometry, ax: number, az: number, bx: number, bz: number, wheelHalf = 0.12): boolean {
  const ux = Math.sin(s.yaw);
  const uz = Math.cos(s.yaw);
  // The strip's frame: u along its length, v across (the direction of travel).
  const toLocal = (x: number, z: number) => ({ u: (x - s.x) * ux + (z - s.z) * uz, v: (x - s.x) * uz - (z - s.z) * ux });
  const p = toLocal(ax, az);
  const q = toLocal(bx, bz);
  const hu = s.length / 2 + wheelHalf;
  const hv = s.depth / 2 + wheelHalf;
  // Segment against the box [-hu, hu] x [-hv, hv] (slab method).
  let t0 = 0;
  let t1 = 1;
  const clip = (p0: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-9) return Math.abs(p0) <= h;
    let ta = (-h - p0) / d;
    let tb = (h - p0) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    return t0 <= t1;
  };
  return clip(p.u, q.u - p.u, hu) && clip(p.v, q.v - p.v, hv);
}

// -------------------------------------------------------------------------------------------------
// Shooting

export interface AimInput {
  loadout: FireLoadout;
  /** Distance to the target, m, and how fast the target moves (m/s). */
  range: number;
  targetSpeed: number;
  /** Shooting from a moving car. */
  drivingBy: boolean;
  /** Extra spread from the weapon API's own bloom is its business; this is the officer's. */
  rules: Readonly<PoliceRules['fire']>;
}

/** The aim error of one shot, degrees (a standard deviation): the weapon's own spread plus range and the target's motion. */
export function aimErrorDeg(a: AimInput): number {
  return a.loadout.spreadDeg + a.range * a.rules.spreadPerMeterDeg + a.targetSpeed * a.rules.spreadPerMpsDeg + (a.drivingBy ? a.rules.driveBySpeedPenaltyDeg : 0);
}

/** Probability that a shot at this aim error hits a standing man-sized target at `range` m (a rough Gaussian: half-width 0.35 m). */
export function hitChance(errDeg: number, range: number): number {
  const sigma = Math.max(0.01, range * Math.tan((errDeg * Math.PI) / 180));
  // P(|N(0, sigma)| < 0.35) (erf approximation).
  const z = 0.35 / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * z);
  const erfc = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return clamp(1 - erfc, 0, 1);
}

export interface Bystander {
  id: number;
  x: number;
  y: number;
  z: number;
}

/**
 * The first bystander standing in the line from `from` to `to` (a point within `margin` m of the line,
 * on this side of the target): an officer does not shoot through a civilian. Null when the line is clear.
 * A bystander just off the line (twice the margin) is not counted: the risk the officers accept.
 */
export function civilianInLine(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, others: Iterable<Bystander>, margin: number): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1) return null;
  const len = Math.sqrt(len2);
  let best: number | null = null;
  let bestT = Infinity;
  for (const o of others) {
    // Chest height of a bystander is a metre up from their feet.
    const ox = o.x - from.x;
    const oy = o.y + 1.0 - from.y;
    const oz = o.z - from.z;
    const t = (ox * dx + oy * dy + oz * dz) / len2;
    if (t <= 0.02 || t >= 0.97) continue;
    const px = ox - dx * t;
    const py = oy - dy * t;
    const pz = oz - dz * t;
    const d = Math.hypot(px, py, pz);
    // The body is about a metre tall either side of the chest: be generous vertically.
    const horiz = Math.hypot(px, pz);
    if (horiz > margin || Math.abs(py) > 1.0) continue;
    void d;
    if (t * len < bestT) {
      bestT = t * len;
      best = o.id;
    }
  }
  return best;
}

/** Rotates a direction by a random aim error (degrees, standard deviation) about both axes. */
export function perturbDir(dir: { x: number; y: number; z: number }, errDeg: number, rng: Rng): { x: number; y: number; z: number } {
  const e = (errDeg * Math.PI) / 180;
  // Box-Muller, two normals.
  const u = Math.max(1e-9, rng.next());
  const v = rng.next();
  const r = Math.sqrt(-2 * Math.log(u));
  const yawErr = r * Math.cos(2 * Math.PI * v) * e;
  const pitchErr = r * Math.sin(2 * Math.PI * v) * e;
  const yaw = Math.atan2(dir.x, dir.z) + yawErr;
  const horiz = Math.hypot(dir.x, dir.z);
  const pitch = Math.atan2(dir.y, horiz) + pitchErr;
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}

// -------------------------------------------------------------------------------------------------
// Helicopter

export interface HeliBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  bank: number;
  pitch: number;
}

export interface HeliGoal {
  /** The point to hold over (the target, or where the search is). */
  x: number;
  z: number;
  /** Height above the ground the airframe wants, the ground there, and the tallest roof near its path (it clears that by 28 m). */
  altitude: number;
  groundY: number;
  roofY: number;
  /** Orbit radius and the angle round the goal it wants to be at now. */
  radius: number;
  angle: number;
}

/**
 * Moves the helicopter one step toward its orbit slot with a bounded acceleration and top speed, banks
 * into turns and noses down with speed. Kinematic: it cannot be shot out of the sky or collide.
 */
export function stepHeli(h: HeliBody, g: HeliGoal, speed: number, accel: number, dt: number) {
  const tx = g.x + Math.sin(g.angle) * g.radius;
  const tz = g.z + Math.cos(g.angle) * g.radius;
  const dx = tx - h.x;
  const dz = tz - h.z;
  const dist = Math.hypot(dx, dz);
  // Slow down for the slot: v = sqrt(2 a d) keeps it from overshooting.
  const want = Math.min(speed, Math.sqrt(2 * accel * 0.6 * dist) + 1.5);
  const wvx = dist > 0.01 ? (dx / dist) * want : 0;
  const wvz = dist > 0.01 ? (dz / dist) * want : 0;
  let ax = wvx - h.vx;
  let az = wvz - h.vz;
  const al = Math.hypot(ax, az);
  const maxA = accel;
  if (al > maxA * dt) {
    ax = (ax / al) * maxA * dt;
    az = (az / al) * maxA * dt;
  }
  h.vx += ax;
  h.vz += az;
  // Climb to the wanted height, eased.
  const wantY = Math.max(g.groundY + g.altitude, g.roofY + 28);
  const dy = wantY - h.y;
  const wvy = clamp(dy * 0.5, -7, 9);
  h.vy += clamp(wvy - h.vy, -6 * dt, 6 * dt);
  h.x += h.vx * dt;
  h.y += h.vy * dt;
  h.z += h.vz * dt;
  const sp = Math.hypot(h.vx, h.vz);
  // Face the way it flies, or the target when it is nearly hovering.
  const faceTo = sp > 4 ? Math.atan2(h.vx, h.vz) : Math.atan2(g.x - h.x, g.z - h.z);
  const prevYaw = h.yaw;
  const dyaw = clamp(wrapAngle(faceTo - h.yaw), -1.3 * dt, 1.3 * dt);
  h.yaw = wrapAngle(h.yaw + dyaw);
  // Bank into the turn, nose down with speed.
  const turn = dt > 0 ? wrapAngle(h.yaw - prevYaw) / dt : 0;
  const bankWant = clamp(turn * sp * 0.012, -0.45, 0.45);
  h.bank += (bankWant - h.bank) * Math.min(1, dt * 2.5);
  h.pitch += (clamp(sp * 0.008, 0, 0.3) - h.pitch) * Math.min(1, dt * 2);
}

export interface HeliSight {
  /** The helicopter and the point it looks at, with the cone's half angle (rad) and the range (m). */
  hx: number;
  hy: number;
  hz: number;
  tx: number;
  ty: number;
  tz: number;
  coneHalf: number;
  range: number;
  /** 0 to 1: how much of the cone's footprint counts (the night scales it down to the searchlight and the street lamps). */
  scale: number;
}

/** Whether a point is inside the downward cone, at its scale. The line of sight against buildings is the caller's check. */
export function inHeliCone(s: HeliSight): boolean {
  const dx = s.tx - s.hx;
  const dy = s.ty - s.hy;
  const dz = s.tz - s.hz;
  const d = Math.hypot(dx, dy, dz);
  if (d > s.range || dy >= -1) return false;
  const off = Math.acos(clamp(-dy / d, -1, 1));
  return off <= s.coneHalf * s.scale;
}
