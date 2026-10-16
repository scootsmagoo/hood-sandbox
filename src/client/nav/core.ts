/**
 * The GPS without a screen: the waypoint, the route to it, and the rules for finding a new one. `NavCore` is fed the loaded graphs and
 * the player each frame and decides what to compute; the `Navigator` system wraps it with the data loading, the radar, the marker
 * and the sound. Pure (no DOM, no three.js), so the whole flow is tested headlessly.
 *
 *  - A waypoint snaps to the nearest road. Setting it where one already is clears it.
 *  - The route is a resumable A* run a small time budget a frame; the old route stays on screen until the new one is ready.
 *  - A new route is found when the waypoint is set, when the player switches between car and foot, when the loaded graphs change
 *    (a tile came or went: a route to somewhere not loaded runs to the edge of what is, then straight, and is extended as more loads),
 *    and when the player strays about 25 m for 2 s or goes back along the route (`RouteTracker`).
 *  - Within about 15 m of the waypoint it is reached: it clears itself.
 */
import { DriveNet, type DriveSearch } from './driveNet';
import { WalkNet, type WalkHit, type WalkSearch } from './walkNet';
import { planDrive, planWalk, driveRoute, walkRoute, type Pose } from './planner';
import { RoadIndex } from './roadIndex';
import { Route, RouteBuilder, type RouteMode } from './route';
import { arrived, RouteTracker, TRACK, type Track } from './tracker';

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** The street it snapped to ('' when unnamed or not snapped). */
  name: string;
  snapped: boolean;
  id: number;
  /** Where it was asked for (it may have snapped some way off): a second click there clears it as well. */
  askedX: number;
  askedZ: number;
}

export interface NavPlayer {
  x: number;
  y: number;
  z: number;
  /** A unit vector the player's vehicle faces (null on foot). */
  heading: { x: number; z: number } | null;
  inVehicle: boolean;
}

export type RouteStatus = 'none' | 'searching' | 'ok' | 'partial' | 'noroute';

export type NavEvent =
  | { type: 'set'; waypoint: Waypoint }
  | { type: 'clear'; reason: 'user' | 'arrived' }
  | { type: 'route'; route: Route; reason: string }
  | { type: 'noroute' };

/** How far from a road a click still snaps to it, m. */
export const SNAP_RADIUS_M = 150;
/** A click this close (m) to the waypoint clears it. */
export const CLEAR_RADIUS_M = 25;

type Job =
  | { kind: 'drive'; search: DriveSearch; reason: string; to: { x: number; z: number }; frontier: boolean }
  | { kind: 'walk'; search: WalkSearch; reason: string; to: { x: number; z: number }; start: WalkHit; goal: WalkHit };

export class NavCore {
  drive: DriveNet = DriveNet.empty();
  walk: WalkNet = WalkNet.empty();
  readonly roads = new RoadIndex();
  waypoint: Waypoint | null = null;
  route: Route | null = null;
  status: RouteStatus = 'none';
  readonly tracker = new RouteTracker();
  track: Track | null = null;
  /** Searches started and routes made, for tests and the debug readout. */
  stats = { searches: 0, routes: 0, reroutes: 0, lastMs: 0, worstMs: 0 };
  private readonly listeners = new Set<(e: NavEvent) => void>();
  private job: Job | null = null;
  private want: { reason: string; immediate: boolean } | null = null;
  private graphChangedAt = -Infinity;
  private clock = 0;
  private lastStartAt = -Infinity;
  private nextId = 1;
  private mode: RouteMode = 'drive';
  private jobMs = 0;
  /** The player of the last `update`: a failed search draws its straight line from where they are. */
  private lastPlayer: NavPlayer | null = null;

  on(fn: (e: NavEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: NavEvent) {
    for (const f of this.listeners) f(e);
  }

  /** The loaded graphs changed (a tile came in or went): the route is found again after a short pause. */
  setNets(drive: DriveNet, walk: WalkNet) {
    this.drive = drive;
    this.walk = walk;
    this.graphChangedAt = this.clock;
    this.job = null;
    if (this.waypoint) this.want = { reason: 'graph', immediate: false };
  }

  /** Snaps (x, z) to the nearest road and makes it the waypoint. */
  setWaypoint(x: number, z: number, fallbackY = 0): Waypoint {
    const hit = this.roads.nearest(x, z, SNAP_RADIUS_M);
    const wp: Waypoint = hit
      ? { x: hit.x, y: hit.y, z: hit.z, name: hit.road.name ?? '', snapped: true, id: this.nextId++, askedX: x, askedZ: z }
      : { x, y: fallbackY, z, name: '', snapped: false, id: this.nextId++, askedX: x, askedZ: z };
    this.waypoint = wp;
    this.route = null;
    this.track = null;
    this.job = null;
    this.status = 'searching';
    this.want = { reason: 'set', immediate: true };
    this.emit({ type: 'set', waypoint: wp });
    return wp;
  }

  clearWaypoint(reason: 'user' | 'arrived' = 'user') {
    if (!this.waypoint && !this.route) return;
    this.waypoint = null;
    this.route = null;
    this.track = null;
    this.job = null;
    this.want = null;
    this.status = 'none';
    this.emit({ type: 'clear', reason });
  }

  /** A click on the map: clears the waypoint when it is near it, else sets one there. Returns what happened. */
  toggleAt(x: number, z: number, nearM: number = CLEAR_RADIUS_M, fallbackY = 0): 'set' | 'cleared' {
    const w = this.waypoint;
    if (w && (Math.hypot(x - w.x, z - w.z) <= nearM || Math.hypot(x - w.askedX, z - w.askedZ) <= nearM)) {
      this.clearWaypoint('user');
      return 'cleared';
    }
    this.setWaypoint(x, z, fallbackY);
    return 'set';
  }

  /** Asks for a new route as soon as the rules allow. */
  requestRoute(reason: string, immediate = false) {
    if (this.waypoint) this.want = { reason, immediate };
  }

  get remainingM(): number {
    return this.track ? this.track.remaining : this.route ? this.route.remaining(0) : 0;
  }

  /** Runs one frame: arrival, tracking, starting a search when one is wanted, and stepping the one that runs. */
  update(dt: number, p: NavPlayer, budgetMs = 2.5) {
    this.clock += dt;
    this.lastPlayer = p;
    const wp = this.waypoint;
    if (!wp) return;
    if (arrived(p.x, p.z, wp.x, wp.z)) {
      this.clearWaypoint('arrived');
      return;
    }
    const mode: RouteMode = p.inVehicle ? 'drive' : 'walk';
    if (mode !== this.mode) {
      this.mode = mode;
      // the other graph: the old route is for the wrong kind of traveller
      if (this.route && this.route.mode !== mode) this.want = { reason: 'mode', immediate: true };
    }
    if (this.route) {
      const t = this.tracker.update(this.route, p.x, p.z, dt);
      this.track = t;
      if (t.reroute) this.want = { reason: t.reroute, immediate: false };
    } else if (!this.job && this.status !== 'searching') {
      this.want ??= { reason: 'missing', immediate: false };
    }
    // start a search
    if (this.want) {
      const w = this.want;
      // (a changed graph waits only for the burst of tiles to settle; the rest wait out the pause after the last search)
      const settled = this.clock - this.graphChangedAt >= 0.4;
      const calm = w.reason === 'graph' ? settled : this.clock - this.lastStartAt >= TRACK.minIntervalS && settled;
      if (w.immediate || calm) {
        this.want = null;
        this.start(p, wp, w.reason);
      }
    }
    // step the running one
    if (this.job) this.step(budgetMs, wp);
  }

  private start(p: NavPlayer, wp: Waypoint, reason: string) {
    this.lastStartAt = this.clock;
    this.stats.searches++;
    if (reason === 'off-route' || reason === 'regress') this.stats.reroutes++;
    const pose: Pose = { x: p.x, z: p.z, heading: p.inVehicle ? p.heading : null };
    const to = { x: wp.x, z: wp.z };
    this.jobMs = 0;
    if (p.inVehicle) {
      const plan = planDrive(this.drive, pose, to);
      if ('error' in plan) return this.fail(p, wp, reason);
      this.job = { kind: 'drive', search: plan.search, reason, to, frontier: plan.frontier };
    } else {
      const plan = planWalk(this.walk, pose, to, (x, z) => this.roads.nameAt(x, z));
      if ('error' in plan) return this.fail(p, wp, reason);
      if ('route' in plan) return this.accept(plan.route, reason);
      this.job = { kind: 'walk', search: plan.search, reason, to, start: plan.start, goal: plan.goal };
    }
    if (!this.route) this.status = 'searching';
  }

  private step(budgetMs: number, wp: Waypoint) {
    const job = this.job!;
    const t0 = performance.now();
    const out = job.search.step(budgetMs);
    this.jobMs += performance.now() - t0;
    if (out === 'running') return;
    this.job = null;
    this.stats.lastMs = this.jobMs;
    this.stats.worstMs = Math.max(this.stats.worstMs, this.jobMs);
    if (out === 'none') {
      const p = this.lastPlayer;
      return this.fail(p ?? { x: wp.x, y: wp.y, z: wp.z, heading: null, inVehicle: false }, wp, job.reason);
    }
    if (job.kind === 'drive') {
      const res = (job.search as DriveSearch).result!;
      this.accept(driveRoute(this.drive, res, job.to), job.reason);
    } else {
      const res = (job.search as WalkSearch).result!;
      this.accept(walkRoute(this.walk, res, job.start, job.goal, job.to, (x, z) => this.roads.nameAt(x, z)), job.reason);
    }
  }

  private accept(route: Route, reason: string) {
    this.route = route;
    this.mode = route.mode;
    this.tracker.reset();
    this.track = null;
    this.status = route.partial ? 'partial' : 'ok';
    this.stats.routes++;
    this.emit({ type: 'route', route, reason });
  }

  /** No road to follow: a straight dashed line to the waypoint, so the player still has a bearing. */
  private fail(p: NavPlayer, wp: Waypoint, reason: string) {
    const b = new RouteBuilder();
    b.add(p.x, p.y, p.z);
    const route = new Route(p.inVehicle ? 'drive' : 'walk', b, { tail: { x: wp.x, z: wp.z }, partial: true });
    this.route = route;
    this.tracker.reset();
    this.track = null;
    this.status = 'noroute';
    this.emit({ type: 'noroute' });
    this.emit({ type: 'route', route, reason });
  }
}
