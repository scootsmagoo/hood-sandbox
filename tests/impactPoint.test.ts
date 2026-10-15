/**
 * `vehicle:damage` carries where a crash hit (`at`, in the car's frame) so the client can dent the
 * body there: the front for a head-on, the tail when backed into a wall.
 */
import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import type { SimEvent } from '../src/shared/protocol';
import { cmd, driverSim, ofType, runLog } from './helpers';

async function wall(speed: number, backwards: boolean) {
  const tile = generateProceduralTile(1);
  const { sim, car } = await driverSim('sedan', tile, { x: -40, z: 985 });
  // the tile's north wall's face is at z 1000
  car.teleport(-40, 0.4, 1000 - car.h.chassis.halfExtents[2] - 1.5, backwards ? Math.PI : 0);
  const events: SimEvent[] = [...runLog(sim, 10, cmd())];
  car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
  car.adopt();
  events.push(...runLog(sim, 120, cmd()));
  return { hz: car.h.chassis.halfExtents[2], hits: ofType(events, 'vehicle:damage').filter((e) => e.at) };
}

describe('crash impact points', () => {
  it('a head-on into a wall is reported at the nose, pushing back', async () => {
    const { hz, hits } = await wall(60 / 3.6, false);
    expect(hits.length).toBeGreaterThan(0);
    const [x, y, z, dx, dy, dz] = hits[0].at!;
    expect(z).toBeGreaterThan(hz * 0.6);
    expect(Math.abs(x)).toBeLessThan(1.1);
    expect(y).toBeGreaterThan(-0.4);
    expect(dz).toBeLessThan(-0.8);
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 1);
  });

  it('backing into a wall is reported at the tail, pushing forward', async () => {
    const { hz, hits } = await wall(40 / 3.6, true);
    expect(hits.length).toBeGreaterThan(0);
    const [, , z, , , dz] = hits[0].at!;
    expect(z).toBeLessThan(-hz * 0.6);
    expect(dz).toBeGreaterThan(0.8);
  });
});
