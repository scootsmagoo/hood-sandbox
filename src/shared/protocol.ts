/**
 * The wire protocol between the presentation (main thread) and the simulation (worker, or later a
 * server). Everything here is plain data and travels through postMessage, a WebSocket or a
 * function call unchanged.
 */
import type { EntityDef } from './entityDefs';
import type { EntityId } from './entities';
import type { CrimeId } from './law';
import type { TileManifest } from './tile';
import type { WeaponId } from './weapons';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

/** Button bits in `InputCommand.buttons`. These are levels: the sim finds the edges. */
export const Button = {
  Jump: 1 << 0,
  Sprint: 1 << 1,
  /** Enter or leave a vehicle, or carjack at a driver's door (and, later, every other "use"). */
  Interact: 1 << 2,
  Handbrake: 1 << 3,
  /** Stand the vehicle back on its wheels. */
  Reset: 1 << 4,
  Horn: 1 << 5,
  /** On foot: throw a punch. */
  Melee: 1 << 6,
  /** Hold the gun up (right mouse, left trigger, the touch aim button). Firing also raises it. */
  Aim: 1 << 7,
  /** Pull the trigger. */
  Fire: 1 << 8,
  Reload: 1 << 9,
  /** Take cover at a wall in reach, or leave it. */
  Cover: 1 << 10,
  WeaponNext: 1 << 11,
  WeaponPrev: 1 << 12,
  /** Draw the weapon in slot 1 to 4 (the order of weapons.json). */
  Slot1: 1 << 13,
  Slot2: 1 << 14,
  Slot3: 1 << 15,
  Slot4: 1 << 16,
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
  /** How strongly the shot is bent toward a threat near the crosshair, 0 to 1: the device decides (mouse low, gamepad and touch high). */
  AimAssist: 8,
} as const;
export const AXIS_COUNT = 9;

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
  | { type: 'entity:respawn'; tick: number; id: EntityId; reason: 'out-of-world' }
  /** An entity came to exist. Carries its definition (see shared/entityDefs.ts). */
  | { type: 'entity:spawn'; tick: number; def: EntityDef }
  | { type: 'entity:despawn'; tick: number; id: EntityId }
  /**
   * A ped started pulling the driver out of a car. This is the crime the law and heat system
   * listens for; `reaction` is how the victim will respond, rolled from their personality.
   */
  | { type: 'carjack'; tick: number; pedId: EntityId; victimId: EntityId; vehicleId: EntityId; x: number; y: number; z: number; reaction: 'flee' | 'fight' }
  /** A ped landed a blow (the player's or an NPC's). */
  | { type: 'ped:attack'; tick: number; pedId: EntityId; targetId: EntityId; damage: number }
  /** A ped started a punch (hit or miss). */
  | { type: 'melee:swing'; tick: number; pedId: EntityId }
  /** Something hurt a ped. `sourceId` is the ped responsible (0 for a fall); for `vehicle`, `vehicleId` is the car. */
  | { type: 'damage'; tick: number; sourceId: EntityId; targetId: EntityId; amount: number; kind: DamageKind; health: number; armour: number; fatal: boolean; x: number; y: number; z: number; vehicleId?: EntityId }
  /** A ped was knocked to the ground (alive). */
  | { type: 'ped:down'; tick: number; pedId: EntityId; seconds: number }
  /** A downed ped got back up. */
  | { type: 'ped:up'; tick: number; pedId: EntityId }
  | { type: 'ped:dead'; tick: number; pedId: EntityId; sourceId: EntityId; kind: DamageKind; x: number; y: number; z: number }
  /** A car's body or engine took damage. `body` and `engine` are the health left. */
  | { type: 'vehicle:damage'; tick: number; vehicleId: EntityId; amount: number; body: number; engine: number; sourceId: EntityId }
  /** The engine dropped below the smoking threshold. */
  | { type: 'vehicle:smoke'; tick: number; vehicleId: EntityId }
  | { type: 'vehicle:engine-dead'; tick: number; vehicleId: EntityId }
  | { type: 'vehicle:fire'; tick: number; vehicleId: EntityId }
  /** The stand-in explosion: a flash, and the car is burnt out and disabled for good. */
  | { type: 'vehicle:explode'; tick: number; vehicleId: EntityId; x: number; y: number; z: number }
  /** A crime was committed (before anyone reports it). */
  | { type: 'crime'; tick: number; crime: CrimeId; severity: number; heat: number; x: number; y: number; z: number; perpetratorId: EntityId; victimId: EntityId; vehicleId: EntityId; witnesses: number; /** How many of the witnesses only heard it (gunfire). */ heard?: number; description: CrimeDescription }
  /** A witness called it in, or police saw it. */
  | { type: 'crime:reported'; tick: number; crime: CrimeId; reporterId: EntityId; police: boolean; x: number; z: number }
  /** A witness who was going to call was knocked down or killed first. */
  | { type: 'witness:silenced'; tick: number; pedId: EntityId; crime: CrimeId }
  /** The heat level or its phase changed. `phase`: none, reported (hollow stars), seen (solid), lost (flashing). */
  | { type: 'heat:change'; tick: number; level: number; prevLevel: number; phase: HeatPhaseName; prevPhase: HeatPhaseName; reason: 'crime' | 'sighting' | 'lost' | 'cooldown' | 'busted' | 'wasted'; lastKnown: { x: number; z: number } | null }
  | { type: 'police:spawn'; tick: number; vehicleId: EntityId; officerIds: EntityId[]; agency: string }
  /** A police car took a role in the chase (the first time, and whenever it changes). */
  | { type: 'police:role'; tick: number; vehicleId: EntityId; role: 'responder' | 'chaser' | 'flanker' | 'blocker'; agency: string }
  /** A PIT: `attempt` when the unit commits to the strike, `hit` when the target's car has been turned, `abort` when it gives up. */
  | { type: 'police:pit'; tick: number; vehicleId: EntityId; targetId: EntityId; phase: 'attempt' | 'hit' | 'abort' }
  /** A police car rammed the target. */
  | { type: 'police:ram'; tick: number; vehicleId: EntityId; targetId: EntityId }
  /** A roadblock was laid across the road ahead of the target; `gap` is the opening left to thread, or 0. */
  | { type: 'police:roadblock'; tick: number; id: number; x: number; z: number; cars: number; gap: number; agency: string }
  | { type: 'police:roadblock-clear'; tick: number; id: number; reason: 'passed' | 'expired' | 'stand-down' }
  /** A spike strip was laid across a lane, and later picked up. */
  | { type: 'police:spikes'; tick: number; id: EntityId; x: number; z: number; yaw: number; length: number }
  | { type: 'police:spikes-clear'; tick: number; id: EntityId; used: boolean }
  /** A helicopter joined the search, saw the target (`sees`), lost it, or left. */
  | { type: 'police:helicopter'; tick: number; heliId: EntityId; state: 'inbound' | 'sees' | 'lost' | 'leaving' }
  /** An officer fired at the player through the weapons API (the `weapon:fire` event carries the bullets). */
  | { type: 'police:fire'; tick: number; officerId: EntityId; weapon: string; x: number; y: number; z: number; dx: number; dy: number; dz: number; targetId: EntityId; passenger: boolean }
  /** Units stood down and are leaving. */
  | { type: 'police:stand-down'; tick: number }
  /** An officer got out to chase on foot. */
  | { type: 'police:dismount'; tick: number; pedId: EntityId; vehicleId: EntityId }
  /** An ambient pedestrian reacted to something (the audio and the tests listen): ran, cowered, got a phone out, stared, jumped back. */
  | { type: 'ped:react'; tick: number; pedId: EntityId; reaction: PedReaction; cause: PedCause; x: number; z: number }
  /** A traffic driver leans on the horn (a car blocks the road, a pedestrian will not move). */
  | { type: 'traffic:honk'; tick: number; vehicleId: EntityId; x: number; z: number }
  /** A traffic driver reacted: braked hard, swerved, pulled over for the police or fled danger. */
  | { type: 'traffic:react'; tick: number; vehicleId: EntityId; reaction: 'brake' | 'swerve' | 'pullover' | 'flee'; x: number; z: number }
  /**
   * A shot was fired. (x, y, z) is the muzzle, (dx, dy, dz) the unit direction of the shot before spread, and `impacts` one entry per
   * bullet (the shotgun's pellets are separate). The client draws the tracers, the flash and the puffs from it; the law hears it.
   */
  | { type: 'weapon:fire'; tick: number; shooterId: EntityId; weapon: WeaponId; x: number; y: number; z: number; dx: number; dy: number; dz: number; impacts: BulletImpact[] }
  /** The trigger was pulled on an empty magazine. */
  | { type: 'weapon:empty'; tick: number; pedId: EntityId; weapon: WeaponId }
  | { type: 'weapon:reload'; tick: number; pedId: EntityId; weapon: WeaponId; durationS: number }
  | { type: 'weapon:reloaded'; tick: number; pedId: EntityId; weapon: WeaponId; mag: number; reserve: number }
  | { type: 'weapon:switch'; tick: number; pedId: EntityId; weapon: WeaponId }
  /** A bullet shot a tyre out (wheel 0 and 1 are the front pair, left then right; 2 and 3 the rear). */
  | { type: 'vehicle:tyre'; tick: number; vehicleId: EntityId; wheel: number; shooterId: EntityId }
  | { type: 'cover:enter'; tick: number; pedId: EntityId; low: boolean; x: number; z: number; nx: number; nz: number }
  | { type: 'cover:exit'; tick: number; pedId: EntityId }
  | { type: 'player:wasted'; tick: number; pedId: EntityId; x: number; y: number; z: number }
  | { type: 'player:busted'; tick: number; pedId: EntityId; officerId: EntityId }
  | { type: 'player:respawn'; tick: number; pedId: EntityId; reason: 'wasted' | 'busted'; x: number; y: number; z: number };

export type PedReaction = 'flee' | 'cower' | 'film' | 'look' | 'startle';
export type PedCause = 'violence' | 'carjack' | 'explosion' | 'crash' | 'wreck' | 'car-on-sidewalk' | 'fast-car' | 'gunfire';

/** What a bullet landed on. */
export type HitKind = 'none' | 'world' | 'ped' | 'vehicle';

/** Where one bullet (or shotgun pellet) ended: a hit, or the point at the end of its range for a miss. */
export interface BulletImpact {
  kind: HitKind;
  x: number;
  y: number;
  z: number;
  /** Surface normal at the hit (zero for a miss). */
  nx: number;
  ny: number;
  nz: number;
  /** The ped or vehicle hit, or 0. */
  targetId: EntityId;
  headshot: boolean;
}

export type DamageKind = 'melee' | 'vehicle' | 'fall' | 'explosion' | 'fire' | 'bullet';
export type HeatPhaseName = 'none' | 'reported' | 'seen' | 'lost';

/** What the police know about the culprit. Each part can be cleared on its own later. */
export interface CrimeDescription {
  vehicle: { id: EntityId; typeId: string; plate: string; color: number } | null;
  /** Index into the outfit table, or -1 when nobody saw the clothes. */
  clothes: number;
  face: boolean;
  cctv: boolean;
}

export interface SimInit {
  seed: number;
  /** Where to find `tile.json`, e.g. `/tiles/atlanta/m1-five-points/`. Null or a failed load uses the procedural test ground. */
  tileBaseUrl: string | null;
  /** When set the sim writes snapshots here (a `SnapshotRing`) instead of posting them. */
  snapshotBuffer?: SharedArrayBuffer;
  /** Key into the handling table for the starting car (`sedan` when absent). */
  vehicleType?: string;
  /**
   * Where the player starts. `spawn` (the default): on the sidewalk at the tile's player spawn,
   * with the parked car occupied. `car`: beside an empty car's driver door. `jack`: beside the
   * driver's door of the occupied car.
   */
  start?: 'spawn' | 'car' | 'jack';
  /** Legacy alias for `start: 'car'`. */
  startAtVehicle?: boolean;
  /** Forces how the first carjack victim reacts. Left out, it is a seeded roll. */
  driverMood?: 'flee' | 'fight';
  /** How many empty cars to park along nearby curbs (default 6). */
  parkedCars?: number;
  /** Idle pedestrians to stand about on nearby sidewalks (default 0): witnesses, and something to punch or run over. */
  bystanders?: number;
  /** Starting armour for the player, 0 to 100 (default 0). */
  armour?: number;
  /** What the player starts with: `default` (a pistol and some rounds), `all` (every weapon) or `none`. `?weapons=` in the URL. */
  weapons?: 'default' | 'all' | 'none';
  /** Ambient pedestrians from the tile's walk network and the city's population table (default on; `?ambient=0` turns them off). */
  ambientPeds?: boolean;
  /** Most ambient pedestrians at once (the graphics tier sets it: 60 on High). */
  pedBudget?: number;
  /** Ambient traffic density, 0 to 1 (the graphics tier sets it: 1 on High, 0.5 on Low). 0 or left out: none. */
  traffic?: number;
  /** Game clock start and pace (`?time=`, `?day=`, `?timescale=`). Left out: Wednesday 14:00 at 0.5 game minutes per second. */
  clock?: { minutes?: number; day?: number; scale?: number };
  /** Run the clock by itself. Tests turn this off and call `advance`. */
  autoRun: boolean;
}

export interface SimReady {
  tile: TileManifest;
  tileSource: 'baked' | 'procedural';
  /** Why the baked tile was not used, when it was not. */
  fallbackReason?: string;
  playerId: EntityId;
  /** The car the player starts next to. */
  vehicleId: EntityId;
  vehicleType: string;
  /** Definitions of every entity that exists now; later ones arrive as `entity:spawn` events. */
  entities: EntityDef[];
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
  /** Settings that can change while the sim runs (the graphics tier steps down). */
  | { type: 'config'; pedBudget?: number; traffic?: number }
  | { type: 'stop' };

export type FromSim =
  | { type: 'ready'; info: SimReady }
  | { type: 'snapshot'; buffer: ArrayBuffer }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'stats'; stats: SimStats }
  | { type: 'error'; message: string };
