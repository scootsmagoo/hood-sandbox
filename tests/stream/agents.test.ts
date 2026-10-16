/**
 * The city's people and cars across tile seams (docs/contracts/city-tiles.md): routes run across seams, traffic drives from tile to
 * tile, pedestrians walk across, and the police chase the player from one tile into the next while the tiles stream round them.
 */
import { describe, expect, it } from 'vitest';
import { Button } from '../../src/shared/protocol';
import type { PedEntity, VehicleEntity } from '../../src/sim/entities';
import { planRoute } from '../../src/sim/traffic/route';
import { cmd, run } from '../helpers';
import { atlanta } from '../policeHelpers';
import { Simulation } from '../../src/sim/Simulation';
import { FixtureTileSource } from '../../src/sim/stream/TileSource';
import { citySim, heroCar, movePlayer, playerPed } from './streamHelpers';

const S = 384;
const tileOf = (x: number, z: number) => `${Math.floor(x / S)}_${Math.floor(z / S)}`;

describe('routes across seams', () => {
  it('a car route and a walk route both run from one tile into another two seams away', async () => {
    const sim = await citySim({ rings: { near: 5000, drop: 6000, far: 9000 } });
    const st = sim.stream!;
    const g = st.lanes;
    // a main-component lane in 0_0 and one in 1_-1
    const pick = (tile: string) => {
      for (let e = 0; e < g.count; e++) {
        if (!g.main[e] || g.isConnector[e]) continue;
        const p = g.pts[e];
        if (tileOf(p[0], p[2]) === tile && g.len[e] > 30) return e;
      }
      return -1;
    };
    const a = pick('0_0'), b = pick('1_-1');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    const route = planRoute(g, a, b, 20000);
    expect(route).not.toBeNull();
    const tiles = new Set(route!.map((e) => tileOf(g.pts[e][0], g.pts[e][2])));
    expect(tiles.size).toBeGreaterThanOrEqual(2);
    // the walk network
    const w = st.walk;
    const node = (tile: string) => {
      for (let n = 0; n < w.nodeCount; n++) if (w.degree(n) > 1 && tileOf(w.x[n], w.z[n]) === tile) return n;
      return -1;
    };
    const wr = w.route(node('0_0'), node('1_-1'), 50000);
    expect(wr).not.toBeNull();
    expect(new Set(wr!.map((n) => tileOf(w.x[n], w.z[n]))).size).toBeGreaterThanOrEqual(2);
  });
});

describe('agents across seams', () => {
  it('traffic drives from tile to tile and stays on the road', async () => {
    const sim = await citySim({ traffic: 1, rings: { near: 300, drop: 450, far: 1500 } });
    // stand by the seam between 0_0 and 1_0, beside the avenue
    movePlayer(sim, 378, 112);
    const last = new Map<number, string>();
    let crossings = 0;
    let fell = 0;
    for (let t = 0; t < 90 * 60; t++) {
      sim.step();
      sim.drainEvents();
      if (t % 10) continue;
      for (const c of sim.traffic!.cars) {
        const p = c.veh.car.body.translation();
        const k = tileOf(p.x, p.z);
        const prev = last.get(c.veh.id);
        if (prev && prev !== k && c.mode !== 'free') crossings++;
        last.set(c.veh.id, k);
        if (p.y < sim.groundAt(p.x, p.z) - 2) fell++;
      }
    }
    expect(crossings).toBeGreaterThan(5);
    expect(fell).toBe(0);
    expect(sim.traffic!.cars.length).toBeGreaterThan(5);
  }, 120_000);

  it('pedestrians walk across a seam', async () => {
    const sim = await citySim({ ambient: true, pedBudget: 50, rings: { near: 300, drop: 450, far: 1500 } });
    movePlayer(sim, 384, 112);
    const side = new Map<number, number>();
    let crossings = 0;
    for (let t = 0; t < 120 * 60; t++) {
      sim.step();
      sim.drainEvents();
      if (t % 15) continue;
      for (const p of sim.ambient!.list) {
        if (p.vehicleId) continue;
        const s = Math.sign(p.controller.x - 384) || 1;
        const prev = side.get(p.id);
        if (prev !== undefined && prev !== s && Math.abs(p.controller.z - 112) < 200) crossings++;
        side.set(p.id, s);
      }
    }
    expect(sim.ambient!.count).toBeGreaterThan(10);
    expect(crossings).toBeGreaterThan(2);
  }, 120_000);

  it('the police chase the player across seams while the tiles stream', async () => {
    const sim = await Simulation.createCity({
      seed: 5,
      source: new FixtureTileSource(),
      driver: false,
      parkedCars: 0,
      law: atlanta,
      vehicleType: 'coupe',
      clock: { minutes: 14 * 60, scale: 0 },
      streamOptions: { rings: { near: 320, drop: 480, far: 1500 } },
    });
    const hero = heroCar(sim) as VehicleEntity;
    const z = 99.5;
    const x0 = -330;
    // to the start: a long way west of the spawn (the tiles load first)
    movePlayer(sim, x0 - 2.5, z + 3);
    for (let i = 0; i < 600 && sim.playerHeld; i++) sim.step();
    for (let i = 0; i < 120; i++) sim.step();
    hero.car.teleport(x0, sim.groundAt(x0, z) + 0.5, z, Math.PI / 2);
    run(sim, 30, cmd());
    run(sim, 4, cmd({ buttons: Button.Interact }));
    run(sim, 4, cmd());
    expect((playerPed(sim) as PedEntity).vehicleId).toBe(hero.id);
    sim.law.heat.report(2, 4, x0, z, true);
    const unitTile = new Map<number, string>();
    let unitCrossings = 0;
    let unitsSeen = 0;
    let fell = 0;
    for (let t = 0; t < 70 * 60; t++) {
      const p = hero.car.pose();
      if (p.x > 720) break;
      const v = hero.car.speedForward;
      const steer = Math.max(-1, Math.min(1, (p.z - z) * 0.15 + (Math.PI / 2 - hero.car.yaw) * 1.5));
      sim.pushInput(1, cmd({ axes: { Throttle: Math.max(0, Math.min(1, (17 - v) * 0.5)), Brake: 0, Steer: -steer } }));
      sim.step();
      sim.drainEvents();
      const me = playerPed(sim);
      me.armour = 1e9;
      if (me.life === 'alive') me.health = 100;
      if (t % 10) continue;
      for (const u of sim.police.units) {
        const veh = sim.registry.get(u.vehicleId) as VehicleEntity | undefined;
        if (!veh) continue;
        unitsSeen = Math.max(unitsSeen, sim.police.units.length);
        const q = veh.car.body.translation();
        const k = tileOf(q.x, q.z);
        const prev = unitTile.get(u.vehicleId);
        if (prev && prev !== k) unitCrossings++;
        unitTile.set(u.vehicleId, k);
        // (through the ground where there is ground: a unit lost far behind may drive off the edge of the fixture city, as off any map)
        if (sim.stream!.solidAt(q.x, q.z) && q.y < sim.groundAt(q.x, q.z) - 2) {
          if (fell < 3) console.log('fell', t, u.vehicleId, q.x.toFixed(1), q.y.toFixed(1), q.z.toFixed(1), 'ground', sim.groundAt(q.x, q.z).toFixed(1), 'solid', sim.stream!.solidAt(q.x, q.z), 'hero', hero.car.pose().x.toFixed(0), veh.car.body.isEnabled(), veh.kinematic);
          fell++;
        }
      }
    }
    expect(hero.car.pose().x).toBeGreaterThan(384 + 50);
    expect(sim.stream!.stats().drops).toBeGreaterThan(0);
    expect(unitsSeen).toBeGreaterThan(0);
    expect(unitCrossings).toBeGreaterThan(0);
    expect(fell).toBe(0);
  }, 180_000);
});
