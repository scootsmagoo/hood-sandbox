/**
 * Trains on the routes of a tile's transit layer, as plain state stepped at a fixed rate: no physics, no randomness, so the same
 * ticks give the same trains (the sim's determinism). A route is one line in one direction, cut at the edge of the loaded area;
 * routes that lie on the same track (two lines sharing a trunk, Red and Gold under Peachtree Street) are one *stream*, and the
 * trains of a stream keep their distance from the one ahead. Trains come in at a stream's source (where the route enters the
 * area) on the timetable's headway for the time of day, the stream's lines taking turns, run to the speed limit with the
 * timetable's acceleration and braking, stop with the head at each platform's far end, open their doors on the platform side,
 * dwell, close and go on, and are taken out once their last car has passed the sink. (A single tile's routes all run edge to
 * edge; a line that ends inside the area turns its trains round at the terminus by sending them out of service there.)
 */
import { headwayAt, routePoint, newRoutePoint, type RoutePoint, type TransitData, type TransitRoute, type TransitTimetable } from '../../shared/transit';
import car from '../../shared/data/railcar.json';

export const CAR = car;

/**
 * What the train model needs of a car (railcar.json by default). Another vehicle on rails (the airport's people mover) passes its
 * own: the model is otherwise only routes with stops (`TransitRoute`), a timetable and a clock.
 */
export interface CarSpec {
  length: number;
  gap: number;
  doors: { openS: number };
}

/** The length of a train of `n` cars, coupler gaps included. */
export const trainLength = (n: number, c: CarSpec = CAR) => n * c.length + (n - 1) * c.gap;

export type TrainPhase = 'run' | 'opening' | 'open' | 'closing';

export interface TrainState {
  /** the entity's id (0 until it has one) */
  id: number;
  route: number;
  stream: number;
  line: number;
  /** head position along the route, m, and speed, m/s */
  s: number;
  v: number;
  /** the next stop (index into the route's stops; its length when there is none) */
  stop: number;
  phase: TrainPhase;
  /** seconds into the phase */
  t: number;
  /** door opening, 0 to 1 */
  doors: number;
  /** how long it stands with its doors open at this stop, s */
  dwell: number;
  /** the speed-limit breakpoint it is on (a cursor) */
  limitAt: number;
  /** seconds of horn left */
  horn: number;
  /** set when it has left the area (the director removes it) */
  gone: boolean;
  /** seconds the doors are held open past the dwell (someone in the doorway) */
  hold: number;
}

export interface Stream {
  routes: number[];
  /** the stream's own clock offset (the "skip to the next station" fast-forwards a stream), s */
  shift: number;
  /** when the next train comes in (stream time), and which of its routes takes it */
  next: number;
  seq: number;
}

export interface TrainEvents {
  arrive(tr: TrainState, stopIdx: number): void;
  depart(tr: TrainState, stopIdx: number): void;
  doors(tr: TrainState, state: 'open' | 'closing' | 'closed'): void;
}

const NOOP: TrainEvents = { arrive() {}, depart() {}, doors() {} };

/** The streams of a transit layer: routes with the same track (the same polyline) share one. */
export function buildStreams(data: TransitData): { streams: Stream[]; streamOf: number[] } {
  const keyOf = (r: TransitRoute) => {
    const p = r.pts;
    const n = p.length;
    return `${Math.round(r.len)}|${Math.round(p[0])},${Math.round(p[2])}|${Math.round(p[n - 3])},${Math.round(p[n - 1])}`;
  };
  const streams: Stream[] = [];
  const byKey = new Map<string, number>();
  const streamOf: number[] = [];
  data.routes.forEach((r, i) => {
    const k = keyOf(r);
    let si = byKey.get(k);
    if (si === undefined) {
      si = streams.length;
      byKey.set(k, si);
      streams.push({ routes: [], shift: 0, next: 0, seq: 0 });
    }
    streams[si].routes.push(i);
    streamOf.push(si);
  });
  return { streams, streamOf };
}

/**
 * The trains of a set of routes. Reusable: it needs `data.routes` (with their `stops`, `speed`, `enter`), `data.stations` (only
 * for which stops are transfers), a timetable, a clock and a car spec; it knows nothing of Rapier, the snapshot or the player
 * (Transit.ts adds those).
 */
export class TrainModel {
  readonly streams: Stream[];
  readonly streamOf: number[];
  readonly trains: TrainState[] = [];
  readonly len: number;
  private readonly pt: RoutePoint = newRoutePoint();
  /** how far behind the tail of the train ahead a train stops, m */
  static readonly GAP = 60;
  /** the speed a train creeps at over its last metres to a stop, m/s */
  static readonly CREEP = 0.6;
  /** a train within this of its stop with a creep's speed has arrived, m */
  static readonly SNAP = 0.2;

  constructor(
    readonly data: TransitData,
    readonly tt: TransitTimetable = data.timetable,
    /** the time of day (game minutes) a stream time maps to, for the headways */
    private readonly clockAt: (streamTime: number) => number,
    readonly events: TrainEvents = NOOP,
    readonly car: CarSpec = CAR,
  ) {
    const b = buildStreams(data);
    this.streams = b.streams;
    this.streamOf = b.streamOf;
    this.len = trainLength(tt.cars, car);
  }

  /** Seconds between two trains of a stream at a time of day (every line of the stream has the timetable's headway; they take turns). */
  interval(st: Stream, minutes: number): number {
    return (headwayAt(this.tt, minutes) * this.tt.secondsPerMinute) / Math.max(1, st.routes.length);
  }

  /** The speed limit at s on a route. */
  limit(r: TransitRoute, tr: TrainState): number {
    const sp = r.speed;
    while (tr.limitAt + 1 < sp.length && sp[tr.limitAt + 1][0] <= tr.s) tr.limitAt++;
    return sp.length ? sp[tr.limitAt][1] : this.tt.maxSpeed;
  }

  /** The fastest a train may go now: the limit, every lower limit ahead within braking, the next stop, the train ahead. */
  allowed(r: TransitRoute, tr: TrainState, ahead: TrainState | null): number {
    const b = this.tt.brake;
    let v = Math.min(this.tt.maxSpeed, this.limit(r, tr));
    const sp = r.speed;
    // the limits ahead apply to the whole train: a train slows before a curve with its head and keeps the speed until its tail is through
    for (let k = tr.limitAt + 1; k < sp.length && sp[k][0] < tr.s + 600; k++) v = Math.min(v, Math.sqrt(sp[k][1] * sp[k][1] + 2 * b * Math.max(0, sp[k][0] - tr.s)));
    for (let k = tr.limitAt - 1; k >= 0 && sp[k + 1][0] > tr.s - this.len; k--) v = Math.min(v, sp[k][1]);
    const stop = r.stops[tr.stop];
    if (stop) {
      const d = stop.s - tr.s;
      v = Math.min(v, Math.max(d > TrainModel.SNAP ? TrainModel.CREEP : 0, Math.sqrt(2 * b * Math.max(0, d))));
    }
    if (ahead) {
      const gap = ahead.s - this.len - TrainModel.GAP - tr.s;
      v = Math.min(v, Math.sqrt(2 * b * Math.max(0, gap)) + Math.min(ahead.v, Math.max(0, gap) * 0.2));
      if (gap <= 0) v = 0;
    }
    return Math.max(0, v);
  }

  /** One train, one step. */
  step(tr: TrainState, dt: number, ahead: TrainState | null): void {
    const r = this.data.routes[tr.route];
    const tt = this.tt;
    tr.horn = Math.max(0, tr.horn - dt);
    if (tr.phase !== 'run') {
      tr.t += dt;
      const openS = this.car.doors.openS;
      if (tr.phase === 'opening') {
        tr.doors = Math.min(1, tr.t / openS);
        if (tr.t >= openS) {
          tr.phase = 'open';
          tr.t = 0;
          this.events.doors(tr, 'open');
        }
      } else if (tr.phase === 'open') {
        if (tr.t >= tr.dwell + tr.hold) {
          tr.phase = 'closing';
          tr.t = 0;
          tr.hold = 0;
          this.events.doors(tr, 'closing');
        }
      } else {
        tr.doors = Math.max(0, 1 - tr.t / openS);
        if (tr.t >= openS + 0.6) {
          this.events.doors(tr, 'closed');
          this.events.depart(tr, tr.stop);
          tr.phase = 'run';
          tr.t = 0;
          tr.doors = 0;
          tr.stop++;
        }
      }
      return;
    }
    const vmax = this.allowed(r, tr, ahead);
    if (tr.v < vmax) tr.v = Math.min(vmax, tr.v + tt.accel * dt * (1 - 0.35 * (tr.v / tt.maxSpeed)));
    else tr.v = Math.max(vmax, tr.v - Math.max(tt.brake, (tr.v - vmax) / Math.max(dt, 1e-3) * 0.5) * dt);
    tr.s += tr.v * dt;
    const stop = r.stops[tr.stop];
    if (stop && tr.s >= stop.s - TrainModel.SNAP && tr.v <= TrainModel.CREEP + 0.05) {
      tr.s = stop.s;
      tr.v = 0;
      tr.phase = 'opening';
      tr.t = 0;
      const st = this.data.stations[stop.station];
      tr.dwell = st && this.isTransfer(stop.station) ? tt.transferDwellS : tt.dwellS;
      this.events.arrive(tr, tr.stop);
    } else if (stop && tr.s > stop.s + 1) {
      // overran (should not happen): skip the stop
      tr.stop++;
    }
    // the horn as a train comes into a station
    if (stop && stop.s - tr.s < 160 && stop.s - tr.s > 150 && tr.v > 6) tr.horn = 0.8;
    if (tr.s - this.len > r.len + 5) tr.gone = true;
  }

  /** Whether a station is where lines cross (a longer dwell). */
  isTransfer(station: number): boolean {
    let lines = 0;
    const st = this.data.stations[station];
    if (!st) return false;
    lines = st.lines.length;
    return lines > 2 || st.platforms.length > 1;
  }

  /** Steps a stream: its trains leader first, then a new one in when one is due. Returns the trains it let in. */
  stepStream(si: number, now: number, dt: number, spawn: (tr: TrainState) => void): void {
    const st = this.streams[si];
    const time = now + st.shift;
    const mine = this.trains.filter((t) => t.stream === si && !t.gone).sort((a, b) => b.s - a.s);
    for (let k = 0; k < mine.length; k++) this.step(mine[k], dt, k > 0 ? mine[k - 1] : null);
    // a train comes in when one is due and the last one in has cleared the entrance
    if (time >= st.next) {
      const last = mine[mine.length - 1];
      if (!last || last.s - this.len > TrainModel.GAP) {
        const ri = st.routes[st.seq % st.routes.length];
        const r = this.data.routes[ri];
        const tr: TrainState = { id: 0, route: ri, stream: si, line: r.line, s: 0, v: 0, stop: 0, phase: 'run', t: 0, doors: 0, dwell: 0, limitAt: 0, horn: 0, gone: false, hold: 0 };
        // it comes in at the speed it would have (from beyond the edge), or standing at a terminus
        tr.v = r.enter ? Math.min(this.limit(r, tr), this.allowed(r, tr, last ?? null)) : 0;
        if (!r.enter && r.stops[0] && r.stops[0].s < 1) tr.s = r.stops[0].s;
        st.seq++;
        st.next += this.interval(st, this.clockAt(time));
        this.trains.push(tr);
        spawn(tr);
      } else st.next = time + 2;
    }
  }

  /** Steps every stream. */
  stepAll(now: number, dt: number, spawn: (tr: TrainState) => void): void {
    for (let si = 0; si < this.streams.length; si++) this.stepStream(si, now, dt, spawn);
  }

  /**
   * Runs the network for `seconds` before the sim starts (coarse steps), so the trains are already out on the line at the start,
   * spread as the timetable spreads them. Deterministic.
   */
  warmUp(start: number, seconds: number): void {
    for (const st of this.streams) st.next = start - seconds;
    const dt = 0.25;
    for (let t = start - seconds; t < start; t += dt) {
      this.stepAll(t, dt, () => {});
      this.reap();
    }
  }

  /** Drops the trains that have left. */
  reap(onGone?: (tr: TrainState) => void): void {
    for (let i = this.trains.length - 1; i >= 0; i--) {
      if (!this.trains[i].gone) continue;
      onGone?.(this.trains[i]);
      this.trains.splice(i, 1);
    }
  }

  /** The point at a distance along a train's route (extrapolated past the ends, for the cars still beyond the edge). */
  pointAt(route: number, s: number, out: RoutePoint = this.pt): RoutePoint {
    const r = this.data.routes[route];
    routePoint(r, s, out);
    if (s < 0) {
      out.x += out.dx * s;
      out.z += out.dz * s;
      out.y += out.grade * s;
    } else if (s > r.len) {
      const e = s - r.len;
      out.x += out.dx * e;
      out.z += out.dz * e;
      out.y += out.grade * e;
    }
    return out;
  }

  /** The distance along the route of car k's middle (0 the head car). */
  carMid(tr: TrainState, k: number): number {
    return tr.s - this.car.length / 2 - k * (this.car.length + this.car.gap);
  }

  /** Seconds a train expects to need to reach its next stop (a rough figure: the distance over a mean speed), or to leave the one it stands at. */
  eta(tr: TrainState): number {
    if (tr.phase === 'opening') return this.car.doors.openS - tr.t + tr.dwell;
    if (tr.phase === 'open') return Math.max(0, tr.dwell + tr.hold - tr.t);
    if (tr.phase === 'closing') return 0;
    const stop = this.data.routes[tr.route].stops[tr.stop];
    if (!stop) return -1;
    const d = stop.s - tr.s;
    return d / Math.max(4, Math.min(14, tr.v || 4)) + 2;
  }
}
