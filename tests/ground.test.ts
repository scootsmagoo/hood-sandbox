/**
 * The ground audit's quick version (tests/audit/ground/; the whole tile is `npm run audit:ground`, docs/ground-audit.md).
 *
 * 1. On a synthetic ground (a slope with a few centimetres of noise at every 4 m vertex, the way a carved DEM is), a car held at
 *    30 m/s never leaves the road and is never pushed by the ground under its hull. Two things keep it down: the crash guard
 *    (RaycastCar's GUARD: no predictive contacts against the road) and the heightfield's internal-edge fix (for the ticks the guard
 *    is on, beside a wall, a barrier or a car). With the guard held on and without the fix the same run is thrown (the regression
 *    the flag guards); with the guard and without the fix it is not (the regression the guard guards).
 * 2. On the baked tile, when there is one: no lane, junction curve or main road runs into a building, and a sample of the lanes
 *    driven at 25 m/s stays within the gate's limits.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLING } from '../src/shared/handling';
import { Rng } from '../src/shared/rng';
import { SIM_DT } from '../src/shared/protocol';
import { heightAt, type TileData } from '../src/shared/tile';
import { initRapier } from '../src/sim/physics/rapier';
import { RaycastCar } from '../src/sim/vehicles/RaycastCar';
import { driveLanes, Graph, GroundWorld, scanBuildings, scanSurfaces } from './audit/ground/core';
import { gateNumbers, loadTile } from './audit/ground/run';
import { flatTile } from './helpers';

/** The flat test tile with its heightmap a 5% slope along +x plus up to `noise` m of seeded noise at every vertex. */
function noisyTile(noise: number): TileData {
  const t = flatTile();
  const { cols, rows, cellSize, minX } = t.manifest.heightmap;
  const rng = new Rng(7);
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) h[r * cols + c] = 0.05 * (minX + c * cellSize) + (rng.next() * 2 - 1) * noise;
  return { ...t, heights: h };
}

/** Drives straight along +x at about 30 m/s for 8 s; returns the ticks in the air and the largest unexplained upward push (m/s). */
async function runNoisy(fixInternalEdges: boolean, guardPinned = false) {
  const R = await initRapier();
  const tile = noisyTile(0.03);
  const gw = new GroundWorld(R, tile, { fixInternalEdges });
  const h = HANDLING.sedan;
  const x0 = -300, z0 = 40;
  const car = new RaycastCar(R, gw.world, h, { x: x0, y: heightAt(tile, x0, z0) + RaycastCar.restHeight(h) + 0.02, z: z0, yaw: Math.PI / 2 });
  car.body.setLinvel({ x: 30, y: 30 * 0.05, z: 0 }, true);
  car.adopt();
  car.guardPinned = guardPinned;
  let air = 0, maxAir = 0, prevVy = car.body.linvel().y, push = 0;
  for (let i = 0; i < 8 * 60; i++) {
    const v = car.speedForward;
    car.step(SIM_DT, { throttle: v < 30 ? 0.6 : 0, brake: 0, steer: 0, handbrake: false });
    const up = car.body.rotation();
    void up;
    let wheelDv = 0;
    for (const w of car.wheels) wheelDv += (w.load * SIM_DT) / h.mass;
    gw.world.step();
    const vy = car.body.linvel().y;
    if (i > 30) push = Math.max(push, vy - prevVy - (wheelDv - 9.81 * SIM_DT));
    prevVy = vy;
    air = car.wheels.some((w) => w.grounded) ? 0 : air + 1;
    maxAir = Math.max(maxAir, air);
  }
  return { maxAir, push, x: car.body.translation().x };
}

describe('the ground under a car', () => {
  it('does not throw a car at 30 m/s on a noisy carved slope (internal edges fixed)', async () => {
    const r = await runNoisy(true);
    expect(r.x).toBeGreaterThan(-300 + 200);
    expect(r.maxAir).toBeLessThan(3);
    expect(r.push).toBeLessThan(0.3);
  });

  it('does not throw it with the crash guard held on either (predictive contacts live, as beside a wall): the fix holds it', async () => {
    const r = await runNoisy(true, true);
    expect(r.maxAir).toBeLessThan(3);
    expect(r.push).toBeLessThan(0.3);
  });

  it('would, with the guard held on and without the fix (the regression the flag guards)', async () => {
    const r = await runNoisy(false, true);
    expect(r.maxAir >= 3 || r.push >= 0.3).toBe(true);
  });

  it('does not, with the guard and without the fix (the regression the guard guards: no predictive contacts on the road)', async () => {
    const r = await runNoisy(false);
    expect(r.x).toBeGreaterThan(-300 + 200);
    expect(r.maxAir).toBeLessThan(3);
    expect(r.push).toBeLessThan(0.3);
  });
});

const DIR = 'public/tiles/atlanta/m1-five-points';
const have = existsSync(`${DIR}/tile.json`);

describe.skipIf(!have)('the ground audit on the baked tile (a sample)', () => {
  it('has no lane, turn or main road into a building, and a sample of lanes drives clean at 25 m/s', async () => {
    const R = await initRapier();
    const tile = await loadTile(DIR);
    const gw = new GroundWorld(R, tile);
    const g = new Graph(tile);
    const buildings = scanBuildings(gw, g);
    const into = buildings.filter((e) => e.edge >= 0 || e.cause === 'main-road-in-building' || e.cause === 'main-road-dead-ends-at-building');
    expect(into.map((e) => `${e.cause} at ${e.x.toFixed(0)}, ${e.z.toFixed(0)}`)).toEqual([]);
    // every 60th edge, routes of at most 25 (about 1.5 km of driving)
    const sample = g.edges.map((_, i) => i).filter((i) => i % 60 === 0);
    const { events, stats } = driveLanes(gw, g, { speed: 25, targets: sample, maxRoutes: 25 });
    const surfaces = scanSurfaces(gw, g, [25], sample);
    const { gate } = gateNumbers([...events, ...surfaces], [stats]);
    console.log('ground sample', JSON.stringify({ km: (stats.metres / 1000).toFixed(1), covered: stats.covered, gate }));
    expect(stats.metres).toBeGreaterThan(500);
    expect(gate.launches).toBeLessThanOrEqual(QUICK.launches);
    expect(gate.smoothLaunches).toBe(0);
    expect(gate.joltsPer10km).toBeLessThanOrEqual(QUICK.joltsPer10km);
  }, 120_000);
});

describe.skipIf(!have)('deck barriers on the baked tile', () => {
  it('turns a car that hits a deck barrier at speed along it: it stays on the deck and is not thrown up', async () => {
    const R = await initRapier();
    const tile = await loadTile(DIR);
    const gw = new GroundWorld(R, tile);
    // Mitchell Street SW over the rail gulch, 7 m up: a two-lane deck with a barrier either side
    const road = (tile as unknown as { roads: { id: string; bridge: boolean; width: number; points: number[][] }[] }).roads.find((r) => r.id === 'osm:way/54032243' && r.bridge);
    expect(road).toBeTruthy();
    const P = road!.points, m = Math.floor(P.length / 2);
    const a = P[m - 1], b = P[m];
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz);
    const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, z = (a[2] + b[2]) / 2;
    const h = HANDLING.sedan;
    for (const [deg, v] of [[25, 25], [45, 35], [-25, 35]]) {
      const yaw = Math.atan2(dx, dz) + (deg * Math.PI) / 180;
      const car = new RaycastCar(R, gw.world, h, { x, y: y + RaycastCar.restHeight(h) + 0.02, z, yaw });
      car.body.setLinvel({ x: Math.sin(yaw) * v, y: 0, z: Math.cos(yaw) * v }, true);
      let off = 0, vy = 0, low = Infinity;
      for (let t = 0; t < 120; t++) {
        car.step(SIM_DT, { throttle: 0.5, brake: 0, steer: 0, handbrake: false });
        gw.world.step();
        const p = car.body.translation();
        off = Math.max(off, Math.abs((p.x - x) * (-dz / l) + (p.z - z) * (dx / l)));
        vy = Math.max(vy, car.body.linvel().y);
        low = Math.min(low, p.y - y);
      }
      expect(off, `${deg} degrees at ${v} m/s`).toBeLessThan(road!.width / 2);
      expect(vy).toBeLessThan(3);
      expect(low).toBeGreaterThan(-1);
      gw.world.removeRigidBody(car.body);
    }
  }, 60_000);
});

/** The sample's limits (looser than the full audit's gate: a sample is small, and a single spot is a big share of it). */
const QUICK = { launches: 1, joltsPer10km: 15 };
