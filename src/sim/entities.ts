import { Authority, EntityKind, type EntityBase, type EntityId } from '../shared/entities';
import type { PedController, PedInput } from './character/PedController';
import type { PedBrain } from './npc/brain';
import type { RaycastCar, VehicleInput } from './vehicles/RaycastCar';

export class PedEntity implements EntityBase {
  readonly kind = EntityKind.Ped;
  owner = 0;
  authority: Authority = Authority.Local;
  health = 100;
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
  health = 1000;
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
  ) {}
}

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
