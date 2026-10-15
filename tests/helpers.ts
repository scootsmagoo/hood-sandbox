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
  // The physics tests want the old bare world: an empty car, nobody else about.
  return Simulation.create({ seed: 1, tile, vehicleType, driver: false, parkedCars: 0 });
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

import type { RoadData } from '../src/shared/tile';
import type { SimEvent } from '../src/shared/protocol';

/** An idle bystander standing at (x, z) on the flat ground, facing `yaw`. */
export function addNpc(sim: Simulation, x: number, z: number, yaw = 0, mood?: 'flee' | 'fight'): PedEntity {
  const p = sim.addPed(x, 0, z, yaw, 2, true);
  p.brain!.enter('idle');
  if (mood) (p.brain!.personality as { reaction: string }).reaction = mood;
  return p;
}

/** A grid of two-way streets every 300 m out to 600 m, each block side its own road so the ends meet. */
export function gridRoads(): RoadData[] {
  const out: RoadData[] = [];
  const xs = [-600, -300, 0, 300, 600];
  const mk = (id: string, a: [number, number], b: [number, number]): RoadData => ({
    id, class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[a[0], 0, a[1]], [b[0], 0, b[1]]],
  });
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < xs.length - 1; j++) {
      out.push(mk(`h${i}-${j}`, [xs[j], xs[i]], [xs[j + 1], xs[i]]));
      out.push(mk(`v${i}-${j}`, [xs[i], xs[j]], [xs[i], xs[j + 1]]));
    }
  }
  return out;
}

/** The empty flat tile with the street grid. */
export function gridTile(): TileData {
  return { ...flatTile(), roads: gridRoads() };
}

/** Runs ticks and returns every event they produced. */
export function runLog(sim: Simulation, ticks: number, c: InputCommand | (() => InputCommand) = () => cmd()): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.pushInput(1, typeof c === 'function' ? c() : { ...c, tick: ++cmdTick });
    sim.step();
    out.push(...sim.drainEvents());
  }
  return out;
}

export const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T) => events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Every witness calls, 3 to 8 s after the crime: the old, simple rules, for tests about something other than who calls and when. */
export function everyoneCalls(sim: Simulation): Simulation {
  const r = sim.law.rules;
  r.callChance = r.heardCallChance = r.victimCallChance = 1;
  r.callDelayS = [3, 8];
  return sim;
}
