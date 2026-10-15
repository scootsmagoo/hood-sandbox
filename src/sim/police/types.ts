import type { EntityId } from '../../shared/entities';
import type { Agency } from '../../shared/law';
import type { PathFollower } from './pursuit';
import type { PathPoint } from './roadGraph';
import type { Role } from './tactics';

/** What an officer on foot is doing. `hold`: standing behind a roadblock car, waiting for the target to come. */
export type OfficerMode = 'seated' | 'chase' | 'search' | 'remount' | 'leave' | 'hold';

/** An officer's trigger discipline (see `fire.ts`). */
export interface FireState {
  /** Seconds the target has been in sight and in line, continuously; the first shot waits for the reaction time. */
  seenT: number;
  /** The reaction time this officer drew for this sighting, s. */
  reactS: number;
  /** Rounds left in the current burst, and the pause (s) before the next burst. */
  burstLeft: number;
  pauseT: number;
  /** Why the last attempt did not fire, for tests and debugging. */
  why: string;
}

/** An officer's state. */
export interface OfficerState {
  agency: string;
  unitId: number;
  mode: OfficerMode;
  /** The car they came in. */
  vehicleId: EntityId;
  /** Seconds the player has been held within arrest range while not resisting. */
  arrestT: number;
  /** Where a search on foot is heading now. */
  goal: { x: number; z: number } | null;
  goalT: number;
  /** Seconds since this officer last saw the player. */
  unseenT: number;
  /** Time left before the next vision check. */
  senseIn: number;
  sees: boolean;
  uniform: number;
  /** The dispatch loadout they were armed with ('pistol', 'shotgun', 'rifle'). */
  loadout: string;
  /** 0 the driver's seat, 1 the passenger's. */
  seat: number;
  /** Seconds left of the "just fired" flag in the snapshot. */
  fireT: number;
  fire: FireState;
}

export type UnitMode = 'drive' | 'loiter' | 'leave';

/** A roadblock: its cars (and officers) as one thing to place and to take away. */
export interface Roadblock {
  id: number;
  x: number;
  z: number;
  /** The direction the target is expected to arrive from (unit vector pointing at it) and the width laid across, m. */
  dirX: number;
  dirZ: number;
  width: number;
  unitIds: number[];
  /** Sim time it was laid, and when the target passed it (0 until then). */
  t0: number;
  passedAt: number;
  gap: { x: number; z: number; width: number } | null;
  stripId: EntityId;
}

/** The sub-state of a PIT in progress. */
export interface PitState {
  side: 1 | -1;
  /** Seconds since the attempt began, and in `align` or `strike`. */
  t: number;
  alignT: number;
  strikeT: number;
  /** The target's yaw when the strike began, to see whether it turned. */
  yaw0: number;
  struck: boolean;
  hit: boolean;
}

export interface Unit {
  id: number;
  agency: Agency;
  vehicleId: EntityId;
  officerIds: EntityId[];
  mode: UnitMode;
  follower: PathFollower | null;
  /** What the route was planned to reach, and how old it is. */
  routeTo: PathPoint | null;
  routeAge: number;
  stuckT: number;
  reverseT: number;
  reverseSteer: number;
  loiterGoal: PathPoint | null;
  loiterWait: number;
  leaveT: number;
  /** Seconds the car has spent within reach of where it was sent. */
  arrivedT: number;
  /** Failed back-outs in a row, and the time left in which it pushes through whatever is in the way. */
  stuckCycles: number;
  ramT: number;
  // ---- the chase
  loadout: string;
  role: Role;
  roleT: number;
  /** Part of a roadblock (its cars never leave until the target has passed). */
  block: Roadblock | null;
  /** A blocker's meeting point on the target's route, and when it was worked out. */
  meet: { x: number; z: number; s: number; dx: number; dz: number } | null;
  meetAt: number;
  /** A blocker parked across the road: 0 not yet, 1 turning in, 2 held. */
  blockStage: number;
  pit: PitState | null;
  pitCool: number;
  ramCool: number;
  /** Seconds before this unit may PIT or ram again after a hit. */
  grace: number;
  ramming: boolean;
  /** Seconds into the ram in progress. */
  ramClock: number;
  /** Lateral offset (m, left positive) from the route it is steering for, to pass what is in the lane. */
  lateral: number;
  lateralWant: number;
  lateralT: number;
  spikesLaid: boolean;
  /** Where it searches when the target is lost, and for how long. */
  searchGoal: PathPoint | null;
  searchT: number;
  /** How long it has chased a target it can see, s. */
  chaseT: number;
}
