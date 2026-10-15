/**
 * Who may cross a junction when. The lane graph says which connectors conflict (cross or merge) and
 * who must give way (`yields`) or goes by arrival order (`mutual`); signals and stop signs say when a
 * car may start; this class keeps the reservations. A car reserves its connector when it commits to
 * the junction and holds it until it has left. A connector cannot be reserved while a conflicting
 * one is held by another car, so no two conflicting movements are ever in a junction together.
 *
 * Pure: it knows connector ids and car serials, not cars.
 */
import type { LaneGraph } from './LaneGraph';

/** A gap this long (s) to a car that has the right of way is taken, shorter is waited out. */
export const GAP_ACCEPT_S = 4;

export interface Probe {
  /** Seconds until the nearest car that will take connector `conn` reaches the end of its lane (Infinity: none close). */
  arrivalTime(conn: number): number;
}

export class Arbiter {
  /** connector -> serials of the cars that have it reserved */
  private readonly held = new Map<number, number[]>();
  /** serial -> its reserved connector */
  private readonly mine = new Map<number, number>();
  /** serial -> a car stopped at a line waiting for its turn */
  private readonly waiting = new Map<number, { conn: number; since: number }>();

  constructor(private readonly g: LaneGraph) {}

  /** The connector a car has reserved, or -1. */
  reservation(serial: number): number {
    return this.mine.get(serial) ?? -1;
  }

  get reserved(): number {
    return this.mine.size;
  }

  holders(conn: number): readonly number[] {
    return this.held.get(conn) ?? [];
  }

  /** Whether another car has reserved a connector that conflicts with `conn`. */
  conflictHeld(conn: number, serial: number): boolean {
    for (const c of this.g.conflicts[conn]) {
      const h = this.held.get(c);
      if (h && h.some((s) => s !== serial)) return true;
    }
    return false;
  }

  /** Serials of the cars holding connectors that conflict with `conn` (for diagnosis). */
  conflictingHolders(conn: number, serial: number): number[] {
    const out: number[] = [];
    for (const c of this.g.conflicts[conn]) for (const h of this.held.get(c) ?? []) if (h !== serial) out.push(h);
    return out;
  }

  /** A car stopped at the line and wants `conn`; the first call fixes its place in line. */
  queue(serial: number, conn: number, now: number) {
    const w = this.waiting.get(serial);
    if (!w || w.conn !== conn) this.waiting.set(serial, { conn, since: w && w.conn === conn ? w.since : now });
  }

  unqueue(serial: number) {
    this.waiting.delete(serial);
  }

  /**
   * May `serial` take `conn` now (ignoring the signal or the stop sign, which the caller judges)?
   * `patience` in seconds relaxes the rules for a car that has waited too long to break a deadlock:
   * after 20 s it takes the gaps it is offered, and after 45 s it takes its turn whatever the order.
   */
  canEnter(serial: number, conn: number, now: number, probe: Probe, patience = 0): boolean {
    return this.why(serial, conn, now, probe, patience) === 'ok';
  }

  /** The same as `canEnter`, with the reason a car must wait. */
  why(serial: number, conn: number, now: number, probe: Probe, patience = 0): 'ok' | 'held' | 'yield' | 'order' {
    if (this.conflictHeld(conn, serial)) return 'held';
    if (patience < 20) {
      for (const y of this.g.yields[conn]) if (probe.arrivalTime(y) < GAP_ACCEPT_S) return 'yield';
    }
    if (patience < 45) {
      const mine = this.waiting.get(serial);
      const since = mine && mine.conn === conn ? mine.since : now;
      for (const m of this.g.mutual[conn]) {
        for (const [other, w] of this.waiting) {
          if (other === serial || w.conn !== m) continue;
          if (w.since < since || (w.since === since && other < serial)) return 'order';
        }
      }
    }
    return 'ok';
  }

  reserve(serial: number, conn: number) {
    const old = this.mine.get(serial);
    if (old === conn) return;
    if (old !== undefined) this.release(serial);
    this.mine.set(serial, conn);
    const h = this.held.get(conn);
    if (h) h.push(serial);
    else this.held.set(conn, [serial]);
    this.waiting.delete(serial);
  }

  release(serial: number) {
    const conn = this.mine.get(serial);
    if (conn === undefined) return;
    this.mine.delete(serial);
    const h = this.held.get(conn);
    if (h) {
      const i = h.indexOf(serial);
      if (i >= 0) h.splice(i, 1);
      if (h.length === 0) this.held.delete(conn);
    }
  }

  /** Forgets a car altogether (despawned, taken over). */
  forget(serial: number) {
    this.release(serial);
    this.waiting.delete(serial);
  }
}
