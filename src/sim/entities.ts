import { Authority, EntityKind, type EntityBase, type EntityId } from '../shared/entities';
import type { CoverState, GunState } from './combat/weapons/state';
import type { PedController, PedInput } from './character/PedController';
import type { PedBrain } from './npc/brain';
import type { AmbientState } from './peds/state';
import type { OfficerState } from './police/types';
import type { RaycastCar, VehicleInput } from './vehicles/RaycastCar';
import type { TrafficCar } from './traffic/TrafficManager';

export type PedRole = 'player' | 'civilian' | 'police';
export type PedLife = 'alive' | 'downed' | 'dead';

export const MAX_HEALTH = 100;

export class PedEntity implements EntityBase {
  readonly kind = EntityKind.Ped;
  owner = 0;
  authority: Authority = Authority.Local;
  health = MAX_HEALTH;
  armour = 0;
  role: PedRole = 'civilian';
  life: PedLife = 'alive';
  /** Seconds left on the ground while downed. */
  downT = 0;
  /** Seconds since death. */
  deadT = 0;
  /** The blow in progress (a punch): seconds into it and whether it has landed or missed already. */
  melee: { t: number; resolved: boolean } | null = null;
  /** Seconds before the next punch may start. */
  meleeCool = 0;
  /** Tick of the last damage taken, and who did it (0 for none). */
  lastDamageTick = -1e9;
  lastAttacker = 0;
  /** Fastest downward speed since this ped last stood on the ground, m/s (for fall damage). */
  airVy = 0;
  /** Seconds before a car can hurt this ped again. */
  carHitCool = 0;
  /** An officer's state, for police. */
  officer: OfficerState | null = null;
  /** The vehicle this ped sits in, or 0. */
  vehicleId: EntityId = 0;
  input: PedInput = { moveX: 0, moveY: 0, camYaw: 0, sprint: false, jump: false };
  /** Non-player peds think with a brain; the player's character has none. */
  brain: PedBrain | null = null;
  /** Index into the client's outfit table. */
  outfit = 0;
  /** Set for the pedestrians the ambient director made: their route, what they are doing, whether the player touched them. */
  amb: AmbientState | null = null;
  /** What an idle pedestrian is doing with its body (`PedPose`), for the snapshot. */
  pose = 0;
  /** Under the sim's control for a scripted moment (a carjack): commands are ignored and the body is moved by hand. */
  busy = false;
  /** The weapons this ped carries and the state of the gun in hand; null when unarmed (see combat/weapons/api.ts). */
  gun: GunState | null = null;
  /** The wall this ped is taking cover against, or null. */
  cover: CoverState | null = null;
  /** Seconds left of flinching from a bullet (drawn as a stagger). */
  flinchT = 0;

  constructor(
    readonly id: EntityId,
    readonly controller: PedController,
  ) {}
}

export class VehicleEntity implements EntityBase {
  readonly kind = EntityKind.Vehicle;
  owner = 0;
  authority: Authority = Authority.Local;
  /** Body health. */
  health = 1000;
  /** Engine health: below the smoking threshold it smokes, at zero it dies. */
  engine = 1000;
  readonly maxBody: number;
  readonly maxEngine: number;
  /** Registration plate. */
  plate = '';
  /** Set once the engine has been seen below the smoking threshold. */
  smoking = false;
  engineDead = false;
  onFire = false;
  burnt = false;
  /** Seconds the fire has burnt, and how long until the tank goes. */
  burnT = 0;
  burnFor = 6;
  /** Seconds until a dead engine catches fire (Infinity: it will not unless damaged further). */
  igniteIn = Infinity;
  /** Seconds of burning since the last time the heat hurt the occupant. */
  fireAcc = 0;
  /** The player has driven this car: getting in it again is not a theft. */
  playerOwned = false;
  /** Set for a police car: the agency, and the unit that drives it. */
  police: { agency: string; body: number; stripe: number; lightbar: [number, number]; unmarked?: boolean } | null = null;
  lightbar = false;
  /** A police car's siren is wailing, its role in the chase (`PoliceRole` in the snapshot), and whether it is a roadblock car. */
  siren = false;
  policeRole = 0;
  roadblock = false;
  /** The ped driving, or 0. */
  occupantId: EntityId = 0;
  input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  /** The driver's door is open (a carjack in progress). */
  doorOpen = false;
  /** Set for a car the ambient traffic drives (or left behind): the traffic's record of it. */
  trafficCar: TrafficCar | null = null;
  /** The body is a kinematic follower of a lane, not simulated: the vehicle system leaves it alone. */
  kinematic = false;
  /** Where it was parked; it goes back there if it leaves the world. */
  home = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(
    readonly id: EntityId,
    readonly typeId: string,
    readonly car: RaycastCar,
    /** Paint, 0xRRGGBB. */
    readonly color: number,
  ) {
    this.maxBody = car.h.damage.bodyHealth;
    this.maxEngine = car.h.damage.engineHealth;
    this.health = this.maxBody;
    this.engine = this.maxEngine;
  }
}

/** Owner id for cars driven by the sim's own AI (police). */
export const AI_OWNER = 1000;

/**
 * A police helicopter. Not physics: a kinematic flyer the police system moves (`police/helicopter.ts`).
 * `x, y, z` is the airframe, `yaw` its heading, `bank` and `pitch` the lean it draws with.
 */
export class HelicopterEntity implements EntityBase {
  readonly kind = EntityKind.Helicopter;
  owner = 0;
  authority: Authority = Authority.Local;
  health = 100;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  bank = 0;
  pitch = 0;
  /** Height above the ground under it, m, and the circle its cone sees on the ground, m. */
  agl = 0;
  footprint = 0;
  searchlight = false;
  sees = false;
  leaving = false;
  /** Rotor speed, 0 to 1. */
  rotor = 1;

  constructor(
    readonly id: EntityId,
    readonly agency: string,
    readonly color: number,
  ) {}
}

/** A spike strip lying across a lane. `yaw` is the direction along its length. */
export class SpikeStripEntity implements EntityBase {
  readonly kind = EntityKind.SpikeStrip;
  owner = 0;
  authority: Authority = Authority.Local;
  health = 1;
  used = false;
  /** Seconds it has lain there. */
  age = 0;

  constructor(
    readonly id: EntityId,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly yaw: number,
    readonly length: number,
    readonly depth: number,
    /** Seconds it lies before it is picked up. */
    readonly life: number,
  ) {}
}

export type SimEntity = PedEntity | VehicleEntity | HelicopterEntity | SpikeStripEntity;

/** One human player: their latest input and the edges (presses) accumulated since the last tick. */
export class PlayerSlot {
  buttons = 0;
  prevButtons = 0;
  /** Buttons that went down since the last tick. */
  edges = 0;
  axes: number[] = [];
  /** Tick of the newest command applied. */
  ack = 0;
  /** Clear length of the camera arm, from the last probe, m. */
  camClear = 0;

  constructor(
    readonly slot: number,
    readonly pedId: EntityId,
  ) {}
}
