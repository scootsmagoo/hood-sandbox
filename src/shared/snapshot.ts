/**
 * Snapshots: the sim's state as a flat typed array, built to be copied cheaply, written into a
 * SharedArrayBuffer or sent as a transferable. One fixed-size record per entity keeps the layout
 * trivial; a later network protocol will quantise it and send deltas.
 *
 * Header (u32/f32 words):  tick, entity count, last input tick applied, controlled entity,
 *                          flags, camera arm clearance (m), player ped id, then the player's
 *                          health and armour, the heat level and phase, the overlay (wasted or
 *                          busted) and how long it has run, the clock, and the police search
 *                          area and counts (see `H`).
 * Entity record (36 words): id, kind, position xyz, rotation xyzw, velocity xyz, then a block
 *                          whose meaning depends on the kind, and health at the end (see `E`).
 */
import type { EntityId } from './entities';

export const HEADER_WORDS = 24;
export const ENTITY_WORDS = 36;
export const MAX_ENTITIES = 256;
export const SNAPSHOT_BYTES = (HEADER_WORDS + ENTITY_WORDS * MAX_ENTITIES) * 4;

const E_WHEELS = 16;

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
  /** f32: game minutes since midnight; u32: day of the week, 0 = Monday. */
  ClockMinutes: 14,
  Day: 15,
  /** f32: the police search area while they have lost you (centre x, z and radius, m); the radius is 0 when there is none. */
  SearchX: 16,
  SearchZ: 17,
  SearchR: 18,
  /** u32: roadblocks standing, helicopters up, spike strips lying, and police cars that have a role in the chase (each is an entity too; these are for the minimap and the HUD). */
  Roadblocks: 19,
  Helicopters: 20,
  Strips: 21,
  Chasers: 22,
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
  /** Bits 11 to 13 hold what an idle pedestrian is doing (`PedPose`). */
  PoseShift: 11,
  PoseMask: 7 << 11,
  /** Gun up and aimed (`PB.AimYaw` and `PB.AimPitch` say where). */
  Aiming: 1 << 14,
  /** Flush against a high wall (`PB.CoverNx` and `PB.CoverNz` are the wall's normal). */
  InCover: 1 << 15,
  /** Crouched: behind low cover. */
  Crouched: 1 << 16,
  /** Carrying a weapon (`PB.Gun` says which). */
  Armed: 1 << 17,
  Reloading: 1 << 18,
  /** Just hit by a bullet: flinching. */
  Flinch: 1 << 19,
  /** Fired within the last instant (the gun kicks). Officers set it when they fire too. */
  Firing: 1 << 20,
  /** An officer who has the player in sight right now (the minimap draws their vision cone brighter). */
  Sees: 1 << 21,
} as const;

/**
 * The weapon block of a ped's record. A ped has no wheels, so the wheel block (words 16 to 31 of the
 * record) holds this instead; every ped record writes all of it, every tick.
 */
export const PB = {
  /** u32: weapon index (bits 0 to 7, 0 = none, 1-based in weapons.json order), rounds in the magazine (bits 8 to 15), spare rounds (bits 16 to 31). */
  Gun: E_WHEELS,
  /** f32: the direction the gun points (world yaw, as a ped's `Aux0`, and pitch, positive up). */
  AimYaw: E_WHEELS + 1,
  AimPitch: E_WHEELS + 2,
  /** f32: 0 to 1 how far through a reload. */
  Reload: E_WHEELS + 3,
  /** f32: the current bloom, degrees (the crosshair's spread is this plus the weapon's aimed spread). */
  Bloom: E_WHEELS + 4,
  /** u32: the entity the aim is locked onto, or 0. */
  Lock: E_WHEELS + 5,
  /** f32: the normal of the wall the ped is against (horizontal, pointing at the ped), and how far it leans out to shoot along the wall's positive direction (-nz, nx), -1 to 1. */
  CoverNx: E_WHEELS + 6,
  CoverNz: E_WHEELS + 7,
  Lean: E_WHEELS + 8,
  /** u32: a bit for each weapon carried (bit n is the weapon with index n + 1). */
  Owned: E_WHEELS + 9,
} as const;

/** Packs the gun word of a ped record. */
export const packGun = (weaponIndex: number, mag: number, reserve: number) => ((weaponIndex & 0xff) | ((Math.min(255, mag) & 0xff) << 8) | ((Math.min(65535, reserve) & 0xffff) << 16)) >>> 0;
export const gunWeapon = (w: number) => w & 0xff;
export const gunMag = (w: number) => (w >>> 8) & 0xff;
export const gunReserve = (w: number) => (w >>> 16) & 0xffff;

/** What an ambient pedestrian is doing while it stands (or sits) where it is, in bits 11 to 13 of a ped's flags. */
export const PedPose = {
  None: 0,
  /** On a bench or the grass. */
  Sit: 1,
  /** Phone at the ear. */
  Phone: 2,
  /** Phone held up, filming. */
  Film: 3,
  /** Crouched, arms over the head. */
  Cower: 4,
  /** Talking with their hands. */
  Chat: 5,
  /** Using a cash machine. */
  Atm: 6,
  /** Leaning in to look at a window. */
  Browse: 7,
} as const;
export type PedPose = (typeof PedPose)[keyof typeof PedPose];

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
  /** Part of the ambient traffic (the client draws these as instances unless they are close). */
  Traffic: 1 << 13,
  /** A car of a roadblock, parked across the road. */
  Roadblock: 1 << 14,
  /** Bits 15 to 18: which tyres are flat (one bit a wheel, in snapshot wheel order: front left, front right, rear left, rear right). */
  FlatShift: 15,
  FlatMask: 15 << 15,
  /** The siren is sounding (a unit in a chase; unmarked units flash and wail only then). */
  Siren: 1 << 19,
  /** The car is chasing: the roles below are in bits 20 to 22 (`PoliceRole`). */
  RoleShift: 20,
  RoleMask: 7 << 20,
} as const;

/** A police car's role in the chase, in bits 20 to 22 of its flags. */
export const PoliceRole = { None: 0, Responder: 1, Chaser: 2, Flanker: 3, Blocker: 4, Roadblock: 5 } as const;
export type PoliceRole = (typeof PoliceRole)[keyof typeof PoliceRole];

/** Helicopter flag bits. A helicopter's record: pose, velocity; `Aux0` rotor speed 0 to 1, `Aux1` its height above the ground (m), `Aux2` the radius of the circle its cone covers on the ground (m). */
export const HeliFlag = {
  /** The searchlight is on (night). */
  Searchlight: 1 << 0,
  /** The player is in the cone: the stars are solid because of it. */
  Sees: 1 << 1,
  /** Leaving: the heat is gone. */
  Leaving: 1 << 2,
} as const;

/** A spike strip's record: pose; `Aux0` its length across the lane (m), `Aux1` the share of its life left. */
export const StripFlag = {
  /** A wheel has been flattened on it. */
  Used: 1 << 0,
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
  /** The police search area: its centre (the last known position) and radius, m (0 when there is none). */
  get searchX(): number {
    return this.f32[H.SearchX];
  }
  get searchZ(): number {
    return this.f32[H.SearchZ];
  }
  get searchR(): number {
    return this.f32[H.SearchR];
  }
  get roadblocks(): number {
    return this.u32[H.Roadblocks];
  }
  get helicopters(): number {
    return this.u32[H.Helicopters];
  }
  get strips(): number {
    return this.u32[H.Strips];
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
