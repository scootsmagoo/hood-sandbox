import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../src/client/transport/LoopbackTransport';
import { doorGeometry } from '../src/shared/doors';
import { EntityKind } from '../src/shared/entities';
import { OUTFIT_COUNT, PAINTS } from '../src/shared/entityDefs';
import { rotateVec } from '../src/shared/math';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import type { SimEvent } from '../src/shared/protocol';
import { E, MAX_ENTITIES, PedFlag, SNAPSHOT_BYTES, SnapshotView, VehicleFlag } from '../src/shared/snapshot';
import { Simulation } from '../src/sim/Simulation';
import { Button, cmd, ped, run, vehicle } from './helpers';

const spawnSim = (seed = 1, over: Partial<Parameters<typeof Simulation.create>[0]> = {}) => Simulation.create({ seed, tile: generateProceduralTile(1), driverMood: 'flee', ...over });

function toDoor(sim: Simulation) {
  const v = vehicle(sim);
  const g = doorGeometry(v.car.h);
  const p = v.car.pose();
  const w = rotateVec(p.q, g.stand.x, 0, g.stand.z);
  ped(sim).controller.teleport(p.x + w.x, p.y - 0.3, p.z + w.z);
}

describe('entity definitions', () => {
  it('describe every entity: peds with an outfit, cars with a type and a paint', async () => {
    const sim = await spawnSim();
    const defs = sim.entityDefs();
    expect(defs.length).toBe(sim.registry.size);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    const vehicles = defs.filter((d) => d.kind === EntityKind.Vehicle);
    const peds = defs.filter((d) => d.kind === EntityKind.Ped);
    expect(vehicles.length).toBeGreaterThanOrEqual(4);
    expect(peds.length).toBe(2); // the player and the stand-in driver
    expect(peds.filter((p) => p.kind === EntityKind.Ped && p.player).length).toBe(1);
    expect(new Set(vehicles.map((v) => (v.kind === EntityKind.Vehicle ? v.typeId : ''))).size).toBeGreaterThanOrEqual(3);
    for (const d of defs) {
      if (d.kind === EntityKind.Vehicle) expect(PAINTS).toContain(d.color);
      else if (d.kind === EntityKind.Ped) expect(d.outfit).toBeLessThan(OUTFIT_COUNT);
    }
    // the player's character is outfit 0, the driver someone else
    const driver = peds.find((p) => p.kind === EntityKind.Ped && !p.player)!;
    expect(driver.kind === EntityKind.Ped && driver.outfit).toBeGreaterThan(0);
  });

  it('uses the requested type for the starting car and mixes the rest', async () => {
    const sim = await spawnSim(1, { vehicleType: 'pickup' });
    expect(vehicle(sim).typeId).toBe('pickup');
    const others = [...sim.vehicles()].filter((v) => v.id !== sim.vehicleId);
    expect(others.some((v) => v.typeId !== 'pickup')).toBe(true);
    expect((await spawnSim(1, { vehicleType: 'nonsense' })).vehicleType).toBe('sedan');
  });

  it('reaches the client in SimReady, and then as spawn and despawn events', async () => {
    const t = new LoopbackTransport({ manual: true });
    const ready = await t.start({ seed: 1, tileBaseUrl: null, autoRun: false, driverMood: 'flee' });
    expect(ready.entities.length).toBeGreaterThanOrEqual(6);
    const sim = t.host.simulation!;
    expect(ready.entities).toEqual(sim.entityDefs());
    // construction itself announces nothing: the ready message already carries it
    t.advance(2);
    expect(t.drainEvents().filter((e) => e.type === 'entity:spawn')).toEqual([]);

    // something new appears
    const v = sim.spawnVehicle('coupe', 20, 0, 40, 0, 0x2f5d8a);
    t.advance(2);
    const ev = t.drainEvents();
    const spawn = ev.find((e) => e.type === 'entity:spawn');
    expect(spawn).toMatchObject({ type: 'entity:spawn', def: { id: v.id, kind: EntityKind.Vehicle, typeId: 'coupe', color: 0x2f5d8a } });
    // and in the snapshots too
    const snaps = t.drainSnapshots();
    expect(snaps[snaps.length - 1].indexOf(v.id)).toBeGreaterThanOrEqual(0);

    // and goes away
    sim.despawn(v.id);
    t.advance(2);
    expect(t.drainEvents()).toContainEqual({ type: 'entity:despawn', tick: expect.any(Number), id: v.id });
    const after = t.drainSnapshots();
    expect(after[after.length - 1].indexOf(v.id)).toBe(-1);
    t.dispose();
  });

  it('takes a despawned ped out of the physics world as well as the registry', async () => {
    const sim = await spawnSim(1, { parkedCars: 0 });
    const n = sim.physics.world.bodies.len();
    const driver = sim.registry.get(vehicle(sim).occupantId)!;
    sim.despawn(driver.id);
    run(sim, 2, cmd());
    expect(sim.registry.get(driver.id)).toBeUndefined();
    expect(sim.physics.world.bodies.len()).toBe(n - 1);
    expect(vehicle(sim).occupantId).toBe(0);
  });
});

describe('snapshots with pedestrians and several cars', () => {
  it('flags the carjack as it happens: door open, driver dragged, player busy, then both settle', async () => {
    const sim = await spawnSim();
    run(sim, 20, cmd());
    toDoor(sim);
    run(sim, 3, cmd());
    run(sim, 2, cmd({ buttons: Button.Interact }));
    const v = new SnapshotView();
    const victimId = vehicle(sim).occupantId;
    run(sim, 30, cmd());
    sim.writeSnapshot(v);
    const flags = (id: number) => v.u32[v.at(v.indexOf(id)) + E.Flags];
    expect(flags(sim.vehicleId) & VehicleFlag.DoorOpen).toBeTruthy();
    expect(flags(victimId) & PedFlag.Dragged).toBeTruthy();
    expect(flags(victimId) & PedFlag.Npc).toBeTruthy();
    expect(flags(sim.playerPedId) & PedFlag.Busy).toBeTruthy();
    expect(flags(sim.playerPedId) & PedFlag.Npc).toBeFalsy();
    run(sim, 90, cmd());
    sim.writeSnapshot(v);
    expect(flags(sim.vehicleId) & VehicleFlag.DoorOpen).toBeFalsy();
    expect(flags(victimId) & PedFlag.Fleeing).toBeTruthy();
    expect(flags(sim.playerPedId) & PedFlag.Busy).toBeFalsy();
    expect(flags(sim.playerPedId) & PedFlag.InVehicle).toBeTruthy();
    expect(v.count).toBeLessThanOrEqual(MAX_ENTITIES);
  });

  it('seats a driver at the wheel: the ped sits at the seat, inside the car', async () => {
    const sim = await spawnSim();
    run(sim, 30, cmd());
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    const car = vehicle(sim);
    const p = car.car.pose();
    const driver = sim.registry.get(car.occupantId)!;
    const o = v.at(v.indexOf(driver.id));
    expect(v.u32[o + E.Flags] & PedFlag.InVehicle).toBeTruthy();
    const dx = v.f32[o + E.Px] - p.x;
    const dz = v.f32[o + E.Pz] - p.z;
    expect(Math.hypot(dx, dz)).toBeLessThan(1.2);
    // on the driver's (left) side of the car
    const local = rotateVec({ x: -p.q.x, y: -p.q.y, z: -p.q.z, w: p.q.w }, dx, 0, dz);
    expect(local.x).toBeGreaterThan(0.2);
  });

  it('is deterministic with pedestrians in it: the same seed and inputs give the same bytes and events', async () => {
    const script = async () => {
      const sim = await spawnSim(3, { driverMood: undefined });
      const events: SimEvent[] = [];
      const bytes: Uint8Array[] = [];
      let n = 0;
      for (let i = 0; i < 700; i++) {
        if (i === 30) toDoor(sim);
        const press = i === 40 || i === 330 || i === 380 ? Button.Interact : 0;
        sim.pushInput(1, { tick: ++n, buttons: press, axes: [0, 0, 0, 0, i > 240 ? 0.7 : 0, 0, i > 260 ? 0.3 : 0, 4] });
        sim.step();
        events.push(...sim.drainEvents());
        if (i % 100 === 99) {
          const v = new SnapshotView();
          sim.writeSnapshot(v);
          bytes.push(new Uint8Array(v.buffer.slice(0, SNAPSHOT_BYTES)));
        }
      }
      return { events, bytes };
    };
    const a = await script();
    const b = await script();
    expect(a.events.map((e) => e.type)).toContain('carjack');
    expect(a.events).toEqual(b.events);
    for (let i = 0; i < a.bytes.length; i++) expect(Buffer.from(a.bytes[i]).equals(Buffer.from(b.bytes[i]))).toBe(true);
    // and another seed differs somewhere (the world is parked differently)
    const other = await spawnSim(4);
    expect([...other.vehicles()].map((v) => v.car.pose().x)).not.toEqual([...(await spawnSim(3)).vehicles()].map((v) => v.car.pose().x));
  });
});
