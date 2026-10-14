import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBakedTile } from '../src/shared/tile';
import { Simulation } from '../src/sim/Simulation';
import { Button, cmd, ped, run, telemetry, vehicle } from './helpers';

const DIR = 'public/tiles/atlanta/m1-five-points';
const have = existsSync(`${DIR}/tile.json`);

// Reads the baked tile straight from disk, the way the worker reads it over HTTP.
const fsFetch = async (url: string) => {
  const path = url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return {
    ok,
    status: ok ? 200 : 404,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

describe.skipIf(!have)('the baked Five Points tile', () => {
  async function sim(startAtVehicle = true) {
    const tile = await loadBakedTile(DIR, fsFetch);
    return Simulation.create({ seed: 1, tile, startAtVehicle });
  }

  it('loads and lets the car rest on the road at its spawn', async () => {
    const s = await sim();
    run(s, 120, cmd());
    const car = vehicle(s).car;
    const t = car.body.translation();
    const g = s.physics.groundHeight(t.x, t.z);
    expect(t.y - g).toBeGreaterThan(0.25);
    expect(t.y - g).toBeLessThan(0.6);
    expect(car.wheels.filter((w) => w.grounded).length).toBe(4);
    expect(ped(s).controller.grounded).toBe(true);
  });

  it('drives down the road and the character can get in', async () => {
    const s = await sim();
    run(s, 60, cmd());
    run(s, 3, cmd({ buttons: Button.Interact }));
    expect(ped(s).vehicleId).toBe(s.vehicleId);
    const car = vehicle(s).car;
    const p0 = car.pose();
    run(s, 300, cmd({ axes: { Throttle: 1 } }));
    const p1 = car.pose();
    console.log('drove', Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1), 'm; speed', car.speed.toFixed(1), JSON.stringify(telemetry(car)));
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(20);
    expect(telemetry(car).upY).toBeGreaterThan(0.8);
  });
});
