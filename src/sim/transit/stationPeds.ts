/**
 * The people of a station, on a small budget: only the station the player is in has any. Some wait on its platforms (the
 * platforms' waiting spots, `transit.json` `waits`: the scenario points of the transit layer), facing the track, on their phones
 * now and then; when a train stops by them and opens its doors they walk to the nearest door and get on (and are gone). A train
 * that stops lets a few off, who walk the station's walk network (`transit.json` `walk`) up to the street and leave there.
 * They are ordinary people to everyone else (witnesses, people to scare), with a brain the director leaves in charge whenever
 * it wants them to run.
 */
import { OUTFIT_COUNT } from '../../shared/entityDefs';
import { PedPose } from '../../shared/snapshot';
import type { PedEntity } from '../entities';
import type { Simulation } from '../Simulation';
import type { Transit } from './Transit';
import { CAR, type TrainState } from './trains';
import { GROUPS } from '../physics/rapier';

const Mode = { Wait: 0, Board: 1, Leave: 2 } as const;

export const STATION_PEOPLE = {
  /** waiting on each platform at most, and in the whole station */
  perPlatform: 4,
  max: 12,
  /** getting off each train at most */
  alight: 3,
  /** a walker with no progress for this long is taken away, s */
  stuckS: 8,
  /** the player this far from the station's people: they go, m */
  dropM: 120,
} as const;

export class StationPeople {
  private readonly rng;
  /** who is the director's (entity ids), in creation order */
  readonly ids: number[] = [];
  private station = -1;
  private readonly adj: { to: number; len: number }[][];
  private readonly exits = new Set<number>();
  readonly stats = { spawned: 0, boarded: 0, alighted: 0, left: 0, stuck: 0 };

  constructor(
    private readonly sim: Simulation,
    private readonly transit: Transit,
  ) {
    this.rng = sim.rng.fork('station-people');
    const w = transit.data.walk;
    this.adj = w.nodes.map(() => []);
    for (let i = 0; i + 2 < w.edges.length; i += 3) {
      const a = w.edges[i], b = w.edges[i + 1];
      const pa = w.nodes[a], pb = w.nodes[b];
      const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      this.adj[a].push({ to: b, len });
      this.adj[b].push({ to: a, len });
    }
    // the street ends of the stations' entrances
    for (const st of transit.data.stations) for (const e of st.entrances) {
      const n = this.nearestNode(e.x, e.y, e.z, 4);
      if (n >= 0) this.exits.add(n);
    }
  }

  private nearestNode(x: number, y: number, z: number, within: number): number {
    const nodes = this.transit.data.walk.nodes;
    let best = -1, bd = within;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const d = Math.hypot(n[0] - x, (n[1] - y) * 2, n[2] - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** The shortest way over the walk network from a node to the nearest exit (node indices), or null. */
  private routeOut(from: number): number[] | null {
    const n = this.adj.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    dist[from] = 0;
    const open = [from];
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
      const u = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (this.exits.has(u)) {
        const path: number[] = [];
        for (let v = u; v >= 0; v = prev[v]) path.push(v);
        return path.reverse();
      }
      for (const e of this.adj[u]) {
        const d = dist[u] + e.len;
        if (d < dist[e.to]) {
          if (!Number.isFinite(dist[e.to])) open.push(e.to);
          dist[e.to] = d;
          prev[e.to] = u;
        }
      }
    }
    return null;
  }

  private mine(): PedEntity[] {
    const out: PedEntity[] = [];
    for (let i = this.ids.length - 1; i >= 0; i--) {
      const p = this.sim.registry.get(this.ids[i]) as PedEntity | undefined;
      if (!p) this.ids.splice(i, 1);
      else out.push(p);
    }
    return out;
  }

  private spawn(x: number, y: number, z: number, yaw: number, station: number, mode: number): PedEntity | null {
    const sim = this.sim;
    if (this.ids.length >= STATION_PEOPLE.max) return null;
    if (sim.physics.blockedAt(x, y, z, { vehicles: false })) return null;
    const outfit = 1 + this.rng.int(0, OUTFIT_COUNT - 2);
    const p = sim.addPed(x, y, z, yaw, outfit, true, (o) => {
      o.transit = { mode, path: [], at: 0, t: 0, target: null, trainId: 0, station, wait: 0 };
    });
    p.brain!.enter('idle');
    p.controller.queryGroups = GROUPS.undergroundQuery;
    p.controller.yaw = yaw;
    this.ids.push(p.id);
    this.stats.spawned++;
    return p;
  }

  /** A train stopped: those waiting by it head for its doors, and a few get off. */
  trainArrived(tr: TrainState, stopIdx: number): void {
    const stop = this.transit.data.routes[tr.route].stops[stopIdx];
    if (!stop || stop.station !== this.station) return;
    const doors: [number, number, number][] = [];
    for (let k = 0; k < this.transit.model.tt.cars; k++) for (let d = 0; d < CAR.doors.z.length; d++) {
      const o = this.transit.doorOutside(tr, k, d, 0.45);
      doors.push([o.x, o.y, o.z]);
    }
    for (const p of this.mine()) {
      const t = p.transit!;
      if (t.mode !== Mode.Wait || p.brain?.state !== 'idle') continue;
      const c = p.controller;
      let best = -1, bd = 7;
      doors.forEach((d, i) => {
        const dist = Math.hypot(d[0] - c.x, d[2] - c.z);
        if (dist < bd && Math.abs(d[1] - c.y) < 1.5) { bd = dist; best = i; }
      });
      if (best < 0) continue;
      t.mode = Mode.Board;
      t.target = doors[best];
      t.trainId = tr.id;
      t.t = 0;
      p.pose = PedPose.None;
    }
    // people getting off, at a few of its doors
    const n = this.rng.int(0, STATION_PEOPLE.alight);
    for (let i = 0; i < n; i++) {
      const d = doors[this.rng.int(0, doors.length - 1)];
      const p = this.spawn(d[0], this.transit.data.stations[stop.station].platforms[stop.platform].y, d[2], 0, stop.station, Mode.Leave);
      if (!p) continue;
      const from = this.nearestNode(d[0], this.transit.data.stations[stop.station].platforms[stop.platform].y, d[2], 25);
      const path = from >= 0 ? this.routeOut(from) : null;
      if (!path) {
        this.sim.despawn(p.id);
        continue;
      }
      p.transit!.path = path;
      p.transit!.at = 0;
      p.transit!.wait = 1 + i * 0.7;
      this.stats.alighted++;
      this.sim.emit({ type: 'transit:alight', tick: this.sim.tick, pedId: p.id, trainId: tr.id, station: stop.station });
    }
  }

  update(dt: number): void {
    const sim = this.sim;
    const tr = this.transit;
    const pp = sim.playerPosition();
    // the station of the player: its platforms get their waiting people (once, as the player comes in)
    const st = tr.station;
    if (st !== this.station) {
      this.station = st;
      if (st >= 0) this.populate(st);
    }
    const people = this.mine();
    for (const p of people) {
      const t = p.transit!;
      const c = p.controller;
      if (p.life !== 'alive') continue;
      const far = Math.hypot(c.x - pp.x, c.z - pp.z) > STATION_PEOPLE.dropM;
      if (far || (this.station < 0 && t.mode === Mode.Wait)) {
        sim.despawn(p.id);
        continue;
      }
      // a scared person is the brain's: it runs them
      if (p.brain && p.brain.state !== 'idle' && p.brain.state !== 'calm') continue;
      if (t.mode === Mode.Wait) {
        t.t += dt;
        // now and then the phone comes out
        if (t.t > 4 && (p.id * 7 + Math.floor(sim.tick / 600)) % 5 === 0) p.pose = PedPose.Phone;
        else if (p.pose === PedPose.Phone && (p.id * 7 + Math.floor(sim.tick / 600)) % 5 !== 0) p.pose = PedPose.None;
        continue;
      }
      if (t.mode === Mode.Board) {
        const train = tr.byId.get(t.trainId);
        if (!train || (train.phase !== 'open' && train.phase !== 'opening')) {
          // missed it: back to waiting where they are
          t.mode = Mode.Wait;
          t.target = null;
          continue;
        }
        const g = t.target!;
        if (this.walkTo(p, g[0], g[2], dt)) {
          sim.emit({ type: 'transit:board', tick: sim.tick, pedId: p.id, trainId: train.id, car: -1, seat: -1 });
          this.stats.boarded++;
          train.hold = Math.max(train.hold, 1);
          sim.despawn(p.id);
        }
        continue;
      }
      // leaving: along the path to the street
      if (t.wait > 0) {
        t.wait -= dt;
        continue;
      }
      const nodes = tr.data.walk.nodes;
      const n = nodes[t.path[t.at]];
      if (!n) {
        sim.despawn(p.id);
        this.stats.left++;
        continue;
      }
      if (this.walkTo(p, n[0], n[2], dt)) {
        t.at++;
        t.t = 0;
        if (t.at >= t.path.length) {
          sim.despawn(p.id);
          this.stats.left++;
        }
      } else if ((t.t += dt) > STATION_PEOPLE.stuckS) {
        sim.despawn(p.id);
        this.stats.stuck++;
      }
    }
  }

  /** Walks toward (x, z); true when there. */
  private walkTo(p: PedEntity, x: number, z: number, dt: number): boolean {
    void dt;
    const c = p.controller;
    const dx = x - c.x, dz = z - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.55) {
      p.input.moveY = 0;
      return true;
    }
    p.input.moveX = 0;
    p.input.moveY = 0.5;
    // the controller faces (-sin camYaw, -cos camYaw) forward
    p.input.camYaw = Math.atan2(-dx, -dz);
    p.input.sprint = false;
    return false;
  }

  /** Waiting people on a station's platforms, at their waiting spots (deterministic for the station and the time). */
  private populate(si: number): void {
    const st = this.transit.data.stations[si];
    for (const pl of st.platforms) {
      const spots = [...pl.waits];
      for (let k = 0; k < STATION_PEOPLE.perPlatform && spots.length; k++) {
        const w = spots.splice(this.rng.int(0, spots.length - 1), 1)[0];
        this.spawn(w[0], w[1], w[2], w[3], si, Mode.Wait);
      }
    }
  }

  /** Everyone of the director's, gone (a sim reset). */
  clear(): void {
    for (const p of this.mine()) this.sim.despawn(p.id);
  }
}
