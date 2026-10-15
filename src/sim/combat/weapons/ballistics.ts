/**
 * Hitscan against the physics world: one ray per bullet through the static world, cars and people,
 * skipping the shooter, their car, and anyone already dead. This file is only the geometry (what a ray
 * runs into, and which entity that is); what a hit does is in `api.ts`.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import type { EntityId } from '../../../shared/entities';
import { Rng } from '../../../shared/rng';
import { PedEntity, VehicleEntity, type SimEntity } from '../../entities';
import { GROUPS } from '../../physics/rapier';
import type { Simulation } from '../../Simulation';

export interface RawHit {
  kind: 'none' | 'world' | 'ped' | 'vehicle';
  /** Distance along the ray, m. */
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  ped: PedEntity | null;
  vehicle: VehicleEntity | null;
}

/** A shot that crosses at most this many dead bodies before it counts as stopped. */
const MAX_PASS_THROUGH = 3;

/** What the sim keeps for weapons: the random stream for spread, and a lookup from physics bodies to entities. */
export class WeaponRuntime {
  readonly rng: Rng;
  private ownerTick = -1;
  private ownerSize = -1;
  private readonly owners = new Map<number, SimEntity>();
  private ray: RAPIER.Ray | null = null;

  constructor(private readonly sim: Simulation) {
    this.rng = sim.rng.fork('weapons');
  }

  /** The ped or vehicle that owns a physics body, or undefined for the static world. */
  ownerOf(bodyHandle: number): SimEntity | undefined {
    const sim = this.sim;
    if (this.ownerTick !== sim.tick || this.ownerSize !== sim.registry.size) {
      this.owners.clear();
      for (const e of sim.registry.values()) {
        if (e instanceof PedEntity) this.owners.set(e.controller.body.handle, e);
        else if (e instanceof VehicleEntity) this.owners.set(e.car.body.handle, e);
      }
      this.ownerTick = sim.tick;
      this.ownerSize = sim.registry.size;
    }
    const own = this.owners.get(bodyHandle);
    if (own) return own;
    // a part of a ragdoll belongs to its ped
    const rag = sim.ragdolls.ownerOf(bodyHandle);
    return rag ? sim.registry.get(rag) : undefined;
  }

  /**
   * Casts a ray of length `maxDist` from `origin` along the unit vector `dir`. `skip` holds the body
   * handles to ignore (the shooter and their car). A dead body is passed through.
   */
  cast(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist: number, skip: ReadonlySet<EntityId>, out: RawHit): RawHit {
    const sim = this.sim;
    const R = sim.physics.R;
    const world = sim.physics.world;
    const ray = (this.ray ??= new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
    // Handles of the bodies to ignore: the entities in `skip`, and any corpse the ray has gone through.
    const ignore = new Set<number>();
    for (const id of skip) {
      const e = sim.registry.get(id);
      if (e instanceof PedEntity) ignore.add(e.controller.body.handle);
      else if (e instanceof VehicleEntity) ignore.add(e.car.body.handle);
    }
    let travelled = 0;
    let ox = origin.x;
    let oy = origin.y;
    let oz = origin.z;
    for (let pass = 0; pass <= MAX_PASS_THROUGH; pass++) {
      ray.origin.x = ox;
      ray.origin.y = oy;
      ray.origin.z = oz;
      ray.dir.x = dir.x;
      ray.dir.y = dir.y;
      ray.dir.z = dir.z;
      const left = maxDist - travelled;
      const hit = left > 0 ? world.castRayAndGetNormal(ray, left, true, undefined, GROUPS.bullet, undefined, undefined, ignore.size ? (c) => !ignore.has(c.parent()?.handle ?? -1) : undefined) : null;
      if (!hit) {
        out.kind = 'none';
        out.t = maxDist;
        out.x = origin.x + dir.x * maxDist;
        out.y = origin.y + dir.y * maxDist;
        out.z = origin.z + dir.z * maxDist;
        out.nx = out.ny = out.nz = 0;
        out.ped = null;
        out.vehicle = null;
        return out;
      }
      const t = travelled + hit.timeOfImpact;
      const body = hit.collider.parent();
      const owner = body ? this.ownerOf(body.handle) : undefined;
      if (owner instanceof PedEntity && owner.life === 'dead') {
        // A corpse: the bullet goes on through it (all of it, when it is a ragdoll).
        ignore.add(body!.handle);
        const rag = sim.ragdolls.ragdollOf(owner.id);
        if (rag) for (const b of rag.bodies) ignore.add(b.handle);
        travelled = t + 0.05;
        ox = origin.x + dir.x * travelled;
        oy = origin.y + dir.y * travelled;
        oz = origin.z + dir.z * travelled;
        continue;
      }
      out.kind = owner instanceof PedEntity ? 'ped' : owner instanceof VehicleEntity ? 'vehicle' : 'world';
      out.t = t;
      out.x = origin.x + dir.x * t;
      out.y = origin.y + dir.y * t;
      out.z = origin.z + dir.z * t;
      // The normal faces the side the ray came from.
      let nx = hit.normal.x;
      let ny = hit.normal.y;
      let nz = hit.normal.z;
      if (nx * dir.x + ny * dir.y + nz * dir.z > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.ped = owner instanceof PedEntity ? owner : null;
      out.vehicle = owner instanceof VehicleEntity ? owner : null;
      return out;
    }
    out.kind = 'none';
    out.t = maxDist;
    out.x = origin.x + dir.x * maxDist;
    out.y = origin.y + dir.y * maxDist;
    out.z = origin.z + dir.z * maxDist;
    out.nx = out.ny = out.nz = 0;
    out.ped = null;
    out.vehicle = null;
    return out;
  }
}

export function newRawHit(): RawHit {
  return { kind: 'none', t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ped: null, vehicle: null };
}

/** A unit vector thrown into a cone of half-angle `deg` around `dir` (uniform over the cone's area), using `rng`. */
export function scatter(dir: { x: number; y: number; z: number }, deg: number, rng: Rng, out: { x: number; y: number; z: number }) {
  if (deg <= 0) {
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    return out;
  }
  const a = (deg * Math.PI) / 180 * Math.sqrt(rng.next());
  const phi = rng.next() * Math.PI * 2;
  // An orthonormal basis (u, v) around dir.
  let ux: number, uy: number, uz: number;
  if (Math.abs(dir.y) < 0.95) {
    // u = normalize(dir x up)
    ux = dir.z;
    uy = 0;
    uz = -dir.x;
  } else {
    ux = 0;
    uy = -dir.z;
    uz = dir.y;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = dir.y * uz - dir.z * uy;
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const cp = Math.cos(phi) * s;
  const sp = Math.sin(phi) * s;
  out.x = dir.x * c + ux * cp + vx * sp;
  out.y = dir.y * c + uy * cp + vy * sp;
  out.z = dir.z * c + uz * cp + vz * sp;
  return out;
}
