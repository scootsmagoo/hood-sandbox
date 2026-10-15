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
 * all at once. A new crime raises the level to at least its own; it never lowers it. Escalation is
 * earned: a crime's own level (`CRIMES[id].heat`) is what a single report can give, and reports that
 * pile up in one run of heat add their points: enough of them reach heat 2 ("repeated crimes"), and
 * enough violent ones heat 3 ("sustained violence"), see `LawRules.escalation`. Nothing raises the
 * level by itself with time.
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
  /** Seconds since the last report while nobody has seen the player (hollow stars do not cool before `reportedHoldS`). */
  reportedT = 0;
  /** What the reports of this run of heat add up to (see `LawRules.escalation`). */
  points = 0;
  violence = 0;

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

  /**
   * The search area, m: the police know roughly where you are (the last known position) and sweep a
   * circle that grows with every second they have not seen you, from `searchStartM` at that level at
   * `searchGrowMps` up to `searchMaxM`. Zero when there is no heat or the police have eyes on you.
   */
  get searchRadius(): number {
    if (this.level === 0 || this.phase === 'seen' || !this.lastKnown) return 0;
    const lv = Math.min(MAX_HEAT, this.level);
    const grown = Math.max(0, this.sightT - this.rules.seenGraceS) * (this.rules.searchGrowMps[lv] ?? 2);
    return Math.min(this.rules.searchMaxM, (this.rules.searchStartM[lv] ?? 50) + grown);
  }

  /** 0 to 1: how far toward clearing. */
  get cooldownFrac(): number {
    return this.level === 0 || this.phase === 'seen' ? 0 : Math.min(1, this.coolT / this.cooldownS);
  }

  /** The level the points of this run of heat reach on their own. */
  private get pointsLevel(): number {
    const E = this.rules.escalation;
    return this.violence >= E.heat3ViolencePoints ? 3 : this.points >= E.heat2Points ? 2 : 0;
  }

  /**
   * A witness reported a crime (or an officer saw it). `heat` is the crime's own level; `offence` is what
   * it adds to the run's totals. Each crime is reported once: the caller (`Law`) does not report a second
   * call about the same crime, so calls never stack.
   */
  report(heat: number, severity: number, x: number, z: number, police = false, offence?: { points: number; violent: boolean }) {
    if (this.level === 0) this.anchor = { x, z };
    if (offence) {
      this.points += offence.points;
      if (offence.violent) this.violence += offence.points;
    }
    const level = Math.min(MAX_HEAT, Math.max(this.level, heat, this.pointsLevel));
    this.severity = Math.max(this.severity, severity);
    this.coolT = 0;
    this.reportedT = 0;
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

  /**
   * Advances the clocks. `seen` says whether the police see you now (call `sight` as well). `coolRate`
   * scales how fast the cooldown runs (the police slow it while the search is still on top of you), and
   * `unitEnRoute` says a police car is still on its way to the scene.
   */
  step(dt: number, seen: boolean, coolRate = 1, unitEnRoute = false) {
    if (this.level === 0 || seen) return;
    this.sightT += dt;
    if (this.phase === 'seen') {
      if (this.sightT >= this.rules.seenGraceS) this.set(this.level, 'lost', 'lost');
      return;
    }
    // A report nobody has acted on yet: the police are still on their way, so the stars hold, for a
    // while at least and as long as a car is still driving to the scene (up to `reportedMaxHoldS`).
    if (this.phase === 'reported' && (this.reportedT < this.rules.reportedHoldS || (unitEnRoute && this.reportedT < this.rules.reportedMaxHoldS))) {
      this.reportedT += dt;
      return;
    }
    this.coolT += dt * coolRate;
    if (this.coolT >= this.cooldownS) this.clear('cooldown');
  }

  clear(reason: 'cooldown' | 'busted' | 'wasted') {
    this.severity = 0;
    this.points = 0;
    this.violence = 0;
    this.reportedT = 0;
    this.coolT = 0;
    this.sightT = 0;
    this.lastKnown = null;
    this.anchor = null;
    this.set(0, 'none', reason);
  }
}
