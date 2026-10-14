/**
 * Snapshots: the sim's state as a flat typed array, built to be copied cheaply, written into a
 * SharedArrayBuffer or sent as a transferable. One fixed-size record per entity keeps the layout
 * trivial; a later network protocol will quantise it and send deltas.
 *
 * Header (u32/f32 words):  tick, entity count, last input tick applied, controlled entity,
 *                          flags, camera arm clearance (m), player ped id, then the player's
 *                          health and armour, the heat level and phase, the overlay (wasted or
 *                          busted) and how long it has run (see `H`).
 * Entity record (36 words): id, kind, position xyz, rotation xyzw, velocity xyz, then a block
 *                          whose meaning depends on the kind, and health at the end (see `E`).
 */
import type { EntityId } from './entities';

export const HEADER_WORDS = 16;
export const ENTITY_WORDS = 36;
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
  /** f32: the player's health and armour. */
  Health: 7,
  Armour: 8,
  /** u32: heat level 0 to 6, and its phase (`HeatPhase`). */
  Heat: 9,
  HeatPhase: 10,
  /** u32: 0 none, 1 wasted, 2 busted (`Overlay`); f32: seconds into it. */
  Overlay: 11,
  OverlayT: 12,
  /** f32: 0 to 1, how far the heat has cooled toward clearing (while out of sight). */
  Cooldown: 13,
} as const;

export const HeatPhase = { None: 0, Reported: 1, Seen: 2, Lost: 3 } as const;
export const Overlay = { None: 0, Wasted: 1, Busted: 2 } as const;

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
  /** Ped: health (0 to 100). Vehicle: body health. */
  Health: 32,
  /** Ped: armour. Vehicle: engine health. */
  Health2: 33,
  /** Vehicle: 0 to 1 how far a fire has burnt toward the explosion. */
  Aux2: 34,
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
  /** Knocked to the ground, alive. */
  Downed: 1 << 8,
  Dead: 1 << 9,
  /** An officer. */
  Police: 1 << 10,
  /** Mid-punch (`Aux1` is the swing, 0 to 1). The same bit as an NPC's `Fighting`, set for the player too. */
  Punching: 1 << 5,
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
  /** Engine below the smoking threshold. */
  Smoking: 1 << 7,
  EngineDead: 1 << 8,
  OnFire: 1 << 9,
  /** Exploded: a charred shell. */
  Burnt: 1 << 10,
  /** A police car. */
  Police: 1 << 11,
  /** Lightbar flashing. */
  Lightbar: 1 << 12,
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
  get health(): number {
    return this.f32[H.Health];
  }
  get armour(): number {
    return this.f32[H.Armour];
  }
  get heat(): number {
    return this.u32[H.Heat];
  }
  get heatPhase(): number {
    return this.u32[H.HeatPhase];
  }
  get overlay(): number {
    return this.u32[H.Overlay];
  }
  get overlayT(): number {
    return this.f32[H.OverlayT];
  }
  get cooldown(): number {
    return this.f32[H.Cooldown];
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
