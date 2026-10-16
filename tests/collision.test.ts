import { describe, expect, it } from 'vitest';
import { FootprintIndex } from '../src/shared/footprints';
import { BENCH_SOLIDS, collectProps, worldSolids } from '../src/shared/props';
import { Simulation } from '../src/sim/Simulation';
import { GROUPS } from '../src/sim/physics/rapier';
import { boxMesh, boxTile, polesAt } from './collisionHelpers';
import { crossroads, pedSim, population } from './pedHelpers';
import { Button, cmd, driverSim, ofType, ped, run, runLog, vehicle } from './helpers';

const walk = (sim: Simulation, ticks: number, sprint = false) => run(sim, ticks, cmd({ axes: { MoveY: 1, Yaw: 0 }, buttons: sprint ? Button.Sprint : 0 }));

describe('street furniture is solid', () => {
  it('stops a player walking into a signal pole, and a sprinting one too', async () => {
    // the player spawns near the origin facing north (-z); the pole stands 8 m ahead, in line
    for (const sprint of [false, true]) {
      const sim = await Simulation.create({ seed: 1, tile: boxTile([], { lanes: polesAt([0, -8]) }), driver: false, parkedCars: 0 });
      const c = ped(sim).controller;
      c.teleport(0, 0.1, 0);
      run(sim, 20, cmd());
      walk(sim, 60 * 6, sprint);
      // the pole is 0.2 m wide and the capsule 0.32 m in radius: it stops with its centre at 0.1 + 0.32 from the pole's face
      expect(c.z).toBeGreaterThan(-8 + 0.1 + 0.3);
      expect(c.z).toBeLessThan(-8 + 0.1 + 0.6);
      expect(Math.abs(c.x)).toBeLessThan(0.2);
    }
  });

  it('catches a person sprinting at a 0.15 m pole, at a high frame-step too (no tunnelling)', async () => {
    const sim = await Simulation.create({ seed: 1, tile: boxTile([]), driver: false, parkedCars: 0 });
    const R = sim.physics.R;
    sim.physics.world.createCollider(R.ColliderDesc.cuboid(0.075, 2, 0.075).setTranslation(0, 2, -8).setCollisionGroups(GROUPS.prop));
    const c = ped(sim).controller;
    c.teleport(0, 0.1, 0);
    run(sim, 20, cmd());
    walk(sim, 60 * 5, true);
    expect(c.z).toBeGreaterThan(-8 + 0.075);
    // a shove of 20 m/s (an explosion) does not carry through it either
    c.teleport(0, 0.1, -3);
    run(sim, 5, cmd());
    for (let i = 0; i < 40; i++) {
      c.launch(0, 0, -20);
      run(sim, 1, cmd());
    }
    expect(c.z).toBeGreaterThan(-8 + 0.075);
  });

  it('stops a car at 30 m/s against a 0.15 m pole, and against a signal pole', async () => {
    for (const kind of ['thin', 'signal'] as const) {
      const tile = boxTile([], kind === 'signal' ? { lanes: polesAt([0, 800]) } : {});
      const { sim, car } = await driverSim('sedan', tile, { x: 0, z: 900 });
      if (kind === 'thin') {
        sim.physics.world.createCollider(sim.physics.R.ColliderDesc.cuboid(0.075, 2, 0.075).setTranslation(0, 2, 800).setCollisionGroups(GROUPS.prop));
      }
      // the car faces north (-z); get it to 30 m/s heading for the pole 100 m ahead, and keep the throttle down
      car.body.setLinvel({ x: 0, y: 0, z: -30 }, true);
      let maxSpeed = 0;
      let passed = false;
      for (let i = 0; i < 60 * 7; i++) {
        run(sim, 1, cmd({ axes: { Throttle: 1 } }));
        maxSpeed = Math.max(maxSpeed, car.speed);
        if (car.body.translation().z < 800 - 0.5) passed = true;
      }
      expect(maxSpeed).toBeGreaterThan(25);
      expect(passed).toBe(false);
      // it hit the pole hard: whatever speed it had a moment before is gone
      expect(vehicle(sim).car.speed).toBeLessThan(10);
    }
  });

  it('makes benches and bus stops solid from the same boxes that are drawn', async () => {
    const pts = [
      { id: 'b', type: 'bench' as const, x: 5, y: 0.05, z: 5, yaw: 0, cap: 2, src: 'synth' as const },
      { id: 's', type: 'busstop' as const, x: -20, y: 0.05, z: 5, yaw: Math.PI / 2, cap: 3, src: 'synth' as const },
    ];
    const props = collectProps(undefined, pts);
    expect(props.map((p) => p.kind)).toEqual(['bench', 'busstop']);
    // a bench seat is a block from the ground to 0.48 m, 1.7 m wide
    const seat = worldSolids(props[0])[0];
    expect(seat.hy * 2).toBeCloseTo(BENCH_SOLIDS[0].h, 6);
    expect(seat.hx).toBeCloseTo(0.85, 6);
    const sim = await Simulation.create({ seed: 1, tile: boxTile([], { scenarios: pts }), driver: false, parkedCars: 0 });
    expect(sim.physics.props.length).toBe(2);
    // walk into the middle of the bench from the north: stopped by it
    const c = ped(sim).controller;
    c.teleport(5, 0.1, -3);
    run(sim, 30, cmd());
    run(sim, 60 * 4, cmd({ axes: { MoveY: -1, Yaw: 0 } })); // backwards: south
    expect(c.z).toBeLessThan(5);
    expect(c.z).toBeGreaterThan(5 - 0.4 - 0.32 - 0.1);
    // the bus stop's glass back is a wall too: from the west side walking east through its post-and-glass
    c.teleport(-20 - 6, 0.1, 5);
    run(sim, 30, cmd());
    run(sim, 60 * 5, cmd({ axes: { MoveY: 1, Yaw: -Math.PI / 2 } })); // forward is (-sin yaw, -cos yaw) = (+1, 0): east
    expect(c.x).toBeLessThan(-20 + 1.2);
  });
});

describe('footprints from the collision mesh', () => {
  it('knows inside from outside, and how far a wall is', () => {
    const m = boxMesh([{ x0: 0, z0: 0, x1: 10, z1: 6, h: 12 }]);
    const fp = new FootprintIndex(m.positions, m.indices, m.indices.length / 3);
    expect(fp.inside(5, 0, 3)).toBe(true);
    expect(fp.inside(11, 0, 3)).toBe(false);
    // on the roof, above it, is not inside
    expect(fp.inside(5, 12, 3)).toBe(false);
    expect(fp.nearestWall(12, 3, 5)).toBeCloseTo(2, 5);
    const n = { nx: 0, nz: 0 };
    fp.nearestWall(12, 3, 5, n);
    expect(n.nx).toBeCloseTo(1, 5);
    expect(fp.nearestWall(30, 3, 5)).toBe(Infinity);
    expect(fp.outlineCount).toBe(4);
    expect(fp.clear(12, 0, 3, 1.5)).toBe(true);
    expect(fp.clear(10.5, 0, 3, 1.5)).toBe(false);
  });
});

describe('floating footprints', () => {
  it('a skybridge drawn on the corners of the tower it joins starts where it starts, not at the tower\'s ground', () => {
    // the tower's west wall (x = 20, z -2.5 to 2.5) is the tube's east end: the two share their corners; the tube hangs from 10 to 14 m
    const m = boxMesh([{ x0: 20, z0: -2.5, x1: 60, z1: 30, h: 90 }, { x0: 0, z0: -2.5, x1: 20, z1: 2.5, h: 14, y0: 10 }]);
    const fp = new FootprintIndex(m.positions, m.indices, m.indices.length / 3);
    expect(fp.inside(40, 0, 10)).toBe(true);           // in the tower
    expect(fp.inside(10, 0.8, 0)).toBe(false);          // the street under the tube
    expect(fp.inside(10, 11, 0)).toBe(true);            // in the tube
    expect(fp.nearestWall(10, 0, 4, undefined, 0.8)).toBe(Infinity);
  });
});

describe('nobody stays in a wall', () => {
  it('moves someone put inside a building out of it, and says so', async () => {
    const sim = await Simulation.create({ seed: 1, tile: boxTile([{ x0: 20, z0: -10, x1: 40, z1: 10, h: 12 }]), driver: false, parkedCars: 0 });
    const c = ped(sim).controller;
    c.teleport(30, 0.1, 0);
    const events = runLog(sim, 60);
    const ev = ofType(events, 'ped:unstuck');
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0]).toMatchObject({ reason: 'inside', action: 'depenetrate', pedId: ped(sim).id });
    expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
    // beside the nearest wall, not on the far side of the building
    expect(Math.hypot(c.x - 30, c.z)).toBeLessThan(11);
    expect(sim.physics.overlapsStatic(c.x, c.y, c.z)).toBe(false);
  });

  it('lifts someone out of a wall they overlap, and an NPC that is wedged is put somewhere it can walk', async () => {
    const sim = await Simulation.create({ seed: 1, tile: boxTile([{ x0: 20, z0: -10, x1: 40, z1: 10, h: 12 }]), driver: false, parkedCars: 0 });
    const c = ped(sim).controller;
    // half in the wall
    c.teleport(20.05, 0.1, 0);
    const events = runLog(sim, 90);
    const ev = ofType(events, 'ped:unstuck');
    expect(ev.some((e) => e.reason === 'inside' || e.reason === 'overlap')).toBe(true);
    expect(sim.physics.overlapsStatic(c.x, c.y, c.z)).toBe(false);
    expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
  });

  it('gives up on an NPC that has been trying to walk through a wall for several seconds, when nobody sees it', async () => {
    const sim = await Simulation.create({ seed: 1, tile: boxTile([{ x0: 300, z0: -10, x1: 320, z1: 10, h: 12 }]), driver: false, parkedCars: 0 });
    // far from the player; no brain, so its input stays as set: pushing east into the wall
    const npc = sim.addPed(296, 0.1, 0, 0, 2, false);
    npc.input.moveY = 1;
    npc.input.camYaw = Math.PI / 2 * -1; // forward = (-sin(-pi/2), ...) = +x
    const events: ReturnType<typeof ofType<'ped:unstuck'>> = [];
    for (let i = 0; i < 60 * 12; i++) {
      run(sim, 1, cmd());
      events.push(...ofType(sim.drainEvents(), 'ped:unstuck'));
      if (!sim.registry.get(npc.id)) break;
    }
    const mine = events.filter((e) => e.pedId === npc.id);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0].reason).toBe('no-progress');
    // with no walk network to put it on, an unseen NPC is removed
    expect(mine[0].action).toBe('despawn');
    expect(sim.registry.get(npc.id)).toBeUndefined();
  });

  it('does not count the player pressing against a wall as stuck', async () => {
    const sim = await Simulation.create({ seed: 1, tile: boxTile([{ x0: 0, z0: -30, x1: 20, z1: -10, h: 12 }]), driver: false, parkedCars: 0 });
    ped(sim).controller.teleport(10, 0.1, -5);
    run(sim, 20, cmd());
    const events: ReturnType<typeof ofType<'ped:unstuck'>> = [];
    for (let i = 0; i < 60 * 12; i++) {
      run(sim, 1, cmd({ axes: { MoveY: 1, Yaw: 0 } }));
      events.push(...ofType(sim.drainEvents(), 'ped:unstuck'));
    }
    expect(events).toEqual([]);
    expect(ped(sim).controller.z).toBeGreaterThan(-10);
  });
});

describe('getting out of a car', () => {
  it('never puts the driver in the wall the car is parked against', async () => {
    // a building's wall at x = 10; the car beside it, its side 0.2 m off the wall
    const tile = boxTile([{ x0: 10, z0: 800, x1: 40, z1: 1000, h: 12 }]);
    for (const yaw of [Math.PI, 0]) {
      const { sim, car } = await driverSim('sedan', tile, { x: 8.9, z: 900 });
      car.teleport(8.9, 0.5, 900, yaw);
      run(sim, 40, cmd());
      run(sim, 3, cmd({ buttons: Button.Interact }));
      run(sim, 5, cmd());
      expect(ped(sim).vehicleId).toBe(0);
      const c = ped(sim).controller;
      expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
      expect(c.x).toBeLessThan(10 - 0.3);
      expect(sim.physics.overlapsStatic(c.x, c.y, c.z, { vehicles: true })).toBe(false);
    }
  });

  it('never puts the driver inside another car', async () => {
    const { sim, car } = await driverSim('sedan', boxTile([]), { x: 0, z: 900 });
    // a car close on either side: the way out is at the front or the back
    for (const x of [-2.3, 2.3]) sim.spawnVehicle('sedan', x, 0, 900, Math.PI, 0x336699);
    run(sim, 60, cmd());
    expect(car.body.translation().z).toBeGreaterThan(895);
    run(sim, 3, cmd({ buttons: Button.Interact }));
    run(sim, 5, cmd());
    expect(ped(sim).vehicleId).toBe(0);
    const c = ped(sim).controller;
    expect(sim.physics.overlapsStatic(c.x, c.y, c.z, { vehicles: true })).toBe(false);
    for (const v of sim.vehicles()) {
      if (v.id === vehicle(sim).id) continue;
      const t = v.car.body.translation();
      expect(Math.hypot(t.x - c.x, t.z - c.z)).toBeGreaterThan(1.3);
    }
  });

  it('puts the driver somewhere clear when the car is boxed in on all sides but one', async () => {
    const tile = boxTile([
      { x0: 10, z0: 800, x1: 40, z1: 1000, h: 12 },
      { x0: -12, z0: 800, x1: 6.5, z1: 1000, h: 12 },
    ]);
    const { sim, car } = await driverSim('sedan', tile, { x: 8.2, z: 900 });
    car.teleport(8.2, 0.5, 900, Math.PI);
    run(sim, 40, cmd());
    run(sim, 3, cmd({ buttons: Button.Interact }));
    run(sim, 5, cmd());
    const c = ped(sim).controller;
    expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
    expect(sim.physics.overlapsStatic(c.x, c.y, c.z, { vehicles: true })).toBe(false);
  });
});

describe('spawning and walking beside solids', () => {
  const walkTile = (boxes: Parameters<typeof boxTile>[0], extra: Parameters<typeof boxTile>[1]) => ({ ...boxTile(boxes, extra), ...(() => { const { paths, junctions } = crossroads(true); return { paths, junctions }; })() });

  it('never makes anyone inside a building, and moves a group at a scenario point clear of a wall', async () => {
    const pts = [
      { id: 'in', type: 'plaza' as const, x: 110, y: 0.05, z: 0, yaw: 0, cap: 3, src: 'synth' as const },
      { id: 'edge', type: 'plaza' as const, x: 110, y: 0.05, z: 5.2, yaw: 0, cap: 3, src: 'synth' as const },
    ];
    const sim = await pedSim({ tile: walkTile([{ x0: 100, z0: -5, x1: 120, z1: 5, h: 12 }], { scenarios: pts }), peds: 0 });
    const A = sim.ambient!;
    const group = population(1).pedGroups.locals;
    expect(A.standable(110, 0.05, 0, false)).toBe(false);
    expect(A.standable(110, 0.05, 8, true)).toBe(true);
    expect(A.spawnScenario(0, 'locals', group)).toBe(0);
    expect(A.list.length).toBe(0);
    // the other point is 0.2 m from the wall: people are put where a body fits, or not at all
    for (let k = 0; k < 6; k++) {
      A.scenarios.used.fill(0);
      A.spawnScenario(1, 'locals', group);
    }
    expect(A.list.length).toBeGreaterThan(0);
    for (const p of A.list) {
      const c = p.controller;
      expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
      expect(sim.physics.overlapsStatic(c.x, c.y, c.z, { props: false })).toBe(false);
    }
  });

  it('keeps a walker off a pole beside the sidewalk, and does not send anyone down a sidewalk a pole blocks', async () => {
    // the sidewalk along z = 8 from x = 128 to 168: a pole 0.5 m south of its middle line, and one on the line itself further on
    const sim = await pedSim({ tile: walkTile([], { lanes: polesAt([150, 8.5], [188, 8]) }), peds: 0 });
    const A = sim.ambient!;
    const g = A.graph;
    const e1 = g.nearestEdge(150, 8, 0.5)!.edge;
    const from1 = g.x[g.ea[e1]] < g.x[g.eb[e1]] ? g.ea[e1] : g.eb[e1];
    // walking east (+x) along z = +8, a positive lane is toward -z (the walker's right is north): clear; the south side is narrowed by the pole
    expect(A.clearance.isBlocked(e1)).toBe(false);
    expect(A.clearance.lane(e1, from1, 0.55)).toBeCloseTo(0.55, 5);
    expect(A.clearance.lane(e1, from1, -0.55)).toBeGreaterThan(-0.5);
    // a pole on the middle line blocks the edge for walking: routes leave it out
    const e2 = g.nearestEdge(188, 8, 0.5)!.edge;
    expect(A.clearance.isBlocked(e2)).toBe(true);
    expect(g.hasRoom(e2, 30)).toBe(true); // the sidewalk goes on both ways round it... but not through it
    const a = g.ea[e2], b = g.eb[e2];
    const route = g.route(a, b);
    // the only other way between its two ends is round the block
    expect(route === null || !route.some((n, i) => i > 0 && g.edgeBetween(route[i - 1], n) === e2)).toBe(true);
  });
});
