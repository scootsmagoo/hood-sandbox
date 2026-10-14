import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agencyById, parseJurisdictions, type LawData } from '../src/shared/law';
import { DEG } from '../src/shared/math';
import { Rng } from '../src/shared/rng';
import type { RoadData } from '../src/shared/tile';
import { SnapshotView, E, H, HeatPhase, PedFlag, VehicleFlag } from '../src/shared/snapshot';
import { agenciesWanting, mayPursueVehicle, ordersAt } from '../src/sim/police/dispatch';
import { POLICE } from '../src/sim/police/PoliceSystem';
import { PathFollower, GOVERNOR, governSpeed, lookaheadDistance, pedalsFor, pursuitAngle, steerCommand } from '../src/sim/police/pursuit';
import { RoadGraph, densify, polyLength } from '../src/sim/police/roadGraph';
import { Simulation } from '../src/sim/Simulation';
import { LIFE } from '../src/sim/combat/systems';
import { driverSim, cmd, gridRoads, gridTile, makeSim, ofType, ped, run, runLog, vehicle, addNpc, Button } from './helpers';

const atlanta = parseJurisdictions(JSON.parse(readFileSync('data/cities/atlanta/jurisdictions.json', 'utf8')));

const road = (id: string, pts: [number, number][], over: Partial<RoadData> = {}): RoadData => ({
  id, class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: pts.map(([x, z]) => [x, 0, z] as [number, number, number]), ...over,
});

describe('dispatch tables', () => {
  const state = (counts: Record<string, number> = {}, nextAt: Record<string, number> = {}) => ({ nextAt: new Map(Object.entries(nextAt)), counts: new Map(Object.entries(counts)) });

  it('sends what the table says at each heat level, up to the unit cap', () => {
    const at1 = agenciesWanting(atlanta, 1, state(), 0);
    expect(at1.map((o) => o.agency.id).sort()).toEqual(['acp', 'fcp', 'ghp', 'tap']);
    expect(at1.find((o) => o.agency.id === 'acp')).toMatchObject({ units: 1, row: { maxUnits: 1, spawnIntervalS: 25 } });
    expect(agenciesWanting(atlanta, 1, state({ acp: 1 }), 0).some((o) => o.agency.id === 'acp')).toBe(false);
    expect(agenciesWanting(atlanta, 2, state({ acp: 1 }), 0).find((o) => o.agency.id === 'acp')?.units).toBe(1);
    expect(agenciesWanting(atlanta, 0, state(), 0)).toEqual([]);
  });

  it('waits out the spawn interval, and holds task forces back until their heat level', () => {
    expect(agenciesWanting(atlanta, 1, state({}, { acp: 25 }), 10).some((o) => o.agency.id === 'acp')).toBe(false);
    expect(agenciesWanting(atlanta, 1, state({}, { acp: 25 }), 25).some((o) => o.agency.id === 'acp')).toBe(true);
    expect(agenciesWanting(atlanta, 3, state(), 0).some((o) => o.agency.id === 'gtf')).toBe(false);
    expect(agenciesWanting(atlanta, 4, state(), 0).some((o) => o.agency.id === 'gtf')).toBe(true);
    expect(agenciesWanting(atlanta, 6, state(), 0).map((o) => o.agency.id)).toContain('guard');
  });

  it('only the agency of the area at the spawn point sends a car; task forces join anywhere', () => {
    const roads = [road('m', [[0, 0], [400, 0]], { class: 'motorway', oneway: true }), road('s', [[0, 200], [400, 200]])];
    const w1 = agenciesWanting(atlanta, 1, state(), 0);
    expect(ordersAt(atlanta, roads, 200, 3, w1).map((o) => o.agency.id)).toEqual(['ghp']);
    expect(ordersAt(atlanta, roads, 200, 200, w1).map((o) => o.agency.id)).toEqual(['acp']);
    const w4 = agenciesWanting(atlanta, 4, state(), 0);
    expect(ordersAt(atlanta, roads, 200, 200, w4).map((o) => o.agency.id).sort()).toEqual(['acp', 'gtf']);
  });

  it('a restrictive agency does not chase a car for a minor crime; an aggressive one always does', () => {
    const acp = agencyById(atlanta, 'acp')!;
    const ghp = agencyById(atlanta, 'ghp')!;
    expect(acp.pursuit).toBe('restrictive');
    expect(mayPursueVehicle(acp, 2)).toBe(false);
    expect(mayPursueVehicle(acp, 3)).toBe(true);
    expect(mayPursueVehicle(ghp, 1)).toBe(true);
  });
});

describe('the road graph', () => {
  const grid = new RoadGraph(gridRoads());

  it('routes along the street grid from one end to the other', () => {
    const r = grid.route({ x: -500, z: 0 }, Math.PI / 2, { x: 500, z: 300 })!;
    expect(r).toBeTruthy();
    expect(Math.hypot(r[r.length - 1].x - 500, r[r.length - 1].z - 300)).toBeLessThan(3);
    expect(polyLength(r)).toBeGreaterThan(1100);
    expect(polyLength(r)).toBeLessThan(1340); // 1000 along x, 300 along z: no detours
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z)).toBeLessThan(3);
  });

  it('leaves in the direction the car faces rather than turning round, when it can', () => {
    // Facing east at x = 10 with a goal up the street at x = 300, z = 150: straight on, then up.
    const east = grid.route({ x: 10, z: 0 }, Math.PI / 2, { x: 300, z: 150 })!;
    expect(east[3].x).toBeGreaterThan(east[0].x);
    expect(polyLength(east)).toBeCloseTo(440, -1);
    // Facing west it would have to turn round (or loop the block): it still gets there.
    const west = grid.route({ x: 10, z: 0 }, -Math.PI / 2, { x: 300, z: 150 })!;
    expect(west).toBeTruthy();
    expect(polyLength(west)).toBeGreaterThan(polyLength(east) - 1);
  });

  it('respects one-way streets and returns null when there is no route', () => {
    const g = new RoadGraph([
      road('a', [[0, 0], [100, 0]], { oneway: true }),
      road('b', [[100, 0], [100, 100]]),
      road('c', [[0, 0], [0, 100]]),
      road('d', [[0, 100], [100, 100]]),
      road('island', [[500, 500], [600, 500]]),
    ]);
    // From (90, 0) heading east (against... with) the one-way a (0->100), to (10, 0): must go round.
    const r = g.route({ x: 90, z: 0 }, Math.PI / 2, { x: 10, z: 0 })!;
    expect(polyLength(r)).toBeGreaterThan(280);
    expect(g.route({ x: 50, z: 0 }, 0, { x: 550, z: 500 })).toBe(null);
  });

  it('drops streets a car cannot use', () => {
    const g = new RoadGraph([
      road('svc', [[0, 0], [50, 0]], { class: 'service' }),
      road('bridge', [[0, 10], [50, 10]], { bridge: true }),
      { ...road('steep', [[0, 20], [50, 20]]), points: [[0, 0, 20], [50, 30, 20]] },
      road('ok', [[0, 30], [50, 30]]),
    ]);
    expect(g.edges).toHaveLength(1);
  });

  it('picks a spawn point in the ring, the same one for the same seed', () => {
    const pick = (seed: number) => grid.pickAround(new Rng(seed), 40, 40, 120, 200, () => true);
    const a = pick(5)!;
    expect(Math.hypot(a.x - 40, a.z - 40)).toBeGreaterThanOrEqual(120);
    expect(Math.hypot(a.x - 40, a.z - 40)).toBeLessThanOrEqual(200);
    expect(pick(5)).toEqual(a);
    expect(grid.pickAround(new Rng(1), 0, 0, 5000, 6000, () => true)).toBe(null);
  });
});

describe('pure pursuit', () => {
  /** A kinematic bicycle driven by the controller, on a path. */
  function drive(path: { x: number; z: number }[], opts: { cruise?: number; stopAtEnd?: boolean; seconds?: number } = {}) {
    const f = new PathFollower(densify(path));
    const wheelbase = 2.65;
    const lockRad = 34 * DEG;
    let x = path[0].x;
    let z = path[0].z;
    let yaw = Math.atan2(path[1].x - path[0].x, path[1].z - path[0].z);
    let v = 0;
    let maxCross = 0;
    let minSpeedInCorner = Infinity;
    let maxSpeed = 0;
    const dt = 1 / 60;
    const gov = { ...GOVERNOR, cruise: opts.cruise ?? 16, stopAtEnd: opts.stopAtEnd ?? false };
    const pedals = { throttle: 0, brake: 0 };
    let t = 0;
    for (; t < (opts.seconds ?? 120); t += dt) {
      f.advance(x, z);
      if (f.remaining < 1 && (v < 0.3 || !opts.stopAtEnd)) break;
      const aim = f.lookahead(lookaheadDistance(v));
      const ang = pursuitAngle({ x, z, yaw, speed: v }, aim, wheelbase);
      const steer = steerCommand(ang, lockRad);
      const delta = -steer * lockRad;
      pedalsFor(Math.max(0, governSpeed(f, gov)), v, pedals);
      v = Math.max(0, v + (pedals.throttle * 4.5 - pedals.brake * 8 - 0.05 * v) * dt);
      yaw += (v / wheelbase) * Math.tan(delta) * dt;
      x += Math.sin(yaw) * v * dt;
      z += Math.cos(yaw) * v * dt;
      maxSpeed = Math.max(maxSpeed, v);
      // cross-track error against the polyline
      let best = Infinity;
      const pts = f.pts;
      for (let i = Math.max(0, f.i - 4); i < Math.min(pts.length, f.i + 6); i++) best = Math.min(best, Math.hypot(pts[i].x - x, pts[i].z - z));
      maxCross = Math.max(maxCross, best);
      if (f.i > 0 && f.distAt(f.i) > 20 && f.distAt(f.i) < f.length - 20) minSpeedInCorner = Math.min(minSpeedInCorner, v);
    }
    return { x, z, v, maxCross, t, maxSpeed, f, minSpeedInCorner };
  }

  const turn = [{ x: 0, z: 0 }, { x: 0, z: 120 }, { x: 80, z: 120 }, { x: 80, z: 250 }];

  it('follows a path with right angles within the lane and arrives', () => {
    const r = drive(turn);
    expect(r.maxCross).toBeLessThan(3);
    expect(Math.hypot(r.x - 80, r.z - 250)).toBeLessThan(6);
    expect(r.t).toBeLessThan(60);
  });

  it('slows for a sharp corner and speeds up on the straights', () => {
    const r = drive(turn, { cruise: 20 });
    expect(r.maxSpeed).toBeGreaterThan(14);
    expect(r.minSpeedInCorner).toBeLessThan(10);
  });

  it('plans to stop at the end of the path', () => {
    const r = drive([{ x: 0, z: 0 }, { x: 0, z: 200 }], { stopAtEnd: true, cruise: 20 });
    expect(r.v).toBeLessThan(0.5);
    expect(Math.hypot(r.x, r.z - 200)).toBeLessThan(6);
    expect(r.z).toBeLessThan(201.5);
  });

  it('steers the right way: a target on the left asks for a left turn (the command is negative)', () => {
    const left = pursuitAngle({ x: 0, z: 0, yaw: 0, speed: 5 }, { x: 5, z: 10 }, 2.65); // facing +Z, left is +X
    expect(left).toBeGreaterThan(0);
    expect(steerCommand(left, 0.6)).toBeLessThan(0);
    const right = pursuitAngle({ x: 0, z: 0, yaw: 0, speed: 5 }, { x: -5, z: 10 }, 2.65);
    expect(steerCommand(right, 0.6)).toBeGreaterThan(0);
    expect(Math.abs(pursuitAngle({ x: 0, z: 0, yaw: 0, speed: 5 }, { x: 0, z: 10 }, 2.65))).toBeLessThan(1e-9);
    // a target behind asks for full lock
    expect(Math.abs(steerCommand(pursuitAngle({ x: 0, z: 0, yaw: 0, speed: 5 }, { x: 1, z: -10 }, 2.65), 0.6))).toBe(1);
  });

  it('brakes when over the target speed and floors it when under', () => {
    const o = { throttle: 0, brake: 0 };
    pedalsFor(15, 2, o);
    expect(o.throttle).toBe(1);
    expect(o.brake).toBe(0);
    pedalsFor(5, 15, o);
    expect(o.throttle).toBe(0);
    expect(o.brake).toBeGreaterThan(0.5);
    pedalsFor(0, 0.1, o);
    expect(o.brake).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// The response in the sim

/** A police-ready sim: the street grid, the Atlanta pack, the player on foot at (40, 40). */
async function policeSim(over: Partial<Parameters<typeof Simulation.create>[0]> = {}) {
  const sim = await Simulation.create({ seed: 1, tile: gridTile(), driver: false, parkedCars: 0, law: atlanta, ...over });
  // The tile's spawn car stands on one of the grid streets: move it off the roads.
  vehicle(sim).car.teleport(150, 0.4, 150, 0);
  ped(sim).controller.teleport(40, 0, 40, 0);
  run(sim, 30, cmd());
  sim.drainEvents();
  return sim;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('the first police response', () => {
  it('sends a car in the agency livery, out of view, 120 to 200 m away on a road', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    const ev = runLog(sim, 60 * 3);
    const sp = ofType(ev, 'police:spawn');
    expect(sp).toHaveLength(1);
    expect(sp[0].agency).toBe('acp');
    const spawned = ofType(ev, 'entity:spawn').filter((e) => e.def.kind === 2 && (e.def as { police?: unknown }).police);
    expect(spawned).toHaveLength(1);
    const def = spawned[0].def as { police: { agency: string; body: number; stripe: number; lightbar: number[] }; typeId: string; plate: string };
    expect(def.police).toEqual({ agency: 'acp', body: 0x2c3e50, stripe: 0xe8c547, lightbar: [0x3ea8ff, 0xffb000] });
    expect(def.typeId).toBe('sedan');
    expect(def.plate).toMatch(/^[A-Z]{3}\d{4}$/);
    const officer = ofType(ev, 'entity:spawn').find((e) => e.def.kind === 1 && (e.def as { police?: unknown }).police)!;
    expect((officer.def as { police: { uniform: number } }).police.uniform).toBe(0x2c3e50);
    const car = sim.registry.get(sp[0].vehicleId) as ReturnType<typeof vehicle>;
    const first = car.home;
    const d = dist(first, { x: 40, z: 40 });
    expect(d).toBeGreaterThanOrEqual(POLICE.spawnMin - 1);
    expect(d).toBeLessThanOrEqual(POLICE.spawnMax + 1);
    // on a road: the grid is on x or z multiples of 300
    const onRoad = Math.min(Math.abs(first.x % 300), 300 - Math.abs(first.x % 300)) < 1 || Math.min(Math.abs(first.z % 300), 300 - Math.abs(first.z % 300)) < 1;
    expect(onRoad).toBe(true);
    expect(car.lightbar).toBe(true);
    expect(car.occupantId).toBe(sp[0].officerIds[0]);
  });

  it('respects the dispatch table: one unit at heat 1, two at heat 2, and the interval between', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    // The player hides in the far corner, so nobody arrests them while the table plays out.
    ped(sim).controller.teleport(550, 0, 550, 0);
    const ev1 = runLog(sim, 60 * 20);
    expect(ofType(ev1, 'police:spawn')).toHaveLength(1);
    sim.law.heat.report(2, 3, 40, 40);
    const ev2 = runLog(sim, 60 * 4);
    // heat 2 allows two units, but the agency waits out its 25 s spawn interval: not yet
    expect(ofType(ev2, 'police:spawn')).toHaveLength(0);
    const ev3 = runLog(sim, 60 * 15);
    expect(ofType(ev3, 'police:spawn')).toHaveLength(1);
    expect(sim.police.units.length).toBe(2);
    // and never a third
    expect(ofType(runLog(sim, 60 * 30), 'police:spawn')).toHaveLength(0);
  });

  it('sends nothing without heat, or with no road network', async () => {
    const sim = await policeSim();
    expect(ofType(runLog(sim, 60 * 10), 'police:spawn')).toHaveLength(0);
    const flat = await Simulation.create({ seed: 1, tile: { ...gridTile(), roads: [] }, driver: false, parkedCars: 0, law: atlanta });
    flat.law.heat.report(1, 2, 0, 0);
    expect(ofType(runLog(flat, 60 * 10), 'police:spawn')).toHaveLength(0);
  });

  it('drives to the scene along the road, sees the player, and turns the stars solid', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    const ev = runLog(sim, 60 * 13);
    const seen = ofType(ev, 'heat:change').find((e) => e.phase === 'seen');
    expect(seen).toBeTruthy();
    expect(seen!.prevPhase).toBe('reported');
    const car = sim.registry.get(sim.police.units[0].vehicleId) as ReturnType<typeof vehicle>;
    expect(dist(car.car.pose(), { x: 40, z: 40 })).toBeLessThan(60);
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.heat).toBe(1);
    expect(v.heatPhase).toBe(HeatPhase.Seen);
    expect(v.u32[v.at(v.indexOf(car.id)) + E.Flags] & (VehicleFlag.Police | VehicleFlag.Lightbar)).toBe(VehicleFlag.Police | VehicleFlag.Lightbar);
    expect(v.u32[v.at(v.indexOf(sim.police.units[0].officerIds[0])) + E.Flags] & PedFlag.Police).toBeTruthy();
  });

  it('stars flash when line of sight is broken, and the heat cools when they stay hidden', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    runLog(sim, 60 * 10);
    expect(sim.law.heat.phase).toBe('seen');
    // Kill the officers' eyes: the player vanishes behind the edge of the world.
    ped(sim).controller.teleport(40, 0, 560, 0);
    const ev = runLog(sim, 60 * 3);
    expect(ofType(ev, 'heat:change').some((e) => e.phase === 'lost')).toBe(true);
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.heatPhase).toBe(HeatPhase.Lost);
  });

  it('gets out and chases on foot when the player is on foot nearby, and arrests them if they stand still', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    const ev = runLog(sim, 60 * 40);
    expect(ofType(ev, 'police:dismount')).toHaveLength(1);
    const busted = ofType(ev, 'player:busted');
    expect(busted).toHaveLength(1);
    const respawn = ofType(ev, 'player:respawn');
    expect(respawn[0].reason).toBe('busted');
    expect(sim.law.heat.level).toBe(0);
    expect(ofType(ev, 'heat:change').pop()).toMatchObject({ level: 0, reason: 'busted' });
    // everyone stood down
    expect(sim.police.units).toHaveLength(0);
    run(sim, 5, cmd());
    expect([...sim.vehicles()].filter((v) => v.police)).toHaveLength(0);
  });

  it('does not arrest someone who keeps moving, and arrests someone in reach only after two seconds', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    // Run in circles whenever an officer is near.
    let n = 0;
    const events = runLog(sim, 60 * 45, () => {
      n++;
      return cmd({ axes: { MoveY: 1, Yaw: (n / 60) * 1.5 }, buttons: Button.Sprint });
    });
    expect(ofType(events, 'player:busted')).toHaveLength(0);
    expect(ofType(events, 'police:dismount').length).toBeGreaterThanOrEqual(1);
    expect(sim.law.heat.level).toBe(1);
  });

  it('times the arrest: two seconds in reach, standing still', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    // Run the chase until an officer is at the player's side.
    let reach = -1;
    for (let i = 0; i < 60 * 40 && reach < 0; i++) {
      run(sim, 1, cmd());
      const o = sim.police.units[0] && (sim.registry.get(sim.police.units[0].officerIds[0]) as ReturnType<typeof ped>);
      if (o && o.officer && o.officer.arrestT > 0) reach = sim.tick;
    }
    expect(reach).toBeGreaterThan(0);
    const ev = runLog(sim, 60 * 3);
    const b = ofType(ev, 'player:busted');
    expect(b).toHaveLength(1);
    expect(b[0].tick - reach).toBeGreaterThanOrEqual(POLICE.arrestS * 60 - 70);
    expect(b[0].tick - reach).toBeLessThanOrEqual(POLICE.arrestS * 60 + 5);
  });

  it('is busted-proof in a car: no arrest while driving', async () => {
    const { sim } = await driverSim('sedan', gridTile(), { x: 40, z: 0 });
    sim.law.heat.report(1, 2, 40, 40);
    const ev = runLog(sim, 60 * 40);
    expect(ofType(ev, 'player:busted')).toHaveLength(0);
  });

  it('wasted clears the heat and sends the police home', async () => {
    const sim = await policeSim();
    sim.law.heat.report(2, 3, 40, 40);
    runLog(sim, 60 * 8);
    expect(sim.police.units.length).toBeGreaterThan(0);
    const { damagePed } = await import('../src/sim/combat/damage');
    damagePed(sim, ped(sim), 500, 'fall', 0);
    const ev = runLog(sim, Math.ceil(LIFE.wastedS * 60) + 30);
    expect(ofType(ev, 'player:respawn')[0].reason).toBe('wasted');
    expect(sim.law.heat.level).toBe(0);
    expect(sim.police.units).toHaveLength(0);
    expect(ofType(ev, 'heat:change').pop()).toMatchObject({ level: 0, reason: 'wasted' });
  });

  it('stands down when the heat cools: the cars drive off and are removed', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    // Let the car come, then hide: the player is far away and out of sight.
    runLog(sim, 60 * 4);
    ped(sim).controller.teleport(40, 0, 590, 0);
    const ev = runLog(sim, 60 * 100);
    expect(sim.law.heat.level).toBe(0);
    expect(ofType(ev, 'police:stand-down')).toHaveLength(1);
    // Units are gone within the despawn time.
    run(sim, 60 * 50, cmd());
    expect(sim.police.units).toHaveLength(0);
    expect([...sim.vehicles()].filter((v) => v.police)).toHaveLength(0);
  });
});

describe('jurisdiction: who chases a car', () => {
  /** The player in a car on the road at z = 0, driving east at about 12 m/s. */
  async function chase(law: LawData, severity: number) {
    const { sim, car } = await driverSim('sedan', gridTile(), { x: 0, z: 0 });
    // driverSim built its own sim with the generic law: swap in ours.
    const sim2 = await Simulation.create({ seed: 1, tile: gridTile(), driver: false, parkedCars: 0, law });
    void sim;
    void car;
    const v = vehicle(sim2);
    v.car.teleport(-100, 0.4, 0, Math.PI / 2);
    ped(sim2).controller.teleport(-100 - 2.5, 0, 0, 0);
    run(sim2, 20, cmd());
    run(sim2, 4, cmd({ buttons: Button.Interact }));
    run(sim2, 4, cmd());
    expect(ped(sim2).vehicleId).toBe(v.id);
    sim2.drainEvents();
    sim2.law.heat.report(severity >= 3 ? 2 : 1, severity, -100, 0);
    return { sim: sim2, v };
  }

  const drive = (sim: Simulation, seconds: number) => {
    let near = Infinity;
    const out: number[] = [];
    let n = 0;
    // Wait at the scene until the police have eyes on the car, then drive off.
    for (let t = 0; t < 30 * 60 && !sim.police.seesPlayer; t++) {
      sim.pushInput(1, cmd());
      sim.step();
      sim.drainEvents();
    }
    expect(sim.police.seesPlayer).toBe(true);
    for (let t = 0; t < seconds * 60; t++) {
      // Cruise east along z = 0, reversing course at the ends so the car stays on the grid.
      const v = vehicle(sim);
      const p = v.car.pose();
      const yaw = v.car.yaw;
      const steer = Math.max(-1, Math.min(1, -(0 - p.z) * 0.12 + (yaw - Math.PI / 2) * 1.5)) * -1;
      sim.pushInput(1, cmd({ axes: { Throttle: v.car.speedForward < 11 ? 0.6 : 0, Steer: steer } }));
      sim.step();
      sim.drainEvents();
      n++;
      const u = sim.police.units[0];
      if (u && n % 30 === 0) {
        const c = (sim.registry.get(u.vehicleId) as ReturnType<typeof vehicle>).car.pose();
        near = Math.min(near, dist(c, p));
        out.push(dist(c, p));
      }
    }
    return { near, out };
  };

  it('a restrictive agency does not follow a car for a minor crime: it gathers at the scene', async () => {
    const { sim } = await chase(atlanta, 2);
    const r = drive(sim, 40);
    expect(sim.police.units.length).toBeGreaterThan(0);
    const u = sim.police.units[0];
    const car = (sim.registry.get(u.vehicleId) as ReturnType<typeof vehicle>).car.pose();
    // The player has driven off down the road; the unit stays near the scene at x = -100.
    expect(dist(car, { x: -100, z: 0 })).toBeLessThan(90);
    expect(dist(car, vehicle(sim).car.pose())).toBeGreaterThan(80);
    expect(r.out.length).toBeGreaterThan(0);
  });

  it('...and chases for a crime at or above its minimum severity', async () => {
    const { sim } = await chase(atlanta, 3);
    const r = drive(sim, 40);
    expect(r.near).toBeLessThan(35);
    const u = sim.police.units[0];
    const car = (sim.registry.get(u.vehicleId) as ReturnType<typeof vehicle>).car.pose();
    expect(dist(car, vehicle(sim).car.pose())).toBeLessThan(120);
  });

  it('an aggressive agency chases for any crime', async () => {
    const aggressive: LawData = {
      ...atlanta,
      agencies: atlanta.agencies.map((a) => (a.id === 'acp' ? { ...a, pursuit: 'aggressive' as const, minPursuitSeverity: 5 } : a)),
    };
    const { sim } = await chase(aggressive, 2);
    const r = drive(sim, 40);
    expect(r.near).toBeLessThan(35);
  });
});

describe('stealing a police car', () => {
  it('a car whose officer is gone is the player\'s to drive: the AI lets go of the pedals', async () => {
    const sim = await policeSim();
    sim.law.heat.report(1, 2, 40, 40);
    ped(sim).controller.teleport(550, 0, 550, 0);
    runLog(sim, 60 * 3);
    const unit = sim.police.units[0];
    const car = sim.registry.get(unit.vehicleId) as ReturnType<typeof vehicle>;
    const { damagePed } = await import('../src/sim/combat/damage');
    damagePed(sim, sim.registry.get(unit.officerIds[0]) as ReturnType<typeof ped>, 500, 'melee', ped(sim).id);
    run(sim, 5, cmd());
    expect(car.occupantId).toBe(0);
    car.car.teleport(300, 0.4, 0, Math.PI / 2);
    const p = car.car.pose();
    ped(sim).controller.teleport(p.x, 0, p.z + 2.5);
    run(sim, 30, cmd());
    run(sim, 4, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(car.id);
    const x0 = car.car.pose().x;
    run(sim, 120, cmd({ axes: { Throttle: 1 } }));
    expect(car.car.pose().x - x0).toBeGreaterThan(5);
    expect(car.lightbar).toBe(false);
  });
});

describe('determinism', () => {
  it('a scripted carjack and then the police response replay exactly', async () => {
    const { rotateVec } = await import('../src/shared/math');
    const { doorGeometry } = await import('../src/shared/doors');
    const { SNAPSHOT_BYTES } = await import('../src/shared/snapshot');
    const script = async () => {
      const sim = await Simulation.create({ seed: 7, tile: gridTile(), law: atlanta, parkedCars: 0, bystanders: 0, driverMood: 'flee' });
      const hero = vehicle(sim);
      const pose = hero.car.pose();
      const g = doorGeometry(hero.car.h);
      const w = rotateVec(pose.q, g.stand.x, 0, g.stand.z);
      ped(sim).controller.teleport(pose.x + w.x, pose.y - 0.3, pose.z + w.z);
      addNpc(sim, pose.x + 8, pose.z + 6, 0);
      const events: unknown[] = [];
      const bytes: Uint8Array[] = [];
      let n = 0;
      for (let i = 0; i < 60 * 70; i++) {
        const press = i === 40 ? Button.Interact : 0;
        const stand = i > 60 * 50;
        sim.pushInput(1, { tick: ++n, buttons: press, axes: [0, 0, 0, 0, i > 150 && !stand ? 0.4 : 0, stand ? 1 : 0, i > 200 ? 0.2 * Math.sin(i / 90) : 0, 4] });
        sim.step();
        events.push(...sim.drainEvents());
        if (i % 600 === 599) {
          const v = new SnapshotView();
          sim.writeSnapshot(v);
          bytes.push(new Uint8Array(v.buffer.slice(0, SNAPSHOT_BYTES)));
        }
      }
      return { events, bytes };
    };
    const a = await script();
    const b = await script();
    const types = a.events.map((e) => (e as { type: string }).type);
    expect(types).toContain('carjack');
    expect(types).toContain('crime');
    expect(types).toContain('crime:reported');
    expect(types).toContain('heat:change');
    expect(types).toContain('police:spawn');
    expect(a.events).toEqual(b.events);
    for (let i = 0; i < a.bytes.length; i++) expect(Buffer.from(a.bytes[i]).equals(Buffer.from(b.bytes[i]))).toBe(true);
  });
});

void H;
