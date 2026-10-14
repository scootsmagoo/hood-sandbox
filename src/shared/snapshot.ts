/**
 * Snapshots: the sim's state as a flat typed array, built to be copied cheaply, written into a
 * SharedArrayBuffer or sent as a transferable. One fixed-size record per entity keeps the layout
 * trivial; a later network protocol will quantise it and send deltas.
 *
 * Header (u32/f32 words):  tick, entity count, last input tick applied, controlled entity,
 *                          flags, camera arm clearance (m), player ped id, reserved.
 * Entity record (32 words): id, kind, position xyz, rotation xyzw, velocity xyz, then a block
 *                          whose meaning depends on the kind (see the constants below).
 */
import type { EntityId } from './entities';

export const HEADER_WORDS = 8;
export const ENTITY_WORDS = 32;
export const MAX_ENTITIES = 64;
export const SNAPSHOT_BYTES = (HEADER_WORDS + ENTITY_WORDS * MAX_ENTITIES) * 4;

export const H = {
  Tick: 0,
  Count: 1,
  Ack: 2,
  Controlled: 3,
  Flags: 4,
  CamClear: 5,
  PlayerPed: 6,
} as const;

/** Header flag bits. */
export const SnapFlag = {
  /** The controlled entity is a vehicle the player is driving. */
  InVehicle: 1 << 0,
} as const;

/** Offsets inside an entity record. Ped: `Aux1` is a swing/progress 0..1; vehicle: `Aux1` is the throttle. */
export const E = {
  Id: 0,
  Kind: 1,
  Px: 2,
  Py: 3,
  Pz: 4,
  Qx: 5,
  Qy: 6,
  Qz: 7,
  Qw: 8,
  Vx: 9,
  Vy: 10,
  Vz: 11,
  /** Kind-specific u32 flag bits. */
  Flags: 12,
  /** Ped: horizontal speed. Vehicle: signed forward speed. */
  Speed: 13,
  /** Ped: yaw. Vehicle: front wheel steer angle (positive turns left). */
  Aux0: 14,
  /** Vehicle: throttle actually applied (-1 to 1). */
  Aux1: 15,
  /** Vehicle wheel block: 4 wheels x (steer, roll angle, suspension length, slip 0..1). */
  Wheels: 16,
} as const;

export const WHEEL_FLOATS = 4;
export const WHEEL_COUNT = 4;

export const PedFlag = {
  Grounded: 1 << 0,
  Sprinting: 1 << 1,
  /** Inside a vehicle (drawn seated at the wheel; the ped's position is the seat). */
  InVehicle: 1 << 2,
  /** Not the player's character. */
  Npc: 1 << 3,
  /** Running away in panic. */
  Fleeing: 1 << 4,
  /** Squaring up to the player. `Aux1` is the punch swing, 0 to 1. */
  Fighting: 1 << 5,
  /** Being dragged out of a car. */
  Dragged: 1 << 6,
  /** The player is mid-way through a carjack and has no control. */
  Busy: 1 << 7,
} as const;

export const VehicleFlag = {
  Occupied: 1 << 0,
  Handbraking: 1 << 1,
  Braking: 1 << 2,
  Reversing: 1 << 3,
  /** At least one wheel is spinning or sliding hard (smoke, skid marks). */
  Skidding: 1 << 4,
  Airborne: 1 << 5,
  /** The driver's door is open. `Aux1` of a vehicle stays the throttle; the door is just this bit. */
  DoorOpen: 1 << 6,
} as const;

export class SnapshotView {
  readonly f32: Float32Array;
  readonly u32: Uint32Array;

  constructor(readonly buffer: ArrayBuffer = new ArrayBuffer(SNAPSHOT_BYTES)) {
    this.f32 = new Float32Array(buffer);
    this.u32 = new Uint32Array(buffer);
  }

  get tick(): number {
    return this.u32[H.Tick];
  }
  get count(): number {
    return this.u32[H.Count];
  }
  get ack(): number {
    return this.u32[H.Ack];
  }
  get controlled(): EntityId {
    return this.u32[H.Controlled];
  }
  get inVehicle(): boolean {
    return (this.u32[H.Flags] & SnapFlag.InVehicle) !== 0;
  }
  get camClear(): number {
    return this.f32[H.CamClear];
  }
  get playerPed(): EntityId {
    return this.u32[H.PlayerPed];
  }

  /** Word offset of record `i`. */
  at(i: number): number {
    return HEADER_WORDS + i * ENTITY_WORDS;
  }

  /** Index of the record for an entity, or -1. */
  indexOf(id: EntityId): number {
    for (let i = 0, n = this.count; i < n; i++) if (this.u32[this.at(i) + E.Id] === id) return i;
    return -1;
  }

  copyFrom(other: SnapshotView) {
    this.f32.set(other.f32);
  }
}
