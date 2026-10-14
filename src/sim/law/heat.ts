/**
 * The heat model: a level from 0 to 6 and a phase that says how much the police know. Pure, so the
 * rules test without a world.
 *
 *   none      no heat
 *   reported  someone called it in; the police do not know where you are (hollow stars)
 *   seen      the police have eyes on you (solid stars)
 *   lost      they had you and lost you (flashing stars)
 *
 * Heat cools down after a number of seconds out of police sight, longer at higher heat, and clears
 * all at once. A new crime raises the level to at least its own; it never lowers it.
 */
import { MAX_HEAT, type LawRules } from '../../shared/law';
import type { HeatPhaseName } from '../../shared/protocol';

export interface HeatChange {
  level: number;
  prevLevel: number;
  phase: HeatPhaseName;
  prevPhase: HeatPhaseName;
  reason: 'crime' | 'sighting' | 'lost' | 'cooldown' | 'busted' | 'wasted';
}

export class HeatModel {
  level = 0;
  phase: HeatPhaseName = 'none';
  /** Where the police believe you are: the crime scene, then wherever they last saw you. */
  lastKnown: { x: number; z: number } | null = null;
  /** Where the first report of this run of heat put the crime: units that may not chase a car gather here. */
  anchor: { x: number; z: number } | null = null;
  /** The worst crime of this run of heat, 1 to 5 (decides who chases a car). */
  severity = 0;
  /** Seconds out of police sight toward clearing, and since the last sighting. */
  coolT = 0;
  sightT = 0;

  constructor(
    private readonly rules: Readonly<LawRules>,
    private readonly onChange: (c: HeatChange) => void = () => {},
  ) {}

  private set(level: number, phase: HeatPhaseName, reason: HeatChange['reason']) {
    if (level === this.level && phase === this.phase) return;
    const c: HeatChange = { level, prevLevel: this.level, phase, prevPhase: this.phase, reason };
    this.level = level;
    this.phase = phase;
    this.onChange(c);
  }

  /** Seconds out of sight it takes to clear the current level. */
  get cooldownS(): number {
    return this.rules.cooldownS[Math.min(this.level, MAX_HEAT)] ?? 60;
  }

  /** 0 to 1: how far toward clearing. */
  get cooldownFrac(): number {
    return this.level === 0 || this.phase === 'seen' ? 0 : Math.min(1, this.coolT / this.cooldownS);
  }

  /** A witness reported a crime (or an officer saw it). */
  report(heat: number, severity: number, x: number, z: number, police = false) {
    if (this.level === 0) this.anchor = { x, z };
    const level = Math.min(MAX_HEAT, Math.max(this.level, heat));
    this.severity = Math.max(this.severity, severity);
    this.coolT = 0;
    if (police) {
      this.sightT = 0;
      this.lastKnown = { x, z };
      this.set(level, 'seen', 'crime');
      return;
    }
    // The police go to where it happened, unless they already have eyes on you.
    if (this.phase !== 'seen') this.lastKnown = { x, z };
    this.set(level, this.phase === 'none' ? 'reported' : this.phase, 'crime');
  }

  /** The police see you this tick. */
  sight(x: number, z: number) {
    if (this.level === 0) return;
    this.sightT = 0;
    this.coolT = 0;
    this.lastKnown = { x, z };
    this.set(this.level, 'seen', 'sighting');
  }

  /** Advances the clocks. `seen` says whether the police see you now (call `sight` as well). */
  step(dt: number, seen: boolean) {
    if (this.level === 0 || seen) return;
    this.sightT += dt;
    if (this.phase === 'seen') {
      if (this.sightT >= this.rules.seenGraceS) this.set(this.level, 'lost', 'lost');
      return;
    }
    this.coolT += dt;
    if (this.coolT >= this.cooldownS) this.clear('cooldown');
  }

  clear(reason: 'cooldown' | 'busted' | 'wasted') {
    this.severity = 0;
    this.coolT = 0;
    this.sightT = 0;
    this.lastKnown = null;
    this.anchor = null;
    this.set(0, 'none', reason);
  }
}
