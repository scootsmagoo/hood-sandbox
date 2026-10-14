import { generateProceduralTile } from '../src/shared/proceduralTile';
import type { TileData } from '../src/shared/tile';
import { Simulation } from '../src/sim/Simulation';
import { AXIS_COUNT, Axis, Button, type InputCommand } from '../src/shared/protocol';
import type { VehicleEntity, PedEntity } from '../src/sim/entities';

/** The procedural tile without any buildings, ramps or walls: empty flat ground. */
export function flatTile(): TileData {
  const t = generateProceduralTile(1);
  return {
    ...t,
    collisionPositions: new Float32Array(0),
    collisionIndices: new Uint32Array(0),
    manifest: { ...t.manifest, collision: { file: 'collision.bin', vertexCount: 0, indexCount: 0 } },
  };
}

export async function makeSim(tile: TileData = flatTile(), vehicleType = 'sedan') {
  return Simulation.create({ seed: 1, tile, vehicleType });
}

let cmdTick = 0;
export function cmd(over: { buttons?: number; axes?: Partial<Record<keyof typeof Axis, number>> } = {}): InputCommand {
  const axes = new Array<number>(AXIS_COUNT).fill(0);
  for (const [k, v] of Object.entries(over.axes ?? {})) axes[Axis[k as keyof typeof Axis]] = v as number;
  return { tick: ++cmdTick, buttons: over.buttons ?? 0, axes };
}

export function run(sim: Simulation, ticks: number, c: InputCommand | (() => InputCommand)) {
  for (let i = 0; i < ticks; i++) {
    sim.pushInput(1, typeof c === 'function' ? c() : { ...c, tick: ++cmdTick });
    sim.step();
  }
}

export const vehicle = (sim: Simulation) => sim.registry.get(sim.vehicleId) as VehicleEntity;
export const ped = (sim: Simulation) => sim.registry.get(sim.playerPedId) as PedEntity;
export { Axis, Button };

import { rotateVec } from '../src/shared/math';

/** A sim with the player already in the car, parked at the south end of the flat tile facing north. */
export async function driverSim(type = 'sedan', tile: TileData = flatTile(), at = { x: 0, z: 900 }) {
  const sim = await makeSim(tile, type);
  const car = vehicle(sim).car;
  car.teleport(at.x, 0.4, at.z, Math.PI);
  run(sim, 30, cmd());
  ped(sim).controller.teleport(at.x - 2, 0, at.z);
  run(sim, 5, cmd());
  run(sim, 2, cmd({ buttons: Button.Interact }));
  run(sim, 2, cmd());
  if (ped(sim).vehicleId !== sim.vehicleId) throw new Error('could not get into the car');
  return { sim, car };
}

export interface CarTelemetry {
  speed: number;
  forward: number;
  yawRate: number;
  /** Direction of travel relative to the nose, degrees; positive travelling to the left of the nose. */
  slideDeg: number;
  upY: number;
  steerDeg: number;
}

export function telemetry(car: import('../src/sim/vehicles/RaycastCar').RaycastCar): CarTelemetry {
  const q = car.body.rotation();
  const up = rotateVec(q, 0, 1, 0);
  const left = rotateVec(q, 1, 0, 0);
  const lv = car.body.linvel();
  const av = car.body.angvel();
  const vL = lv.x * left.x + lv.y * left.y + lv.z * left.z;
  return {
    speed: car.speed,
    forward: car.speedForward,
    yawRate: av.x * up.x + av.y * up.y + av.z * up.z,
    slideDeg: (Math.atan2(vL, car.speedForward) * 180) / Math.PI,
    upY: up.y,
    steerDeg: (car.steerAngle * 180) / Math.PI,
  };
}
