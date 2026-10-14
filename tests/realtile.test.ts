import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBakedTile } from '../src/shared/tile';
import { Simulation } from '../src/sim/Simulation';
import { doorGeometry } from '../src/shared/doors';
import { rotateVec } from '../src/shared/math';
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

  it('starts on foot on the sidewalk, a few metres from an occupied car parked at the curb', async () => {
    const tile = await loadBakedTile(DIR, fsFetch);
    const s = await Simulation.create({ seed: 1, tile, driverMood: 'flee' });
    run(s, 90, cmd());
    const car = vehicle(s);
    const c = ped(s).controller;
    const p = car.car.pose();
    expect(Math.hypot(c.x - p.x, c.z - p.z)).toBeGreaterThan(4);
    expect(Math.hypot(c.x - p.x, c.z - p.z)).toBeLessThan(12);
    expect(c.grounded).toBe(true);
    expect(car.occupantId).not.toBe(0);
    expect(car.car.wheels.filter((w) => w.grounded).length).toBe(4);
    expect(car.car.speed).toBeLessThan(0.15);

    // parked cars along nearby curbs: several, of mixed types, each at rest on the ground
    const others = [...s.vehicles()].filter((v) => v.id !== car.id);
    expect(others.length).toBeGreaterThanOrEqual(4);
    expect(new Set(others.map((v) => v.typeId)).size).toBeGreaterThanOrEqual(2);
    for (const v of others) {
      expect(v.occupantId).toBe(0);
      expect(v.car.speed).toBeLessThan(0.3);
      expect(v.car.wheels.filter((w) => w.grounded).length).toBe(4);
    }

    // walk round to the driver's door (teleport there), jack the car, and drive off
    const g = doorGeometry(car.car.h);
    const w = rotateVec(p.q, g.stand.x, 0, g.stand.z);
    c.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
    run(s, 5, cmd());
    run(s, 2, cmd({ buttons: Button.Interact }));
    run(s, 100, cmd());
    expect(ped(s).vehicleId).toBe(car.id);
    const p0 = car.car.pose();
    run(s, 180, cmd({ axes: { Throttle: 1 } }));
    const p1 = car.car.pose();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(15);
    expect(telemetry(car.car).upY).toBeGreaterThan(0.9);
  });
});
