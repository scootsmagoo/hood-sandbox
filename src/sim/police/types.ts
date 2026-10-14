import type { EntityId } from '../../shared/entities';

/** What an officer on foot is doing. */
export type OfficerMode = 'seated' | 'chase' | 'search' | 'remount' | 'leave';

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
}
