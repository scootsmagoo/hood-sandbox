/**
 * What a car's damage looks like, GTA IV style: it gets ugly long before it dies. Pure state, no
 * three.js, so it tests on its own; `CarModel.syncDamage` draws it.
 *
 *   dents     spheres of crumple at the impact points (from `vehicle:damage`'s `at`), deeper and
 *             wider for harder hits, pushed along the impact; the model displaces its vertices
 *   bumpers   sag at one end after a few knocks at their end of the car, then fall off
 *   bonnet    springs ajar, then pops up after hard frontal hits
 *   windows   a panel breaks (crazed and darker) when a deep dent reaches it, when a bullet hits it,
 *             or the windscreen once the body is badly hurt; all of them when the car burns out
 *   tyres     flat tyres come from the snapshot's flags (VehicleFlag.FlatMask), as before
 * The numbers are in the sim's body damage (a sedan has 1000), scaled by the type's `deformMult`.
 * Smoke and fire are drawn as before (EntityViews).
 */

export interface Dent {
  /** Centre, in the car's frame. */
  x: number;
  y: number;
  z: number;
  /** Unit push direction, in the car's frame (into the car). */
  dx: number;
  dy: number;
  dz: number;
  /** Radius (m) and depth (m) at the centre. */
  r: number;
  d: number;
}

export const BUMPER_ON = 0;
export const BUMPER_SAG = 1;
export const BUMPER_OFF = 2;

export interface CarDamageState {
  /** Every dent so far, oldest first (a model applies the ones it has not yet). */
  dents: Dent[];
  /** Dents dropped from the front of `dents` (the list is capped): a model that has seen fewer must rebuild. */
  dropped: number;
  /** Damage taken at each end and side (deform-scaled). */
  front: number;
  rear: number;
  left: number;
  right: number;
  bumperF: number;
  bumperR: number;
  /** Which end of a sagging bumper hangs down: +1 the left (+X), -1 the right. */
  sagF: number;
  sagR: number;
  /** 0 shut, 1 ajar, 2 popped up. */
  hood: number;
  /** Broken windows, one bit a panel (`CarAsset.windows` indices). */
  windows: number;
  burnt: boolean;
  /** Bumped on every change; a model redraws when its copy differs. */
  version: number;
}

export const DAMAGE = {
  /** Most dents kept (older ones are dropped; a model built later shows the newest). */
  maxDents: 28,
  /** Hits smaller than this (deform-scaled body damage) leave no mark. */
  minHit: 8,
  /** Depth (m): the floor, the most it tends to, and the damage that gets it two-thirds of the way (dents show from small knocks). */
  depthMin: 0.025,
  depthMax: 0.2,
  depthScale: 160,
  /** Radius (m): the floor, the most, and the damage that gets it two-thirds of the way. */
  radiusBase: 0.3,
  radiusMax: 0.68,
  radiusScale: 200,
  /** A hit at an end also crumples the whole nose or tail: a wider, shallower dent behind the first. */
  crumpleRadius: 1.7,
  crumpleDepth: 0.5,
  /** A hit counts toward an end of the car when it lands beyond this share of the half-length. */
  endShare: 0.5,
  /** Bumper: sags, then falls, at this much damage at its end (or one hit this big). */
  bumperSag: 80,
  bumperSagHit: 70,
  bumperOff: 200,
  bumperOffHit: 170,
  /** Bonnet: ajar, then popped, at this much damage at the front. */
  hoodAjar: 120,
  hoodPop: 260,
  /** A dent at least this deep breaks the windows within its radius. */
  windowDepth: 0.055,
  /** The windscreen goes when the body is below this share of its health, or with one frontal hit this big (the rear window from behind). */
  windscreenHealth: 0.3,
  windscreenHit: 110,
} as const;

export function newDamage(): CarDamageState {
  return { dents: [], dropped: 0, front: 0, rear: 0, left: 0, right: 0, bumperF: BUMPER_ON, bumperR: BUMPER_ON, sagF: 1, sagR: 1, hood: 0, windows: 0, burnt: false, version: 0 };
}

/** What the damage needs to know about the car's shape. */
export interface DamageShape {
  /** Half-length and half-width of the body (m). */
  halfLength: number;
  halfWidth: number;
  /** Window panels: index and centre, in the car's frame. */
  windows: { index: number; x: number; y: number; z: number }[];
  /** Index of the windscreen (the panel furthest forward), or -1. */
  windscreen: number;
  /** Index of the rear window (the panel furthest back), or -1. */
  rearWindow: number;
}

/** Bounds-only shape for cars drawn without an asset (no windows). */
export function boxShape(halfLength: number, halfWidth: number): DamageShape {
  return { halfLength, halfWidth, windows: [], windscreen: -1, rearWindow: -1 };
}

function addDent(s: CarDamageState, dent: Dent) {
  const l = Math.hypot(dent.dx, dent.dy, dent.dz) || 1;
  dent.dx /= l;
  dent.dy /= l;
  dent.dz /= l;
  s.dents.push(dent);
  if (s.dents.length > DAMAGE.maxDents) {
    s.dents.shift();
    s.dropped++;
  }
}

/**
 * One collision: `amount` body damage (the `vehicle:damage` event) at a point (car frame) pushed
 * along `dir` (unit, car frame). `deform` is the type's deformMult.
 */
export function applyImpact(s: CarDamageState, shape: DamageShape, px: number, py: number, pz: number, dx: number, dy: number, dz: number, amount: number, deform = 1) {
  if (s.burnt || !(amount > 0)) return;
  const a = amount * deform;
  // a scrape leaves no mark (and keeps a traffic car on the cheap instanced path)
  if (a < DAMAGE.minHit) return;
  const depth = DAMAGE.depthMin + (DAMAGE.depthMax - DAMAGE.depthMin) * (1 - Math.exp(-a / DAMAGE.depthScale));
  const r = DAMAGE.radiusBase + (DAMAGE.radiusMax - DAMAGE.radiusBase) * (1 - Math.exp(-a / DAMAGE.radiusScale));
  addDent(s, { x: px, y: py, z: pz, dx, dy, dz, r, d: depth });
  const end = shape.halfLength * DAMAGE.endShare;
  if (Math.abs(pz) > end && depth > 0.03) {
    // the whole nose (or tail) gives a little, not just the spot that was hit
    addDent(s, { x: px * 0.4, y: py + 0.15, z: pz, dx, dy, dz, r: r * DAMAGE.crumpleRadius, d: depth * DAMAGE.crumpleDepth });
  }
  if (pz > end) s.front += a;
  else if (pz < -end) s.rear += a;
  if (px > shape.halfWidth * 0.4) s.left += a;
  else if (px < -shape.halfWidth * 0.4) s.right += a;
  const side = px >= 0 ? 1 : -1;
  if (pz > end) {
    if (s.bumperF === BUMPER_ON && (s.front >= DAMAGE.bumperSag || a >= DAMAGE.bumperSagHit)) {
      s.bumperF = BUMPER_SAG;
      s.sagF = side;
    }
    if (s.bumperF === BUMPER_SAG && (s.front >= DAMAGE.bumperOff || a >= DAMAGE.bumperOffHit)) s.bumperF = BUMPER_OFF;
    if (a >= DAMAGE.windscreenHit && shape.windscreen >= 0) s.windows |= 1 << shape.windscreen;
    if (s.hood < 1 && s.front >= DAMAGE.hoodAjar) s.hood = 1;
    if (s.hood < 2 && s.front >= DAMAGE.hoodPop) s.hood = 2;
  } else if (pz < -end) {
    if (s.bumperR === BUMPER_ON && (s.rear >= DAMAGE.bumperSag || a >= DAMAGE.bumperSagHit)) {
      s.bumperR = BUMPER_SAG;
      s.sagR = side;
    }
    if (s.bumperR === BUMPER_SAG && (s.rear >= DAMAGE.bumperOff || a >= DAMAGE.bumperOffHit)) s.bumperR = BUMPER_OFF;
    if (a >= DAMAGE.windscreenHit && shape.rearWindow >= 0) s.windows |= 1 << shape.rearWindow;
  }
  if (depth >= DAMAGE.windowDepth) {
    for (const w of shape.windows) {
      if (Math.hypot(w.x - px, w.y - py, w.z - pz) < r * 1.15) s.windows |= 1 << w.index;
    }
  }
  s.version++;
}

/** A bullet hit at a point of the car (car frame): breaks the window it hit, if it hit one. */
export function applyBullet(s: CarDamageState, shape: DamageShape, px: number, py: number, pz: number) {
  let best = -1;
  let bestD = 0.75;
  for (const w of shape.windows) {
    const d = Math.hypot(w.x - px, w.y - py, w.z - pz);
    if (d < bestD) {
      bestD = d;
      best = w.index;
    }
  }
  if (best >= 0 && !(s.windows & (1 << best))) {
    s.windows |= 1 << best;
    s.version++;
  }
}

/** Body health (0 to 1 of its maximum): the windscreen goes when it is low. */
export function applyHealth(s: CarDamageState, shape: DamageShape, health: number) {
  if (health < DAMAGE.windscreenHealth && shape.windscreen >= 0 && !(s.windows & (1 << shape.windscreen))) {
    s.windows |= 1 << shape.windscreen;
    s.version++;
  }
}

/** The tank went up: every window, both bumpers, the bonnet, and a mangled shell (seeded, so it is the same each time). */
export function applyExplosion(s: CarDamageState, shape: DamageShape, seed: number) {
  if (s.burnt) return;
  let r = (seed * 2654435761) >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 6; i++) {
    const px = (rnd() * 2 - 1) * shape.halfWidth;
    const pz = (rnd() * 2 - 1) * shape.halfLength;
    const py = 0.1 + rnd() * 0.5;
    addDent(s, { x: px, y: py, z: pz, dx: -px * 0.5, dy: -0.8, dz: -pz * 0.2, r: 0.5 + rnd() * 0.3, d: 0.06 + rnd() * 0.08 });
  }
  for (const w of shape.windows) s.windows |= 1 << w.index;
  s.bumperF = s.bumperR = BUMPER_OFF;
  s.hood = 2;
  s.burnt = true;
  s.version++;
}

/** Whether a car looks damaged at all (traffic swaps to its full model then). */
export function isDamaged(s: CarDamageState | undefined): boolean {
  return !!s && (s.dents.length > 0 || s.windows !== 0 || s.dropped > 0 || s.burnt);
}
