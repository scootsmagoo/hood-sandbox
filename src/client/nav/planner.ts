/**
 * Turns a start, a waypoint and the loaded graphs into a search to run (`planDrive`, `planWalk`), and a finished search into a
 * `Route` with its turns (`driveRoute`, `walkRoute`). Pure: no DOM, no three.js.
 */
import { inRect } from './tiles';
import { DriveNet, DriveSearch, Turn, type DriveGoal, type DriveResult, type DriveSource } from './driveNet';
import { newHit } from './geom';
import { Route, RouteBuilder, type RouteStep } from './route';
import { WalkNet, WalkSearch, type WalkHit, type WalkResult } from './walkNet';

export interface Pose {
  x: number;
  z: number;
  /** A unit vector the vehicle faces; null on foot or when unknown. */
  heading?: { x: number; z: number } | null;
}

/** The search a request needs, or why there is none. */
export type DrivePlan = { search: DriveSearch; frontier: boolean } | { error: 'no-road' | 'no-graph' };

/** A leg longer than this from the road to the waypoint is drawn as a straight dashed tail. */
const TAIL_MIN_M = 8;

export function planDrive(net: DriveNet, from: Pose, to: { x: number; z: number }): DrivePlan {
  if (net.count === 0) return { error: 'no-graph' };
  const heading = from.heading ?? null;
  let cands = [] as ReturnType<DriveNet['near']>;
  for (const r of [14, 40, 120]) {
    cands = net.near(from.x, from.z, r, heading, 0.15);
    if (cands.length === 0 && heading) cands = net.near(from.x, from.z, r, null);
    if (cands.length) break;
  }
  if (!cands.length) return { error: 'no-road' };
  const sources: DriveSource[] = cands.slice(0, 8).map((c) => ({ edge: c.edge, s: c.s, cost: c.dist * 0.12 + (heading ? (1 - c.align) * 6 : 0) }));
  // the goal: the lanes of the nearest road, both directions, when the waypoint is in the loaded area
  let goals: DriveGoal[] | null = null;
  const inside = net.tileBounds.some((b) => inRect(b, to.x, to.z));
  if (inside) {
    const pick = (g: ReturnType<DriveNet['near']>): DriveGoal[] => g.filter((c) => c.dist <= g[0].dist + 8).slice(0, 10).map((c) => ({ edge: c.edge, s: c.s }));
    // a lane that nobody can drive to (a freeway stretch with no ramp in the loaded area, a parking lot's) is a goal only if there is
    // nothing else for 300 m: the route then ends at the nearest street, and the dashed tail does the rest
    for (const r of [40, 120, 300]) {
      const ok = net.near(to.x, to.z, r).filter((c) => !net.conn[c.edge] && net.reach[c.edge]);
      if (ok.length) {
        goals = pick(ok);
        break;
      }
    }
    if (!goals) {
      const any = net.near(to.x, to.z, 120).filter((c) => !net.conn[c.edge]);
      if (any.length) goals = pick(any);
    }
  }
  return { search: new DriveSearch(net, sources, goals, to.x, to.z), frontier: goals === null };
}

/** The route of a finished car search. `to` is the waypoint (a dashed tail runs to it when the road ends short of it). */
export function driveRoute(net: DriveNet, res: DriveResult, to: { x: number; z: number }): Route {
  const b = new RouteBuilder();
  const steps: RouteStep[] = [];
  const E = res.edges;
  let dist = 0;
  const hit = newHit();
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    const first = i === 0;
    const last = i === E.length - 1;
    const s0 = first ? res.startS : 0;
    const s1 = last ? res.endS : net.len[e];
    if (!first && net.conn[e]) {
      const kind = turnKind(net, E[i - 1], e);
      if (kind) steps.push({ s: dist, kind, street: net.streetName(e) });
    }
    b.addAlong(net.pts, net.ptOff[e], net.pointCount(e), s0, s1);
    dist += Math.max(0, s1 - s0);
  }
  void hit;
  let tail: { x: number; z: number } | null = null;
  const n = b.length;
  if (n > 0) {
    const d = Math.hypot(to.x - b.xs[n - 1], to.z - b.zs[n - 1]);
    if (res.partial || d > TAIL_MIN_M) tail = { x: to.x, z: to.z };
  }
  const route = new Route('drive', b, { tail, partial: res.partial, steps });
  if (!res.partial) route.steps.push({ s: route.length + route.tailLen, kind: 'arrive', street: '' });
  return route;
}

function turnKind(net: DriveNet, prev: number, conn: number): RouteStep['kind'] | null {
  switch (net.turn[conn]) {
    case Turn.Left:
      return 'left';
    case Turn.Right:
      return 'right';
    case Turn.UTurn:
      return 'uturn';
  }
  // straight on: only worth saying when the street changes name (or it is a ramp)
  const to = net.to[conn];
  if (to >= 0 && net.link[to] && !net.link[prev]) return 'ramp';
  const a = net.nameId[prev];
  const bn = net.nameId[conn];
  if (a !== bn && net.names[bn] !== '' && net.roadId[prev] !== net.roadId[conn]) return 'straight';
  return null;
}

export type WalkPlan = { search: WalkSearch; start: WalkHit; goal: WalkHit } | { route: Route } | { error: 'no-path' | 'no-graph' };

export function planWalk(net: WalkNet, from: Pose, to: { x: number; z: number }, nameAt: (x: number, z: number) => string): WalkPlan {
  if (net.edgeCount === 0) return { error: 'no-graph' };
  let start: WalkHit | null = null;
  for (const r of [60, 250]) {
    start = net.nearest(from.x, from.z, r);
    if (start) break;
  }
  if (!start) return { error: 'no-path' };
  // the nearest path to the waypoint; when it is not in the loaded area, the nearest one that is (the route then runs on straight)
  let goal: WalkHit | null = null;
  for (const r of [60, 300, 1500, 6000]) {
    goal = net.nearest(to.x, to.z, r);
    if (goal) break;
  }
  if (!goal) return { error: 'no-path' };
  if (start.edge === goal.edge) {
    const b = new RouteBuilder();
    b.add(start.x, start.y, start.z);
    b.add(goal.x, goal.y, goal.z);
    return { route: finishWalk(b, goal, to, nameAt) };
  }
  return { search: new WalkSearch(net, start, goal, goal.x, goal.z), start, goal };
}

export function walkRoute(net: WalkNet, res: WalkResult, start: WalkHit, goal: WalkHit, to: { x: number; z: number }, nameAt: (x: number, z: number) => string): Route {
  const b = new RouteBuilder();
  b.add(start.x, start.y, start.z);
  for (const n of res.nodes) b.add(net.nodes[n * 3], net.nodes[n * 3 + 1], net.nodes[n * 3 + 2]);
  b.add(goal.x, goal.y, goal.z);
  return finishWalk(b, goal, to, nameAt);
}

function finishWalk(b: RouteBuilder, goal: WalkHit, to: { x: number; z: number }, nameAt: (x: number, z: number) => string): Route {
  const far = Math.hypot(to.x - goal.x, to.z - goal.z);
  const tail = far > TAIL_MIN_M ? { x: to.x, z: to.z } : null;
  // "partial" when the paths end well short of the waypoint (it is not in the loaded area)
  const route = new Route('walk', b, { tail, partial: far > 120, steps: [] });
  route.steps = polylineSteps(route, nameAt);
  if (!route.partial) route.steps.push({ s: route.length + route.tailLen, kind: 'arrive', street: '' });
  return route;
}

/** Turns found from the shape of a polyline: a change of heading of more than `minDeg` over about 10 m each side. */
export function polylineSteps(route: Route, nameAt: (x: number, z: number) => string, minDeg = 55): RouteStep[] {
  const out: RouteStep[] = [];
  const n = route.count;
  if (n < 3) return out;
  const L = 10;
  const point = { x: 0, z: 0 };
  let lastS = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const s = route.cum[i];
    if (s - lastS < 25 || s < L || route.length - s < L) continue;
    const bx = route.pointAt(s - L, point).x;
    const bz = point.z;
    const ax = route.pointAt(s + L, point).x;
    const az = point.z;
    const px = route.xs[i], pz = route.zs[i];
    const d1x = px - bx, d1z = pz - bz;
    const d2x = ax - px, d2z = az - pz;
    const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
    if (l1 < 3 || l2 < 3) continue;
    const dot = (d1x * d2x + d1z * d2z) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
    if (ang < minDeg) continue;
    const cross = d1x * d2z - d1z * d2x;
    const street = nameAt(ax, az);
    out.push({ s, kind: ang > 150 ? 'uturn' : cross > 0 ? 'right' : 'left', street });
    lastS = s;
  }
  return out;
}
