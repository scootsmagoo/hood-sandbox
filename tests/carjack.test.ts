import { describe, expect, it } from 'vitest';
import { doorGeometry } from '../src/shared/doors';
import { rotateVec } from '../src/shared/math';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import type { SimEvent } from '../src/shared/protocol';
import { Simulation } from '../src/sim/Simulation';
import type { PedEntity, VehicleEntity } from '../src/sim/entities';
import { Button, cmd, ped, run, vehicle } from './helpers';

/** The default start on the procedural ground: the player on the sidewalk, the car at the curb with a driver in it. */
async function spawnSim(over: Partial<Parameters<typeof Simulation.create>[0]> = {}) {
  return Simulation.create({ seed: 1, tile: generateProceduralTile(1), ...over });
}

function driverOf(sim: Simulation): PedEntity {
  return sim.registry.get(vehicle(sim).occupantId) as PedEntity;
}

/** Puts the player at the driver's door of the car, facing it. */
function toDoor(sim: Simulation, v: VehicleEntity = vehicle(sim)) {
  const g = doorGeometry(v.car.h);
  const p = v.car.pose();
  const w = rotateVec(p.q, g.stand.x, 0, g.stand.z);
  ped(sim).controller.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
}

const events = (sim: Simulation, into: SimEvent[]) => into.push(...sim.drainEvents());

describe('the start: on foot, beside a parked car with someone in it', () => {
  it('stands the player on the sidewalk a few metres from an occupied parked car', async () => {
    const sim = await spawnSim();
    run(sim, 60, cmd());
    const car = vehicle(sim);
    const c = ped(sim).controller;
    const p = car.car.pose();
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThan(12);
    expect(ped(sim).vehicleId).toBe(0);
    const driver = driverOf(sim);
    expect(driver).toBeTruthy();
    expect(driver.brain?.state).toBe('seated');
    expect(driver.vehicleId).toBe(car.id);
    expect(car.car.speed).toBeLessThan(0.1);
  });

  it('parks a few empty cars of mixed types along nearby streets', async () => {
    const sim = await spawnSim();
    run(sim, 120, cmd());
    const parked = [...sim.vehicles()].filter((v) => v.id !== sim.vehicleId);
    expect(parked.length).toBeGreaterThanOrEqual(3);
    expect(new Set(parked.map((v) => v.typeId)).size).toBeGreaterThanOrEqual(2);
    for (const v of parked) {
      expect(v.occupantId).toBe(0);
      expect(v.car.speed).toBeLessThan(0.2);
      const p = v.car.pose();
      expect(Math.hypot(p.x - ped(sim).controller.x, p.z - ped(sim).controller.z)).toBeGreaterThan(8);
      expect(v.car.wheels.every((w) => w.grounded)).toBe(true);
    }
  });

  it('keeps ?start=car as an empty car with the player at its door', async () => {
    const sim = await spawnSim({ start: 'car' });
    expect(vehicle(sim).occupantId).toBe(0);
    run(sim, 30, cmd());
    run(sim, 3, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(sim.vehicleId);
  });
});

describe('carjacking', () => {
  it('needs the driver door: from the passenger side nothing happens', async () => {
    const sim = await spawnSim({ driverMood: 'flee' });
    run(sim, 30, cmd());
    const car = vehicle(sim);
    const p = car.car.pose();
    const g = doorGeometry(car.car.h);
    const w = rotateVec(p.q, -g.stand.x, 0, g.stand.z);
    ped(sim).controller.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
    run(sim, 3, cmd());
    run(sim, 3, cmd({ buttons: Button.Interact }));
    run(sim, 10, cmd());
    expect(sim.carjacks.length).toBe(0);
    expect(ped(sim).vehicleId).toBe(0);
    expect(driverOf(sim).brain?.state).toBe('seated');
  });

  it('pulls the driver out over about a second, who flees, and puts the player at the wheel', async () => {
    const sim = await spawnSim({ driverMood: 'flee' });
    run(sim, 30, cmd());
    const log: SimEvent[] = [];
    const car = vehicle(sim);
    const victim = driverOf(sim);
    toDoor(sim);
    run(sim, 3, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    events(sim, log);
    const jack = log.find((e) => e.type === 'carjack');
    expect(jack).toMatchObject({ type: 'carjack', pedId: ped(sim).id, victimId: victim.id, vehicleId: car.id, reaction: 'flee' });
    expect(ped(sim).busy).toBe(true);
    expect(car.doorOpen || sim.carjacks.length === 1).toBe(true);

    // Mid-sequence the player cannot walk off or drive.
    run(sim, 20, cmd({ axes: { MoveY: 1 } }));
    expect(ped(sim).vehicleId).toBe(0);

    // About 1.4 s later the driver is out and the player is in.
    run(sim, 70, cmd());
    events(sim, log);
    expect(ped(sim).vehicleId).toBe(car.id);
    expect(car.occupantId).toBe(ped(sim).id);
    expect(ped(sim).busy).toBe(false);
    expect(car.doorOpen).toBe(false);
    expect(log.map((e) => e.type)).toContain('vehicle:enter');
    expect(victim.vehicleId).toBe(0);
    expect(victim.brain?.state).toBe('flee');
    expect(victim.controller.enabled).toBe(true);

    // The player can drive off at once.
    const p0 = car.car.pose();
    run(sim, 120, cmd({ axes: { Throttle: 1 } }));
    const p1 = car.car.pose();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(10);
  });

  it('has the driver run away from the player along open ground, and gone when far', async () => {
    const sim = await spawnSim({ driverMood: 'flee' });
    run(sim, 30, cmd());
    const victim = driverOf(sim);
    const car = vehicle(sim);
    toDoor(sim);
    run(sim, 3, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    run(sim, 90, cmd());
    // The player stays put at the wheel; the driver runs.
    const log: SimEvent[] = [];
    let d0 = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 20 * 60; i++) {
      run(sim, 1, cmd());
      if (i === 0) d0 = Math.hypot(victim.controller.x - car.car.pose().x, victim.controller.z - car.car.pose().z);
      maxSpeed = Math.max(maxSpeed, victim.controller.speed);
      events(sim, log);
      if (!sim.registry.get(victim.id)) break;
    }
    expect(maxSpeed).toBeGreaterThan(6);
    expect(d0).toBeGreaterThan(0.5);
    expect(log.some((e) => e.type === 'entity:despawn' && e.id === victim.id)).toBe(true);
  });

  it('can have the driver fight back for a few seconds, then run', async () => {
    const sim = await spawnSim({ driverMood: 'fight' });
    run(sim, 30, cmd());
    const victim = driverOf(sim);
    const log: SimEvent[] = [];
    toDoor(sim);
    run(sim, 3, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    // Stay on foot beside the car: the player is "in" it after the script, so step out again
    run(sim, 90, cmd());
    events(sim, log);
    expect(log.find((e) => e.type === 'carjack')).toMatchObject({ reaction: 'fight' });
    expect(victim.brain?.state).toBe('fight');
    run(sim, 2, cmd({ buttons: Button.Interact })); // get out so there is something to punch
    let fought = 0;
    let fled = false;
    for (let i = 0; i < 10 * 60; i++) {
      run(sim, 1, cmd());
      events(sim, log);
      if (victim.brain?.state === 'flee') {
        fled = true;
        break;
      }
      fought++;
    }
    expect(fled).toBe(true);
    expect(fought / 60).toBeGreaterThan(1.5);
    expect(fought / 60).toBeLessThan(6);
    expect(log.some((e) => e.type === 'ped:attack')).toBe(true);
    expect(ped(sim).health).toBeLessThan(100);
  });

  it('rolls the reaction from the seed, deterministically, and about three in ten fight', async () => {
    const moods: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const sim = await Simulation.create({ seed, tile: generateProceduralTile(1), parkedCars: 0 });
      moods.push(driverOf(sim).brain!.personality.reaction);
    }
    const again = await Simulation.create({ seed: 7, tile: generateProceduralTile(1), parkedCars: 0 });
    expect(driverOf(again).brain!.personality.reaction).toBe(moods[6]);
    const fights = moods.filter((m) => m === 'fight').length;
    expect(fights).toBeGreaterThan(4);
    expect(fights).toBeLessThan(22);
  });
});

describe('entering an empty car', () => {
  it('works for the car just stolen once the player has left it, and for a parked one', async () => {
    const sim = await spawnSim({ driverMood: 'flee' });
    run(sim, 30, cmd());
    const car = vehicle(sim);
    toDoor(sim);
    run(sim, 3, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    run(sim, 100, cmd());
    expect(ped(sim).vehicleId).toBe(car.id);
    run(sim, 2, cmd({ buttons: Button.Interact })); // out
    expect(ped(sim).vehicleId).toBe(0);
    run(sim, 20, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact })); // back in, through the empty-car path
    expect(ped(sim).vehicleId).toBe(car.id);
    run(sim, 2, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(0);

    // A parked one: walk up to it and get in.
    const other = [...sim.vehicles()].find((v) => v.id !== car.id)!;
    const p = other.car.pose();
    const g = doorGeometry(other.car.h);
    const w = rotateVec(p.q, g.stand.x, 0, g.stand.z);
    ped(sim).controller.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
    run(sim, 10, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(other.id);
  });
});
