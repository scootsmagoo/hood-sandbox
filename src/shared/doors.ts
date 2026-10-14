/**
 * Where a car's driver sits and where its door is, in the car's own frame (+Z forward, +Y up, +X
 * left, so the driver's seat and door are on the left). Shared by the sim (carjack, exiting) and
 * the client (the door prompt, the seated figure), so both agree.
 */
import type { HandlingData } from './handling';

export interface DoorGeometry {
  /** The driver's hip. The seated figure is a standing one (feet at hip - SEAT_DROP), bent at the hip. */
  seat: { x: number; y: number; z: number };
  /** Where the door sits on the body's side. */
  door: { x: number; z: number };
  /** Where someone stands to work the door. */
  stand: { x: number; z: number };
  /** Where a driver dragged out of the car lands. */
  eject: { x: number; z: number };
}

/** Hip height of the standing character model, and the scale it is drawn at when seated. */
export const HIP_HEIGHT = 0.9;
export const SEATED_SCALE = 0.92;
/** How far below the hip a seated figure's feet (its root) sit. */
export const SEAT_DROP = HIP_HEIGHT * SEATED_SCALE;
/** How close (m) to the door's standing spot a ped must be to work it. */
export const DOOR_REACH = 1.45;

export function doorGeometry(h: HandlingData): DoorGeometry {
  const hx = h.chassis.halfExtents[0];
  const cab = h.chassis.cabin;
  const cabinTop = cab.offset[1] + cab.halfExtents[1];
  const z = cab.offset[2] + 0.2;
  return {
    seat: { x: hx * 0.45, y: cabinTop - 0.83, z: z - 0.15 },
    door: { x: hx, z },
    stand: { x: hx + 0.55, z },
    eject: { x: hx + 1.15, z: z - 1.2 },
  };
}

/** Distance (m, horizontal) from a point in the car's frame to the driver's door standing spot. */
export function distanceToDriverDoor(h: HandlingData, localX: number, localZ: number): number {
  const g = doorGeometry(h);
  return Math.hypot(localX - g.stand.x, localZ - g.stand.z);
}

/** Whether a point in the car's frame (and its height above the body origin) is close enough to work the driver's door. */
export function atDriverDoor(h: HandlingData, localX: number, localY: number, localZ: number): boolean {
  return Math.abs(localY) < 2.2 && localX > 0 && distanceToDriverDoor(h, localX, localZ) < DOOR_REACH;
}

/**
 * How far into the sequence each part is, for a time `t` seconds after the pull-out began. The
 * stand-in timing: the door opens, the driver is dragged out, the new driver climbs in, the door closes.
 */
export const CARJACK_TIMES = {
  /** Door fully open by here. */
  doorOpen: 0.25,
  /** The driver is out of the seat between these. */
  pullStart: 0.3,
  pullEnd: 0.9,
  /** The new driver is in the seat here and takes the wheel. */
  done: 1.4,
  /** The door closes by here. */
  doorClose: 1.3,
} as const;

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export interface CarjackPhase {
  /** 0 closed, 1 wide open. */
  door: number;
  /** 0 in the seat, 1 on the ground where they land. */
  pull: number;
  /** 0 standing at the door spot, 1 in the seat (the jacker). */
  climb: number;
  /** The victim is out and free. */
  released: boolean;
  done: boolean;
}

export function carjackPhase(t: number, out: CarjackPhase = { door: 0, pull: 0, climb: 0, released: false, done: false }): CarjackPhase {
  const T = CARJACK_TIMES;
  out.door = t < T.doorClose - 0.15 ? ease(t / T.doorOpen) : 1 - ease((t - (T.doorClose - 0.15)) / 0.15);
  out.pull = ease((t - T.pullStart) / (T.pullEnd - T.pullStart));
  out.climb = ease((t - T.pullEnd) / (T.done - T.pullEnd));
  out.released = t >= T.pullEnd;
  out.done = t >= T.done;
  return out;
}
