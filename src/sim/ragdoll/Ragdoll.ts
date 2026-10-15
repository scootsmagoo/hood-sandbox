/**
 * One ragdoll: eleven Rapier bodies (shared/ragdoll.ts) joined by ball joints at the hips, shoulders,
 * waist and neck and hinges at the knees and elbows. The ball joints carry a little muscle tone (a
 * soft motor toward the standing pose) so a body slumps rather than folds like cloth; a living
 * person keeps more of it than a dead one. The parts collide with the world, props and cars but not
 * with each other; a car and a body trade momentum through their contacts like any two bodies (75 kg
 * against a tonne and a half: the car hardly notices).
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { RAG_PARTS, RAG_RIG, restPose } from '../../shared/ragdoll';
import { rotateVec, type Quat, type Vec3 } from '../../shared/math';
import { GROUPS } from '../physics/rapier';

export const RAGDOLL = {
  /** Muscle tone of the ball joints (acceleration-based motor toward the rest pose): stiffness and damping, alive and dead. */
  toneAlive: [14, 4],
  toneDead: [2, 1.5],
  /** Contact friction and bounce of a body. */
  friction: 0.75,
  restitution: 0.05,
  /** Air and joint damping. */
  linearDamping: 0.05,
  angularDamping: 0.9,
  /** Speed limits a part is clamped to each tick (a body squeezed between a car and the road must not be fired into the sky), m/s and rad/s. */
  maxSpeed: 32,
  maxSpin: 28,
} as const;

const scratchPos = new Float32Array(RAG_PARTS * 3);
/** The pelvis, the torso and the thighs. */
const TRUNK = [0, 1, 7, 9] as const;
const scratchRot = new Float32Array(RAG_PARTS * 4);

export class Ragdoll {
  readonly bodies: RAPIER.RigidBody[] = [];
  private readonly joints: RAPIER.ImpulseJoint[] = [];
  private tone: 'alive' | 'dead' = 'alive';

  /**
   * Builds the ragdoll standing at feet (x, y, z) facing `yaw`, or at a given pose (`pos` 11 x 3, `rot` 11 x 4: a frozen body
   * being woken), every part moving at (vx, vy, vz).
   */
  constructor(
    private readonly R: typeof RAPIER,
    private readonly world: RAPIER.World,
    x: number,
    y: number,
    z: number,
    yaw: number,
    vx: number,
    vy: number,
    vz: number,
    pose?: { pos: ArrayLike<number>; rot: ArrayLike<number> },
  ) {
    let pos: ArrayLike<number> = scratchPos;
    let rot: ArrayLike<number> = scratchRot;
    if (pose) {
      pos = pose.pos;
      rot = pose.rot;
    } else restPose(x, y, z, yaw, scratchPos, scratchRot);
    for (let i = 0; i < RAG_PARTS; i++) {
      const d = RAG_RIG[i];
      const big = i <= 2 || d.mass >= 9;
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
          .setRotation({ x: rot[i * 4], y: rot[i * 4 + 1], z: rot[i * 4 + 2], w: rot[i * 4 + 3] })
          .setLinvel(vx, vy, vz)
          .setLinearDamping(RAGDOLL.linearDamping)
          .setAngularDamping(RAGDOLL.angularDamping * (i === 2 || (i >= 3 && i <= 6) ? 2.5 : 1))
          .setSoftCcdPrediction(big ? 0.5 : 0.25)
          .setAdditionalSolverIterations(2)
          .setCanSleep(false),
      );
      const s = d.shape;
      const r = s.kind === 'box' ? (s.round ?? 0) : 0;
      const desc = s.kind === 'box' ? (r > 0 ? R.ColliderDesc.roundCuboid(s.half[0], s.half[1], s.half[2], r) : R.ColliderDesc.cuboid(s.half[0], s.half[1], s.half[2])) : R.ColliderDesc.capsule(s.halfHeight, s.radius);
      // Density from the part's mass and its shape's volume.
      const vol = s.kind === 'box' ? 8 * (s.half[0] + r) * (s.half[1] + r) * (s.half[2] + r) : Math.PI * s.radius * s.radius * (2 * s.halfHeight + (4 / 3) * s.radius);
      world.createCollider(
        desc.setDensity(d.mass / vol).setFriction(RAGDOLL.friction).setRestitution(RAGDOLL.restitution).setCollisionGroups(GROUPS.ragdoll),
        body,
      );
      this.bodies.push(body);
    }
    for (let i = 1; i < RAG_PARTS; i++) {
      const d = RAG_RIG[i];
      const j = d.joint!;
      const pc = RAG_RIG[d.parent].centre;
      const a1 = { x: j.at[0] - pc[0], y: j.at[1] - pc[1], z: j.at[2] - pc[2] };
      const a2 = { x: j.at[0] - d.centre[0], y: j.at[1] - d.centre[1], z: j.at[2] - d.centre[2] };
      let data: RAPIER.JointData;
      if (j.kind === 'hinge') {
        data = R.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 });
        data.limitsEnabled = true;
        data.limits = [j.min, j.max];
      } else data = R.JointData.spherical(a1, a2);
      const joint = world.createImpulseJoint(data, this.bodies[d.parent], this.bodies[i], true);
      joint.setContactsEnabled(false);
      this.joints.push(joint);
    }
    this.setTone('alive', true);
  }

  /** Muscle tone: a living person keeps some, a dead one slumps. */
  setTone(t: 'alive' | 'dead', force = false) {
    if (t === this.tone && !force) return;
    this.tone = t;
    const [k, c] = t === 'alive' ? RAGDOLL.toneAlive : RAGDOLL.toneDead;
    const A = this.R.JointAxis;
    for (const j of this.joints) {
      if (!(j instanceof this.R.SphericalImpulseJoint)) continue;
      for (const ax of [A.AngX, A.AngY, A.AngZ]) j.configureMotorPosition(ax, 0, k, c);
    }
  }

  get pelvis(): RAPIER.RigidBody {
    return this.bodies[0];
  }

  /** Adds (dx, dy, dz) m/s to the body: all of it to the upper body, a share to the hips and legs, so a push topples it. */
  push(dx: number, dy: number, dz: number, legShare = 0.55) {
    for (let i = 0; i < RAG_PARTS; i++) {
      const k = i === 0 ? 0.85 : i >= 7 ? legShare : 1;
      const b = this.bodies[i];
      const v = b.linvel();
      b.setLinvel({ x: v.x + dx * k, y: v.y + dy * k, z: v.z + dz * k }, true);
    }
  }

  /** An impulse (N s) on one part at a world point. */
  impulse(part: number, jx: number, jy: number, jz: number, at?: Vec3) {
    const b = this.bodies[part];
    if (at) b.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, at, true);
    else b.applyImpulse({ x: jx, y: jy, z: jz }, true);
  }

  /** Keeps every part within the speed limits (see `RAGDOLL.maxSpeed`). */
  clampSpeeds() {
    for (const b of this.bodies) {
      const v = b.linvel();
      const s = Math.hypot(v.x, v.y, v.z);
      if (s > RAGDOLL.maxSpeed) {
        const k = RAGDOLL.maxSpeed / s;
        b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
      }
      const w = b.angvel();
      const r = Math.hypot(w.x, w.y, w.z);
      if (r > RAGDOLL.maxSpin) {
        const k = RAGDOLL.maxSpin / r;
        b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
      }
    }
  }

  /** The fastest the trunk and thighs move, m/s, and spin, rad/s (a hand or the head twitching on the ground is not motion). */
  motion(): { speed: number; spin: number } {
    let speed = 0;
    let spin = 0;
    for (const i of TRUNK) {
      const b = this.bodies[i];
      const v = b.linvel();
      const w = b.angvel();
      speed = Math.max(speed, Math.hypot(v.x, v.y, v.z));
      spin = Math.max(spin, Math.hypot(w.x, w.y, w.z));
    }
    return { speed, spin };
  }

  /** Writes the part centres (11 x 3) and rotations (11 x 4). */
  read(pos: Float32Array, rot: Float32Array) {
    for (let i = 0; i < RAG_PARTS; i++) {
      const b = this.bodies[i];
      const t = b.translation();
      const q = b.rotation();
      pos[i * 3] = t.x;
      pos[i * 3 + 1] = t.y;
      pos[i * 3 + 2] = t.z;
      rot[i * 4] = q.x;
      rot[i * 4 + 1] = q.y;
      rot[i * 4 + 2] = q.z;
      rot[i * 4 + 3] = q.w;
    }
  }

  /** Which way the body lies: the yaw its head points along from the pelvis, and whether it is face up. */
  lie(): { yaw: number; faceUp: boolean } {
    const p = this.bodies[0].translation();
    const h = this.bodies[2].translation();
    const q = this.bodies[1].rotation() as Quat;
    const front = rotateVec(q, 0, 0, 1);
    return { yaw: Math.atan2(h.x - p.x, h.z - p.z), faceUp: front.y > 0 };
  }

  /** Whether a rigid body handle is one of this ragdoll's parts. */
  owns(handle: number): boolean {
    for (const b of this.bodies) if (b.handle === handle) return true;
    return false;
  }

  dispose() {
    for (const j of this.joints) this.world.removeImpulseJoint(j, false);
    for (const b of this.bodies) this.world.removeRigidBody(b);
    this.joints.length = 0;
    this.bodies.length = 0;
  }
}
