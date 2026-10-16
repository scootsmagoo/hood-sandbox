/**
 * A flight's plan: the legs it moves along (a path and a speed profile each) and how its pose follows from the time. An arrival
 * comes in on a 3 degree glide path from 14 km out, flares, touches down 380 m past the threshold, rolls out and turns off at the
 * first taxiway it can take beyond its class's roll, taxis to its stand and stops on the stand's mark. A departure is pushed
 * back (a tug, nose away from the way it moves) off its stand onto the taxilane, waits for the tug to go, taxis to its runway,
 * holds short, lines up and waits, rolls, rotates and climbs out straight ahead to 16 km. Pure: the same inputs, the same plan.
 */
import { trimEnd, type AeroGraph, type AeroStand, type AircraftClass, type RunwayEnd } from '../../shared/aeroway';
import { AircraftFlag, AircraftPhase } from '../../shared/snapshot';
import { fillet, Path3, Profile, type V3 } from './path';
import { TYPES } from './types';

export interface Leg {
  kind: 'arrive' | 'push' | 'depart';
  path: Path3;
  prof: Profile;
  /** seconds from the plan's start */
  start: number;
  /** the nose faces away from the way it moves (a pushback) */
  reverse: boolean;
  /** arc lengths where the phases change (arrive: threshold, touchdown, exit, stand lead-in; depart: hold, line-up, roll, rotate, lift-off) */
  marks: Record<string, number>;
}

export interface Plan {
  kind: 'arrival' | 'departure';
  cls: AircraftClass;
  livery: number;
  stand: number;
  /** the runway (index) and the end it uses */
  runway: number;
  end: 0 | 1;
  legs: Leg[];
  duration: number;
  /** seconds from the start when it touches down (arrival) or starts its roll (departure) */
  tRunway: number;
  /** seconds from the start when it leaves its stand (a departure: the pushback ends) */
  tOffStand: number;
}

const APPROACH_LEN = 14000;
const GLIDE = Math.tan((3 * Math.PI) / 180);
const TOUCHDOWN = 380;
const CLIMB_LEN = 16000;
const deg = Math.PI / 180;

/** Turn radius on the ground by class, m. */
const TURN_R: Record<AircraftClass, number> = { narrowbody: 34, widebody: 46, regional: 28 };
/** Roll before it may turn off (from the threshold), m. */
const ROLL_MIN: Record<AircraftClass, number> = { narrowbody: 1500, widebody: 1900, regional: 1200 };
/** Takeoff acceleration, m/s^2. */
const TAKEOFF_A: Record<AircraftClass, number> = { narrowbody: 1.9, widebody: 1.6, regional: 2.0 };

/** The point of a runway end at `along` m from its threshold (on the centreline), with the ground height there. */
function runwayPoint(end: RunwayEnd, other: RunwayEnd, along: number): V3 {
  const t = end.threshold;
  const x = t[0] + end.dir[0] * along, z = t[2] + end.dir[1] * along;
  const L = Math.hypot(other.threshold[0] - t[0], other.threshold[2] - t[2]) || 1;
  const f = Math.max(0, Math.min(1, along / L));
  return [x, t[1] + (other.threshold[1] - t[1]) * f, z];
}

const alongOf = (end: RunwayEnd, p: ArrayLike<number>) => (p[0] - end.threshold[0]) * end.dir[0] + (p[2] - end.threshold[2]) * end.dir[1];

/** Rounds the corners of a ground path: high-speed exits (gentle corners) wide, sharp corners at the class's radius. */
function rounded(pts: V3[], r: number): V3[] {
  // two passes: the gentle corners first with a wide radius, then what is left with the class's
  const wide = fillet(pts, r * 2.6, 4);
  return fillet(wide, r, 3);
}

function legOf(kind: Leg['kind'], pts: V3[], spec: ConstructorParameters<typeof Profile>[1], start: number, reverse: boolean, marks: Record<string, number>): Leg {
  const path = new Path3(pts);
  return { kind, path, prof: new Profile(path, spec), start, reverse, marks };
}

/** Is an edge one an aircraft may taxi on (not a runway, not another stand's lead-in)? */
const taxiable = (g: AeroGraph) => (ei: number) => {
  const k = g.data.edges[ei].kind;
  return k === 'taxiway' || k === 'taxilane';
};

/** The lead-in of a stand as points from its entry to where the main gear stops (a wheelbase short of the stand's mark). */
function leadIn(g: AeroGraph, st: AeroStand, wheelbase: number): V3[] | null {
  const r = g.route(st.entry, st.node, (ei) => g.data.edges[ei].kind === 'leadin');
  if (!r) return null;
  const pts = g.polyline(r) as V3[];
  return trimEnd(pts, wheelbase);
}

/** An arrival to `stand` on runway end `endIdx` of runway `rwi`, or null when no way off the runway reaches the stand. */
export function planArrival(g: AeroGraph, cls: AircraftClass, livery: number, standIdx: number, rwi: number, endIdx: 0 | 1): Plan | null {
  const d = g.data;
  const st = d.stands[standIdx];
  const rw = d.runways[rwi];
  const E = rw.ends[endIdx], O = rw.ends[1 - endIdx];
  const T = TYPES[cls];
  const lead = leadIn(g, st, T.wheelbase);
  if (!lead) return null;
  // the exit: the first runway node past the class's roll with a taxiway off it that reaches the stand's entry
  let exit: { node: number; route: { edges: number[]; nodes: number[] } } | null = null;
  for (const n of E.nodes) {
    const al = alongOf(E, d.nodes[n]);
    if (al < ROLL_MIN[cls] || al > rw.length - 250) continue;
    const off = g.adj[n].filter((ei) => taxiable(g)(ei));
    if (!off.length) continue;
    // not a turn back of more than 100 degrees
    const ok = off.some((ei) => {
      const e = d.edges[ei];
      const p = e.a === n ? [e.pts[3], e.pts[5]] : [e.pts[e.pts.length - 6], e.pts[e.pts.length - 4]];
      const vx = p[0] - d.nodes[n][0], vz = p[1] - d.nodes[n][2];
      const l = Math.hypot(vx, vz) || 1;
      return (vx * E.dir[0] + vz * E.dir[1]) / l > Math.cos(100 * deg);
    });
    if (!ok) continue;
    const route = g.route(n, st.entry, taxiable(g));
    if (!route) continue;
    exit = { node: n, route };
    break;
  }
  if (!exit) return null;
  const thr = E.threshold;
  const yT = thr[1];
  const pts: V3[] = [];
  pts.push([thr[0] - E.dir[0] * APPROACH_LEN, yT + 15 + APPROACH_LEN * GLIDE, thr[2] - E.dir[1] * APPROACH_LEN]);
  pts.push([thr[0], yT + 15, thr[2]]);
  const td = runwayPoint(E, O, TOUCHDOWN);
  pts.push(td);
  const ground: V3[] = [td];
  for (const n of E.nodes) {
    const al = alongOf(E, d.nodes[n]);
    if (al > TOUCHDOWN + 10 && n !== exit.node && al < alongOf(E, d.nodes[exit.node])) ground.push(runwayPoint(E, O, al));
  }
  const taxi = g.polyline(exit.route) as V3[];
  ground.push(...taxi);
  ground.push(...lead.slice(1));
  const r = TURN_R[cls];
  const gpts = rounded(ground, r);
  const all = [...pts.slice(0, 2), ...gpts];
  const path0 = new Path3(all);
  // marks along the path
  const sThr = APPROACH_LEN;
  const sTouch = APPROACH_LEN + TOUCHDOWN;
  const exitAlong = alongOf(E, d.nodes[exit.node]);
  const sExit = APPROACH_LEN + exitAlong;
  const sLead = path0.length - Math.hypot(lead[lead.length - 1][0] - lead[0][0], lead[lead.length - 1][2] - lead[0][2]) - 10;
  const sp = T.speeds;
  const leg = legOf('arrive', all, {
    v0: sp.approach,
    v1: 0,
    vmax: (s) => (s < sThr ? sp.approach : s < sTouch ? sp.touchdown + 2 : s < sExit - 40 ? sp.touchdown : s < sLead ? sp.taxi : 2.5),
    accel: (s) => (s < sTouch ? 0.6 : 0.7),
    decel: (s) => (s < sTouch ? 0.6 : s < sExit + 30 ? 2.3 : 1.0),
    lateral: 1.1,
    vturnMin: 3,
    ds: (s) => (s < sThr - 300 ? 25 : 2),
  }, 0, false, { threshold: sThr, touch: sTouch, exit: sExit, lead: sLead });
  return { kind: 'arrival', cls, livery, stand: standIdx, runway: rwi, end: endIdx, legs: [leg], duration: leg.prof.duration, tRunway: timeAt(leg, sTouch), tOffStand: 0 };
}

/** The time (from the leg's start) when the leg reaches arc length s. */
function timeAt(leg: Leg, s: number): number {
  const P = leg.prof;
  for (let k = 1; k < P.s.length; k++) if (P.s[k] >= s) return leg.start + P.t[k];
  return leg.start + P.duration;
}

/** A departure from `stand` off runway end `endIdx` of runway `rwi`, or null. */
export function planDeparture(g: AeroGraph, cls: AircraftClass, livery: number, standIdx: number, rwi: number, endIdx: 0 | 1, holdNodes: Set<number>): Plan | null {
  const d = g.data;
  const st = d.stands[standIdx];
  const rw = d.runways[rwi];
  const E = rw.ends[endIdx], O = rw.ends[1 - endIdx];
  const T = TYPES[cls];
  const lead = leadIn(g, st, T.wheelbase);
  if (!lead) return null;
  // the runway entry: the first node from the departure end with a taxiway onto it that the stand reaches
  let entry: { node: number; route: { edges: number[]; nodes: number[] } } | null = null;
  for (const n of E.nodes) {
    const al = alongOf(E, d.nodes[n]);
    if (al < -30) continue;
    if (al > 700) break;
    if (!g.adj[n].some((ei) => taxiable(g)(ei))) continue;
    const route = g.route(st.entry, n, taxiable(g));
    if (!route) continue;
    entry = { node: n, route };
    break;
  }
  if (!entry) return null;
  // the pushback: back along the lead-in, then onto the taxilane the other way from where it will taxi
  const route = entry.route;
  const firstEdge = route.edges[0];
  const ent = d.nodes[st.entry];
  const dirOf = (ei: number): [number, number] => {
    const e = d.edges[ei];
    const p = e.a === st.entry ? [e.pts[3], e.pts[5]] : [e.pts[e.pts.length - 6], e.pts[e.pts.length - 4]];
    const vx = p[0] - ent[0], vz = p[1] - ent[2], l = Math.hypot(vx, vz) || 1;
    return [vx / l, vz / l];
  };
  const routeDir = firstEdge != null ? dirOf(firstEdge) : [1, 0];
  let ext: V3[] = [];
  let best = -1, bestDot = 0.2;
  for (const ei of g.adj[st.entry]) {
    if (ei === firstEdge || !taxiable(g)(ei)) continue;
    const v = dirOf(ei);
    const dot = -(v[0] * routeDir[0] + v[1] * routeDir[1]);
    if (dot > bestDot) { bestDot = dot; best = ei; }
  }
  const pushLen = cls === 'widebody' ? 55 : 42;
  if (best >= 0) {
    const pl = g.polyline({ edges: [best], nodes: [st.entry, g.other(best, st.entry)] }) as V3[];
    const p = new Path3(pl);
    const L = Math.min(pushLen, p.length * 0.9);
    const o = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
    for (let s = 0; s <= L; s += 3) {
      p.at(s, o);
      ext.push([o.x, o.y, o.z]);
    }
  } else {
    // nowhere to go but straight back off the stand
    const a = lead[lead.length - 1], b = lead[0];
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
    ext = [[b[0], b[1], b[2]], [b[0] + (dx / l) * pushLen * 0.6, b[1], b[2] + (dz / l) * pushLen * 0.6]];
  }
  const pushPts = fillet([...[...lead].reverse(), ...ext.slice(1)], 22, 2);
  const push = legOf('push', pushPts, { v0: 0, v1: 0, vmax: () => 1.4, accel: () => 0.3, decel: () => 0.35, lateral: 0.3, vturnMin: 0.6, ds: () => 1.5 }, 0, true, {});
  // the taxi out: back to the entry, the route, the runway entry; then the line-up, the roll and the climb out
  const r = TURN_R[cls];
  const taxi = g.polyline(route) as V3[];
  const ground: V3[] = [...[...ext].reverse(), ...taxi.slice(1)];
  // line up: a little way along the centreline from the entry node
  const rAlong = alongOf(E, d.nodes[entry.node]);
  ground.push(runwayPoint(E, O, rAlong + 60));
  const gpts = rounded(ground, r);
  const rollStart = gpts.length;
  const sp = T.speeds;
  const a = TAKEOFF_A[cls];
  const dRot = (sp.rotate * sp.rotate) / (2 * a);
  const dLift = dRot + sp.rotate * 3.5;
  const liftAlong = rAlong + 60 + dLift;
  const runwayEnd = rw.length;
  const air: V3[] = [];
  air.push(runwayPoint(E, O, Math.min(liftAlong, runwayEnd - 50)));
  const lift = air[0];
  // the climb: 7% to 2.5 km, then 5%
  const out = (dist: number, h: number): V3 => [lift[0] + E.dir[0] * dist, lift[1] + h, lift[2] + E.dir[1] * dist];
  for (const [dist, h] of [[600, 30], [2500, 160], [6000, 330], [CLIMB_LEN, 830]] as [number, number][]) air.push(out(dist, h));
  const all = [...gpts, ...air];
  void rollStart;
  const path0 = new Path3(all);
  // marks: the hold short (a hold node on the route, the last one), the line-up, the roll, the rotation, the lift-off
  const o = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
  const sOf = (p: ArrayLike<number>) => {
    // the arc length nearest a point (coarse then fine)
    let bs = 0, bd = Infinity;
    for (let s = 0; s <= path0.length; s += 4) {
      path0.at(s, o);
      const dd = Math.hypot(o.x - p[0], o.z - p[2]);
      if (dd < bd) { bd = dd; bs = s; }
    }
    return bs;
  };
  let sHold = -1;
  for (let k = route.nodes.length - 1; k >= 0; k--) if (holdNodes.has(route.nodes[k])) { sHold = sOf(d.nodes[route.nodes[k]]); break; }
  const lineup = runwayPoint(E, O, rAlong + 60);
  const sLine = sOf(lineup);
  const sLift = sLine + dLift;
  const sRot = sLine + dRot;
  const stops = [{ s: sLine, dwell: 14 }];
  if (sHold > 0 && sHold < sLine - 20) stops.push({ s: sHold, dwell: 7 });
  const dep = legOf('depart', all, {
    v0: 0,
    v1: 100,
    vmax: (s) => (s < sLine - 70 ? sp.taxi : s < sLine ? sp.turn : s < sLift ? 90 : 100),
    accel: (s) => (s < sLine ? 0.6 : s < sLift + 2000 ? a : 0.8),
    decel: () => 1.0,
    lateral: 1.1,
    vturnMin: 3,
    ds: (s) => (s < sLift + 400 ? 2 : 25),
    stops,
  }, push.prof.duration + 25, false, { hold: sHold, lineup: sLine, rotate: sRot, lift: sLift });
  const legs = [push, dep];
  return { kind: 'departure', cls, livery, stand: standIdx, runway: rwi, end: endIdx, legs, duration: dep.start + dep.prof.duration, tRunway: timeAt(dep, sLine + 1), tOffStand: push.prof.duration };
}

export interface AircraftPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  gear: number;
  thrust: number;
  phase: AircraftPhase;
  flags: number;
  /** the leg and arc length (for the conflict checks and tests) */
  leg: number;
  s: number;
}

export const newPose = (): AircraftPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, gear: 1, thrust: 0, phase: AircraftPhase.Parked, flags: 0, leg: 0, s: 0 });

const P = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const PA = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const PB = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const S = { s: 0, v: 0 };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The pose of a plan `t` seconds after its start. */
export function poseAt(plan: Plan, t: number, out: AircraftPose): AircraftPose {
  let li = 0;
  for (let k = 0; k < plan.legs.length; k++) if (t >= plan.legs[k].start) li = k;
  const leg = plan.legs[li];
  leg.prof.sample(t - leg.start, S);
  const s = S.s;
  leg.path.at(s, P);
  // the heading: the path's direction a few metres either side (smooth through a fillet's points)
  const look = Math.min(3, leg.path.length / 4);
  const a = leg.path.at(Math.max(0, s - look), PA);
  const b = leg.path.at(Math.min(leg.path.length, s + look), PB);
  let dx = b.x - a.x, dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-6) { dx = P.dx; dz = P.dz; }
  let yaw = Math.atan2(dx, dz);
  if (leg.reverse) yaw += Math.PI;
  if (yaw > Math.PI) yaw -= 2 * Math.PI;
  out.x = P.x;
  out.y = P.y;
  out.z = P.z;
  out.yaw = yaw;
  out.roll = 0;
  out.speed = S.v;
  out.leg = li;
  out.s = s;
  const m = leg.marks;
  let flags = AircraftFlag.Nav | AircraftFlag.Cabin;
  if (leg.kind === 'arrive') {
    const L = leg.path.length;
    // approach attitude, the flare, the nose lowered after the touchdown
    out.pitch = s < m.threshold ? 2.6 * deg : s < m.touch ? (2.6 + 3.0 * smooth(m.threshold - 120, m.touch, s)) * deg : 5.6 * deg * (1 - smooth(m.touch, m.touch + 260, s));
    out.gear = s < m.threshold - 9500 ? 0 : clamp01((s - (m.threshold - 9500)) / 450);
    out.thrust = s < m.touch ? 0.4 : s < m.touch + 600 ? 0.7 : 0.15;
    out.phase = s < m.touch ? AircraftPhase.Approach : s < m.exit ? AircraftPhase.Rollout : AircraftPhase.TaxiIn;
    flags |= AircraftFlag.Beacon;
    if (s < m.exit) flags |= AircraftFlag.Strobe | AircraftFlag.Landing;
    else flags |= AircraftFlag.Taxi;
    if (s >= L - 0.05 && S.v < 0.05) out.phase = AircraftPhase.Parked;
  } else if (leg.kind === 'push') {
    out.pitch = 0;
    out.gear = 1;
    out.thrust = 0.05;
    out.phase = AircraftPhase.Pushback;
    flags |= AircraftFlag.Beacon | AircraftFlag.Tug;
  } else {
    // taxi, hold, line up, roll, rotate, lift off, climb (the gear comes up 6 s after the lift-off)
    const grade = Math.atan(P.grade);
    out.pitch = s < m.rotate ? grade : s < m.lift ? 9 * deg * smooth(m.rotate, m.lift, s) : (13 - 4 * smooth(m.lift, m.lift + 3000, s)) * deg;
    out.gear = s < m.lift + 450 ? 1 : 1 - clamp01((s - m.lift - 450) / 500);
    out.thrust = s < m.lineup - 1 ? 0.18 : s < m.lift + 3000 ? 1 : 0.85;
    const holding = S.v < 0.05;
    out.phase = s < m.lineup - 1 ? (holding && m.hold > 0 && Math.abs(s - m.hold) < 2 ? AircraftPhase.Hold : AircraftPhase.TaxiOut) : s < m.lift ? (holding ? AircraftPhase.Hold : AircraftPhase.Takeoff) : AircraftPhase.Climb;
    flags |= AircraftFlag.Beacon;
    if (s >= m.lineup - 1) flags |= AircraftFlag.Strobe | AircraftFlag.Landing;
    else flags |= AircraftFlag.Taxi;
    if (s > m.lift + 9000) flags &= ~AircraftFlag.Landing;
  }
  if (t < leg.start && li === 0) out.phase = AircraftPhase.Parked;
  out.flags = flags;
  return out;
}
