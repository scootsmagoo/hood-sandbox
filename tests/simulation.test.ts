import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import { EntityKind } from '../src/shared/entities';
import { SNAPSHOT_BYTES, SnapshotView, E, H, PedFlag, SnapFlag, VehicleFlag } from '../src/shared/snapshot';
import { Axis, Button, driverSim, cmd, makeSim, ped, run, telemetry, vehicle } from './helpers';

describe('enter and exit', () => {
  it('gets in when close to the car with one press, and out with another', async () => {
    const sim = await makeSim();
    const car = vehicle(sim).car;
    const c = ped(sim).controller;
    run(sim, 30, cmd());
    expect(c.enabled).toBe(true);
    run(sim, 3, cmd({ buttons: Button.Interact }));
    // 6 m away: nothing happens
    expect(ped(sim).vehicleId).toBe(0);
    c.teleport(car.body.translation().x - 2.5, 0, car.body.translation().z);
    run(sim, 3, cmd());
    run(sim, 3, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(sim.vehicleId);
    expect(vehicle(sim).occupantId).toBe(ped(sim).id);
    expect(c.enabled).toBe(false);
    expect(sim.drainEvents().map((e) => e.type)).toContain('vehicle:enter');

    // holding the key is one press, not a toggle
    run(sim, 30, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(sim.vehicleId);
    run(sim, 2, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(0);
    expect(c.enabled).toBe(true);
    expect(vehicle(sim).occupantId).toBe(0);
    // standing beside the car, on the ground, not inside it
    const t = car.body.translation();
    expect(Math.hypot(c.x - t.x, c.z - t.z)).toBeGreaterThan(1.2);
    expect(Math.hypot(c.x - t.x, c.z - t.z)).toBeLessThan(3.5);
    run(sim, 30, cmd());
    expect(c.grounded).toBe(true);
    expect(sim.drainEvents().map((e) => e.type)).toContain('vehicle:exit');
  });

  it('counts a tap that starts and ends between two ticks', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    const car = vehicle(sim).car;
    c.teleport(car.body.translation().x - 2.5, 0, car.body.translation().z);
    run(sim, 10, cmd());
    sim.pushInput(1, cmd({ buttons: Button.Interact }));
    sim.pushInput(1, cmd({ buttons: 0 }));
    sim.step();
    expect(ped(sim).vehicleId).toBe(sim.vehicleId);
  });

  it('will not let the driver out at speed', async () => {
    const { sim, car } = await driverSim();
    run(sim, 200, cmd({ axes: { Throttle: 1 } }));
    sim.drainEvents();
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(sim.vehicleId);
    expect(sim.drainEvents().map((e) => e.type)).toContain('vehicle:exit-denied');
    for (let i = 0; i < 400 && car.speedForward > 1; i++) run(sim, 1, cmd({ axes: { Brake: 1 } }));
    run(sim, 30, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(car.speed).toBeLessThan(9);
    expect(ped(sim).vehicleId).toBe(0);
  });

  it('puts the driver down on the ground beside a car parked near a wall', async () => {
    const tile = generateProceduralTile(1);
    const { sim, car } = await driverSim('sedan', tile, { x: -14, z: 40 });
    run(sim, 30, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    expect(ped(sim).vehicleId).toBe(0);
    run(sim, 30, cmd());
    expect(ped(sim).controller.grounded).toBe(true);
    void car;
  });

  it('stands the car back up on reset', async () => {
    const { sim, car } = await driverSim();
    car.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); // upside down
    run(sim, 2, cmd());
    run(sim, 2, cmd({ buttons: Button.Reset }));
    run(sim, 120, cmd());
    expect(telemetry(car).upY).toBeGreaterThan(0.95);
    expect(car.wheels.every((w) => w.grounded)).toBe(true);
  });

  it('puts things that fall out of the world back at their spawn', async () => {
    const sim = await makeSim();
    const car = vehicle(sim).car;
    car.teleport(0, -500, 0, 0);
    run(sim, 3, cmd());
    expect(car.body.translation().y).toBeGreaterThan(0);
    expect(sim.drainEvents().some((e) => e.type === 'entity:respawn')).toBe(true);
    ped(sim).controller.teleport(5000, 0, 0);
    run(sim, 3, cmd());
    expect(Math.abs(ped(sim).controller.x)).toBeLessThan(100);
  });
});

describe('snapshots', () => {
  it('describes the entities, the controlled one and the flags', async () => {
    const sim = await makeSim();
    run(sim, 10, cmd());
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.tick).toBe(sim.tick);
    expect(v.count).toBe(2);
    expect(v.controlled).toBe(sim.playerPedId);
    expect(v.inVehicle).toBe(false);
    const pi = v.indexOf(sim.playerPedId);
    const vi = v.indexOf(sim.vehicleId);
    expect(v.u32[v.at(pi) + E.Kind]).toBe(EntityKind.Ped);
    expect(v.u32[v.at(vi) + E.Kind]).toBe(EntityKind.Vehicle);
    expect(v.u32[v.at(pi) + E.Flags] & PedFlag.Grounded).toBeTruthy();
    expect(v.f32[v.at(vi) + E.Py]).toBeCloseTo(vehicle(sim).car.body.translation().y, 4);
    expect(v.f32[v.at(vi) + E.Wheels + 2]).toBeCloseTo(vehicle(sim).car.wheels[0].length, 5);

    const { sim: s2 } = await driverSim();
    s2.writeSnapshot(v);
    expect(v.inVehicle).toBe(true);
    expect(v.controlled).toBe(s2.vehicleId);
    expect(v.u32[v.at(v.indexOf(s2.vehicleId)) + E.Flags] & VehicleFlag.Occupied).toBeTruthy();
    expect(v.u32[v.at(v.indexOf(s2.playerPedId)) + E.Flags] & PedFlag.InVehicle).toBeTruthy();
    expect(v.u32[H.Flags] & SnapFlag.InVehicle).toBeTruthy();
  });

  it('acknowledges the newest input tick', async () => {
    const sim = await makeSim();
    sim.pushInput(1, { tick: 777, buttons: 0, axes: new Array(8).fill(0) });
    sim.step();
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.ack).toBe(777);
    // an older command is ignored
    sim.pushInput(1, { tick: 5, buttons: Button.Jump, axes: new Array(8).fill(0) });
    sim.step();
    expect(sim.players.get(1)!.buttons).toBe(0);
  });

  it('is deterministic: the same inputs give the same bytes', async () => {
    const script = (sim: Awaited<ReturnType<typeof makeSim>>) => {
      let n = 0;
      const next = () => ({ tick: ++n, buttons: n === 5 ? Button.Interact : n === 200 ? Button.Handbrake : 0, axes: [0.2, 0.5, 0.3, 0, n > 10 ? 1 : 0, 0, Math.sin(n / 30), 4] });
      for (let i = 0; i < 400; i++) {
        sim.pushInput(1, next());
        sim.step();
      }
      const v = new SnapshotView();
      sim.writeSnapshot(v);
      return new Uint8Array(v.buffer.slice(0, SNAPSHOT_BYTES));
    };
    const a = script(await makeSim(generateProceduralTile(3)));
    const b = script(await makeSim(generateProceduralTile(3)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('camera arm', () => {
  it('reports how much of the arm is clear and shortens it behind a wall', async () => {
    const tile = generateProceduralTile(1);
    const sim = await makeSim(tile);
    const c = ped(sim).controller;
    // The 1 m wall box at x -14, z 10 is only 1 m high, so use a building: the tile's wall at z = +1000.
    c.teleport(0, 0, 995);
    run(sim, 30, cmd({ axes: { Yaw: 0, Pitch: -0.3, CamDist: 6 } }));
    // yaw 0 looks north (-Z); the arm points south into the wall 5 m behind the player
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.camClear).toBeGreaterThan(2);
    expect(v.camClear).toBeLessThan(5.5);
    c.teleport(0, 0, 500);
    run(sim, 30, cmd({ axes: { Yaw: 0, Pitch: -0.3, CamDist: 6 } }));
    sim.writeSnapshot(v);
    expect(v.camClear).toBeCloseTo(6, 3);
  });
});
void Axis;
