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
} as const;

/** Packs a membership and filter into Rapier's interaction groups. */
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS = {
  world: groups(Group.World, 0xffff),
  /** Vehicles do not collide with the character's body (it is kinematic and would stop them dead). */
  vehicle: groups(Group.Vehicle, Group.World | Group.Vehicle | Group.Query),
  ped: groups(Group.Ped, Group.World),
  /** The character controller and the wheel rays see the world and vehicles. */
  actorQuery: groups(Group.Query, Group.World | Group.Vehicle),
  /** The camera arm sees only the world. */
  cameraQuery: groups(Group.Query, Group.World),
} as const;
