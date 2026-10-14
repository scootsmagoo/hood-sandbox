/**
 * The wire protocol between the presentation (main thread) and the simulation (worker, or later a
 * server). Everything here is plain data and travels through postMessage, a WebSocket or a
 * function call unchanged.
 */
import type { EntityId } from './entities';
import type { TileManifest } from './tile';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

/** Button bits in `InputCommand.buttons`. These are levels: the sim finds the edges. */
export const Button = {
  Jump: 1 << 0,
  Sprint: 1 << 1,
  /** Enter or leave a vehicle (and, later, every other "use"). */
  Interact: 1 << 2,
  Handbrake: 1 << 3,
  /** Stand the vehicle back on its wheels. */
  Reset: 1 << 4,
  Horn: 1 << 5,
} as const;

/** Indices into `InputCommand.axes`. */
export const Axis = {
  /** On foot, camera-relative strafe: +1 is right. */
  MoveX: 0,
  /** On foot, camera-relative: +1 is forward. */
  MoveY: 1,
  /** Camera yaw (rotation.y). Movement is camera-relative, and the camera arm is probed from it. */
  Yaw: 2,
  /** Camera pitch (rotation.x, negative looks down). */
  Pitch: 3,
  /** In a vehicle: 0 to 1. */
  Throttle: 4,
  /** In a vehicle: 0 to 1. Brakes, then reverses once stopped. */
  Brake: 5,
  /** In a vehicle: -1 left to +1 right. */
  Steer: 6,
  /** Wanted distance of the camera arm, so the sim can report how much of it is clear. */
  CamDist: 7,
} as const;
export const AXIS_COUNT = 8;

export interface InputCommand {
  /** Counts up with every command the sender makes. The sim drops older ones and reports the newest it applied (`ack`), which measures latency. */
  tick: number;
  buttons: number;
  axes: number[];
}

export function emptyCommand(tick = 0): InputCommand {
  return { tick, buttons: 0, axes: new Array<number>(AXIS_COUNT).fill(0) };
}

export type SimEvent =
  | { type: 'vehicle:enter'; tick: number; pedId: EntityId; vehicleId: EntityId }
  | { type: 'vehicle:exit'; tick: number; pedId: EntityId; vehicleId: EntityId }
  | { type: 'vehicle:exit-denied'; tick: number; vehicleId: EntityId; reason: 'too-fast' }
  | { type: 'vehicle:impact'; tick: number; vehicleId: EntityId; strength: number }
  | { type: 'vehicle:reset'; tick: number; vehicleId: EntityId }
  | { type: 'entity:respawn'; tick: number; id: EntityId; reason: 'out-of-world' };

export interface SimInit {
  seed: number;
  /** Where to find `tile.json`, e.g. `/tiles/atlanta/m1-five-points/`. Null or a failed load uses the procedural test ground. */
  tileBaseUrl: string | null;
  /** When set the sim writes snapshots here (a `SnapshotRing`) instead of posting them. */
  snapshotBuffer?: SharedArrayBuffer;
  /** Key into the handling table (`sedan` when absent). */
  vehicleType?: string;
  /** Start the player beside the vehicle. */
  startAtVehicle?: boolean;
  /** Run the clock by itself. Tests turn this off and call `advance`. */
  autoRun: boolean;
}

export interface SimReady {
  tile: TileManifest;
  tileSource: 'baked' | 'procedural';
  /** Why the baked tile was not used, when it was not. */
  fallbackReason?: string;
  playerId: EntityId;
  vehicleId: EntityId;
  vehicleType: string;
  /** True when snapshots come through the shared ring. */
  sharedSnapshots: boolean;
}

export interface SimStats {
  tick: number;
  /** Mean wall time of one sim step over the last second, in ms. */
  stepMs: number;
  /** Worst step in the last second, in ms. */
  stepMaxMs: number;
}

export type ToSim =
  | { type: 'init'; init: SimInit }
  | { type: 'input'; cmd: InputCommand }
  | { type: 'stop' };

export type FromSim =
  | { type: 'ready'; info: SimReady }
  | { type: 'snapshot'; buffer: ArrayBuffer }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'stats'; stats: SimStats }
  | { type: 'error'; message: string };
