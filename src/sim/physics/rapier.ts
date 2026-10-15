/**
 * Loads the Rapier WASM module once. The "compat" build carries its WASM inline, so it works the
 * same in a worker, on the main thread and in Node (tests, a future server).
 */
import RAPIER from '@dimforge/rapier3d-simd-compat';

export type Rapier = typeof RAPIER;
export { RAPIER };

let initPromise: Promise<Rapier> | null = null;

export function initRapier(): Promise<Rapier> {
  if (!initPromise) initPromise = RAPIER.init().then(() => RAPIER);
  return initPromise;
}

/** Collision membership bits. A pair collides when each one's membership is in the other's filter. */
export const Group = {
  World: 1 << 0,
  Vehicle: 1 << 1,
  Ped: 1 << 2,
  /** What actors' own queries (wheel rays, the character controller, the camera arm) identify as. */
  Query: 1 << 3,
  /** Solid street furniture (signal poles, benches, bus stops). Not seen by the camera arm or sight lines, which only need walls. */
  Prop: 1 << 4,
  /** The parts of a ragdoll (sim/ragdoll): they hit the world, props and cars, not each other, and nothing's queries but bullets see them. */
  Ragdoll: 1 << 5,
} as const;

/** Packs a membership and filter into Rapier's interaction groups. */
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS = {
  world: groups(Group.World, 0xffff),
  /** Vehicles do not collide with the character's body (it is kinematic and would stop them dead). */
  vehicle: groups(Group.Vehicle, Group.World | Group.Vehicle | Group.Query | Group.Prop | Group.Ragdoll),
  ped: groups(Group.Ped, Group.World),
  /** The character controller and the wheel rays see the world and vehicles. */
  actorQuery: groups(Group.Query, Group.World | Group.Vehicle | Group.Prop),
  /** Static solids only: walls, decks and street furniture (placement tests, the unstick check). */
  staticQuery: groups(Group.Query, Group.World | Group.Prop),
  /** Walls and decks only, without the furniture (where a person may sit on a bench). */
  wallQuery: groups(Group.Query, Group.World),
  /** Sees other vehicles only (traffic looking for a car ahead). */
  vehicleQuery: groups(Group.Query, Group.Vehicle),
  /** The camera arm sees only the world. */
  cameraQuery: groups(Group.Query, Group.World),
  /** A bullet sees the world, cars and people. (Its membership is World because a person's collider only answers to World.) */
  bullet: groups(Group.World, Group.World | Group.Vehicle | Group.Ped | Group.Prop | Group.Ragdoll),
  /** A ragdoll part. */
  ragdoll: groups(Group.Ragdoll, Group.World | Group.Vehicle | Group.Prop),
  /** A fixed prop: collides with whatever lists Prop in its filter. */
  prop: groups(Group.Prop, 0xffff),
} as const;
