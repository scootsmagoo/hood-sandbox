/**
 * Cover, first pass. A press near a wall (a ray against the static world) snaps the ped against it:
 * crouched behind a low wall (about 0.5 to 1.6 m), or flush against a high one. While in cover the
 * character moves only along the wall, stops at its ends, and leans or stands to shoot while aiming.
 * The poses are stand-ins; the wall is found with a handful of horizontal rays, nothing cleverer.
 *
 * The wall's normal `(nx, nz)` points out of it at the ped. Along the wall, the direction `(-nz, nx)`
 * is the positive one: `lean` and `edge` are positive toward it (to the LEFT of someone facing the wall).
 */
import { PED } from '../../character/locomotion';
import { clamp, wrapAngle } from '../../../shared/math';
import type { PedEntity } from '../../entities';
import { GROUPS } from '../../physics/rapier';
import type { Simulation } from '../../Simulation';

export const COVER = {
  /** How far from the ped a wall can be and still be taken, m. */
  reach: 1.7,
  /** The ped's centre ends up this far from the wall face. */
  standOff: PED.radius + 0.1,
  /** Rays are cast at these heights above the feet, m. */
  kneeY: 0.5,
  headY: 1.65,
  /** A wall must carry on this far to each side of the ped to be cover (not a pole or a corner), m. */
  halfWidth: 0.5,
  /** Slow walk along the wall, share of the normal input. */
  moveScale: 0.5,
  /** Pushing straight away from the wall this long leaves cover, s. */
  breakAwayS: 0.45,
} as const;

interface WallHit {
  t: number;
  nx: number;
  nz: number;
  px: number;
  pz: number;
}

/** A horizontal ray against the static world only. */
function wallRay(sim: Simulation, x: number, y: number, z: number, dx: number, dz: number, len: number): WallHit | null {
  const R = sim.physics.R;
  const r = new R.Ray({ x, y, z }, { x: dx, y: 0, z: dz });
  const h = sim.physics.world.castRayAndGetNormal(r, len, true, undefined, GROUPS.cameraQuery);
  if (!h) return null;
  let nx = h.normal.x;
  let nz = h.normal.z;
  const ny = h.normal.y;
  // Only upright faces count (a slope or a roof is not a wall).
  if (Math.abs(ny) > 0.5) return null;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-3) return null;
  nx /= nl;
  nz /= nl;
  if (nx * dx + nz * dz > 0) {
    nx = -nx;
    nz = -nz;
  }
  return { t: h.timeOfImpact, nx, nz, px: x + dx * h.timeOfImpact, pz: z + dz * h.timeOfImpact };
}

/**
 * Takes cover against the best wall within reach, preferring the direction (dirX, dirZ) (default: the way the ped faces).
 * Returns false when no wall is close enough or it is too low to hide behind.
 */
export function enterCover(sim: Simulation, ped: PedEntity, dirX?: number, dirZ?: number): boolean {
  if (ped.life !== 'alive' || ped.vehicleId || ped.busy) return false;
  const c = ped.controller;
  if (dirX === undefined || dirZ === undefined) {
    dirX = Math.sin(c.yaw);
    dirZ = Math.cos(c.yaw);
  }
  const pref = Math.atan2(dirX, dirZ);
  let best: { hit: WallHit; low: boolean; score: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    const hit = wallRay(sim, c.x, c.y + COVER.kneeY, c.z, dx, dz, COVER.reach);
    if (!hit) continue;
    // A wall seen at a glancing angle is a corner or a curve, not a face to stand against.
    if (-(hit.nx * dx + hit.nz * dz) < 0.55) continue;
    const ang = Math.abs(wrapAngle(a - pref));
    const score = hit.t + ang * 0.7;
    if (best && score >= best.score) continue;
    // Stand where the ped would end up, and look at the wall's height from there.
    const sx = hit.px + hit.nx * COVER.standOff;
    const sz = hit.pz + hit.nz * COVER.standOff;
    const knee = wallRay(sim, sx, c.y + COVER.kneeY, sz, -hit.nx, -hit.nz, 0.6);
    if (!knee) continue;
    // A wall, not a pole or a corner: it must carry on a body's width to each side.
    const tx = -hit.nz;
    const tz = hit.nx;
    let wide = true;
    for (const side of [-1, 1]) {
      const w = wallRay(sim, sx + tx * side * COVER.halfWidth, c.y + COVER.kneeY, sz + tz * side * COVER.halfWidth, -hit.nx, -hit.nz, 0.8);
      if (!w || Math.abs(w.t - knee.t) > 0.3) wide = false;
    }
    if (!wide) continue;
    const head = wallRay(sim, sx, c.y + COVER.headY, sz, -hit.nx, -hit.nz, 0.6);
    best = { hit, low: !head, score };
  }
  if (!best) return false;
  const h = best.hit;
  const sx = h.px + h.nx * COVER.standOff;
  const sz = h.pz + h.nz * COVER.standOff;
  // The snap: the ground is where the ped already stands.
  if (Math.hypot(sx - c.x, sz - c.z) > 0.03) c.teleport(sx, c.y, sz, c.yaw);
  ped.cover = { nx: h.nx, nz: h.nz, low: best.low, lean: 0, px: h.px, pz: h.pz, edge: 0, t: 0, away: 0 };
  ped.input.moveX = ped.input.moveY = 0;
  sim.emit({ type: 'cover:enter', tick: sim.tick, pedId: ped.id, low: best.low, x: sx, z: sz, nx: h.nx, nz: h.nz });
  return true;
}

export function leaveCover(sim: Simulation, ped: PedEntity) {
  if (!ped.cover) return;
  ped.cover = null;
  sim.emit({ type: 'cover:exit', tick: sim.tick, pedId: ped.id });
}

/**
 * One tick for a ped in cover: leaves it when it stops making sense, keeps the lean easing, and for
 * a player turns the stick into a slow walk along the wall (`ped.input` already holds this tick's stick).
 */
export function stepCover(sim: Simulation, ped: PedEntity, dt: number, drive: boolean) {
  const k = ped.cover;
  if (!k) return;
  const c = ped.controller;
  if (ped.life !== 'alive' || ped.vehicleId || ped.busy) {
    leaveCover(sim, ped);
    return;
  }
  k.t += dt;
  // The wall must still be there.
  const wall = wallRay(sim, c.x, c.y + COVER.kneeY, c.z, -k.nx, -k.nz, 0.9);
  if (!wall) {
    leaveCover(sim, ped);
    return;
  }
  k.px = wall.px;
  k.pz = wall.pz;
  // The positive direction along the face: (-nz, nx).
  const tx = -k.nz;
  const tz = k.nx;
  const g = ped.gun;
  const aiming = !!g?.aiming;
  // Lean out to shoot: toward the side the gun points. Behind a low wall the ped stands up instead.
  let want = 0;
  if (aiming && !k.low) {
    const ax = Math.sin(g!.aimYaw);
    const az = Math.cos(g!.aimYaw);
    const side = ax * tx + az * tz;
    want = Math.abs(side) < 0.15 ? 0 : Math.sign(side);
  }
  k.lean += (want - k.lean) * Math.min(1, dt * 12);

  if (!drive) return;
  const i = ped.input;
  if (i.jump || i.sprint) {
    leaveCover(sim, ped);
    return;
  }
  // The stick in the world, then along the wall.
  const fx = -Math.sin(i.camYaw);
  const fz = -Math.cos(i.camYaw);
  const rx = Math.cos(i.camYaw);
  const rz = -Math.sin(i.camYaw);
  const wx = i.moveX * rx + i.moveY * fx;
  const wz = i.moveX * rz + i.moveY * fz;
  const along = wx * tx + wz * tz;
  const away = wx * k.nx + wz * k.nz;
  const pushing = Math.hypot(wx, wz) > 0.6 && away > 0.8 * Math.hypot(wx, wz);
  k.away = pushing ? k.away + dt : 0;
  if (k.away > COVER.breakAwayS) {
    leaveCover(sim, ped);
    return;
  }
  let move = clamp(along, -1, 1);
  k.edge = 0;
  if (Math.abs(move) > 0.12) {
    const sgn = Math.sign(move);
    // Is there still wall a body's width further on? If not, this is the edge.
    const probe = wallRay(sim, c.x + tx * sgn * 0.55, c.y + COVER.kneeY, c.z + tz * sgn * 0.55, -k.nx, -k.nz, 0.9);
    if (!probe) {
      k.edge = sgn;
      move = 0;
    }
  } else move = 0;
  if (move === 0) {
    i.moveX = i.moveY = 0;
  } else {
    const sgn = Math.sign(move);
    // Walk along the wall: forward in the direction sgn * (tx, tz).
    i.moveX = 0;
    i.moveY = Math.abs(move) * COVER.moveScale;
    i.camYaw = Math.atan2(-sgn * tx, -sgn * tz);
  }
  i.sprint = false;
  i.jump = false;
}

/** The yaw a ped in cover faces when it is not aiming: toward a low wall, away from a high one. */
export function coverYaw(ped: PedEntity): number {
  const k = ped.cover!;
  return k.low ? Math.atan2(-k.nx, -k.nz) : Math.atan2(k.nx, k.nz);
}
