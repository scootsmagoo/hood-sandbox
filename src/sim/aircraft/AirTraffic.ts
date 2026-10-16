/**
 * The airport's traffic (the city's `aeroway.json`, src/shared/aeroway.ts): AI airliners that land, taxi to a gate, park, push
 * back, taxi out and take off, on a deterministic schedule.
 *
 * - **Schedule.** Arrivals come every 38 to 62 s (west flow, Hartsfield-Jackson's usual: they land on the outer runways, 26R for
 *   the stands north of the terminal, 27L and 28 by turns for the south ones; departures take the inner runways, 26L and 27R).
 *   Each arrival is given a free stand of its class (narrowbodies most, regionals, widebodies at the international concourses,
 *   cargo freighters at the cargo ramps) and parks there for 6 to 16 minutes; then it departs. At the start a little over half the
 *   stands have an aircraft on them, and the schedule is run from 15 minutes before the sim's start, so there is traffic moving at once.
 * - **Separation.** A flight is planned when it is due (plans.ts: its whole path and speed profile), then checked against every
 *   flight planned before it, sampled every 2 s: no two on or near the ground closer than their half spans and a margin, no two
 *   arrivals on one runway within 90 s, no two departures within 80 s, and the stand must be clear when it gets there. Where
 *   there is a conflict it is delayed (an arrival holds out of sight, a departure stays at the gate a little longer) in 4 s steps.
 *   Flights never change once planned, and they are planned in time order, so the same seed gives the same traffic.
 * - **Physics.** Kinematic: a moving aircraft's pose is its plan at the sim time. Within 450 m of the player an aircraft on or
 *   near the ground has a kinematic body of boxes (aircraft.json `colliders`), a parked one a fixed body: cars bump into them, the
 *   player walks into them, and an aircraft taxiing over the player knocks them down.
 * - **Snapshot.** The aircraft block (src/shared/snapshot.ts): the moving aircraft as records, the parked ones as stand words.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { AeroGraph, standPose, type AerowayData, type AircraftClass } from '../../shared/aeroway';
import type { Rng } from '../../shared/rng';
import { AC, AC_WORDS, AircraftFlag, AircraftInfo, AircraftPhase, MAX_AIRCRAFT, MAX_STANDS, StandWord, type SnapshotView } from '../../shared/snapshot';
import { GROUPS } from '../physics/rapier';
import { knockDown } from '../combat/damage';
import type { Simulation } from '../Simulation';
import type { PedEntity } from '../entities';
import { AiPlanController, newAircraftState, type AircraftController, type AircraftState } from './control';
import { newPose, planArrival, planDeparture, poseAt, type Plan } from './plans';
import { CLASS_INDEX, liveriesFor, TYPES } from './types';

/** Sample spacing of a flight's track (conflict checks), s. */
const TRACK_DT = 2;
/** The schedule starts this long before the sim (so traffic is under way at once), s. */
export const PRE_RUN = 900;
const COLLIDE_R = 450;
const COLLIDE_DROP = 520;
/** West flow: the arrival and departure runway ends by the side of the field (north or south of the terminal). */
const FLOW = { arriveNorth: ['26R'], arriveSouth: ['27L', '28'], departNorth: ['26L'], departSouth: ['27R'] };

export interface Flight {
  id: number;
  plan: Plan;
  /** sim time it starts, s */
  t0: number;
  /** [x, y, z, low] every TRACK_DT from t0 (low: on or near the ground) */
  track: Float32Array;
  state: AircraftState;
  controller: AircraftController;
  /** a kinematic body while it is near the player */
  body: RAPIER.RigidBody | null;
  done: boolean;
}

interface Stand {
  /** the parked aircraft, if any */
  occ: { cls: AircraftClass; livery: number; departAt: number; planned: boolean } | null;
  /** the arrival (flight id) on its way to it */
  reservedBy: number;
  /** when the departing aircraft will be off it */
  freeAt: number;
  body: RAPIER.RigidBody | null;
}

export interface AirTrafficOptions {
  /** share of the stands with an aircraft at the start, 0..1 (default 0.55) */
  occupancy?: number;
  /** seconds between arrivals, [min, max] (default [38, 62]) */
  arrivalEvery?: [number, number];
  /** seconds parked, [min, max] (default [360, 960]) */
  dwell?: [number, number];
  /** no colliders (tests that only want the schedule) */
  noPhysics?: boolean;
}

export class AirTraffic {
  readonly graph: AeroGraph;
  readonly flights: Flight[] = [];
  readonly stands: Stand[];
  private readonly holdNodes: Set<number>;
  private readonly ends: { arrivals: { north: [number, 0 | 1][]; south: [number, 0 | 1][] }; departures: { north: [number, 0 | 1][]; south: [number, 0 | 1][] } };
  private readonly zMid: number;
  private nextArrival: number;
  private nextId = 1;
  private southTurn = 0;
  /** arrival touchdowns and departure rolls, by runway end key, sim seconds */
  private readonly runwayUse = new Map<string, number[]>();
  readonly stats = { arrivals: 0, departures: 0, delayed: 0, delaySeconds: 0, failed: 0, landed: 0, departed: 0, runOver: 0, bodies: 0 };
  private now = -PRE_RUN;
  private readonly opts: Required<Omit<AirTrafficOptions, 'noPhysics'>> & { noPhysics: boolean };

  constructor(
    readonly data: AerowayData,
    private readonly rng: Rng,
    private readonly sim: Simulation | null,
    opts: AirTrafficOptions = {},
  ) {
    this.opts = { occupancy: opts.occupancy ?? 0.55, arrivalEvery: opts.arrivalEvery ?? [38, 62], dwell: opts.dwell ?? [360, 960], noPhysics: opts.noPhysics ?? !sim };
    this.graph = new AeroGraph(data);
    this.holdNodes = new Set(data.holds.map((h) => h.node));
    const endOf = (ref: string): [number, 0 | 1] | null => {
      for (let i = 0; i < data.runways.length; i++) for (const k of [0, 1] as const) if (data.runways[i].ends[k].ref.replace(/^0/, '') === ref.replace(/^0/, '')) return [i, k];
      return null;
    };
    const pick = (refs: string[]) => refs.map(endOf).filter((e): e is [number, 0 | 1] => !!e);
    this.ends = {
      arrivals: { north: pick(FLOW.arriveNorth), south: pick(FLOW.arriveSouth) },
      departures: { north: pick(FLOW.departNorth), south: pick(FLOW.departSouth) },
    };
    // the line between the north and the south complexes: midway between the departure runways
    const zs = [...this.ends.departures.north, ...this.ends.departures.south].map(([i]) => (data.runways[i].ends[0].threshold[2] + data.runways[i].ends[1].threshold[2]) / 2);
    this.zMid = zs.length >= 2 ? (Math.min(...zs) + Math.max(...zs)) / 2 : data.nodes.reduce((a, n) => a + n[2], 0) / Math.max(1, data.nodes.length);
    this.stands = data.stands.map(() => ({ occ: null, reservedBy: 0, freeAt: -Infinity, body: null }));
    // the stands taken at the start, with their departure times spread over the first half hour
    const r = this.rng;
    data.stands.forEach((st, i) => {
      if (r.next() >= this.opts.occupancy) return;
      const lv = this.livery(st.size, st.cargo);
      if (lv < 0) return;
      this.stands[i].occ = { cls: st.size, livery: lv, departAt: -PRE_RUN + 60 + r.next() * 5400, planned: false };
    });
    this.nextArrival = -PRE_RUN + r.next() * 20;
    // run the schedule up to the start: flights under way at t = 0
    for (let t = -PRE_RUN; t < 0; t += 1) this.update(t);
  }

  /** A livery (index) for a class, by weight, or -1. */
  private livery(cls: AircraftClass, cargo: boolean): number {
    const list = liveriesFor(cls, cargo);
    if (!list.length) return -1;
    const total = list.reduce((a, l) => a + l.weight, 0);
    let x = this.rng.next() * total;
    for (const l of list) {
      x -= l.weight;
      if (x <= 0) return l.index;
    }
    return list[list.length - 1].index;
  }

  private sideOf(standIdx: number): 'north' | 'south' {
    return this.data.nodes[this.data.stands[standIdx].node][2] < this.zMid ? 'north' : 'south';
  }

  /** The schedule at sim time `t`: new arrivals and departures planned, finished flights parked or gone. */
  update(t: number) {
    this.now = t;
    // finished flights
    for (const f of this.flights) {
      if (f.done || t < f.t0 + f.plan.duration) continue;
      f.done = true;
      const st = this.stands[f.plan.stand];
      if (f.plan.kind === 'arrival') {
        st.occ = { cls: f.plan.cls, livery: f.plan.livery, departAt: t + this.opts.dwell[0] + this.rng.next() * (this.opts.dwell[1] - this.opts.dwell[0]), planned: false };
        st.reservedBy = 0;
        this.stats.landed++;
      } else this.stats.departed++;
      this.dropBody(f);
    }
    for (let i = this.flights.length - 1; i >= 0; i--) if (this.flights[i].done) this.flights.splice(i, 1);
    // a departure leaving its stand: the stand's aircraft is the moving flight from now on
    for (const f of this.flights) {
      if (f.plan.kind !== 'departure' || t < f.t0) continue;
      const st = this.stands[f.plan.stand];
      if (st.occ?.planned) {
        st.occ = null;
        if (st.body) this.dropStandBody(st);
      }
    }
    // departures due
    this.stands.forEach((st, i) => {
      if (!st.occ || st.occ.planned || t < st.occ.departAt) return;
      if (this.planDepartureFrom(i, t)) return;
      st.occ.departAt = t + 120;
    });
    // arrivals due
    while (t >= this.nextArrival) {
      this.planArrivalAt(this.nextArrival);
      const [a, b] = this.opts.arrivalEvery;
      this.nextArrival += a + this.rng.next() * (b - a);
    }
  }

  private planArrivalAt(t: number) {
    const r = this.rng;
    const cargo = r.next() < 0.07;
    const x = r.next();
    const cls: AircraftClass = cargo ? (r.next() < 0.6 ? 'widebody' : 'narrowbody') : x < 0.58 ? 'narrowbody' : x < 0.86 ? 'regional' : 'widebody';
    const free: number[] = [];
    this.data.stands.forEach((st, i) => {
      const s = this.stands[i];
      if (st.size !== cls || st.cargo !== cargo || s.occ || s.reservedBy) return;
      free.push(i);
    });
    if (!free.length) {
      this.stats.failed++;
      return;
    }
    const si = free[r.int(0, free.length - 1)];
    const lv = this.livery(cls, cargo);
    if (lv < 0) return;
    const side = this.sideOf(si);
    const ends = this.ends.arrivals[side];
    if (!ends.length) return;
    const [rwi, end] = ends[side === 'south' ? this.southTurn++ % ends.length : 0];
    const plan = planArrival(this.graph, cls, lv, si, rwi, end);
    if (!plan) {
      this.stats.failed++;
      return;
    }
    const st = this.stands[si];
    const delay = this.findDelay(plan, t, 900, `${rwi}/${end}`, 90, (d) => t + d + plan.duration >= st.freeAt + 20);
    if (delay < 0) {
      this.stats.failed++;
      return;
    }
    this.add(plan, t + delay);
    st.reservedBy = this.flights[this.flights.length - 1].id;
    this.stats.arrivals++;
  }

  private planDepartureFrom(si: number, t: number): boolean {
    const st = this.stands[si];
    const occ = st.occ!;
    const side = this.sideOf(si);
    const ends = this.ends.departures[side];
    if (!ends.length) return false;
    const [rwi, end] = ends[0];
    const plan = planDeparture(this.graph, occ.cls, occ.livery, si, rwi, end, this.holdNodes);
    if (!plan) {
      this.stats.failed++;
      return false;
    }
    const delay = this.findDelay(plan, t, 1200, `${rwi}/${end}`, 60, () => true);
    if (delay < 0) return false;
    this.add(plan, t + delay);
    occ.planned = true;
    st.freeAt = t + delay + plan.tOffStand + 30;
    this.stats.departures++;
    return true;
  }

  private add(plan: Plan, t0: number) {
    const id = this.nextId++;
    const track = trackOf(plan);
    const state = newAircraftState(id, plan.cls, plan.livery);
    const f: Flight = { id, plan, t0, track, state, controller: new AiPlanController(plan, t0), body: null, done: false };
    poseAt(plan, 0, state);
    this.flights.push(f);
    const key = `${plan.runway}/${plan.end}`;
    const list = this.runwayUse.get(key) ?? [];
    list.push(t0 + plan.tRunway);
    // (only the last hour matters)
    while (list.length && list[0] < this.now - 3600) list.shift();
    this.runwayUse.set(key, list);
  }

  /** The smallest delay (4 s steps, up to `max`) at which a plan planned at `t` meets no earlier flight, or -1. */
  private findDelay(plan: Plan, t: number, max: number, runwayKey: string, runwayGap: number, ok: (delay: number) => boolean): number {
    const track = trackOf(plan);
    const use = this.runwayUse.get(runwayKey) ?? [];
    const spanA = TYPES[plan.cls].span;
    for (let d = 0; d <= max; d += 4) {
      if (!ok(d)) continue;
      const tr = t + d + plan.tRunway;
      if (use.some((u) => Math.abs(u - tr) < runwayGap)) continue;
      if (this.trackClear(track, t + d, spanA)) {
        if (d > 0) {
          this.stats.delayed++;
          this.stats.delaySeconds += d;
        }
        return d;
      }
    }
    return -1;
  }

  /** No earlier flight within its separation of this track (starting at t0) while both are low. */
  private trackClear(track: Float32Array, t0: number, spanA: number): boolean {
    const n = track.length / 4;
    const t1 = t0 + (n - 1) * TRACK_DT;
    for (const f of this.flights) {
      if (f.done) continue;
      const fn = f.track.length / 4;
      const f0 = f.t0, f1 = f.t0 + (fn - 1) * TRACK_DT;
      const a = Math.max(t0, f0), b = Math.min(t1, f1);
      if (a > b) continue;
      const sep = (spanA + TYPES[f.plan.cls].span) / 2 + 8;
      const sep2 = sep * sep;
      for (let tt = a; tt <= b; tt += TRACK_DT) {
        const i = Math.round((tt - t0) / TRACK_DT) * 4, j = Math.round((tt - f0) / TRACK_DT) * 4;
        if (i + 3 >= track.length || j + 3 >= f.track.length) continue;
        if (!track[i + 3] || !f.track[j + 3]) continue;
        const dx = track[i] - f.track[j], dz = track[i + 2] - f.track[j + 2];
        if (dx * dx + dz * dz < sep2 && Math.abs(track[i + 1] - f.track[j + 1]) < 30) return false;
      }
    }
    return true;
  }

  /** One sim tick: the schedule, the poses, the colliders near the player, an aircraft over the player. */
  step(sim: Simulation, dt: number) {
    const t = sim.tick * dt;
    this.update(t);
    for (const f of this.flights) if (t >= f.t0) f.controller.step(f.state, t, dt);
    if (this.opts.noPhysics) return;
    const me = sim.playerPosition();
    this.syncBodies(sim, me);
    this.runOver(sim, me);
  }

  private syncBodies(sim: Simulation, me: { x: number; z: number }) {
    const R = sim.physics.R;
    const world = sim.physics.world;
    let n = 0;
    for (const f of this.flights) {
      const s = f.state;
      const live = this.now >= f.t0 && !f.done;
      const d = Math.hypot(s.x - me.x, s.z - me.z);
      const low = s.gear > 0.5 && (s.phase !== AircraftPhase.Approach || s.y < groundGuess(this.data, s) + 40);
      const want = live && low && d < (f.body ? COLLIDE_DROP : COLLIDE_R);
      if (!want) {
        if (f.body) this.dropBody(f);
        continue;
      }
      if (!f.body) f.body = makeBody(R, world, R.RigidBodyDesc.kinematicPositionBased(), f.plan.cls, s.x, s.y, s.z, s.yaw, s.pitch, s.roll);
      else {
        f.body.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
        f.body.setNextKinematicRotation(quatYPR(s.yaw, s.pitch, s.roll));
      }
      n++;
    }
    this.data.stands.forEach((st, i) => {
      const sd = this.stands[i];
      const p = this.data.nodes[st.node];
      const d = Math.hypot(p[0] - me.x, p[2] - me.z);
      const want = !!sd.occ && d < (sd.body ? COLLIDE_DROP : COLLIDE_R);
      if (!want) {
        if (sd.body) this.dropStandBody(sd);
        return;
      }
      if (!sd.body) {
        const q = standPose(this.data, st, TYPES[sd.occ!.cls].wheelbase);
        sd.body = makeBody(R, world, R.RigidBodyDesc.fixed(), sd.occ!.cls, q.x, q.y, q.z, q.yaw, 0, 0);
      }
      n++;
    });
    this.stats.bodies = n;
  }

  private dropBody(f: Flight) {
    if (f.body && this.sim) this.sim.physics.world.removeRigidBody(f.body);
    f.body = null;
  }

  private dropStandBody(s: Stand) {
    if (s.body && this.sim) this.sim.physics.world.removeRigidBody(s.body);
    s.body = null;
  }

  /** A moving aircraft over the player on foot knocks them down (its gear or its engines). */
  private runOver(sim: Simulation, me: { x: number; y: number; z: number }) {
    const ped = sim.registry.get(sim.playerPedId) as PedEntity | undefined;
    if (!ped || ped.vehicleId || ped.life !== 'alive') return;
    for (const f of this.flights) {
      const s = f.state;
      if (!f.body || s.speed < 1) continue;
      const dx = me.x - s.x, dy = me.y - s.y, dz = me.z - s.z;
      if (dx * dx + dz * dz > 80 * 80) continue;
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      for (const b of TYPES[s.cls].colliders) {
        if (Math.abs(lx - b.c[0]) < b.h[0] + 0.45 && Math.abs(dy + 0.9 - b.c[1]) < b.h[1] + 0.9 && Math.abs(lz - b.c[2]) < b.h[2] + 0.45) {
          // thrown along the way the aircraft moves (backwards in a pushback)
          const dir = s.phase === AircraftPhase.Pushback ? -1 : 1;
          knockDown(sim, ped, 3, Math.sin(s.yaw) * 9 * dir, Math.cos(s.yaw) * 9 * dir, 2.5);
          this.stats.runOver++;
          return;
        }
      }
    }
  }

  /** The aircraft block of the snapshot (after the ragdoll records). */
  write(view: SnapshotView, me: { x: number; z: number } | null) {
    const u = view.u32, fl = view.f32;
    const base = view.aircraftBase;
    // the moving aircraft, nearest first when there are more than the block holds
    let list = this.flights.filter((f) => !f.done && this.now >= f.t0);
    if (list.length > MAX_AIRCRAFT && me) list = list.sort((a, b) => Math.hypot(a.state.x - me.x, a.state.z - me.z) - Math.hypot(b.state.x - me.x, b.state.z - me.z) || a.id - b.id).slice(0, MAX_AIRCRAFT);
    const n = Math.min(MAX_AIRCRAFT, list.length);
    const ns = Math.min(MAX_STANDS, this.stands.length);
    u[base] = n;
    u[base + 1] = ns;
    for (let i = 0; i < n; i++) {
      const s = list[i].state;
      const o = base + 2 + i * AC_WORDS;
      u[o + AC.Id] = list[i].id;
      u[o + AC.Info] = AircraftInfo.pack(CLASS_INDEX[s.cls], s.livery, s.phase, s.flags);
      fl[o + AC.Px] = s.x;
      fl[o + AC.Py] = s.y;
      fl[o + AC.Pz] = s.z;
      fl[o + AC.Yaw] = s.yaw;
      fl[o + AC.Pitch] = s.pitch;
      fl[o + AC.Roll] = s.roll;
      fl[o + AC.Speed] = s.speed;
      fl[o + AC.Gear] = s.gear;
      fl[o + AC.Thrust] = s.thrust;
    }
    const sb = base + 2 + n * AC_WORDS;
    for (let i = 0; i < ns; i++) {
      const o = this.stands[i].occ;
      // a parked aircraft about to push back has its beacon on
      u[sb + i] = o ? StandWord.pack(CLASS_INDEX[o.cls], o.livery, o.planned || this.now > o.departAt - 60 ? AircraftFlag.Beacon : 0) : 0;
    }
  }

  dispose() {
    for (const f of this.flights) this.dropBody(f);
    for (const s of this.stands) this.dropStandBody(s);
  }
}

/** The empty aircraft block (a city with no airport). */
export function writeNoAircraft(view: SnapshotView) {
  const b = view.aircraftBase;
  view.u32[b] = 0;
  view.u32[b + 1] = 0;
}

/** A plan's track: [x, y, z, low] every TRACK_DT s. */
export function trackOf(plan: Plan): Float32Array {
  const n = Math.floor(plan.duration / TRACK_DT) + 1;
  const out = new Float32Array(n * 4);
  const p = newPose();
  for (let k = 0; k < n; k++) {
    poseAt(plan, k * TRACK_DT, p);
    out[k * 4] = p.x;
    out[k * 4 + 1] = p.y;
    out[k * 4 + 2] = p.z;
    const leg = plan.legs[p.leg];
    const m = leg.marks;
    const low = leg.kind === 'arrive' ? p.s > m.threshold - 400 : leg.kind === 'push' ? true : p.s < m.lift + 1200;
    out[k * 4 + 3] = low ? 1 : 0;
  }
  return out;
}

/** The ground's height near an aircraft in the air (the runway's), for "near the ground". */
function groundGuess(d: AerowayData, s: { x: number; z: number }): number {
  let best = 0, bd = Infinity;
  for (const r of d.runways) for (const e of r.ends) {
    const dd = Math.hypot(e.threshold[0] - s.x, e.threshold[2] - s.z);
    if (dd < bd) { bd = dd; best = e.threshold[1]; }
  }
  return best;
}

/** The rotation of an aircraft: yaw about +Y (nose (sin, cos)), then pitch (nose up) about its left axis, then roll. */
export function quatYPR(yaw: number, pitch: number, roll: number): { x: number; y: number; z: number; w: number } {
  // q = qy(yaw) * qx(-pitch) * qz(roll): +X is the left wing, and a positive turn about it dips the nose
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  // qy * qx
  const ax = cy * sp, ay = sy * cp, az = -sy * sp, aw = cy * cp;
  // (qy * qx) * qz
  return { x: ax * cr + ay * sr, y: ay * cr - ax * sr, z: aw * sr + az * cr, w: aw * cr - az * sr };
}

function makeBody(R: typeof RAPIER, world: RAPIER.World, desc: RAPIER.RigidBodyDesc, cls: AircraftClass, x: number, y: number, z: number, yaw: number, pitch: number, roll: number): RAPIER.RigidBody {
  desc.setTranslation(x, y, z).setRotation(quatYPR(yaw, pitch, roll));
  const body = world.createRigidBody(desc);
  for (const b of TYPES[cls].colliders) {
    const cd = R.ColliderDesc.cuboid(b.h[0], b.h[1], b.h[2]).setTranslation(b.c[0], b.c[1], b.c[2]).setCollisionGroups(GROUPS.world).setSolverGroups(GROUPS.world);
    world.createCollider(cd, body);
  }
  return body;
}
