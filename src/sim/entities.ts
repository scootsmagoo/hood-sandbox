import { Authority, EntityKind, type EntityBase, type EntityId } from '../shared/entities';
import type { PedController, PedInput } from './character/PedController';
import type { PedBrain } from './npc/brain';
import type { OfficerState } from './police/types';
import type { RaycastCar, VehicleInput } from './vehicles/RaycastCar';

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
  /** Under the sim's control for a scripted moment (a carjack): commands are ignored and the body is moved by hand. */
  busy = false;

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
  police: { agency: string; body: number; stripe: number; lightbar: [number, number] } | null = null;
  lightbar = false;
  /** The ped driving, or 0. */
  occupantId: EntityId = 0;
  input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  /** The driver's door is open (a carjack in progress). */
  doorOpen = false;
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

export type SimEntity = PedEntity | VehicleEntity;

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
