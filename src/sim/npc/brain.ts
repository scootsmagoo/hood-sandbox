/**
 * The mind of a non-player pedestrian: a small state machine with no physics in it. Each tick the
 * simulation tells the brain what it senses (where it is, where the threat is, how clear the ground
 * is) and gets back where to move and whether a punch lands. Everything is a function of the seed
 * (the personality roll) and the senses, so it replays exactly.
 */
import { clamp, lerp } from '../../shared/math';
import type { Rng } from '../../shared/rng';
import { chooseFleeHeading, type ClearProbe } from './flee';

export type BrainState =
  /** Standing about. */
  | 'idle'
  /** Sitting in a car. The simulation moves the body. */
  | 'seated'
  /** Being pulled out of a car. */
  | 'dragged'
  | 'flee'
  | 'fight'
  /** Safely away, or boxed in with nowhere to go: stands still. */
  | 'calm';

export type Reaction = 'flee' | 'fight';

export interface Personality {
  /** 0 timid to 1 hard. */
  courage: number;
  /** What they do when their car is taken. */
  reaction: Reaction;
}

/** Share of drivers who fight back. */
export const FIGHT_CHANCE = 0.3;

export function rollPersonality(rng: Rng, forced?: Reaction): Personality {
  const courage = rng.next();
  return { courage, reaction: forced ?? (courage >= 1 - FIGHT_CHANCE ? 'fight' : 'flee') };
}

export const BRAIN = {
  /** Fleeing ends (the ped is gone) at this distance from the threat, m. */
  escapeDistance: 60,
  /** A runner who cannot get away in this long stops, s. */
  fleeGiveUp: 30,
  /** Fight lasts this long, s, between timid and hard. */
  fightTime: [2.4, 4.4] as const,
  /** A fighter gives up the chase when the threat is this far, m. */
  fightLeash: 16,
  /** Punch reach, m, wind-up, s, and the pause between punches, s. */
  reach: 1.25,
  windUp: 0.3,
  recover: 0.6,
  damage: 6,
  /** How often the flee heading is chosen again, s. */
  rethink: 0.2,
  /** Boxed in for this long, s, and the runner turns to fight. */
  corneredFor: 1.2,
} as const;

export interface BrainSense {
  dt: number;
  x: number;
  z: number;
  threatX: number;
  threatZ: number;
  probe: ClearProbe;
}

export type MoveSpeed = 'stop' | 'run' | 'sprint';

export interface BrainOutput {
  /** Unit direction to move in (zero when stopping). */
  dirX: number;
  dirZ: number;
  speed: MoveSpeed;
  /** A punch lands this tick. */
  attack: boolean;
  /** Face the threat even when standing still. */
  faceThreat: boolean;
  /** The runner is clear of the threat: remove it from the world. */
  escaped: boolean;
}

export function newBrainOutput(): BrainOutput {
  return { dirX: 0, dirZ: 0, speed: 'stop', attack: false, faceThreat: false, escaped: false };
}

export class PedBrain {
  state: BrainState;
  /** What to run from when it is not the player (an explosion, a car on the pavement). Cleared when the brain leaves `flee`. */
  threat: { x: number; z: number } | null = null;
  /** Seconds in the current state. */
  timer = 0;
  /** Punch wind-up progress, 0 to 1 (0 when not swinging). */
  swing = 0;
  private heading: number | null = null;
  private rethinkIn = 0;
  private cornered = 0;
  private attackCool = 0;
  private winding = false;

  constructor(
    readonly personality: Personality,
    initial: BrainState = 'idle',
  ) {
    this.state = initial;
  }

  /** The victim is out of the car and free: act on the personality. */
  release() {
    this.enter(this.personality.reaction);
  }

  enter(state: BrainState) {
    this.state = state;
    this.timer = 0;
    this.swing = 0;
    this.winding = false;
    this.attackCool = 0.25;
    this.cornered = 0;
    this.rethinkIn = 0;
    if (state !== 'flee') {
      this.heading = null;
      this.threat = null;
    }
  }

  update(s: BrainSense, out: BrainOutput): BrainOutput {
    out.dirX = out.dirZ = 0;
    out.speed = 'stop';
    out.attack = false;
    out.faceThreat = false;
    out.escaped = false;
    this.timer += s.dt;
    const dx = s.threatX - s.x;
    const dz = s.threatZ - s.z;
    const dist = Math.hypot(dx, dz);

    switch (this.state) {
      case 'flee':
        this.flee(s, dist, out);
        break;
      case 'fight':
        this.fight(s, dx, dz, dist, out);
        break;
      default:
        break;
    }
    return out;
  }

  private flee(s: BrainSense, dist: number, out: BrainOutput) {
    if (dist > BRAIN.escapeDistance) {
      out.escaped = true;
      return;
    }
    if (this.timer > BRAIN.fleeGiveUp) {
      this.enter('calm');
      return;
    }
    this.rethinkIn -= s.dt;
    if (this.rethinkIn <= 0 || this.heading === null) {
      this.rethinkIn = BRAIN.rethink;
      const c = chooseFleeHeading(s.x, s.z, s.threatX, s.threatZ, this.heading, s.probe);
      this.heading = c.heading;
      this.cornered = c.cornered ? this.cornered + BRAIN.rethink : 0;
      if (this.cornered >= BRAIN.corneredFor) {
        this.enter('fight');
        return;
      }
    }
    out.dirX = Math.sin(this.heading);
    out.dirZ = Math.cos(this.heading);
    // Sprint while the threat is close, then settle into a run.
    out.speed = dist < 30 ? 'sprint' : 'run';
  }

  private fight(s: BrainSense, dx: number, dz: number, dist: number, out: BrainOutput) {
    const limit = lerp(BRAIN.fightTime[0], BRAIN.fightTime[1], clamp(this.personality.courage, 0, 1));
    if (this.timer > limit || dist > BRAIN.fightLeash) {
      this.enter('flee');
      return;
    }
    out.faceThreat = true;
    this.attackCool -= s.dt;
    if (this.winding) {
      this.swing = clamp(this.swing + s.dt / BRAIN.windUp, 0, 1);
      if (this.swing >= 1) {
        this.winding = false;
        this.swing = 0;
        this.attackCool = BRAIN.recover;
        // The blow lands if the target is still in reach when it ends.
        out.attack = dist < BRAIN.reach * 1.35;
      }
      return;
    }
    if (dist > BRAIN.reach) {
      out.dirX = dx / (dist || 1);
      out.dirZ = dz / (dist || 1);
      out.speed = 'run';
    } else if (this.attackCool <= 0) {
      this.winding = true;
      this.swing = 0;
    }
  }
}
