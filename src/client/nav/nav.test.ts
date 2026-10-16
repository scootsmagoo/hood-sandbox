import { describe, expect, it } from 'vitest';
import { fixtureIndex } from '../../shared/fixture';
import type { RoadData } from '../../shared/tile';
import { NavCore, type NavPlayer } from './core';
import { DriveSearch } from './driveNet';
import { MinHeap } from './heap';
import { NavData } from './navData';
import { planDrive, planWalk, driveRoute, polylineSteps, walkRoute } from './planner';
import { RoadIndex } from './roadIndex';
import { describeStep, formatDistance, Route, RouteBuilder } from './route';
import { fixtureSource, roofTriangles } from './source';
import { arrived, RouteTracker, TRACK } from './tracker';
import { WalkSearch } from './walkNet';

/** The fixture city with some of its tiles loaded into a core. */
async function city(ids: string[], settleMs = 0) {
  const index = fixtureIndex({ half: 1 });
  const source = fixtureSource(index, 'fixture');
  const core = new NavCore();
  const data = new NavData(source, core, settleMs);
  data.setLoaded(ids);
  await data.settled();
  return { core, data, source, index };
}

const foot = (x: number, z: number): NavPlayer => ({ x, y: 0, z, heading: null, inVehicle: false });
const car = (x: number, z: number, hx = 1, hz = 0): NavPlayer => ({ x, y: 0, z, heading: { x: hx, z: hz }, inVehicle: true });

/** Runs a car search to its end. */
function runDrive(core: NavCore, from: { x: number; z: number; heading?: { x: number; z: number } | null }, to: { x: number; z: number }) {
  const plan = planDrive(core.drive, from, to);
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.search.step(1000)).toBe('found');
  return { route: driveRoute(core.drive, plan.search.result!, to), res: plan.search.result!, frontier: plan.frontier };
}

function simulate(core: NavCore, p: NavPlayer, seconds: number, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) core.update(dt, p, 50);
}

describe('routing over the lane graph', () => {
  it('builds one directed net from a tile, with named streets', async () => {
    const { core } = await city(['0_0']);
    expect(core.drive.count).toBeGreaterThan(60);
    expect(core.drive.frontier.length).toBeGreaterThan(0);
    const names = new Set(core.drive.names);
    expect(names.has('Fixture Avenue')).toBe(true);
  });

  it('respects one-ways: against the street the route goes round the block', async () => {
    const { core } = await city(['1_0']);
    // "One Way" runs north-south along x = 480 in the middle tile column of the fixture
    const net = core.drive;
    let dir = 0;
    for (let e = 0; e < net.count && !dir; e++) {
      if (net.conn[e] || net.streetName(e) !== 'One Way') continue;
      const o = net.ptOff[e] * 3;
      const last = (net.ptOff[e + 1] - 1) * 3;
      dir = Math.sign(net.pts[last + 2] - net.pts[o + 2]);
    }
    expect(dir).not.toBe(0);
    const along = dir; // +1: traffic runs towards +z
    // (the one-way's lanes start at a junction and run to the next: the points are between 4th St and the avenue)
    const upstream = { x: 481, z: along > 0 ? 125 : 260 };
    const downstream = { x: 481, z: along > 0 ? 260 : 125 };
    const fwd = runDrive(core, { ...upstream, heading: { x: 0, z: along } }, downstream);
    const back = runDrive(core, { ...downstream, heading: { x: 0, z: -along } }, upstream);
    // with the street: about the straight 200 m. against it: round the block
    expect(fwd.route.length).toBeLessThan(260);
    expect(back.route.length).toBeGreaterThan(fwd.route.length + 150);
    // and no part of the long one drives against the one-way
    const r = back.route;
    for (let i = 0; i + 1 < r.count; i++) {
      if (Math.abs(r.xs[i] - 480) < 3 && Math.abs(r.xs[i + 1] - 480) < 3 && Math.abs(r.zs[i + 1] - r.zs[i]) > 0.5) {
        expect(Math.sign(r.zs[i + 1] - r.zs[i])).toBe(along);
      }
    }
  });

  it('says its turns, with the street they turn onto', async () => {
    const { core } = await city(['0_0']);
    const { route } = runDrive(core, { x: 20, z: 96, heading: { x: 1, z: 0 } }, { x: 288, z: 200 });
    const turns = route.steps.filter((s) => s.kind === 'left' || s.kind === 'right');
    expect(turns.length).toBeGreaterThan(0);
    expect(route.steps[route.steps.length - 1].kind).toBe('arrive');
    expect(turns.every((t) => t.s >= 0 && t.s <= route.length)).toBe(true);
    expect(turns.some((t) => t.street.length > 0)).toBe(true);
  });

  it('a route with the goal behind the car on its own lane does not drive backwards', async () => {
    const { core } = await city(['0_0']);
    const here = { x: 150, z: 96, heading: { x: 1, z: 0 } };
    const { route } = runDrive(core, here, { x: 100, z: 99 });
    // it has to turn round: a loop, much longer than the 50 m as the crow flies
    expect(route.length).toBeGreaterThan(150);
  });
});

describe('routing on foot', () => {
  it('walks sidewalks and crossings between two points', async () => {
    const { core } = await city(['0_0']);
    const to = { x: 270, z: 250 };
    const plan = planWalk(core.walk, { x: 60, z: 60 }, to, () => '');
    expect('search' in plan).toBe(true);
    if (!('search' in plan)) return;
    expect(plan.search.step(1000)).toBe('found');
    const route = walkRoute(core.walk, plan.search.result!, plan.start, plan.goal, to, () => '');
    expect(route.mode).toBe('walk');
    expect(route.length).toBeGreaterThanOrEqual(Math.hypot(210, 190) - 1);
    expect(route.length).toBeLessThan(900);
    expect(Math.hypot(route.xs[0] - 60, route.zs[0] - 60)).toBeLessThan(40);
  });

  it('two points on one path are one straight leg', async () => {
    const { core } = await city(['0_0']);
    const nearA = core.walk.nearest(100, 90, 40)!;
    const plan = planWalk(core.walk, { x: nearA.x, z: nearA.z }, { x: nearA.x + 0.5, z: nearA.z }, () => '');
    expect(plan).toHaveProperty('route');
  });
});

describe('snapping to roads', () => {
  const road = (id: string, cls: string, z: number): RoadData => ({ id, class: cls, name: id, lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[0, 0, z], [200, 0, z]] });

  it('puts a click on the nearest road centreline', () => {
    const idx = new RoadIndex();
    idx.setTile('a', [road('north', 'residential', 0), road('south', 'residential', 100)]);
    const h = idx.nearest(60, 70, 150)!;
    expect(h.road.id).toBe('south');
    expect(h.z).toBeCloseTo(100, 5);
    expect(h.x).toBeCloseTo(60, 5);
    expect(idx.nearest(60, 500, 100)).toBeNull();
  });

  it('prefers a street to a service lot when they are about as near, and forgets a dropped tile', () => {
    const idx = new RoadIndex();
    idx.setTile('a', [road('lot', 'service', 40), road('avenue', 'primary', 50)]);
    expect(idx.nearest(10, 45, 100)!.road.id).toBe('avenue');
    expect(idx.nearest(10, 38, 100)!.road.id).toBe('lot');
    idx.dropTile('a');
    expect(idx.nearest(10, 45, 100)).toBeNull();
    expect(idx.tileCount).toBe(0);
  });

  it('keeps a tile\'s roads until the GPS and the map have both let go of it', () => {
    const idx = new RoadIndex();
    const r = road('r', 'primary', 10);
    idx.setTile('a', [r], 'nav');
    idx.setTile('a', [r], 'map');
    idx.dropTile('a', 'map');
    expect(idx.nearest(10, 12, 50)).not.toBeNull();
    idx.dropTile('a', 'nav');
    expect(idx.nearest(10, 12, 50)).toBeNull();
  });

  it('a waypoint set in the open lands on the road and keeps its name', async () => {
    const { core } = await city(['0_0']);
    const w = core.setWaypoint(200, 150);
    expect(w.snapped).toBe(true);
    expect(w.name).not.toBe('');
    expect(Math.hypot(w.x - 200, w.z - 150)).toBeLessThan(150);
  });
});

describe('the re-route rules', () => {
  const straight = () => {
    const b = new RouteBuilder();
    for (let x = 0; x <= 1000; x += 10) b.add(x, 0, 0);
    return new Route('drive', b);
  };

  it('stays quiet while the player is on the line, and while a little off it', () => {
    const r = straight();
    const t = new RouteTracker();
    t.reset();
    let x = 0;
    for (let i = 0; i < 600; i++) {
      x += 0.5;
      const tr = t.update(r, x, i % 2 ? 8 : -8, 1 / 30);
      expect(tr.reroute).toBeNull();
    }
    expect(t.track.s).toBeGreaterThan(100);
  });

  it('asks for a new route after about 2 s more than 25 m off, not before', () => {
    const r = straight();
    const t = new RouteTracker();
    t.reset();
    let asked = -1;
    for (let i = 0; i < 400 && asked < 0; i++) {
      if (t.update(r, 300, 30, 1 / 30).reroute) asked = i / 30;
    }
    expect(asked).toBeGreaterThanOrEqual(TRACK.offTimeS - 0.05);
    expect(asked).toBeLessThan(TRACK.offTimeS + 0.2);
    // a short stray that comes back resets the clock
    const t2 = new RouteTracker();
    t2.reset();
    for (let k = 0; k < 5; k++) {
      for (let i = 0; i < 40; i++) expect(t2.update(r, 300, 40, 1 / 30).reroute).toBeNull();
      t2.update(r, 300, 2, 1 / 30);
    }
  });

  it('asks again when the player turns back along the route', () => {
    const r = straight();
    const t = new RouteTracker();
    t.reset();
    for (let x = 0; x <= 400; x += 5) t.update(r, x, 0, 0.05);
    let reason: string | null = null;
    for (let x = 400; x > 150 && !reason; x -= 5) reason = t.update(r, x, 0, 0.1).reroute;
    expect(reason).toBe('regress');
  });

  it('a stray inside the pause after a route is not answered at once', () => {
    const r = straight();
    const t = new RouteTracker();
    t.reset();
    let n = 0;
    for (let i = 0; i < 40; i++) if (t.update(r, 300, 60, 0.05).reroute) n++;
    expect(n).toBeGreaterThan(0);
    // 2 s of strays but the route is only 1 s old
    const t2 = new RouteTracker();
    t2.reset();
    let early = 0;
    for (let i = 0; i < 20; i++) if (t2.update(r, 300, 60, 0.05).reroute) early++;
    expect(early).toBe(0);
  });

  it('arrival is within 15 m', () => {
    expect(arrived(0, 0, 14, 0)).toBe(true);
    expect(arrived(0, 0, 16, 0)).toBe(false);
  });
});

describe('the whole flow', () => {
  it('sets a waypoint, finds a route, re-routes after a wrong turn, and clears on arrival', async () => {
    const { core } = await city(['0_0']);
    const events: string[] = [];
    core.on((e) => events.push(e.type === 'route' ? `route:${e.reason}` : e.type === 'clear' ? `clear:${e.reason}` : e.type));
    const start = { x: 20, z: 96 };
    const wp = core.setWaypoint(288, 288);
    expect(core.status).toBe('searching');
    let p = car(start.x, start.z);
    simulate(core, p, 0.3);
    expect(core.route).not.toBeNull();
    expect(core.status).toBe('ok');
    const first = core.route!;
    expect(first.mode).toBe('drive');
    expect(events).toContain('route:set');

    // follow the route for a while: no new route
    const n0 = core.stats.routes;
    for (let s = 5; s < Math.min(120, first.length - 40); s += 1) {
      const q = first.pointAt(s, { x: 0, z: 0 });
      p = car(q.x, q.z);
      simulate(core, p, 0.05);
    }
    expect(core.stats.routes).toBe(n0);

    // a wrong turn: far from the route for several seconds
    const away = car(40, 290);
    simulate(core, away, 4);
    expect(core.stats.reroutes).toBeGreaterThan(0);
    expect(core.route!.id).not.toBe(first.id);
    expect(events.some((e) => e === 'route:off-route')).toBe(true);
    expect(Math.hypot(core.route!.xs[0] - away.x, core.route!.zs[0] - away.z)).toBeLessThan(40);

    // switching to foot finds a walking route
    simulate(core, foot(away.x + 4, away.z), 0.4);
    expect(core.route!.mode).toBe('walk');

    // arriving clears it
    simulate(core, foot(wp.x + 6, wp.z), 0.1);
    expect(core.waypoint).toBeNull();
    expect(core.route).toBeNull();
    expect(core.status).toBe('none');
    expect(events[events.length - 1]).toBe('clear:arrived');
  });

  it('a click on the waypoint clears it, a click elsewhere moves it', async () => {
    const { core } = await city(['0_0']);
    const w = core.setWaypoint(200, 100);
    expect(core.toggleAt(w.x + 5, w.z + 5)).toBe('cleared');
    expect(core.waypoint).toBeNull();
    core.setWaypoint(200, 100);
    expect(core.toggleAt(40, 300)).toBe('set');
    expect(core.waypoint).not.toBeNull();
  });

  it('with no road near the car, draws a straight line instead of nothing', async () => {
    const { core } = await city(['0_0']);
    core.setWaypoint(250, 250);
    simulate(core, car(10000, 10000), 0.3);
    expect(core.status).toBe('noroute');
    expect(core.route!.tail).not.toBeNull();
  });
});

describe('routes across a streamed seam', () => {
  it('joins the lanes and the paths of neighbouring tiles', async () => {
    const { core } = await city(['0_0', '1_0']);
    expect(core.drive.stitched).toBeGreaterThan(0);
    expect(core.walk.stitched).toBeGreaterThan(0);
    expect(core.drive.tileIds).toEqual(['0_0', '1_0']);
  });

  it('drives from one tile into the next over the seam at x = 384', async () => {
    const { core } = await city(['0_0', '1_0']);
    const { route, frontier } = runDrive(core, { x: 60, z: 96, heading: { x: 1, z: 0 } }, { x: 600, z: 96 });
    expect(frontier).toBe(false);
    expect(route.partial).toBe(false);
    expect(Math.min(...route.xs)).toBeLessThan(384);
    expect(Math.max(...route.xs)).toBeGreaterThan(560);
    // it crosses the seam once on a lane, in one go
    let crossings = 0;
    for (let i = 0; i + 1 < route.count; i++) if (route.xs[i] <= 384 && route.xs[i + 1] > 384) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(1);
  });

  it('walks across the seam too', async () => {
    const { core } = await city(['0_0', '1_0']);
    const to = { x: 600, z: 100 };
    const plan = planWalk(core.walk, { x: 60, z: 100 }, to, () => '');
    if (!('search' in plan)) throw new Error('no search');
    expect(plan.search.step(1000)).toBe('found');
    const route = walkRoute(core.walk, plan.search.result!, plan.start, plan.goal, to, () => '');
    expect(route.partial).toBe(false);
    expect(Math.min(...route.xs)).toBeLessThan(384);
    expect(Math.max(...route.xs)).toBeGreaterThan(560);
  });

  it('a waypoint past the loaded tiles routes to the edge of what is loaded, then straight, and extends when the next tile comes', async () => {
    const { core, data } = await city(['0_0']);
    const wp = core.setWaypoint(600, 96);
    // (600, 96) is in tile 1_0, which is not loaded: the roads index has nothing there, so the waypoint is not snapped
    expect(wp.snapped).toBe(false);
    simulate(core, car(60, 96), 0.3);
    const partial = core.route!;
    expect(core.status).toBe('partial');
    expect(partial.partial).toBe(true);
    expect(partial.tail).not.toBeNull();
    // it runs to the east edge of tile 0_0 and not past
    expect(Math.max(...partial.xs)).toBeGreaterThan(370);
    expect(Math.max(...partial.xs)).toBeLessThanOrEqual(384.5);
    // the next tile loads: the route is found again, now whole
    data.setLoaded(['0_0', '1_0']);
    await data.settled();
    simulate(core, car(60, 96), 1);
    expect(core.status).toBe('ok');
    expect(core.route!.partial).toBe(false);
    expect(Math.max(...core.route!.xs)).toBeGreaterThan(560);
  });

  it('dropping the tile under the route finds a new one without crashing', async () => {
    const { core, data } = await city(['0_0', '1_0']);
    core.roads.setTile('1_0', await fixtureSource(fixtureIndex({ half: 1 }), 'fixture').roads('1_0'));
    core.setWaypoint(600, 96);
    simulate(core, car(60, 96), 0.3);
    expect(core.status).toBe('ok');
    data.setLoaded(['0_0']);
    await data.settled();
    simulate(core, car(60, 96), 1);
    expect(['partial', 'ok', 'noroute']).toContain(core.status);
    expect(core.drive.tileIds).toEqual(['0_0']);
  });
});

describe('the search is incremental', () => {
  it('can be run a sliver at a time and finds the same route', async () => {
    const { core } = await city(['0_0', '1_0']);
    const to = { x: 600, z: 300 };
    const a = planDrive(core.drive, { x: 60, z: 96, heading: { x: 1, z: 0 } }, to);
    if ('error' in a) throw new Error(a.error);
    let steps = 0;
    while (a.search.step(0.02) === 'running' && steps++ < 100000);
    const b = planDrive(core.drive, { x: 60, z: 96, heading: { x: 1, z: 0 } }, to);
    if ('error' in b) throw new Error(b.error);
    b.search.step(1000);
    expect(a.search.result!.edges).toEqual(b.search.result!.edges);
    expect(a.search instanceof DriveSearch).toBe(true);
    void WalkSearch;
  });
});

describe('route building and the turn prompt', () => {
  it('cuts a polyline between two distances', () => {
    const pts = [0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0];
    const b = new RouteBuilder();
    b.addAlong(pts, 0, 4, 5, 25);
    expect(Array.from(b.xs)).toEqual([5, 10, 20, 25]);
    // the whole of it, and an empty cut
    const all = new RouteBuilder();
    all.addAlong(pts, 0, 4, 0, 30);
    expect(all.xs.length).toBe(4);
    const same = new RouteBuilder();
    same.addAlong(pts, 0, 4, 12, 12);
    expect(same.length).toBeLessThanOrEqual(2);
  });

  it('locates a point on a route and measures what is left', () => {
    const b = new RouteBuilder();
    for (let x = 0; x <= 100; x += 10) b.add(x, 0, 0);
    const r = new Route('drive', b, { tail: { x: 100, z: 40 } });
    const hit = { s: 0, off: 0, seg: 0 };
    r.locate(35, 4, 0, hit);
    expect(hit.s).toBeCloseTo(35, 4);
    expect(hit.off).toBeCloseTo(4, 4);
    expect(r.remaining(35)).toBeCloseTo(65 + 40, 4);
    // from the far end of the route a whole-route search finds it too
    r.locate(95, 0, 0, hit);
    expect(hit.s).toBeCloseTo(95, 4);
  });

  it('writes turns and distances the way the prompt says them', () => {
    expect(describeStep({ s: 0, kind: 'left', street: 'Peachtree Street Northeast' })).toBe('Turn left onto Peachtree St NE');
    expect(describeStep({ s: 0, kind: 'right', street: '' })).toBe('Turn right');
    expect(describeStep({ s: 0, kind: 'uturn', street: '' })).toBe('Make a U-turn');
    expect(describeStep({ s: 0, kind: 'ramp', street: 'Interstate 75' })).toContain('ramp');
    expect(formatDistance(42)).toBe('40 m');
    expect(formatDistance(480)).toBe('480 m');
    expect(formatDistance(1740)).toBe('1.7 km');
    expect(formatDistance(23500)).toBe('24 km');
  });

  it('finds the turns of a walking route from its shape', () => {
    const b = new RouteBuilder();
    for (let x = 0; x <= 100; x += 3) b.add(x, 0, 0);
    for (let z = 3; z <= 100; z += 3) b.add(100, 0, z);
    for (let x = 97; x >= 0; x -= 3) b.add(x, 0, 100);
    const r = new Route('walk', b);
    const steps = polylineSteps(r, () => 'Main St');
    // east, then south, then west: two right turns
    expect(steps.map((s) => s.kind)).toEqual(['right', 'right']);
    expect(steps[0].s).toBeGreaterThan(90);
    expect(steps[0].s).toBeLessThan(110);
    expect(steps[0].street).toBe('Main St');
  });
});

describe('the roof triangles of a collision mesh are the footprints', () => {
  it('keeps the flat ones and drops the walls', () => {
    // a box 10 x 10, 8 m tall: a roof of two triangles and a wall of two
    const pos = new Float32Array([0, 8, 0, 10, 8, 0, 10, 8, 10, 0, 8, 10, 0, 0, 0, 10, 0, 0]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 5, 0, 5, 4]);
    const t = roofTriangles(pos, idx, 4);
    expect(t.length).toBe(12);
    expect(Array.from(t.slice(0, 6))).toEqual([0, 0, 10, 0, 10, 10]);
    // only the first n triangles are buildings
    expect(roofTriangles(pos, idx, 1).length).toBe(6);
  });
});

describe('the heap', () => {
  it('pops in order, and keeps its storage across a clear', () => {
    const h = new MinHeap();
    const keys = Array.from({ length: 2000 }, (_, i) => ((i * 7919) % 2003) + 0.5);
    keys.forEach((k, i) => h.push(k, i));
    let last = -Infinity;
    for (let i = 0; i < 2000; i++) {
      h.pop();
      expect(h.popped).toBeGreaterThanOrEqual(last);
      last = h.popped;
    }
    expect(h.size).toBe(0);
    h.push(3, 1);
    h.clear();
    expect(h.size).toBe(0);
  });
});
