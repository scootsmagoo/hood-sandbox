/**
 * A raycast car on a Rapier rigid body. The chassis is a dynamic body with two convex hulls (the
 * body with a raked nose, and a cabin with a sloped windscreen and roof edges, for rolling over and
 * for people going over the bonnet); the wheels are not bodies at all, only rays cast down from the
 * suspension hardpoints. Each tick the car turns what the rays see into spring, tyre and drag
 * impulses on the chassis (the maths is in dynamics.ts), and Rapier integrates the result with the
 * world. docs/physics.md has the model and the tuning guide.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { DEG, G, clamp, rotateVec, yawOfQuat, type Quat } from '../../shared/math';
import type { HandlingData } from '../../shared/handling';
import { GROUPS } from '../physics/rapier';
import {
  burnoutHold,
  burnoutWanted,
  driverLock,
  engineAccel,
  lowSpeedGrip,
  newTireOutput,
  nominalLoad,
  resolvePedals,
  selfAlignAngle,
  slewSteer,
  steerLock,
  suspensionAccel,
  tireForce,
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

/** The body's collision material: a crash should feel heavy, with a little bounce and some scrub. */
export const BODY = {
  /** Coefficient of restitution with the max rule (a wall or a car), and friction. */
  restitution: 0.32,
  /** (the lower of this and what it touches: a belly scraping the road or a flank against a wall slides) */
  friction: 0.4,
  /** How far below the top of the travel the bump stop starts, m. */
  bumpStop: 0.04,
} as const;

/**
 * Tripping: a wheel sliding sideways into a step (a kerb) stops dead at the bottom while the mass
 * above carries on, which is how most real rollovers start. The rays alone would simply climb the
 * step, so each wheel sliding sideways faster than `minSpeed` looks a little way ahead at `height`
 * above the road; a near-vertical face there takes `share` of the wheel's sideways momentum out
 * at that low point.
 */
export const TRIP = { minSpeed: 2.2, height: 0.09, share: 0.75 } as const;

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
  /** Mass share carried, kg, and its weight, N. */
  share: number;
  nominal: number;
  /** Normal load this step, N. */
  load: number;
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
  vLong: 0, vLat: 0, load: 0, nominal: 0, mass: 0, dt: 0, driveForce: 0, brakeForce: 0, locked: false, gripMult: 1, lateralMult: 1,
};
const tireOut = newTireOutput();
const pedals: DriveRequest = { drive: 0, brake: 0, reversing: false };

/** The points of the body hull: a box whose front and rear top edges are chamfered (a bonnet and a boot that slope away). */
function bodyHull(half: readonly number[], off: readonly number[]): Float32Array {
  const [hx, hy, hz] = half;
  const [ox, oy, oz] = off;
  const pts: number[] = [];
  const add = (x: number, y: number, z: number) => pts.push(ox + x, oy + y, oz + z);
  for (const sx of [-1, 1]) {
    // The floor, a little above the box's bottom, with approach and departure angles cut under the bumpers so a crest or a
    // dip scrapes rather than catches.
    const floor = -hy + 0.05;
    add(sx * hx, floor, hz - 0.3);
    add(sx * hx, floor, -hz + 0.25);
    add(sx * hx, floor + 0.14, hz);
    add(sx * hx, floor + 0.12, -hz);
    // The bumper faces lean back a touch toward the top: what they hit is pushed forward and a little up (a pedestrian's legs
    // are taken, a planter or a bench does not become a ramp the car climbs).
    add(sx * hx, hy * 0.3, hz - 0.06);
    add(sx * hx, hy * 0.25, -hz + 0.06);
    // the top: the bonnet's front edge rounded back and down
    add(sx * hx * 0.96, hy, hz - 0.28);
    add(sx * hx * 0.96, hy, -hz + 0.18);
  }
  return new Float32Array(pts);
}

/** The cabin hull: a raked windscreen, a rear window, and a roof narrower than the waist. */
function cabinHull(half: readonly number[], off: readonly number[]): Float32Array {
  const [hx, hy, hz] = half;
  const [ox, oy, oz] = off;
  const pts: number[] = [];
  const add = (x: number, y: number, z: number) => pts.push(ox + x, oy + y, oz + z);
  for (const sx of [-1, 1]) {
    add(sx * hx, -hy, hz + 0.25);
    add(sx * hx, -hy, -hz - 0.1);
    add(sx * hx * 0.84, hy, hz - Math.min(0.5, hz * 0.45));
    add(sx * hx * 0.84, hy, -hz + Math.min(0.25, hz * 0.25));
  }
  return new Float32Array(pts);
}

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
  /** A burnout is on (throttle with the brake, nearly stopped). */
  burnout = false;
  /** Seconds left in which the tail is let go after a PIT (see `pitKick`). */
  private slideT = 0;
  private readonly yawInertia: number;
  private ray: RAPIER.Ray;
  private prevVel = { x: 0, y: 0, z: 0 };
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
        // Soft CCD (contacts predicted a step ahead) rather than hard CCD: hard CCD clamps the car's motion against anything it
        // would touch, a ragdoll included, which stops the car dead for a step and squeezes the body out like a pip.
        .setSoftCcdPrediction(1.2)
        .setAngularDamping(0.08)
        .setLinearDamping(0)
        .setCanSleep(false),
    );
    this.body = body;

    const c = h.chassis;
    const mk = (pts: Float32Array, half: readonly number[], off: readonly number[]) =>
      (R.ColliderDesc.convexHull(pts) ?? R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(off[0], off[1], off[2]))
        .setDensity(0)
        .setFriction(BODY.friction)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(BODY.restitution)
        .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
        .setCollisionGroups(GROUPS.vehicle);
    world.createCollider(mk(bodyHull(c.halfExtents, c.offset), c.halfExtents, c.offset), body);
    world.createCollider(mk(cabinHull(c.cabin.halfExtents, c.cabin.offset), c.cabin.halfExtents, c.cabin.offset), body);

    const w = c.halfExtents[0] * 2;
    const hh = c.cabin.offset[1] + c.cabin.halfExtents[1] - (c.offset[1] - c.halfExtents[1]);
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
      const share = (front ? frontMass : rearMass) / 2;
      this.wheels.push({
        front,
        mx: (left ? 1 : -1) * track * 0.5,
        my: wb.mountY,
        mz: front ? wb.frontZ : wb.rearZ,
        steer: 0, roll: 0, length: h.suspension.travel, grounded: false, slip: 0,
        flat: 0, flatTarget: 0, rad: wb.radius,
        prevLength: h.suspension.travel,
        share,
        nominal: nominalLoad(share),
        load: 0,
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

  /** Normal load on wheel `i` this step, N (0 in the air). */
  loadOf(i: number): number {
    return this.wheels[i].load;
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
   * A PIT: the nose of a police car has shoved the tail sideways. The contact itself is the physics of
   * two bodies; this adds what a real bumper-on-quarter-panel push does that two boxes do not: `yawRate`
   * (rad/s, positive turns left) of spin, and for `slideS` seconds the rear tyres are past their peak
   * (pushed sideways they slide), so the spin carries on instead of being caught by the next step's grip.
   */
  pitKick(yawRate: number, slideS = 0.9) {
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
    const q: Quat = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    const com = body.worldCom();

    const fwd = rotateVec(q, 0, 0, 1);
    const up = rotateVec(q, 0, 1, 0);
    const left = rotateVec(q, 1, 0, 0);
    const vF = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    this.speed = speed;
    this.speedForward = vF;

    // Impact detector: a sudden velocity change that the tyres cannot explain.
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

    const throttle = clamp(input.throttle, 0, 1);
    const brakePedal = clamp(input.brake, 0, 1);
    const hb = input.handbrake;
    const burnout = burnoutWanted(throttle, brakePedal, hb, vF);
    this.burnout = burnout;
    if (burnout) {
      pedals.drive = throttle;
      pedals.brake = 0;
      pedals.reversing = false;
    } else resolvePedals(throttle, brakePedal, vF, pedals);
    this.reversing = pedals.reversing;
    this.throttleApplied = pedals.drive;
    this.braking = pedals.brake > 0.05 || (burnout && brakePedal > 0.5);
    this.handbraking = hb;
    this.slideT = Math.max(0, this.slideT - dt);

    // Steering: the driver's lock narrows with speed and the rack slows with it; a released wheel trails (caster).
    const fullLock = h.steering.lockDeg * DEG;
    const st = clamp(input.steer, -1, 1);
    const frontLeftVel = lv.x * left.x + lv.y * left.y + lv.z * left.z + h.wheels.frontZ * (av.x * up.x + av.y * up.y + av.z * up.z);
    const travel = vF > 1 ? Math.atan2(frontLeftVel, vF) : 0;
    const lock = driverLock(st, travel, steerLock(speed, h.steering), fullLock);
    const free = (1 - Math.abs(st)) ** 2;
    const target = clamp(-st * lock + selfAlignAngle(frontLeftVel, vF, h.steering.selfAlign, fullLock) * free, -fullLock, fullLock);
    this.steerAngle = slewSteer(this.steerAngle, target, dt, h.steering, speed);
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
      const hit = this.world.castRayAndGetNormal(this.ray, reach, true, undefined, GROUPS.wheelQuery, undefined, body);
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
        w.accel = suspensionAccel(w.length, w.prevLength, dt, rest, omega, sus.bumpDamping, sus.reboundDamping, BODY.bumpStop);
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
        const k = a === 0 ? sus.antiRollFront : sus.antiRollRear;
        const ar = k * (r.length - l.length);
        l.accel = Math.max(0, l.accel + ar);
        r.accel = Math.max(0, r.accel - ar);
      }
    }

    // Pass 2: tyre forces.
    const d = h.drive;
    const accel = engineAccel(pedals.drive, vF, d);
    const throttleOff = Math.abs(pedals.drive) < 0.05;
    // (with the wheel turned the front brakes let go, so the spinning rear swings the car round its front axle: a donut)
    const holdBrake = burnout ? burnoutHold(vF, h.extras) * Math.max(0, 1 - Math.abs(st) * 1.5) : 0;
    const driveBias = d.driveBiasFront;
    this.skidding = false;
    for (const w of this.wheels) {
      w.steer = w.front ? this.steerAngle : 0;
      if (!w.grounded) {
        w.slip = 0;
        w.load = 0;
        continue;
      }
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
      w.load = load;

      const axleDrive = w.front ? driveBias : 1 - driveBias;
      const driven = axleDrive > 0;
      tmpTire.vLong = cvx * fx + cvy * fy + cvz * fz;
      tmpTire.vLat = cvx * lx + cvy * ly + cvz * lz;
      tmpTire.load = load;
      tmpTire.nominal = w.nominal;
      tmpTire.mass = w.share;
      tmpTire.dt = dt;
      tmpTire.driveForce = driven ? (accel * h.mass * axleDrive) / 2 : 0;
      let brake = (pedals.brake * d.brakeForce * h.mass * (w.front ? d.brakeBiasFront : 1 - d.brakeBiasFront)) / 2;
      brake += (d.rolling * h.mass) / 4;
      if (throttleOff && driven) brake += (d.engineBrake * h.mass * axleDrive) / 2;
      if (holdBrake > 0 && w.front) brake += (holdBrake * h.mass) / 2;
      // The handbrake locks the rear wheels (unless the throttle is spinning them against it, a burnout).
      tmpTire.locked = hb && !w.front && !burnout;
      tmpTire.forceSpin = burnout && driven;
      tmpTire.lateralMult = burnout && driven ? lowSpeedGrip(speed, true, h.traction) : 1;
      // After a PIT the tail is past its peak: little lateral grip at the rear until the car has come round.
      if (this.slideT > 0 && !w.front) tmpTire.lateralMult *= 0.35;
      // A flat tyre scrapes the rim (drag) and holds the road less.
      if (w.flat > 0) brake += (FLAT.drag * w.flat * h.mass) / 4;
      tmpTire.brakeForce = brake;
      tmpTire.gripMult = (w.front ? h.traction.frontGrip : h.traction.rearGrip) * (1 - FLAT.gripLoss * w.flat);
      tireForce(tmpTire, h.traction, tireOut);
      // A driven wheel that broke loose at low speed (a launch, a burnout) loses more of its lateral grip.
      if (driven && tireOut.spinning && !burnout && speed < h.traction.lowSpeedLossSpeed) {
        tmpTire.lateralMult *= lowSpeedGrip(speed, true, h.traction);
        tireForce(tmpTire, h.traction, tireOut);
      }
      w.slip = tireOut.slip;
      if (tireOut.slip > 0.6) this.skidding = true;

      // Driving and braking act at the road (the body dives and squats); cornering acts at the roll centre (it rolls about it).
      const rc = w.front ? sus.rollCentreFront : sus.rollCentreRear;
      const lix = tireOut.fLat * lx * dt;
      const liy = tireOut.fLat * ly * dt;
      const liz = tireOut.fLat * lz * dt;
      body.applyImpulseAtPoint({ x: lix, y: liy, z: liz }, { x: px + w.nx * rc, y: py + w.ny * rc, z: pz + w.nz * rc }, true);
      const fix = tireOut.fLong * fx * dt;
      const fiy = tireOut.fLong * fy * dt;
      const fiz = tireOut.fLong * fz * dt;
      body.applyImpulseAtPoint({ x: fix, y: fiy, z: fiz }, { x: px, y: py, z: pz }, true);

      // A wheel sliding sideways into a kerb trips the car.
      if (Math.abs(tmpTire.vLat) > TRIP.minSpeed) this.trip(w, px, py, pz, lx, ly, lz, tmpTire.vLat, dt);

      // Wheel rolling angle: locked by the handbrake, spinning when the tyre lets go.
      let wv = tmpTire.vLong;
      if (tmpTire.locked) wv = 0;
      else if (tireOut.spinning) wv += Math.sign(tmpTire.driveForce || 1) * 14;
      w.roll = (w.roll + (wv / w.rad) * dt) % (Math.PI * 2);
    }

    // Air drag and downforce.
    const dragK = d.drag * speed * dt * h.mass;
    const dfK = h.extras.downforce * speed * speed * dt * h.mass;
    body.applyImpulse({ x: -lv.x * dragK - up.x * dfK, y: -lv.y * dragK - up.y * dfK, z: -lv.z * dragK - up.z * dfK }, true);
  }

  /** See `TRIP`. (lx, ly, lz) is the wheel's left axis on the ground plane; `vLat` the contact's velocity along it. */
  private trip(w: Wheel, px: number, py: number, pz: number, lx: number, ly: number, lz: number, vLat: number, dt: number) {
    const dir = Math.sign(vLat);
    const ray = this.ray;
    ray.origin.x = px + w.nx * TRIP.height;
    ray.origin.y = py + w.ny * TRIP.height;
    ray.origin.z = pz + w.nz * TRIP.height;
    ray.dir.x = lx * dir;
    ray.dir.y = ly * dir;
    ray.dir.z = lz * dir;
    const reach = this.h.wheels.width * 0.5 + Math.abs(vLat) * dt + 0.04;
    const hit = this.world.castRayAndGetNormal(ray, reach, true, undefined, GROUPS.cameraQuery, undefined, this.body);
    if (!hit) return;
    const n = hit.normal;
    if (Math.abs(n.x * w.nx + n.y * w.ny + n.z * w.nz) > 0.6) return;
    const j = -vLat * w.share * 2 * TRIP.share;
    const t = hit.timeOfImpact;
    this.body.applyImpulseAtPoint({ x: lx * j, y: ly * j, z: lz * j }, { x: ray.origin.x + ray.dir.x * t, y: ray.origin.y + ray.dir.y * t, z: ray.origin.z + ray.dir.z * t }, true);
  }

  /** Per-wheel state for the snapshot. */
  wheelState(i: number): WheelState {
    return this.wheels[i];
  }

  /** Where the body origin sits above flat ground when the car is at rest on its suspension. */
  static restHeight(h: HandlingData): number {
    const sus = h.suspension;
    const omega = 2 * Math.PI * sus.frequencyHz;
    const len = Math.max(BODY.bumpStop, sus.travel * sus.restRatio - G / (omega * omega));
    return h.wheels.radius + len - h.wheels.mountY;
  }
}

/** Yaw rate (rad/s, about the body's up axis) and the slide angle (radians, positive travelling left of the nose) of a car. */
export function yawAndSlide(car: RaycastCar): { yawRate: number; slide: number } {
  const q = car.body.rotation();
  const up = rotateVec(q, 0, 1, 0);
  const left = rotateVec(q, 1, 0, 0);
  const lv = car.body.linvel();
  const av = car.body.angvel();
  const vL = lv.x * left.x + lv.y * left.y + lv.z * left.z;
  return { yawRate: av.x * up.x + av.y * up.y + av.z * up.z, slide: car.speedForward > 1 ? Math.atan2(vL, car.speedForward) : 0 };
}

