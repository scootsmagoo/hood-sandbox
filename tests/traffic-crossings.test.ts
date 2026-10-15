import { describe, expect, it } from 'vitest';
import { parsePaths, type PathsData } from '../src/shared/walk';
import { Simulation } from '../src/sim/Simulation';
import type { VehicleEntity } from '../src/sim/entities';
import { ped } from './helpers';
import { crossroads, laneOf, laneTile, lanesFor, stepAll } from './trafficHelpers';

const KIND = { type: 'sedan', color: 0x2244cc };

/** One unsignalled crossing across the avenue at x = 40, from kerb (z = -8) to kerb (z = 8). */
function crossingPaths(): PathsData {
  return parsePaths({
    version: 1,
    nodes: [[40, 0.1, -8], [40, 0.1, 8]],
    attrs: [{ kind: 'crossing', width: 3, crossing: { id: null, marked: true, signals: false, junction: null, leg: null, road: 'osm:way/1' } }],
    edges: [0, 1, 0],
  })!;
}

/** The avenue (no random traffic), its one crossing, and a car spawned in the eastbound lane 190 m west of the crossing. */
async function avenue() {
  const { roads, junctions } = crossroads('none', 500);
  const sim = await Simulation.create({
    seed: 1, tile: { ...laneTile(lanesFor(roads, junctions)), paths: crossingPaths() }, driver: false, parkedCars: 0, traffic: 1,
    clock: { minutes: 14 * 60, scale: 0 },
  });
  sim.traffic!.density = 0;
  (sim.registry.get(sim.vehicleId) as VehicleEntity).car.teleport(300, 0.5, 300, 0);
  const car = sim.traffic!.spawnAt(laneOf(sim, 'ew', 1, 0, 'first'), 350, KIND); // x = -150
  const at = (x: number, z: number) => ped(sim).controller.teleport(x, sim.groundAt(x, z) + 0.1, z);
  const x = () => car.veh.car.body.translation().x;
  return { sim, car, at, x };
}

describe('traffic and unsignalled crossings', () => {
  it('stops for someone on the crossing, then goes on once it is clear', async () => {
    const { sim, car, at, x } = await avenue();
    at(40, 6);
    let furthest = -Infinity;
    stepAll(sim, 20 * 60, () => {
      furthest = Math.max(furthest, x());
    });
    // the front bumper stops short of the crossing (it is at x = 40) and the car has come to rest
    expect(furthest).toBeLessThan(38);
    expect(car.v).toBeLessThan(0.5);
    expect(car.crossWait).toBeGreaterThanOrEqual(0);

    at(40, 30);
    stepAll(sim, 12 * 60);
    expect(x()).toBeGreaterThan(44);
  });

  it('does not hold the street for ever: after its patience a car drives on past someone who stays on the crossing', async () => {
    const { sim, car, x, at } = await avenue();
    at(40, 6);
    let stoppedAt = -1;
    let passedAt = -1;
    stepAll(sim, 40 * 60, (i) => {
      if (stoppedAt < 0 && car.v < 0.5 && x() < 38) stoppedAt = i;
      if (passedAt < 0 && x() > 44) passedAt = i;
    });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(passedAt).toBeGreaterThan(stoppedAt);
    // it waited about the patience (15 s), then went on
    expect((passedAt - stoppedAt) / 60).toBeGreaterThan(10);
    expect((passedAt - stoppedAt) / 60).toBeLessThan(25);
  });
});
