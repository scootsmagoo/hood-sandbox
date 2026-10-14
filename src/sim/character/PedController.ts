/**
 * The protagonist on foot: a capsule moved by Rapier's kinematic character controller. Gravity, the
 * jump and the horizontal velocity are ours; Rapier handles sliding along walls, climbing slopes,
 * stepping up kerbs and sticking to the ground.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { DEG, approachAngle, yawFromDir } from '../../shared/math';
import { GROUPS } from '../physics/rapier';
import { PED, PED_FEET_OFFSET, approachVelocity, wishVelocity, type WishVelocity } from './locomotion';

export interface PedInput {
  moveX: number;
  moveY: number;
  camYaw: number;
  sprint: boolean;
  jump: boolean;
}

const wish: WishVelocity = { x: 0, z: 0, magnitude: 0 };

export class PedController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  /** Feet position. */
  x = 0;
  y = 0;
  z = 0;
  /** Horizontal velocity. */
  readonly vel = { x: 0, z: 0 };
  vy = 0;
  yaw = 0;
  grounded = false;
  sprinting = false;
  enabled = true;
  private coyote = 0;
  private jumpBuffered = 0;
  private jumpWasDown = false;

  constructor(
    private readonly R: typeof RAPIER,
    private readonly world: RAPIER.World,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + PED_FEET_OFFSET, z),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(PED.halfHeight, PED.radius).setCollisionGroups(GROUPS.ped),
      this.body,
    );
    const kcc = (this.kcc = world.createCharacterController(0.02));
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setSlideEnabled(true);
    kcc.enableAutostep(PED.maxStep, 0.2, false);
    kcc.enableSnapToGround(0.3);
    kcc.setMaxSlopeClimbAngle(PED.maxSlopeDeg * DEG);
    kcc.setMinSlopeSlideAngle(60 * DEG);
    kcc.setApplyImpulsesToDynamicBodies(false);
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
  }

  /** One fixed step. Call before the world steps. */
  step(dt: number, input: PedInput) {
    if (!this.enabled) return;
    wishVelocity(input.moveX, input.moveY, input.camYaw, input.sprint, wish);
    approachVelocity(this.vel, wish.x, wish.z, this.grounded, dt);
    this.sprinting = input.sprint && wish.magnitude > 0.5;

    // Jump with a little forgiveness on both sides of the ledge and the press.
    const jumpPressed = input.jump && !this.jumpWasDown;
    this.jumpWasDown = input.jump;
    this.coyote = this.grounded ? PED.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffered = jumpPressed ? PED.jumpBuffer : Math.max(0, this.jumpBuffered - dt);
    if (this.jumpBuffered > 0 && this.coyote > 0) {
      this.vy = PED.jumpSpeed;
      this.jumpBuffered = 0;
      this.coyote = 0;
      this.grounded = false;
    } else if (this.grounded && this.vy <= 0) {
      this.vy = -0.5;
    } else {
      this.vy = Math.max(-PED.terminalSpeed, this.vy - PED.gravity * dt);
    }

    this.kcc.computeColliderMovement(
      this.collider,
      { x: this.vel.x * dt, y: this.vy * dt, z: this.vel.z * dt },
      undefined,
      GROUPS.actorQuery,
    );
    const m = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded() && this.vy <= 0.01;
    // Horizontal velocity is left alone: Rapier's step-up needs the full push into a ledge every tick.
    // A ceiling does stop a jump.
    if (this.vy > 0 && m.y < this.vy * dt - 1e-4) this.vy = Math.min(this.vy, m.y / dt);

    const t = this.body.translation();
    const nx = t.x + m.x;
    const ny = t.y + m.y;
    const nz = t.z + m.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.x = nx;
    this.y = ny - PED_FEET_OFFSET;
    this.z = nz;

    if (wish.magnitude > 0.05) this.yaw = approachAngle(this.yaw, yawFromDir(wish.x, wish.z), PED.turnRate * dt);
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Hides the capsule from the world while the character sits in a vehicle. */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.body.setEnabled(on);
    if (!on) this.vel.x = this.vel.z = this.vy = 0;
  }

  /** Puts the character at a feet position, standing. */
  teleport(x: number, y: number, z: number, yaw = this.yaw) {
    const cy = y + PED_FEET_OFFSET;
    this.body.setTranslation({ x, y: cy, z }, true);
    this.body.setNextKinematicTranslation({ x, y: cy, z });
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.vel.x = this.vel.z = this.vy = 0;
    this.grounded = false;
  }

  /** Takes the character out of the physics world for good. */
  dispose() {
    this.world.removeCharacterController(this.kcc);
    this.world.removeRigidBody(this.body);
  }
}
