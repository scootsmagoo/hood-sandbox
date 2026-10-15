/** Tunables of the police response that are not in `data/police.json` (spawn rings, arrest, driving speeds). */
export const POLICE = {
  /** Spawn ring around the player, m. */
  spawnMin: 120,
  spawnMax: 200,
  /** A spawn must be at least this far from the player and out of the camera's view. */
  hiddenMin: 100,
  cameraHalfFov: (62 * Math.PI) / 180,
  /** An officer within this range of a player who stands still arrests them after `arrestS`. */
  arrestRange: 1.5,
  arrestS: 2,
  /** The player counts as resisting at or above this speed, m/s. */
  resistSpeed: 2,
  /** Driving speeds, m/s. A pursuit's top speed rises with the heat (`PoliceManager.speedCap`). */
  respondSpeed: 17,
  pursueSpeed: 23,
  loiterSpeed: 7,
  leaveSpeed: 14,
  /** An officer gets out within this of a player on foot, m. */
  dismountRange: 22,
  /** Dispatch is checked this often, s. */
  dispatchEvery: 0.5,
  /** Units that stood down despawn beyond this distance, m, or after this long, s. */
  leaveDespawnDist: 130,
  leaveDespawnS: 45,
  /** Most cars of the pursuit at once (roadblock cars are on top of it). */
  maxUnits: 12,
  /** Entities the 256-entity snapshot must keep free: dispatch stops adding units beyond this many in the registry. */
  entityCap: 238,
} as const;
