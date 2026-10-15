/**
 * Measuring a car: traces of a run (speed, yaw rate, slide angle, lateral g from the velocity change,
 * body roll and pitch), test tiles with a wall or a kerb, and the speed-holding driver the handling
 * envelopes use.
 */
import { propsToMesh, type PropSpec } from '../src/shared/proceduralTile';
import type { TileData } from '../src/shared/tile';
import { rotateVec } from '../src/shared/math';
import type { RaycastCar } from '../src/sim/vehicles/RaycastCar';
import { cmd, driverSim, flatTile, run, telemetry } from './helpers';

export type Driver = Awaited<ReturnType<typeof driverSim>>;
type Cmd = Parameters<typeof cmd>[0];
export const R2D = 180 / Math.PI;

/** Roll and pitch of the body, degrees (roll positive with the left side up, pitch positive nose up). */
export function attitude(car: RaycastCar): { roll: number; pitch: number } {
  const q = car.body.rotation();
  const f = rotateVec(q, 0, 0, 1);
  const l = rotateVec(q, 1, 0, 0);
  return { pitch: Math.asin(Math.max(-1, Math.min(1, f.y))) * R2D, roll: Math.asin(Math.max(-1, Math.min(1, l.y))) * R2D };
}

export interface Sample {
  t: number;
  speed: number;
  forward: number;
  yaw: number;
  yawRate: number;
  /** Direction of travel relative to the nose, degrees, positive travelling left of it. */
  slide: number;
  /** Lateral acceleration from the change of velocity, g. */
  latG: number;
  /** Longitudinal acceleration along the velocity, g (negative braking). */
  longG: number;
  roll: number;
  pitch: number;
  upY: number;
  steerDeg: number;
  x: number;
  z: number;
}

/** Runs `ticks` of a command (or a command per tick) and records the car each tick. */
export function trace(d: Driver, ticks: number, c: Cmd | ((i: number) => ReturnType<typeof cmd>)): Sample[] {
  const out: Sample[] = [];
  const v0 = d.car.body.linvel();
  let px = v0.x;
  let pz = v0.z;
  for (let i = 0; i < ticks; i++) {
    run(d.sim, 1, typeof c === 'function' ? c(i) : cmd(c));
    const v = d.car.body.linvel();
    const ax = (v.x - px) * 60;
    const az = (v.z - pz) * 60;
    const sp = Math.hypot(v.x, v.z) || 1;
    px = v.x;
    pz = v.z;
    const tl = telemetry(d.car);
    const a = attitude(d.car);
    const p = d.car.pose();
    out.push({
      t: i / 60, speed: tl.speed, forward: tl.forward, yaw: d.car.yaw, yawRate: tl.yawRate, slide: tl.slideDeg,
      latG: Math.abs(ax * (v.z / sp) - az * (v.x / sp)) / 9.81, longG: (ax * (v.x / sp) + az * (v.z / sp)) / 9.81,
      roll: a.roll, pitch: a.pitch, upY: tl.upY, steerDeg: tl.steerDeg, x: p.x, z: p.z,
    });
  }
  return out;
}

export const max = (a: Sample[], f: (s: Sample) => number) => Math.max(...a.map(f));
export const min = (a: Sample[], f: (s: Sample) => number) => Math.min(...a.map(f));
export const mean = (a: Sample[], f: (s: Sample) => number) => a.reduce((s, x) => s + f(x), 0) / a.length;

/** Gets up to `speed` (m/s) on a straight line from the south end of the flat tile. */
export async function atSpeed(type: string, speed: number): Promise<Driver> {
  const d = await driverSim(type);
  for (let i = 0; i < 60 * 40 && d.car.speedForward < speed; i++) run(d.sim, 1, cmd({ axes: { Throttle: 1 } }));
  return d;
}

/** A driver that holds `speed` with the throttle (never above `maxThrottle`) and the wheel at `steer`. */
export const holding = (d: Driver, speed: number, steer: number, maxThrottle = 1) => () =>
  cmd({ axes: { Throttle: Math.max(0, Math.min(maxThrottle, (speed - d.car.speedForward) * 0.6)), Steer: steer } });

/** Heading change from `a` to `b` (radians), wrapped to (-PI, PI]. */
export const turned = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** The flat test ground with some boxes and wedges on it (walls, kerbs). */
export function tileWith(props: PropSpec[]): TileData {
  const t = flatTile();
  const m = propsToMesh(props);
  return {
    ...t,
    collisionPositions: new Float32Array(m.positions),
    collisionIndices: new Uint32Array(m.indices),
    manifest: { ...t.manifest, collision: { file: 'collision.bin', vertexCount: m.positions.length / 3, indexCount: m.indices.length } },
  };
}

export const box = (x: number, z: number, sx: number, sy: number, sz: number): PropSpec => ({ kind: 'box', x, y: 0, z, sx, sy, sz, yaw: 0, color: [0.5, 0.5, 0.5] });
