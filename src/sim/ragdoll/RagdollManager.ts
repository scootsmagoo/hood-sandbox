/**
 * Euphoria-lite: who is a ragdoll, for how long, and how they get up.
 *
 * A ped becomes a ragdoll when it is knocked down (a car above a few m/s, a punch, a bullet that
 * knocks down, a hard landing, an explosion) or killed. The ragdoll starts from the standing figure
 * with the ped's own velocity plus whatever threw it, and from then on Rapier moves it: a car's body
 * carries it over the bonnet and the roof, a blast throws it, a corpse slumps. While it is a ragdoll
 * the ped's capsule is out of the world and its feet follow the pelvis (PedController.enterRagdoll).
 *
 * Bounded: at most `RAG.maxActive` ragdolls have bodies at once. A body that has come to rest, or the
 * oldest one when a new one needs its slot, is frozen: its bodies are removed and its last pose is kept
 * (a corpse lies as it fell). A living person who has settled and whose knockdown time is over gets up:
 * the pose blends from where they lie to standing over `RAG.getUpS`, then the capsule comes back.
 *
 * Headless and deterministic: everything happens in sim ticks, in creation order.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import type { EntityId } from '../../shared/entities';
import { clamp, nlerpQuat, smoothstep, type Quat } from '../../shared/math';
import type { SimEvent } from '../../shared/protocol';
import { RAG_PARTS, RAG_PELVIS_HEIGHT, packQuat, restPose } from '../../shared/ragdoll';
import { H, MAX_RAGDOLL_RECORDS, PedFlag, RG, type SnapshotView } from '../../shared/snapshot';
import type { PedEntity } from '../entities';
import { damagePed } from '../combat/damage';
import { GROUPS } from '../physics/rapier';
import type { Simulation } from '../Simulation';
import { Ragdoll } from './Ragdoll';

export const RAG = {
  /** Most ragdolls with bodies at once. */
  maxActive: 6,
  /** A body is at rest when no part moves faster than this (m/s) or spins faster (rad/s) for `settleS` seconds. */
  settleSpeed: 0.3,
  settleSpin: 0.9,
  settleS: 0.5,
  /** A ragdoll that has not come to rest after this long (s) is frozen anyway (wedged, rocking). */
  maxActiveS: 9,
  /** Seconds to get up, blending from the lying pose to standing. */
  getUpS: 1.1,
  /** Impacts: no damage for this long after going down (the blow that threw them already hurt), then a part's velocity change above `impactSafe` m/s in one tick hurts `impactPerMps` a m/s. */
  impactGraceS: 0.4,
  impactSafe: 13,
  impactPerMps: 6,
} as const;

interface Entry {
  ped: PedEntity;
  rag: Ragdoll | null;
  /** The pose, kept current while active, frozen after. Part centres (11 x 3) and rotations (11 x 4). */
  pos: Float32Array;
  rot: Float32Array;
  /** Tick it went down, tick it froze (0 while active). */
  since: number;
  frozenAt: number;
  /** Seconds at rest, and seconds since it went down. */
  still: number;
  age: number;
  /** The knockdown time is over: stand up once at rest. */
  wantUp: boolean;
  /** -1, or 0 to 1 through getting up. */
  up: number;
  upFrom: { pos: Float32Array; rot: Float32Array } | null;
  upAt: { x: number; y: number; z: number; yaw: number };
  grace: number;
  /** Last tick's velocities of the pelvis, torso and head (for impacts). */
  lastV: Float32Array;
}

const restPos = new Float32Array(RAG_PARTS * 3);
const restRot = new Float32Array(RAG_PARTS * 4);
const qa: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qb: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qo: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class RagdollManager {
  private readonly entries = new Map<EntityId, Entry>();
  /** Part body handle to ped, for hitscan (rebuilt when ragdolls come and go). */
  private readonly owners = new Map<number, EntityId>();
  private ray: RAPIER.Ray | null = null;
  /** Ragdolls made and frozen over the sim's life (diagnostics and the leak check). */
  readonly stats = { made: 0, frozen: 0, woken: 0, gotUp: 0 };

  constructor(private readonly sim: Simulation) {}

  /** Whether this ped's body is a ragdoll (moving, frozen or getting up). */
  has(id: EntityId): boolean {
    return this.entries.has(id);
  }

  /** Whether it has physics bodies right now. */
  isActive(id: EntityId): boolean {
    return !!this.entries.get(id)?.rag;
  }

  get activeCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.rag) n++;
    return n;
  }

  get count(): number {
    return this.entries.size;
  }

  /** The ped a ragdoll part belongs to, or 0. */
  ownerOf(bodyHandle: number): EntityId {
    return this.owners.get(bodyHandle) ?? 0;
  }

  /** The ragdoll of a ped, when it has bodies (for tests and tools). */
  ragdollOf(id: EntityId): Ragdoll | null {
    return this.entries.get(id)?.rag ?? null;
  }

  /** The pose kept for a ped: part centres (11 x 3) and rotations (11 x 4). */
  poseOf(id: EntityId): { pos: Float32Array; rot: Float32Array } | null {
    const e = this.entries.get(id);
    return e ? { pos: e.pos, rot: e.rot } : null;
  }

  /**
   * Makes the ped a ragdoll moving at its own velocity plus (dx, dy, dz), or adds that to the ragdoll it already is (waking a
   * frozen one). `legShare` is how much of the push the legs get (less topples the body over them).
   */
  knock(ped: PedEntity, dx: number, dy: number, dz: number, legShare = 0.55): void {
    if (ped.vehicleId) return;
    let e = this.entries.get(ped.id);
    if (!e) {
      const c = ped.controller;
      const vx = c.vel.x + c.ext.x;
      const vz = c.vel.z + c.ext.z;
      const vy = c.grounded ? 0 : c.vy;
      this.makeRoom();
      const rag = new Ragdoll(this.sim.physics.R, this.sim.physics.world, c.x, c.y, c.z, c.yaw, vx, vy, vz);
      c.enterRagdoll((x, y, z) => this.knock(ped, x, y, z));
      e = {
        ped, rag, pos: new Float32Array(RAG_PARTS * 3), rot: new Float32Array(RAG_PARTS * 4), since: this.sim.tick, frozenAt: 0,
        still: 0, age: 0, wantUp: false, up: -1, upFrom: null, upAt: { x: 0, y: 0, z: 0, yaw: 0 }, grace: RAG.impactGraceS, lastV: new Float32Array(9),
      };
      rag.read(e.pos, e.rot);
      this.entries.set(ped.id, e);
      for (const b of rag.bodies) this.owners.set(b.handle, ped.id);
      this.stats.made++;
    } else if (!e.rag) {
      // A frozen or rising body hit again: wake it where it lies.
      if (e.up >= 0) {
        e.up = -1;
        e.upFrom = null;
      }
      this.wake(e);
    }
    e.rag!.setTone(ped.life === 'dead' ? 'dead' : 'alive');
    if (dx || dy || dz) e.rag!.push(dx, dy, dz, legShare);
    e.still = 0;
    e.wantUp = false;
    for (let i = 0; i < 3; i++) {
      const v = e.rag!.bodies[i].linvel();
      e.lastV[i * 3] = v.x;
      e.lastV[i * 3 + 1] = v.y;
      e.lastV[i * 3 + 2] = v.z;
    }
  }

  /**
   * A car's front sweeps the legs: the parts take the car's velocity (vx, vz) in shares that fall from the shins to the head,
   * plus a little lift, so the body pivots back over the bonnet the way a pedestrian struck by a car does, and the car's own
   * body carries it on from there.
   */
  sweep(ped: PedEntity, vx: number, vz: number) {
    const rag = this.entries.get(ped.id)?.rag;
    if (!rag) return;
    const sp = Math.hypot(vx, vz);
    const lift = 0.4 + sp * 0.05;
    for (let i = 0; i < RAG_PARTS; i++) {
      const share = i === 8 || i === 10 ? 0.95 : i === 7 || i === 9 ? 0.85 : i === 0 ? 0.6 : i === 2 ? 0.2 : 0.3;
      const b = rag.bodies[i];
      const v = b.linvel();
      b.setLinvel({ x: v.x + vx * share, y: v.y + (i >= 7 ? lift * 0.5 : lift), z: v.z + vz * share }, true);
    }
  }

  /** The knockdown is over (DownedSystem): stand up once at rest. Returns true while the ragdoll is still in the way. */
  requestUp(ped: PedEntity): boolean {
    const e = this.entries.get(ped.id);
    if (!e) return false;
    e.wantUp = true;
    return true;
  }

  /** Lets a ped go at once (a respawn, a despawn): bodies removed, the capsule back where the controller already is when `keepPlace`. */
  release(ped: PedEntity, keepPlace = true) {
    const e = this.entries.get(ped.id);
    if (!e) return;
    this.drop(e);
    if (keepPlace) {
      const c = ped.controller;
      c.exitRagdoll(c.x, c.y, c.z, c.yaw);
    }
  }

  onEvent(e: SimEvent) {
    if (e.type === 'entity:despawn') {
      const en = this.entries.get(e.id);
      if (en) this.drop(en);
    }
  }

  private drop(e: Entry) {
    if (e.rag) {
      for (const b of e.rag.bodies) this.owners.delete(b.handle);
      e.rag.dispose();
      e.rag = null;
    }
    this.entries.delete(e.ped.id);
  }

  /** Frees a slot: freezes the oldest active ragdoll when all are taken. */
  private makeRoom() {
    let n = 0;
    let oldest: Entry | null = null;
    for (const e of this.entries.values()) {
      if (!e.rag) continue;
      n++;
      if (!oldest || e.since < oldest.since) oldest = e;
    }
    if (n >= RAG.maxActive && oldest) this.freeze(oldest);
  }

  private freeze(e: Entry) {
    if (!e.rag) return;
    e.rag.read(e.pos, e.rot);
    for (const b of e.rag.bodies) this.owners.delete(b.handle);
    e.rag.dispose();
    e.rag = null;
    e.frozenAt = this.sim.tick;
    this.stats.frozen++;
  }

  private wake(e: Entry) {
    this.makeRoom();
    const rag = new Ragdoll(this.sim.physics.R, this.sim.physics.world, 0, 0, 0, 0, 0, 0, 0, { pos: e.pos, rot: e.rot });
    e.rag = rag;
    e.frozenAt = 0;
    e.since = this.sim.tick;
    e.age = 0;
    e.grace = 0.1;
    for (const b of rag.bodies) this.owners.set(b.handle, e.ped.id);
    this.stats.woken++;
  }

  /** Wakes a frozen body that a moving car has reached. (VehicleHitSystem asks.) */
  nudge(ped: PedEntity) {
    const e = this.entries.get(ped.id);
    if (e && !e.rag && e.up < 0) this.wake(e);
  }

  /** One tick, after the physics step: follow the bodies, hurt on hard impacts, settle, freeze, get up. */
  update(dt: number) {
    const sim = this.sim;
    for (const e of this.entries.values()) {
      const ped = e.ped;
      const c = ped.controller;
      if (e.rag) {
        e.age += dt;
        e.grace = Math.max(0, e.grace - dt);
        e.rag.setTone(ped.life === 'dead' ? 'dead' : 'alive');
        e.rag.clampSpeeds();
        e.rag.read(e.pos, e.rot);
        this.impacts(e);
        const m = e.rag.motion();
        e.still = m.speed < RAG.settleSpeed && m.spin < RAG.settleSpin ? e.still + dt : 0;
        // the feet follow the pelvis (for the AI, the snapshot and anyone looking for this person)
        const torsoUp = 1 - 2 * (e.rot[4] * e.rot[4] + e.rot[6] * e.rot[6]);
        c.followRagdoll(e.pos[0], e.pos[1] - (0.15 + 0.85 * Math.max(0, torsoUp)), e.pos[2]);
        if (e.still >= RAG.settleS || e.age >= RAG.maxActiveS) {
          if (ped.life !== 'dead' && e.wantUp) this.startUp(e);
          else this.freeze(e);
        }
      } else if (e.up >= 0) {
        e.up += dt / RAG.getUpS;
        this.blendUp(e);
        if (e.up >= 1) {
          this.entries.delete(ped.id);
          c.exitRagdoll(e.upAt.x, e.upAt.y, e.upAt.z, e.upAt.yaw);
          this.stats.gotUp++;
        }
      } else if (ped.life !== 'dead' && e.wantUp) {
        this.startUp(e);
      }
    }
  }

  /** Damage from a hard knock: a part's velocity changing faster than a fall the legs could take. */
  private impacts(e: Entry) {
    const rag = e.rag!;
    let dv = 0;
    // (the pelvis and the torso: a head or a hand whipping round is not a blow)
    for (let i = 0; i < 2; i++) {
      const v = rag.bodies[i].linvel();
      const o = i * 3;
      dv = Math.max(dv, Math.hypot(v.x - e.lastV[o], v.y - e.lastV[o + 1], v.z - e.lastV[o + 2]));
      e.lastV[o] = v.x;
      e.lastV[o + 1] = v.y;
      e.lastV[o + 2] = v.z;
    }
    if (e.grace > 0 || dv <= RAG.impactSafe || e.ped.life === 'dead') return;
    // Who did it: a moving car right there, or the ground.
    const p = rag.pelvis.translation();
    let source = 0;
    let vehicleId = 0;
    for (const v of this.sim.vehicles()) {
      if (v.car.speed < 3) continue;
      const t = v.car.body.translation();
      if (Math.hypot(t.x - p.x, t.z - p.z) < v.car.h.chassis.halfExtents[2] + 1.5) {
        source = v.occupantId;
        vehicleId = v.id;
        break;
      }
    }
    e.grace = 0.25;
    damagePed(this.sim, e.ped, Math.round((dv - RAG.impactSafe) * RAG.impactPerMps), vehicleId ? 'vehicle' : 'fall', source, vehicleId);
  }

  private startUp(e: Entry) {
    if (e.rag) this.freeze(e);
    const lie = this.lieOf(e);
    // Stand where the pelvis lies, on whatever is under it.
    const x = e.pos[0];
    const z = e.pos[2];
    const y = this.floorUnder(x, e.pos[1] + 0.6, z);
    // (on a clear spot: nobody stands up inside a wall, a prop or a car)
    const spot = this.sim.physics.clearSpot(x, y, z, 3, { vehicles: true });
    e.upAt = spot ? { x: spot.x, y: spot.y, z: spot.z, yaw: lie } : { x, y, z, yaw: lie };
    e.upFrom = { pos: e.pos.slice(), rot: e.rot.slice() };
    e.up = 0;
  }

  /** Which way to face on getting up: along the body, toward the head. */
  private lieOf(e: Entry): number {
    return Math.atan2(e.pos[6] - e.pos[0], e.pos[8] - e.pos[2]);
  }

  private floorUnder(x: number, y: number, z: number): number {
    const R = this.sim.physics.R;
    const ray = (this.ray ??= new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
    ray.origin.x = x;
    ray.origin.y = y;
    ray.origin.z = z;
    const hit = this.sim.physics.world.castRay(ray, 4, true, undefined, GROUPS.cameraQuery);
    return hit ? y - hit.timeOfImpact : this.sim.groundAt(x, z);
  }

  /** The pose part way up: each part's rotation and the pelvis blended from lying to standing. */
  private blendUp(e: Entry) {
    const k = smoothstep(0, 1, clamp(e.up, 0, 1));
    const a = e.upAt;
    restPose(a.x, a.y, a.z, a.yaw, restPos, restRot);
    const f = e.upFrom!;
    for (let i = 0; i < RAG_PARTS; i++) {
      const o = i * 4;
      qa.x = f.rot[o]; qa.y = f.rot[o + 1]; qa.z = f.rot[o + 2]; qa.w = f.rot[o + 3];
      qb.x = restRot[o]; qb.y = restRot[o + 1]; qb.z = restRot[o + 2]; qb.w = restRot[o + 3];
      nlerpQuat(qa, qb, k, qo);
      e.rot[o] = qo.x; e.rot[o + 1] = qo.y; e.rot[o + 2] = qo.z; e.rot[o + 3] = qo.w;
    }
    // the hips rise late: most of the way through, the body is still low
    const kp = smoothstep(0.25, 1, clamp(e.up, 0, 1));
    for (let j = 0; j < 3; j++) e.pos[j] = f.pos[j] + (restPos[j] - f.pos[j]) * (j === 1 ? kp : k);
    e.ped.controller.followRagdoll(e.pos[0], Math.min(e.pos[1] - RAG_PELVIS_HEIGHT * kp, a.y), e.pos[2]);
  }

  /** Snapshot flags for a ped's body. */
  flags(id: EntityId): number {
    return this.entries.has(id) ? PedFlag.Ragdoll : 0;
  }

  /** Writes the ragdoll records after the entity records: active ones, then getting up, then the most recently frozen. */
  write(view: SnapshotView) {
    const u = view.u32;
    const f = view.f32;
    let n = 0;
    const put = (e: Entry) => {
      if (n >= MAX_RAGDOLL_RECORDS) return;
      const o = view.ragdollAt(n++);
      u[o + RG.Id] = e.ped.id;
      f[o + RG.Px] = e.pos[0];
      f[o + RG.Py] = e.pos[1];
      f[o + RG.Pz] = e.pos[2];
      for (let i = 0; i < RAG_PARTS; i++) packQuat(e.rot[i * 4], e.rot[i * 4 + 1], e.rot[i * 4 + 2], e.rot[i * 4 + 3], u, o + RG.Rot + i * 2);
    };
    // (the entity records must be written first: the ragdoll records go after them)
    for (const e of this.entries.values()) if (e.rag || e.up >= 0) put(e);
    if (n < MAX_RAGDOLL_RECORDS) {
      const frozen = [...this.entries.values()].filter((e) => !e.rag && e.up < 0).sort((a, b) => b.frozenAt - a.frozenAt || a.ped.id - b.ped.id);
      for (const e of frozen) put(e);
    }
    u[H.Ragdolls] = n;
  }
}
