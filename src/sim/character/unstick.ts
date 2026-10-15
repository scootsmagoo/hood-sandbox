/**
 * The safety net under everybody on foot. Collision keeps people out of walls, but nothing is perfect: a
 * spawn, a shove, a car door, a glide past a corner can leave a capsule inside a building or overlapping a
 * wall or a pole, and a walker can wedge in a place the planner thought was open. Every tenth of a second
 * (each person on their own tick) this checks everyone on foot for
 *
 *   inside   the feet are inside a building's footprint, under its roof
 *   overlap  the capsule overlaps a wall, a deck or a prop (for four checks in a row)
 *   fell     the feet are under the ground
 *   no-progress  someone who is trying to move has not got anywhere for several seconds (NPCs only: the player
 *                pressing against a wall is not stuck)
 *
 * and puts them right: the nearest clear spot (depenetrate), else the last place they stood clear (rollback),
 * else the nearest spot on the walk network (snap-node), else, for an NPC nobody can see, away (despawn).
 * Each fix is a `ped:unstuck` event, so the log shows what went wrong and where.
 */
import type { EntityId } from '../../shared/entities';
import type { SimEvent } from '../../shared/protocol';
import { PedEntity } from '../entities';
import type { Simulation } from '../Simulation';
import type { SimSystem } from '../systems';

/** Each person is checked once in this many ticks. */
const EVERY = 6;
/** Overlapping a wall for this long (s) is stuck. */
const OVERLAP_S = 0.4;
/** The no-progress window (s), the least distance from where it began that counts as progress in it (m), and the share of it spent trying to move. */
const WINDOW_S = 4;
const PROGRESS_M = 0.5;
const TRYING = 0.8;
/** After a fix, leave the person alone for this long (s), and a third fix inside this long removes an NPC nobody sees. */
const COOLDOWN_S = 2;
const REPEAT_S = 40;

interface Track {
  /** Seconds spent overlapping. */
  bad: number;
  good: { x: number; y: number; z: number } | null;
  goodT: number;
  /** The no-progress window: its anchor, the farthest anywhere in it got from the anchor, its length so far, the part of it spent trying to move, and how many windows in a row got nowhere. */
  ax: number;
  az: number;
  far: number;
  t: number;
  trying: number;
  idle: number;
  cool: number;
  fixes: number[];
  seen: number;
}

export class UnstickSystem implements SimSystem {
  readonly name = 'unstick';
  readonly priority = 62;
  private readonly tracks = new Map<EntityId, Track>();
  /** Fixes made, by reason and action (diagnostics, and the audit). */
  readonly counts: Record<string, number> = {};

  fixedUpdate(sim: Simulation, dt: number) {
    const dtc = dt * EVERY;
    let sweep = false;
    for (const e of sim.registry.values()) {
      if (!(e instanceof PedEntity)) continue;
      const c = e.controller;
      // (a ragdoll has the body of anyone thrown: its own collision keeps it out of walls, and the capsule is out of the world)
      if (e.vehicleId || e.busy || !c.enabled || (c as { ragdolled?: boolean }).ragdolled) continue;
      if ((sim.tick + e.id) % EVERY !== 0) continue;
      sweep = true;
      let tr = this.tracks.get(e.id);
      if (!tr) this.tracks.set(e.id, (tr = { bad: 0, good: null, goodT: 0, ax: c.x, az: c.z, far: 0, t: 0, trying: 0, idle: 0, cool: 0, fixes: [], seen: sim.tick }));
      tr.seen = sim.tick;
      this.check(sim, e, tr, dtc);
    }
    // forget the people who are gone
    if (sweep && sim.tick % 600 === 0) for (const [id, tr] of this.tracks) if (sim.tick - tr.seen > 600) this.tracks.delete(id);
  }

  private check(sim: Simulation, ped: PedEntity, tr: Track, dtc: number) {
    const phys = sim.physics;
    const c = ped.controller;
    if (tr.cool > 0) {
      tr.cool -= dtc;
      tr.ax = c.x; tr.az = c.z; tr.far = 0; tr.t = 0; tr.trying = 0;
      return;
    }
    const sitting = ped.amb?.mode === 'scenario';
    const inside = phys.footprints.inside(c.x, c.y, c.z);
    const fell = c.y < phys.groundHeight(c.x, c.z) - 1.2;
    const overlap = !inside && !fell && phys.overlapsStatic(c.x, c.y, c.z, { props: !sitting });
    if (inside || fell) return this.fix(sim, ped, tr, inside ? 'inside' : 'fell');
    if (overlap) {
      tr.bad += dtc;
      if (tr.bad >= OVERLAP_S) return this.fix(sim, ped, tr, 'overlap');
    } else {
      tr.bad = 0;
      tr.goodT += dtc;
      if (c.grounded && tr.goodT >= 1) {
        tr.good = { x: c.x, y: c.y, z: c.z };
        tr.goodT = 0;
      }
    }
    // no progress: NPCs that are alive and trying to walk, and not the police (their own logic stands them against what they are after)
    if (ped.role === 'player' || ped.role === 'police' || ped.life !== 'alive') {
      tr.t = 0;
      return;
    }
    tr.t += dtc;
    tr.far = Math.max(tr.far, Math.hypot(c.x - tr.ax, c.z - tr.az));
    if (Math.hypot(ped.input.moveX, ped.input.moveY) > 0.3) tr.trying += dtc;
    if (tr.t >= WINDOW_S) {
      // pacing up and down a dead end is not stuck: what counts is how far they got from where the window began
      const stuck = tr.trying >= WINDOW_S * TRYING && tr.far < PROGRESS_M;
      tr.idle = stuck ? tr.idle + 1 : 0;
      tr.ax = c.x; tr.az = c.z; tr.far = 0; tr.t = 0; tr.trying = 0;
      // a second window in a row, or one when nobody is watching (the walkers' own planner has already had a go at turning round)
      if (stuck && (tr.idle >= 2 || !this.seen(sim, ped))) this.fix(sim, ped, tr, 'no-progress');
    }
  }

  private seen(sim: Simulation, ped: PedEntity): boolean {
    const c = ped.controller;
    if (sim.ambient) return sim.ambient.visible(c.x, c.y, c.z);
    const p = sim.playerPosition();
    return Math.hypot(c.x - p.x, c.z - p.z) < 40;
  }

  private fix(sim: Simulation, ped: PedEntity, tr: Track, reason: 'inside' | 'overlap' | 'no-progress' | 'fell') {
    const phys = sim.physics;
    const c = ped.controller;
    const fromX = c.x, fromZ = c.z;
    const sitting = ped.amb?.mode === 'scenario';
    const opts = { props: !sitting } as const;
    const now = sim.tick / 60;
    tr.fixes = tr.fixes.filter((t) => now - t < REPEAT_S);
    tr.fixes.push(now);
    tr.bad = 0;
    tr.idle = 0;
    tr.cool = COOLDOWN_S;
    tr.t = 0; tr.trying = 0; tr.far = 0;

    let action: Extract<SimEvent, { type: 'ped:unstuck' }>['action'] = 'depenetrate';
    let to: { x: number; y: number; z: number } | null = null;
    if (reason === 'no-progress') {
      // not in a wall, but wedged: the nearest place on the walk network
      to = this.nodeSpot(sim, ped);
      action = 'snap-node';
    } else {
      const y = Math.max(c.y, phys.groundHeight(c.x, c.z));
      to = phys.clearSpot(c.x, y, c.z, 4, opts);
      // deep inside a building: out through the nearest wall
      if (!to && reason === 'inside') {
        const out = phys.footprints.exitPoint(c.x, c.z, c.y);
        if (out) to = phys.clearSpot(out.x, phys.groundHeight(out.x, out.z), out.z, 2.5, opts);
      }
      if (!to && tr.good && !phys.blockedAt(tr.good.x, tr.good.y, tr.good.z, opts)) {
        to = tr.good;
        action = 'rollback';
      }
      if (!to) {
        to = this.nodeSpot(sim, ped);
        action = 'snap-node';
      }
    }
    // an NPC that keeps coming back, or has nowhere to be put, goes if nobody can see it
    const isPlayer = ped.role === 'player';
    if ((!to || tr.fixes.length >= 3) && !isPlayer && !this.seen(sim, ped)) {
      this.report(sim, ped, reason, 'despawn', fromX, fromZ, fromX, fromZ);
      sim.despawn(ped.id);
      return;
    }
    if (!to) {
      if (isPlayer) {
        sim.respawnPed(ped);
        this.report(sim, ped, reason, 'teleport', fromX, fromZ, c.x, c.z);
      }
      return;
    }
    c.teleport(to.x, to.y, to.z);
    const a = ped.amb;
    if (a) {
      // plan again from here
      a.stuckT = 0; a.stuckN = 0; a.edge = -1; a.prev = -1; a.next = -1; a.route = null; a.crossAttr = -1; a.waitEdge = -1;
      if (sim.ambient && a.mode !== 'scenario' && a.mode !== 'flee' && a.mode !== 'fight') {
        const n = sim.ambient.graph.nearestNode(to.x, to.z, 30);
        a.node = n;
        if (n < 0) a.mode = 'walk';
      }
    }
    this.report(sim, ped, reason, action, fromX, fromZ, to.x, to.z);
  }

  /** The nearest clear spot on or beside a walk-network node near the person. */
  private nodeSpot(sim: Simulation, ped: PedEntity): { x: number; y: number; z: number } | null {
    const g = sim.ambient?.graph;
    if (!g) return null;
    const c = ped.controller;
    // a few nearby nodes, nearest first
    const found: { n: number; d: number }[] = [];
    for (let r = 12; r <= 60 && found.length === 0; r *= 2) {
      const n = g.nearestNode(c.x, c.z, r);
      if (n >= 0) found.push({ n, d: Math.hypot(g.x[n] - c.x, g.z[n] - c.z) });
    }
    for (const { n } of found) {
      const spot = sim.physics.clearSpot(g.x[n], g.y[n], g.z[n], 1.2, { props: ped.amb?.mode !== 'scenario' });
      if (spot) return spot;
    }
    return null;
  }

  private report(sim: Simulation, ped: PedEntity, reason: 'inside' | 'overlap' | 'no-progress' | 'fell', action: Extract<SimEvent, { type: 'ped:unstuck' }>['action'], fromX: number, fromZ: number, toX: number, toZ: number) {
    const k = `${reason}/${action}`;
    this.counts[k] = (this.counts[k] ?? 0) + 1;
    sim.emit({ type: 'ped:unstuck', tick: sim.tick, pedId: ped.id, reason, action, fromX, fromZ, toX, toZ });
  }
}
