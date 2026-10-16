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

export const HEADER_WORDS = 29;
export const ENTITY_WORDS = 36;
export const MAX_ENTITIES = 256;
/**
 * Ragdolls (shared/ragdoll.ts) follow the entity records: `H.Ragdolls` records of `RAG_WORDS` words each, the active ones
 * first and then the most recently frozen bodies. A record is the ped's id, its pelvis centre (three f32) and the eleven
 * part rotations packed into two words each (`packQuat`); the client rebuilds the part positions from the joints.
 */
export const RAG_WORDS = 26;
export const MAX_RAGDOLL_RECORDS = 16;
export const RG = { Id: 0, Px: 1, Py: 2, Pz: 3, Rot: 4 } as const;
/**
 * The airport's aircraft (src/sim/aircraft) follow the ragdoll records: a block of two counts (the moving aircraft, the stands),
 * `AC_WORDS` words per moving aircraft (see `AC`), then one word per stand of the city's `aeroway.json` (see `StandWord`): a parked
 * aircraft stands still, so it is a stand's word, not a record. Empty (two zero counts) in a city with no airport.
 */
export const AC_WORDS = 11;
export const MAX_AIRCRAFT = 48;
export const MAX_STANDS = 320;
export const AIRCRAFT_BLOCK_WORDS = 2 + AC_WORDS * MAX_AIRCRAFT + MAX_STANDS;
export const SNAPSHOT_BYTES = (HEADER_WORDS + ENTITY_WORDS * MAX_ENTITIES + RAG_WORDS * MAX_RAGDOLL_RECORDS + AIRCRAFT_BLOCK_WORDS) * 4;

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
  /** u32: how many ragdoll records follow the entity records (see `RAG_WORDS`). */
  Ragdolls: 23,
  /** u32: the train the player rides (an entity id), or 0. */
  Train: 24,
  /**
   * u32, the player and the transit (`TransitInfo`): bits 0-7 the station they are in (index + 1, 0 none), bits 8-9 how they
   * ride (1 seated, 2 standing), bits 10-11 the skip ("fade to the next station": 1 fading out, 2 just arrived), bits 12-13 a door
   * in reach (1 the train's doors are open by them: board; 2 off at this station), bits 16-23 the car they are in.
   */
  TransitInfo: 25,
  /**
   * f32: when the next trains are due at the platform the player is at (or nearest, in their station), seconds, for its first two
   * streams (the two directions of an island); -1 when none is known. u32 `EtaRoutes`: those trains' routes, route + 1 in bits 0-7
   * and 8-15 (0 none).
   */
  Eta0: 26,
  Eta1: 27,
  EtaRoutes: 28,
} as const;

/** Packing of `H.TransitInfo`. */
export const TransitInfo = {
  station: (w: number) => (w & 0xff) - 1,
  ride: (w: number) => (w >>> 8) & 3,
  skip: (w: number) => (w >>> 10) & 3,
  door: (w: number) => (w >>> 12) & 3,
  car: (w: number) => (w >>> 16) & 0xff,
  pack: (station: number, ride: number, skip: number, door: number, car: number) => (((station + 1) & 0xff) | ((ride & 3) << 8) | ((skip & 3) << 10) | ((door & 3) << 12) | ((car & 0xff) << 16)) >>> 0,
} as const;

export const HeatPhase = { None: 0, Reported: 1, Seen: 2, Lost: 3 } as const;
export const Overlay = { None: 0, Wasted: 1, Busted: 2 } as const;

/** Header flag bits. */
export const SnapFlag = {
  /** The controlled entity is a vehicle the player is driving. */
  InVehicle: 1 << 0,
  /** The player rides a train (`H.Train`). */
  OnTrain: 1 << 1,
  /** The player is in the spaces under the ground (a station, a tunnel): the outdoor light does not reach them. */
  Underground: 1 << 2,
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
  /** A witness with a call to the police under way (`E.Aux2` is how far through it, 0 to 1): the client draws a phone over their head. */
  Dialling: 1 << 22,
  /** The body is a ragdoll (thrown, slumped, lying, or getting up): draw it from its ragdoll record, or from the last one seen. */
  Ragdoll: 1 << 23,
  /** Staggering from a shove or a car's nudge, catching their balance. */
  Stumble: 1 << 24,
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

/**
 * A train's record: the pose and velocity of its head car; `Speed` its speed along the route, `Aux0` where its head is along the
 * route (m: the client lays the cars out on the route from `transit.json`), `Aux1` how far its doors are open (0 to 1), `Aux2`
 * the route index. The wheel block holds `TR`.
 */
export const TrainFlag = {
  /** Doors on the left of the route's direction (looking along it) are the ones that open at this stop. */
  DoorsLeft: 1 << 0,
  DoorsRight: 1 << 1,
  /** Standing at a stop. */
  Dwelling: 1 << 2,
  /** Braking for the next stop (within its last 250 m). */
  Arriving: 1 << 3,
  /** The player rides it. */
  PlayerAboard: 1 << 4,
  /** Sounding its horn (entering a station, or at someone on the track). */
  Horn: 1 << 5,
  /** The door-closing chime is sounding. */
  Closing: 1 << 6,
} as const;

/** A train's words in the wheel block of its record. */
export const TR = {
  /** u32: the index of the next stop in the route's `stops` (its length when there is none). */
  NextStop: E_WHEELS,
  /** f32: seconds until it leaves the stop it stands at, or (running) the time it expects to reach the next one. */
  Eta: E_WHEELS + 1,
  /** u32: the line's index, and how many cars. */
  Line: E_WHEELS + 2,
  Cars: E_WHEELS + 3,
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
  /** The train the player rides, or 0. */
  get train(): number {
    return this.u32[H.Train];
  }
  get transitInfo(): number {
    return this.u32[H.TransitInfo];
  }

  /** Word offset of record `i`. */
  at(i: number): number {
    return HEADER_WORDS + i * ENTITY_WORDS;
  }

  get ragdollCount(): number {
    return this.u32[H.Ragdolls];
  }

  /** Word offset of ragdoll record `i` (after the entity records). */
  ragdollAt(i: number): number {
    return HEADER_WORDS + this.count * ENTITY_WORDS + i * RAG_WORDS;
  }

  /** Index of the ragdoll record of a ped, or -1. */
  ragdollIndexOf(id: EntityId): number {
    for (let i = 0, n = this.ragdollCount; i < n; i++) if (this.u32[this.ragdollAt(i) + RG.Id] === id) return i;
    return -1;
  }

  /** Bytes in use: the header, the entity records, the ragdoll records and the aircraft block (what a transport needs to send). */
  get usedBytes(): number {
    const ac = this.aircraftBase;
    return (ac + 2 + this.u32[ac] * AC_WORDS + this.u32[ac + 1]) * 4;
  }

  /** Word offset of the aircraft block (after the ragdoll records). */
  get aircraftBase(): number {
    return HEADER_WORDS + this.count * ENTITY_WORDS + this.ragdollCount * RAG_WORDS;
  }

  /** How many moving aircraft records, and stand words, the block holds. */
  get aircraftCount(): number {
    return this.u32[this.aircraftBase];
  }
  get standCount(): number {
    return this.u32[this.aircraftBase + 1];
  }

  /** Word offset of moving aircraft record `i`. */
  aircraftAt(i: number): number {
    return this.aircraftBase + 2 + i * AC_WORDS;
  }

  /** The word of stand `i` (`StandWord`). */
  standWord(i: number): number {
    const b = this.aircraftBase;
    return this.u32[b + 2 + this.u32[b] * AC_WORDS + i];
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

/**
 * A moving aircraft's record (the aircraft block, see `AC_WORDS`): its id (stable while it moves), the packed `Info` word, the
 * position of the main gear's centre on the ground (or in the air), its yaw (as a ped's: the nose (sin, cos)), pitch (nose up
 * positive) and roll (radians), its speed (m/s along its path), how far its gear is down (0 up, 1 down) and its thrust (0 to 1).
 */
export const AC = { Id: 0, Info: 1, Px: 2, Py: 3, Pz: 4, Yaw: 5, Pitch: 6, Roll: 7, Speed: 8, Gear: 9, Thrust: 10 } as const;

/** What an aircraft is doing, in bits 8 to 11 of its `Info` word. */
export const AircraftPhase = { Parked: 0, Approach: 1, Rollout: 2, TaxiIn: 3, Pushback: 4, TaxiOut: 5, Hold: 6, Takeoff: 7, Climb: 8 } as const;
export type AircraftPhase = (typeof AircraftPhase)[keyof typeof AircraftPhase];

/** Light and equipment bits of an aircraft's `Info` word (bits 12 and up), and of a stand word (bits 12 and up). */
export const AircraftFlag = {
  Nav: 1 << 12,
  Beacon: 1 << 13,
  Strobe: 1 << 14,
  Landing: 1 << 15,
  Taxi: 1 << 16,
  /** A tug pushes it (pushback): the nose faces away from the way it moves. */
  Tug: 1 << 17,
  /** Its cabin lights show (night, or parked at a gate). */
  Cabin: 1 << 18,
} as const;

/** Packs and reads an aircraft's `Info` word: class (0 narrowbody, 1 widebody, 2 regional) in bits 0-1, livery in bits 2-7. */
export const AircraftInfo = {
  pack: (cls: number, livery: number, phase: number, flags: number) => ((cls & 3) | ((livery & 63) << 2) | ((phase & 15) << 8) | flags) >>> 0,
  cls: (w: number) => w & 3,
  livery: (w: number) => (w >>> 2) & 63,
  phase: (w: number) => (w >>> 8) & 15,
} as const;

/** A stand's word: 0 empty, else class + 1 in bits 0-1 (1..3), the livery in bits 2-7, and `AircraftFlag` bits (beacon when it is about to push back). */
export const StandWord = {
  pack: (cls: number, livery: number, flags: number) => (((cls + 1) & 3) | ((livery & 63) << 2) | flags) >>> 0,
  occupied: (w: number) => (w & 3) !== 0,
  cls: (w: number) => (w & 3) - 1,
  livery: (w: number) => (w >>> 2) & 63,
} as const;
