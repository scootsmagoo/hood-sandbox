/**
 * A raycast car on a Rapier rigid body. The chassis is a dynamic body with a box (and a cabin box
 * for rolling over); the wheels are not bodies at all, only rays cast down from the suspension
 * hardpoints. Each tick the car turns what the rays see into spring, tyre and drag impulses on the
 * chassis (the maths is in dynamics.ts), and Rapier integrates the result with the world.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { DEG, clamp, lerp, wrapAngle, rotateVec, yawOfQuat, type Quat } from '../../shared/math';
import type { HandlingData } from '../../shared/handling';
import { GROUPS } from '../physics/rapier';
import {
  counterSteer,
  engineAccel,
  lowSpeedGrip,
  newTireOutput,
  resolvePedals,
  slewSteer,
  steerLock,
  suspensionAccel,
  tireForce,
  driftAssistAccel,
  burnoutHold,
  donutAccel,
  donutTurnRate,
  donutRamp,
  donutWanted,
  donutYawAccel,
  donutYawTarget,
  type DriveRequest,
  type TireInput,
} from './dynamics';

export interface VehicleInput {
  throttle: number;
  brake: number;
  /** -1 left to +1 right. */
  steer: number;
  handbrake: boolean;
}

export const IDLE_INPUT: Readonly<VehicleInput> = { throttle: 0, brake: 0, steer: 0, handbrake: true };

/**
 * A flat tyre (a spike strip): the wheel sits lower, grips less and drags. `flat` runs 0 (inflated) to 1
 * (flat) and follows the target at `rate` a second, so the car settles rather than jolts.
 */
export const FLAT = {
  /** Share of the wheel's radius lost at flat 1. */
  radiusLoss: 0.3,
  /** Share of grip (longitudinal and lateral) lost at flat 1. */
  gripLoss: 0.35,
  /** Rim scraping: extra deceleration of the whole car with all four flat, m/s^2 (a quarter of it per flat wheel). */
  drag: 2.6,
  rate: 2.5,
} as const;

export interface WheelState {
  /** Steering angle, positive turns left. */
  steer: number;
  /** Rolling angle, radians. */
  roll: number;
  /** Suspension length (m): 0 fully compressed. */
  length: number;
  grounded: boolean;
  slip: number;
}

interface Wheel extends WheelState {
  front: boolean;
  /** 0 (inflated) to 1 (flat), and where it is heading. */
  flat: number;
  flatTarget: number;
  /** Current rolling radius, m. */
  rad: number;
  /** Mount point in the body's frame. */
  mx: number;
  my: number;
  mz: number;
  prevLength: number;
  /** Mass share carried, kg. */
  share: number;
  // scratch
  accel: number;
  hitDist: number;
  nx: number;
  ny: number;
  nz: number;
  ox: number;
  oy: number;
  oz: number;
}

export interface CarSpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const tmpTire: TireInput = {
  vLong: 0, vLat: 0, load: 0, mass: 0, dt: 0, driveForce: 0, brakeForce: 0, gripMult: 1, lateralMult: 1,
};
const tireOut = newTireOutput();
const pedals: DriveRequest = { drive: 0, brake: 0, reversing: false };

export class RaycastCar {
  readonly body: RAPIER.RigidBody;
  readonly wheels: Wheel[] = [];
  readonly h: HandlingData;
  /** Velocity along the car's forward axis, m/s. */
  speedForward = 0;
  speed = 0;
  steerAngle = 0;
  throttleApplied = 0;
  braking = false;
  handbraking = false;
  reversing = false;
  skidding = false;
  airborne = false;
  /** 0 to 1: how far into a donut. */
  donut = 0;
  private yawInertia: number;
  private ray: RAPIER.Ray;
  private prevVel = { x: 0, y: 0, z: 0 };
  private prevTravelYaw = 0;
  /** How fast the direction of travel turns, rad/s (smoothed). */
  private travelTurn = 0;
  /** Seconds left in which the slide assists are let go after a PIT (see `pitKick`). */
  private slideT = 0;
  /** Largest sudden speed change in the last step, m/s. Used to report impacts. */
  impactSpeedLoss = 0;
  /** The velocity change of the last step in the world frame, m/s. */
  readonly impactDv = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly R: typeof RAPIER,
    private readonly world: RAPIER.World,
    handling: HandlingData,
    spawn: CarSpawn,
  ) {
    const h = (this.h = handling);
    const q = { x: 0, y: Math.sin(spawn.yaw / 2), z: 0, w: Math.cos(spawn.yaw / 2) };
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation(q)
        .setCcdEnabled(true)
        .setAngularDamping(0.25)
        .setLinearDamping(0)
        .setCanSleep(false),
    );
    this.body = body;

    const c = h.chassis;
    const mk = (half: number[], off: number[]) =>
      R.ColliderDesc.cuboid(half[0], half[1], half[2])
        .setTranslation(off[0], off[1], off[2])
        .setDensity(0)
        .setFriction(0.2)
        .setRestitution(0.05)
        .setCollisionGroups(GROUPS.vehicle);
    world.createCollider(mk(c.halfExtents, c.offset), body);
    world.createCollider(mk(c.cabin.halfExtents, c.cabin.offset), body);

    const w = c.halfExtents[0] * 2;
    const hh = (c.cabin.offset[1] + c.cabin.halfExtents[1] - (c.offset[1] - c.halfExtents[1]));
    const l = c.halfExtents[2] * 2;
    const m = h.mass / 12;
    const s = h.inertiaScale;
    this.yawInertia = m * (w * w + l * l) * s[1];
    body.setAdditionalMassProperties(
      h.mass,
      { x: h.centreOfMass[0], y: h.centreOfMass[1], z: h.centreOfMass[2] },
      { x: m * (hh * hh + l * l) * s[0], y: this.yawInertia, z: m * (w * w + hh * hh) * s[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    const wb = h.wheels;
    const L = wb.frontZ - wb.rearZ;
    const frontMass = (h.mass * (h.centreOfMass[2] - wb.rearZ)) / L;
    const rearMass = h.mass - frontMass;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      const track = front ? wb.trackFront : wb.trackRear;
      this.wheels.push({
        front,
        mx: (left ? 1 : -1) * track * 0.5,
        my: wb.mountY,
        mz: front ? wb.frontZ : wb.rearZ,
        steer: 0, roll: 0, length: h.suspension.travel, grounded: false, slip: 0,
        flat: 0, flatTarget: 0, rad: wb.radius,
        prevLength: h.suspension.travel,
        share: (front ? frontMass : rearMass) / 2,
        accel: 0, hitDist: 0, nx: 0, ny: 1, nz: 0, ox: 0, oy: 0, oz: 0,
      });
    }
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  get yaw(): number {
    return yawOfQuat(this.body.rotation());
  }

  /** The car's pose as a plain object (a copy). */
  pose(): { x: number; y: number; z: number; q: Quat } {
    const t = this.body.translation();
    const r = this.body.rotation();
    return { x: t.x, y: t.y, z: t.z, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  /** Stands the car upright where it is, a little above the ground, and stops it. */
  reset() {
    const t = this.body.translation();
    const yaw = this.yaw;
    this.body.setTranslation({ x: t.x, y: t.y + 1.2, z: t.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.forgetVelocity();
  }

  /** The body was handed over from another mode (a spline follower turned physics car): its current velocity is the baseline, not a crash. */
  adopt() {
    const lv = this.body.linvel();
    this.prevVel.x = lv.x;
    this.prevVel.y = lv.y;
    this.prevVel.z = lv.z;
    this.prevTravelYaw = Math.atan2(lv.x, lv.z);
    this.impactSpeedLoss = 0;
  }

  /** A move by hand is not a crash: the next step compares against rest. */
  private forgetVelocity() {
    this.prevVel.x = this.prevVel.y = this.prevVel.z = 0;
  }

  teleport(x: number, y: number, z: number, yaw: number) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.forgetVelocity();
  }

  /** Flattens a tyre (0 front left, 1 front right, 2 rear left, 3 rear right). It stays flat for the life of the car. Returns false if it already was. */
  deflate(i: number): boolean {
    const w = this.wheels[i];
    if (!w || w.flatTarget >= 1) return false;
    w.flatTarget = 1;
    return true;
  }

  /**
   * A PIT: the tail has been shoved round. Adds `yawRate` (rad/s, positive turns left) to the spin and, for
   * `slideS` seconds, lets go of the counter-steer and drift assists, which would otherwise catch the slide.
   */
  pitKick(yawRate: number, slideS = 1.8) {
    const q = this.body.rotation();
    const up = rotateVec(q, 0, 1, 0);
    const av = this.body.angvel();
    this.body.setAngvel({ x: av.x + up.x * yawRate, y: av.y + up.y * yawRate, z: av.z + up.z * yawRate }, true);
    this.slideT = Math.max(this.slideT, slideS);
  }

  /** Which tyres are flat (or going flat), one bit a wheel in snapshot order. */
  get flatMask(): number {
    let m = 0;
    for (let i = 0; i < 4; i++) if (this.wheels[i].flatTarget >= 1) m |= 1 << i;
    return m;
  }

  /** Takes the car out of the physics world for good. */
  dispose() {
    this.world.removeRigidBody(this.body);
  }

  /** Applies one tick of forces. Call before the world steps. */
  step(dt: number, input: VehicleInput) {
    const h = this.h;
    const body = this.body;
    const tr = body.translation();
    const rq = body.rotation();
    const q: Quat = rq;
    const lv = body.linvel();
    const av = body.angvel();
    const com = body.worldCom();

    const fwd = rotateVec(q, 0, 0, 1);
    const up = rotateVec(q, 0, 1, 0);
    const left = rotateVec(q, 1, 0, 0);
    const vF = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const vL = lv.x * left.x + lv.y * left.y + lv.z * left.z;
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    this.speed = speed;
    this.speedForward = vF;

    // Impact detector: a sudden loss of speed that the tyres cannot explain.
    const dvx = lv.x - this.prevVel.x;
    const dvy = lv.y - this.prevVel.y;
    const dvz = lv.z - this.prevVel.z;
    this.impactSpeedLoss = Math.hypot(dvx, dvy, dvz);
    this.impactDv.x = dvx;
    this.impactDv.y = dvy;
    this.impactDv.z = dvz;
    this.prevVel.x = lv.x;
    this.prevVel.y = lv.y;
    this.prevVel.z = lv.z;
    if (speed > 3) {
      const ty = Math.atan2(lv.x, lv.z);
      this.travelTurn += (wrapAngle(ty - this.prevTravelYaw) / dt - this.travelTurn) * 0.3;
      this.prevTravelYaw = ty;
    } else {
      this.travelTurn = 0;
      this.prevTravelYaw = Math.atan2(lv.x, lv.z);
    }

    resolvePedals(clamp(input.throttle, 0, 1), clamp(input.brake, 0, 1), vF, pedals);
    this.reversing = pedals.reversing;
    this.throttleApplied = pedals.drive;
    this.braking = pedals.brake > 0.05;
    this.handbraking = input.handbrake;
    this.donut = donutRamp(this.donut, donutWanted(clamp(input.throttle, 0, 1), input.steer, speed, input.handbrake, this.donut > 0.3, h.assists), dt);
    const donut = this.donut;

    // Steering. The assist adds to the driver's input, and only in a slide.
    const lock = steerLock(speed, h.steering);
    // (after a PIT the assists let go for a moment, so the slide is a real one)
    const assistK = this.slideT > 0 ? 0.1 : 1;
    this.slideT = Math.max(0, this.slideT - dt);
    const assist = counterSteer(vL, vF, h.assists.counterSteer, h.steering.lockDeg * DEG) * (1 - this.donut) * assistK;
    const target = clamp(-clamp(input.steer, -1, 1) * lock + assist, -h.steering.lockDeg * DEG, h.steering.lockDeg * DEG);
    this.steerAngle = slewSteer(this.steerAngle, target, dt, h.steering);
    const cosS = Math.cos(this.steerAngle);
    const sinS = Math.sin(this.steerAngle);

    // Pass 1: rays and suspension.
    const sus = h.suspension;
    const omega = 2 * Math.PI * sus.frequencyHz;
    const rest = sus.travel * sus.restRatio;
    const reach = sus.travel + h.wheels.radius;
    let grounded = 0;
    for (const w of this.wheels) {
      if (w.flat !== w.flatTarget) w.flat = w.flat < w.flatTarget ? Math.min(w.flatTarget, w.flat + FLAT.rate * dt) : Math.max(w.flatTarget, w.flat - FLAT.rate * dt);
      w.rad = h.wheels.radius * (1 - FLAT.radiusLoss * w.flat);
      const m = rotateVec(q, w.mx, w.my, w.mz);
      w.ox = tr.x + m.x;
      w.oy = tr.y + m.y;
      w.oz = tr.z + m.z;
      this.ray.origin.x = w.ox;
      this.ray.origin.y = w.oy;
      this.ray.origin.z = w.oz;
      this.ray.dir.x = -up.x;
      this.ray.dir.y = -up.y;
      this.ray.dir.z = -up.z;
      const hit = this.world.castRayAndGetNormal(this.ray, reach, true, undefined, GROUPS.actorQuery, undefined, body);
      w.prevLength = w.length;
      if (hit) {
        w.grounded = true;
        grounded++;
        w.hitDist = hit.timeOfImpact;
        w.length = clamp(hit.timeOfImpact - w.rad, 0, sus.travel);
        const n = hit.normal;
        const nl = Math.hypot(n.x, n.y, n.z);
        if (nl > 0.5) {
          w.nx = n.x / nl; w.ny = n.y / nl; w.nz = n.z / nl;
        } else {
          w.nx = up.x; w.ny = up.y; w.nz = up.z;
        }
        w.accel = suspensionAccel(w.length, w.prevLength, dt, rest, omega, sus.dampingRatio, 0.04);
      } else {
        w.grounded = false;
        w.length = sus.travel;
        w.accel = 0;
      }
    }
    this.airborne = grounded === 0;

    // Anti-roll bars act between the wheels of an axle when both touch.
    for (let a = 0; a < 4; a += 2) {
      const l = this.wheels[a];
      const r = this.wheels[a + 1];
      if (l.grounded && r.grounded) {
        const ar = sus.antiRoll * ((rest - l.length) - (rest - r.length));
        l.accel = Math.max(0, l.accel + ar);
        r.accel = Math.max(0, r.accel - ar);
      }
    }

    // Pass 2: forces.
    const d = h.drive;
    let accel = engineAccel(pedals.drive, vF, d);
    if (donut > 0) accel = lerp(accel, donutAccel(speed, input.steer, d.driveForce * 1.3, h.assists), donut);
    const throttleOff = Math.abs(pedals.drive) < 0.05;
    const hb = input.handbrake;
    const wantSpin = (hb && pedals.drive > 0.6 && speed < 12) || donut > 0.5;
    // A burnout (no donut): hold the car with the front brakes while the rear tyres smoke.
    const holdBrake = wantSpin && donut < 0.5 ? burnoutHold(vF, h.assists) * (1 - donut * 2) : 0;
    this.skidding = false;
    const driveBias = [d.driveBiasFront, 1 - d.driveBiasFront];
    for (const w of this.wheels) {
      // Roll the wheel even in the air.
      if (!w.grounded) {
        w.slip = 0;
        w.steer = w.front ? this.steerAngle : 0;
        continue;
      }
      const wheelSteer = w.front ? this.steerAngle : 0;
      w.steer = wheelSteer;
      // Wheel axes on the ground plane.
      const c = w.front ? cosS : 1;
      const s = w.front ? sinS : 0;
      let fx = fwd.x * c + left.x * s;
      let fy = fwd.y * c + left.y * s;
      let fz = fwd.z * c + left.z * s;
      const fn = fx * w.nx + fy * w.ny + fz * w.nz;
      fx -= w.nx * fn;
      fy -= w.ny * fn;
      fz -= w.nz * fn;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      // lateral = n x f (points left)
      const lx = w.ny * fz - w.nz * fy;
      const ly = w.nz * fx - w.nx * fz;
      const lz = w.nx * fy - w.ny * fx;

      // Contact point and its velocity.
      const px = w.ox - up.x * w.hitDist;
      const py = w.oy - up.y * w.hitDist;
      const pz = w.oz - up.z * w.hitDist;
      const rx = px - com.x;
      const ry = py - com.y;
      const rz = pz - com.z;
      const cvx = lv.x + (av.y * rz - av.z * ry);
      const cvy = lv.y + (av.z * rx - av.x * rz);
      const cvz = lv.z + (av.x * ry - av.y * rx);

      // Suspension: push the chassis up at the hub.
      const sj = w.accel * w.share * dt;
      body.applyImpulseAtPoint(
        { x: up.x * sj, y: up.y * sj, z: up.z * sj },
        { x: w.ox - up.x * w.length, y: w.oy - up.y * w.length, z: w.oz - up.z * w.length },
        true,
      );
      const load = w.accel * w.share;

      const driven = driveBias[w.front ? 0 : 1] > 0;
      const axleDrive = driveBias[w.front ? 0 : 1];
      tmpTire.vLong = cvx * fx + cvy * fy + cvz * fz;
      tmpTire.vLat = cvx * lx + cvy * ly + cvz * lz;
      tmpTire.load = load;
      tmpTire.mass = w.share;
      tmpTire.dt = dt;
      tmpTire.driveForce = driven ? (accel * h.mass * axleDrive) / 2 : 0;
      let brake = pedals.brake * d.brakeForce * h.mass * (w.front ? 0.6 : 0.4) * 0.5;
      if (throttleOff) brake += (d.engineBrake * h.mass) / 4;
      if (holdBrake > 0 && w.front) brake += (holdBrake * h.mass) / 2;
      tmpTire.lateralMult = 1;
      tmpTire.longMult = !w.front && donut > 0 ? lerp(1, 1.6, donut) : 1;
      if (donut > 0 && !w.front) tmpTire.lateralMult *= lerp(1, h.assists.donutRearGrip, donut);
      if (hb && !w.front) {
        // A burnout lets the rear wheels spin against the handbrake instead of being held by it.
        if (!wantSpin) brake += (d.handbrakeForce * h.mass) / 2;
        tmpTire.lateralMult = h.traction.handbrakeGripMult;
      }
      // After a PIT the tail has let go: the rear tyres hold little until the car has come round.
      if (this.slideT > 0) tmpTire.lateralMult *= w.front ? 0.5 : 0.12;
      // A flat tyre scrapes the rim (drag) and holds the road less.
      if (w.flat > 0) {
        brake += (FLAT.drag * w.flat * h.mass) / 4;
        tmpTire.lateralMult *= 1 - FLAT.gripLoss * w.flat;
      }
      tmpTire.brakeForce = brake;
      tmpTire.gripMult = (w.front ? lerp(1, h.assists.donutFrontGrip, donut) : 1) * (1 - FLAT.gripLoss * w.flat);
      tireForce(tmpTire, h.traction, tireOut);
      if (driven && (tireOut.spinning || wantSpin)) {
        tmpTire.lateralMult *= lowSpeedGrip(speed, true, h.traction);
        if (wantSpin && !tireOut.spinning) tmpTire.driveForce = Math.sign(tmpTire.driveForce || 1) * load * h.traction.curveMax * 1.2;
        tireForce(tmpTire, h.traction, tireOut);
      }
      w.slip = !w.front && donut > 0.5 ? 1 : tireOut.slip;
      if (tireOut.slip > 0.6) this.skidding = true;

      // Apply at the contact point lifted toward the centre of mass height (less body roll).
      const lift = ((com.x - px) * up.x + (com.y - py) * up.y + (com.z - pz) * up.z) * h.traction.forceHeight;
      const ix = (tireOut.fLong * fx + tireOut.fLat * lx) * dt;
      const iy = (tireOut.fLong * fy + tireOut.fLat * ly) * dt;
      const iz = (tireOut.fLong * fz + tireOut.fLat * lz) * dt;
      body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px + up.x * lift, y: py + up.y * lift, z: pz + up.z * lift }, true);

      // Wheel rolling angle: locked by the handbrake, spinning when the tyre lets go.
      let wv = tmpTire.vLong;
      if (hb && !w.front) wv = 0;
      else if (tireOut.spinning) wv += Math.sign(tmpTire.driveForce) * 14;
      w.roll = (w.roll + (wv / w.rad) * dt) % (Math.PI * 2);
    }

    // Air drag and downforce.
    const dragK = d.drag * speed * dt * h.mass;
    const dfK = h.assists.downforce * speed * speed * dt * h.mass;
    body.applyImpulse({ x: -lv.x * dragK - up.x * dfK, y: -lv.y * dragK - up.y * dfK, z: -lv.z * dragK - up.z * dfK }, true);

    // Yaw assist while sliding.
    if (grounded > 0) {
      const yawRate = av.x * up.x + av.y * up.y + av.z * up.z;
      const slide = vF > 1 ? Math.atan2(vL, vF) : 0;
      const aa = driftAssistAccel(input.steer, yawRate, this.travelTurn, slide, speed, hb, h.assists);
      if (donut > 0 && speed > 1) {
        const wt = donutYawTarget(input.steer, speed, h.assists);
        const yr = av.x * up.x + av.y * up.y + av.z * up.z;
        const wc = donutTurnRate(wt, yr, Math.atan2(vL, vF), h.assists);
        const ca = wc * speed * donut * h.mass * dt;
        body.applyImpulse({ x: (lv.z / speed) * ca, y: 0, z: (-lv.x / speed) * ca }, true);
      }
      let yawAcc = aa * (1 - donut) * assistK;
      if (donut > 0) yawAcc += donutYawAccel(yawRate, donutYawTarget(input.steer, speed, h.assists)) * donut;
      if (yawAcc !== 0) {
        const ti = this.yawInertia * yawAcc * dt;
        body.applyTorqueImpulse({ x: up.x * ti, y: up.y * ti, z: up.z * ti }, true);
      }
    }
  }

  /** Per-wheel state for the snapshot. */
  wheelState(i: number): WheelState {
    return this.wheels[i];
  }
}
