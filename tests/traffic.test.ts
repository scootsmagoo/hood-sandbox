import { describe, expect, it } from 'vitest';
import { doorGeometry } from '../src/shared/doors';
import { rotateVec } from '../src/shared/math';
import { Axis, SIM_DT, type SimEvent } from '../src/shared/protocol';
import { legState, phaseOf } from '../src/shared/signals';
import { E, H, SnapshotView, VehicleFlag } from '../src/shared/snapshot';
import { Rng } from '../src/shared/rng';
import { Simulation } from '../src/sim/Simulation';
import type { PedEntity, VehicleEntity } from '../src/sim/entities';
import { TRAFFIC, type TrafficCar } from '../src/sim/traffic/TrafficManager';
import { Button, cmd, ped, run } from './helpers';
import { crossroads, lanesFor, laneOf, road, stepAll, trafficSim } from './trafficHelpers';

const KIND = { type: 'sedan', color: 0xcc2222 };

/** A sim on a crossroads with no random traffic: the test places the cars. The player's own car is put out of the way. */
async function scene(control: 'signals' | 'stop' | 'none' = 'signals', half = 500, seed = 1) {
  const { roads, junctions } = crossroads(control, half);
  const sim = await trafficSim(lanesFor(roads, junctions), { seed });
  sim.traffic!.density = 0;
  (sim.registry.get(sim.vehicleId) as VehicleEntity).car.teleport(300, 0.5, 300, 0);
  return sim;
}

const tp = (sim: Simulation, x: number, z: number) => ped(sim).controller.teleport(x, sim.groundAt(x, z) + 0.1, z);
const pos = (c: TrafficCar) => c.veh.car.body.translation();
/** Seconds until the lamp that cars on leg `leg` see turns green (0 when it is green). */
function redLeft(sim: Simulation, jr: Parameters<typeof legState>[0], leg: number): number {
  const t0 = sim.tick * SIM_DT;
  for (let dt = 0; dt < 200; dt += 0.1) if (legState(jr, leg, t0 + dt) === 'green') return dt;
  return 200;
}
const waitFor = (sim: Simulation, cond: () => boolean, maxSeconds: number) => {
  for (let i = 0; i < maxSeconds * 60 && !cond(); i++) sim.step();
  return cond();
};

describe('signals and queues', () => {
  it('cars stop at a red light one behind the other, behind the line, and go when it turns green', async () => {
    const sim = await scene();
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const jr = t.graph.junctions[0];
    const len = t.graph.len[east];
    const green = () => legState(jr, 1, sim.tick * SIM_DT) === 'green';
    // wait for a red with plenty left
    expect(waitFor(sim, () => !green() && redLeft(sim, jr, 1) > 30, 200)).toBe(true);
    const cars = [0, 1, 2, 3].map((i) => t.spawnAt(east, len - 95 - i * 14, KIND));
    for (const c of cars) c.v = 11;
    tp(sim, -40, 6);
    expect(waitFor(sim, () => cars.every((c) => c.v < 0.3), 28)).toBe(true);
    expect(green()).toBe(false);
    // all stopped, in order, the first one with its nose behind the stop line, nobody on top of anybody
    for (let i = 0; i < 3; i++) expect(cars[i + 1].s).toBeLessThan(cars[i].s - 4.5);
    expect(len - cars[0].s - cars[0].len / 2).toBeGreaterThan(2.5);
    expect(len - cars[0].s).toBeLessThan(12);
    expect(cars.every((c) => c.edge === east)).toBe(true);
    // green: the whole queue sets off and crosses
    expect(waitFor(sim, green, 40)).toBe(true);
    stepAll(sim, 60 * 25);
    for (const c of cars) expect(c.edge !== east || c.s > len - 5).toBe(true);
    const crossed = cars.filter((c) => c.edge !== east).length;
    expect(crossed).toBeGreaterThanOrEqual(3);
  });

  it('stops for a stop sign even with the road clear, then goes', async () => {
    const sim = await scene('stop');
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const len = t.graph.len[east];
    const c = t.spawnAt(east, len - 80, KIND);
    c.v = 9;
    tp(sim, -40, 6);
    let minV = Infinity;
    let stoppedNear = false;
    for (let i = 0; i < 60 * 25; i++) {
      sim.step();
      if (c.edge === east && len - c.s < 9) {
        minV = Math.min(minV, c.v);
        if (c.v < 0.3) stoppedNear = true;
      }
      if (c.edge !== east && !t.graph.isConnector[c.edge]) break;
    }
    expect(stoppedNear).toBe(true);
    expect(minV).toBeLessThan(0.3);
    expect(c.edge).not.toBe(east); // it did go on
  });
});

describe('junction conflicts', () => {
  for (const control of ['signals', 'stop', 'none'] as const) {
    it(`never has two conflicting movements in the junction at once (${control})`, async () => {
      const sim = await scene(control, 300, 3);
      const t = sim.traffic!;
      const g = t.graph;
      const starts: number[] = [];
      g.data.edges.forEach((e, i) => {
        if (e.t === 0 && g.len[i] > 100 && g.next[i].length && g.main[i] && g.junction[i] >= 0 && g.junctions[g.junction[i]].id === 'j0') starts.push(i);
      });
      expect(starts.length).toBe(4);
      const rng = new Rng(9);
      const crossed = new Set<number>();
      let violations = 0;
      let spawned = 0;
      tp(sim, 20, 20);
      for (let tick = 0; tick < 60 * 240; tick++) {
        if (tick % 80 === 0 && tick < 60 * 150 && t.cars.length < 45) {
          const e = starts[rng.int(0, starts.length - 1)];
          if (!t.cars.some((c) => c.edge === e && c.s < 30)) {
            const c = t.spawnAt(e, 4, KIND);
            c.v = 8;
            spawned++;
          }
        }
        sim.step();
        const inside = t.cars.filter((c) => g.isConnector[c.edge] && g.junctions[g.junction[c.edge]]?.id === 'j0');
        for (const c of inside) crossed.add(c.serial);
        for (let a = 0; a < inside.length; a++) {
          for (let b = a + 1; b < inside.length; b++) {
            const ca = inside[a].edge;
            const cb = inside[b].edge;
            if (ca !== cb && g.conflicts[ca].includes(cb)) violations++;
          }
        }
      }
      expect(violations).toBe(0);
      // and traffic flowed: nothing deadlocked
      expect(crossed.size).toBeGreaterThanOrEqual(spawned - 3);
      expect(t.count('free')).toBe(0);
    });
  }
});

describe('level of detail', () => {
  it('a spline follower becomes a physics car as the player closes in, keeping its pose and speed, with a driver at the wheel', async () => {
    const sim = await scene();
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const c = t.spawnAt(east, 20, KIND); // x = -480
    tp(sim, -300, 8);
    expect(c.mode).toBe('kin');
    expect(c.veh.kinematic).toBe(true);
    expect(c.veh.occupantId).toBe(0);
    let last = pos(c);
    let lastV = c.v;
    let switchedAt = -1;
    let maxJump = 0;
    let maxDv = 0;
    for (let i = 0; i < 60 * 40; i++) {
      // the player walks toward the car along the road
      if (i % 30 === 0) tp(sim, Math.min(pos(c).x + 120 - i * 0.02, -100), 8);
      sim.step();
      const p = pos(c);
      maxJump = Math.max(maxJump, Math.hypot(p.x - last.x, p.z - last.z, p.y - last.y));
      maxDv = Math.max(maxDv, Math.abs(c.v - lastV));
      last = p;
      lastV = c.v;
      if (switchedAt < 0 && c.mode === 'phys') {
        switchedAt = i;
        const pl = ped(sim).controller;
        // the switch happens inside the near distance
        expect(Math.hypot(p.x - pl.x, p.z - pl.z)).toBeLessThan(TRAFFIC.promoteDist + 15);
        expect(c.veh.kinematic).toBe(false);
        // and the driver is there next tick
        sim.step();
        last = pos(c);
        lastV = c.v;
        const driver = sim.registry.get(c.veh.occupantId) as PedEntity;
        expect(driver).toBeTruthy();
        expect(driver.vehicleId).toBe(c.veh.id);
        expect(driver.brain?.state).toBe('seated');
      }
    }
    expect(switchedAt).toBeGreaterThan(0);
    // no teleports: at most a car's travel in a tick, and speed changes as a car would change it
    expect(maxJump).toBeLessThan(0.5);
    expect(maxDv).toBeLessThan(0.6);
  });

  it('goes back to a spline follower, with its driver removed, when the player is far away', async () => {
    const sim = await scene();
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    tp(sim, -400, 8);
    const c = t.spawnAt(east, 100, KIND); // x = -400
    expect(waitFor(sim, () => c.mode === 'phys', 5)).toBe(true);
    stepAll(sim, 5);
    expect(sim.registry.get(c.veh.occupantId)).toBeTruthy();
    const before = pos(c);
    tp(sim, 300, 8);
    expect(waitFor(sim, () => c.mode === 'kin', 10)).toBe(true);
    stepAll(sim, 3);
    expect(c.veh.occupantId).toBe(0);
    expect(c.veh.kinematic).toBe(true);
    // it carried on along the lane
    expect(pos(c).x).toBeGreaterThan(before.x);
    expect(Math.abs(pos(c).z - 1.8)).toBeLessThan(0.9);
  });

  it('writes spline followers into the snapshot like any vehicle, flagged as traffic', async () => {
    const sim = await scene();
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const c = t.spawnAt(east, 100, KIND);
    tp(sim, -300, 8);
    stepAll(sim, 120);
    const view = new SnapshotView();
    sim.writeSnapshot(view);
    const i = view.indexOf(c.veh.id);
    expect(i).toBeGreaterThanOrEqual(0);
    const o = view.at(i);
    expect(view.u32[o + E.Flags] & VehicleFlag.Traffic).toBeTruthy();
    expect(view.f32[o + E.Px]).toBeCloseTo(pos(c).x, 3);
    expect(Math.abs(view.f32[o + E.Speed] - c.v)).toBeLessThan(0.01);
  });
});

describe('spawning and despawning', () => {
  async function bigRoad(density: number, seed = 5) {
    const roads = [road('main', [[-900, 0], [900, 0]]), road('cross', [[0, -900], [0, 900]])];
    const { junctions } = crossroads('signals', 900);
    const sim = await trafficSim(lanesFor(roads, junctions), { traffic: density, seed });
    (sim.registry.get(sim.vehicleId) as VehicleEntity).car.teleport(800, 0.5, 800, 0);
    return sim;
  }

  it('fills to the density the population table asks for, never past the cap, and leaves room in the snapshot', async () => {
    const sim = await bigRoad(1);
    const t = sim.traffic!;
    let most = 0;
    for (let i = 0; i < 60 * 40; i++) {
      sim.step();
      most = Math.max(most, t.cars.length);
    }
    expect(t.cars.length).toBeGreaterThan(5);
    expect(most).toBeLessThanOrEqual(TRAFFIC.cap + 2);
    expect(sim.registry.size).toBeLessThan(256 - TRAFFIC.entityReserve + 10);
  });

  it('a lower tier asks for fewer cars, and none at all with no density', async () => {
    const hi = await bigRoad(1);
    const lo = await bigRoad(0.5);
    stepAll(hi, 60 * 30);
    stepAll(lo, 60 * 30);
    expect(lo.traffic!.cap).toBe(Math.round(TRAFFIC.cap / 2));
    expect(lo.traffic!.cars.length).toBeLessThanOrEqual(lo.traffic!.cap + 1);
    expect(lo.traffic!.cars.length).toBeLessThan(hi.traffic!.cars.length + 1);
    const none = await Simulation.create({ seed: 1, tile: { ...(await bigRoad(1)).tile }, traffic: 0 });
    expect(none.traffic).toBeNull();
  });

  it('cars appear 120 to 250 m out of the player, out of the camera view, once the world is running; none appear in view', async () => {
    const sim = await bigRoad(1);
    const t = sim.traffic!;
    tp(sim, 0, 8);
    stepAll(sim, 60 * 3); // initial population
    const known = new Set(t.cars.map((c) => c.serial));
    const pl = ped(sim).controller;
    let late = 0;
    for (let i = 0; i < 60 * 120; i++) {
      // the camera looks east
      sim.pushInput(1, { tick: i + 1, buttons: 0, axes: [0, 0, -Math.PI / 2, -0.2, 0, 0, 0, 5] });
      sim.step();
      for (const c of t.cars) {
        if (known.has(c.serial)) continue;
        known.add(c.serial);
        late++;
        const p = pos(c);
        const d = Math.hypot(p.x - pl.x, p.z - pl.z);
        // a new car is never close, and when it is not very far it is outside the camera's cone
        expect(d).toBeGreaterThan(TRAFFIC.spawnMin - 10);
        expect(d).toBeLessThan(TRAFFIC.spawnMax + 40);
        if (d < 200 && p.x > pl.x) expect(Math.abs(Math.atan2(p.z - pl.z, p.x - pl.x))).toBeGreaterThan((62 * Math.PI) / 180 - 0.3);
      }
    }
    expect(late).toBeGreaterThan(3);
  });

  it('removes cars that are far away and cannot be seen, and never lets the count run away', async () => {
    const sim = await bigRoad(1);
    const t = sim.traffic!;
    tp(sim, -800, 8);
    stepAll(sim, 60 * 5);
    const first = [...t.cars];
    tp(sim, 800, 8);
    stepAll(sim, 60 * 20);
    const gone = first.filter((c) => !t.cars.includes(c));
    expect(first.length).toBeGreaterThan(4);
    expect(gone.length).toBeGreaterThanOrEqual(Math.ceil(first.length * 0.6));
    for (const c of gone) expect(sim.registry.get(c.veh.id)).toBeUndefined();
    expect(t.cars.length).toBeLessThanOrEqual(TRAFFIC.cap + 2);
    // despawned cars take their drivers with them
    const drivers = [...sim.peds()].filter((p) => p.vehicleId && p.role !== 'player');
    for (const d of drivers) expect(sim.registry.get(d.vehicleId)).toBeTruthy();
  });
});

describe('determinism', () => {
  it('the same seed and the same inputs give the same traffic, bit for bit', async () => {
    const run1 = async () => {
      const roads = [road('main', [[-800, 0], [800, 0]]), road('cross', [[0, -800], [0, 800]])];
      const { junctions } = crossroads('signals', 800);
      const sim = await trafficSim(lanesFor(roads, junctions), { traffic: 1, seed: 11 });
      const view = new SnapshotView();
      const events: string[] = [];
      for (let i = 0; i < 60 * 45; i++) {
        sim.pushInput(1, { tick: i + 1, buttons: 0, axes: [0, i % 600 < 300 ? 1 : 0, (i % 900) / 400, 0, 0, 0, 0, 5] });
        sim.step();
        for (const e of sim.drainEvents()) if (e.type.startsWith('traffic:') || e.type === 'entity:spawn' || e.type === 'entity:despawn') events.push(JSON.stringify(e));
      }
      sim.writeSnapshot(view);
      return { bytes: new Uint8Array(view.buffer.slice(0, 4 * (16 + 36 * view.count))), events, cars: sim.traffic!.cars.length };
    };
    const a = await run1();
    const b = await run1();
    expect(a.cars).toBeGreaterThan(3);
    expect(a.events.length).toBeGreaterThan(5);
    expect(b.events).toEqual(a.events);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });
});

describe('drivers and carjacking at a red light', () => {
  /** A queue at a red light: the lead car stopped at the line, with a driver. Returns the lead car. */
  async function queue(sim: Simulation) {
    const t = sim.traffic!;
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const jr = t.graph.junctions[0];
    const len = t.graph.len[east];
    waitFor(sim, () => legState(jr, 1, sim.tick * SIM_DT) === 'red' && redLeft(sim, jr, 1) > 28, 200);
    const cars = [0, 1].map((i) => t.spawnAt(east, len - 60 - i * 14, KIND));
    for (const c of cars) c.v = 8;
    tp(sim, -50, 8);
    waitFor(sim, () => cars[0].v < 0.05 && cars[0].edge === east && len - cars[0].s < 12, 20);
    return { cars, east, len };
  }

  it('every car near the player has a driver ped with a personality who sits at the wheel', async () => {
    const sim = await scene();
    const { cars } = await queue(sim);
    for (const c of cars) {
      const d = sim.registry.get(c.veh.occupantId) as PedEntity;
      expect(d?.brain?.state).toBe('seated');
      expect(d.brain!.personality).toBe(c.personality);
      expect(d.vehicleId).toBe(c.veh.id);
    }
  });

  it('a carjack of the car at the front of the queue works through the existing flow: the driver is pulled out, the player drives away, the queue behind waits', async () => {
    const sim = await scene();
    const { cars } = await queue(sim);
    const lead = cars[0];
    expect(lead.v).toBeLessThan(0.1);
    const driver = sim.registry.get(lead.veh.occupantId) as PedEntity;
    const g = doorGeometry(lead.veh.car.h);
    const p = lead.veh.car.pose();
    const w = rotateVec(p.q, g.stand.x, 0, g.stand.z);
    ped(sim).controller.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
    const events: SimEvent[] = [];
    run(sim, 5, cmd());
    sim.pushInput(1, { tick: 9000, buttons: Button.Interact, axes: [0, 0, 0, 0, 0, 0, 0, 5] });
    for (let i = 0; i < 150; i++) {
      sim.step();
      events.push(...sim.drainEvents());
    }
    const jack = events.find((e) => e.type === 'carjack');
    expect(jack).toBeTruthy();
    expect(events.some((e) => e.type === 'crime' && e.crime === 'carjack')).toBe(true);
    expect(ped(sim).vehicleId).toBe(lead.veh.id);
    expect(driver.vehicleId).toBe(0);
    // the car is the player's now, not traffic
    expect(lead.veh.trafficCar).toBeNull();
    expect(t(sim).cars).not.toContain(lead);
    expect(lead.veh.owner).toBe(1);
    // the car behind stays at the red light, behind the car that was taken (never through it)
    stepAll(sim, 120);
    expect(cars[1].edge === cars[0].edge || cars[1].s < cars[0].s).toBe(true);
    // and the player can drive off in it
    const x0 = lead.veh.car.pose().x;
    for (let i = 0; i < 180; i++) {
      sim.pushInput(1, { tick: 9100 + i, buttons: 0, axes: [0, 0, 0, 0, 1, 0, 0, 5] });
      sim.step();
    }
    expect(lead.veh.car.speed).toBeGreaterThan(3);
    expect(Math.abs(lead.veh.car.pose().x - x0) + Math.abs(lead.veh.car.pose().z)).toBeGreaterThan(5);
  });

  it('a driver whose engine dies gets out and runs; the car is left in the road', async () => {
    const sim = await scene();
    const { cars } = await queue(sim);
    const lead = cars[0];
    const driver = sim.registry.get(lead.veh.occupantId) as PedEntity;
    sim.damageVehicle(lead.veh, 2000, 2000, 0);
    stepAll(sim, 60 * 3);
    expect(driver.vehicleId).toBe(0);
    expect(lead.mode).toBe('free');
    expect(['flee', 'fight', 'calm']).toContain(driver.brain!.state);
  });
});

function t(sim: Simulation) {
  return sim.traffic!;
}
