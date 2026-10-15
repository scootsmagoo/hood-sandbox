import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Button, SIM_DT, type SimEvent } from '../src/shared/protocol';
import { walkState } from '../src/shared/signals';
import { loadBakedTile } from '../src/shared/tile';
import { damagePed, knockDown } from '../src/sim/combat/damage';
import type { PedEntity } from '../src/sim/entities';
import { AMBIENT, type AmbientPeds } from '../src/sim/peds/AmbientPeds';
import { newAmbientState } from '../src/sim/peds/state';
import { Simulation } from '../src/sim/Simulation';
import { SnapshotView } from '../src/shared/snapshot';
import { cmd, ofType, ped as playerPed, run, vehicle } from './helpers';
import { pedSim, pedTile, population } from './pedHelpers';

/** Steps the sim and returns the events it made. */
function stepLog(sim: Simulation, ticks: number, each?: (tick: number) => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    out.push(...sim.drainEvents());
    each?.(sim.tick);
  }
  return out;
}

const ambient = (sim: Simulation): AmbientPeds => sim.ambient!;

describe('who is out, and when', () => {
  it('puts more people on the street at lunch than at 4 a.m., from the population table', async () => {
    const peds = [0, 0, 0, 1, 4, 6, 8, 6, 5, 4, 2, 1];
    const lunch = await pedSim({ peds, minutes: 12 * 60 });
    const night = await pedSim({ peds, minutes: 4 * 60 });
    stepLog(lunch, 120);
    stepLog(night, 120);
    expect(ambient(lunch).count).toBeGreaterThan(15);
    expect(ambient(night).count).toBe(0);
    expect(ambient(lunch).target).toBeGreaterThan(ambient(night).target);
  });

  it('follows the clock as it moves on: the street empties as the quiet hours come', async () => {
    const peds = [0, 0, 0, 1, 4, 6, 8, 6, 5, 4, 2, 1];
    const sim = await pedSim({ peds, minutes: 12 * 60 });
    stepLog(sim, 60);
    const before = ambient(sim).count;
    expect(before).toBeGreaterThan(15);
    // turn the camera away from the street so nobody is held there by being watched
    sim.clock.minutes = 4 * 60;
    stepLog(sim, 600);
    expect(ambient(sim).target).toBe(0);
    expect(ambient(sim).count).toBeLessThan(before * 0.75);
  });

  it('knows weekdays from weekends', async () => {
    const lunch = await pedSim({ peds: 5, day: 2 });
    const clock = lunch.clock;
    expect(clock.weekend).toBe(false);
    clock.day = 5;
    expect(clock.weekend).toBe(true);
  });

  it('keeps to the budget and leaves room in the snapshot for everything else', async () => {
    const small = await pedSim({ peds: 40, budget: 12 });
    stepLog(small, 180);
    expect(ambient(small).count).toBeLessThanOrEqual(12);
    expect(ambient(small).count).toBeGreaterThanOrEqual(10);
    // a budget no snapshot could hold: capped by the 256 entities, with room left
    const big = await pedSim({ peds: 60, budget: 400 });
    stepLog(big, 240);
    expect(big.registry.size).toBeLessThanOrEqual(256 - AMBIENT.reserve + 4);
    expect(ambient(big).count).toBeGreaterThan(100);
  });

  it('raises and lowers the budget while it runs', async () => {
    const sim = await pedSim({ peds: 40, budget: 40 });
    stepLog(sim, 120);
    expect(ambient(sim).count).toBeGreaterThan(30);
    const before = ambient(sim).count;
    ambient(sim).budget = 10;
    stepLog(sim, 600);
    // anyone in the camera's view stays until they walk out of it
    expect(ambient(sim).count).toBeLessThan(before * 0.75);
    expect(ambient(sim).target).toBe(10);
  });
});

describe('the spawn ring', () => {
  it('spawns people out of the camera view, 40 to 145 m from the player, and drops the ones left far behind', async () => {
    const sim = await pedSim({ peds: 6 });
    stepLog(sim, 60);
    const c = playerPed(sim).controller;
    // walk the player 150 m down the avenue
    c.teleport(150, 0, 8);
    const seen = new Set(ambient(sim).list.map((p) => p.id));
    const fresh: { id: number; d: number; visible: boolean }[] = [];
    stepLog(sim, 900, () => {
      for (const p of ambient(sim).list) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const q = p.controller;
        const me = sim.playerPosition();
        fresh.push({ id: p.id, d: Math.hypot(q.x - me.x, q.z - me.z), visible: ambient(sim).visible(q.x, q.y, q.z) });
      }
    });
    expect(fresh.length).toBeGreaterThan(5);
    for (const f of fresh) {
      expect(f.d).toBeGreaterThan(36);
      expect(f.d).toBeLessThan(150);
    }
    // nearly all were unseen at the moment they appeared (the camera turns as people walk, so allow the odd one)
    expect(fresh.filter((f) => f.visible).length).toBeLessThanOrEqual(fresh.length * 0.15);
    // and the crowd round the old spot is gone
    const me = sim.playerPosition();
    for (const p of ambient(sim).list) expect(Math.hypot(p.controller.x - me.x, p.controller.z - me.z)).toBeLessThan(AMBIENT.hardR);
  });
});

describe('persistence', () => {
  it('keeps anyone the player touched, and removes the rest when they are far and unseen', async () => {
    const sim = await pedSim({ peds: 8 });
    stepLog(sim, 90);
    const A = ambient(sim);
    const [touched, plain] = A.list.filter((p) => p.amb!.mode === 'walk');
    // a punch on one of them
    damagePed(sim, touched, 5, 'melee', sim.playerPedId);
    stepLog(sim, 3);
    expect(touched.amb!.persistent).toBe(true);
    expect(plain.amb!.persistent).toBe(false);
    // both 90 m behind the camera, which looks north
    const me = playerPed(sim).controller;
    me.teleport(100, 0, 8);
    touched.controller.teleport(100, 0, 98);
    plain.controller.teleport(104, 0, 98);
    stepLog(sim, 2);
    expect(A.visible(100, 0, 98)).toBe(false);
    expect(A.mayRemove(plain)).toBe(true);
    expect(A.mayRemove(touched)).toBe(false);
    // and in front of the camera, in view, within the ring, neither goes
    touched.controller.teleport(100, 0, -80);
    plain.controller.teleport(104, 0, -80);
    stepLog(sim, 2);
    expect(A.mayRemove(plain)).toBe(false);
    expect(A.mayRemove(touched)).toBe(false);
    // far away and unseen, even a touched one goes
    touched.controller.teleport(100, 0, 150);
    stepLog(sim, 2);
    expect(A.mayRemove(touched)).toBe(false); // 142 m behind: a touched person stays until 170 m
    touched.controller.teleport(250, 0, 8);
    me.teleport(-250, 0, 8);
    stepLog(sim, 2);
    expect(A.mayRemove(touched)).toBe(true);
  });

  it('marks a carjack victim and the people the law is waiting on as persistent', async () => {
    const sim = await pedSim({ peds: 8, start: 'jack' });
    stepLog(sim, 90);
    const victim = sim.registry.get(vehicle(sim).occupantId) as PedEntity;
    run(sim, 3, cmd({ buttons: Button.Interact }));
    stepLog(sim, 30);
    expect(sim.law.pending.length).toBeGreaterThan(0);
    stepLog(sim, 12);
    for (const call of sim.law.pending) {
      const w = sim.registry.get(call.witnessId) as PedEntity;
      expect(w.amb?.persistent ?? w === victim).toBe(true);
    }
  });
});

describe('witnesses', () => {
  async function jackSim(seed = 1) {
    const sim = await pedSim({ peds: 8, start: 'jack', seed, driverMood: 'flee' });
    stepLog(sim, 120);
    return sim;
  }

  it('lets a carjack on a busy sidewalk be called in by bystanders, not only the driver', async () => {
    const sim = await jackSim();
    const victim = vehicle(sim).occupantId;
    expect(victim).not.toBe(0);
    const events: SimEvent[] = [];
    for (let i = 0; i < 3; i++) {
      sim.pushInput(1, cmd({ buttons: Button.Interact }));
      sim.step();
      events.push(...sim.drainEvents());
    }
    events.push(...stepLog(sim, 60 * 11));
    const crime = ofType(events, 'crime').find((c) => c.crime === 'carjack')!;
    expect(crime).toBeTruthy();
    // the driver always counts; bystanders in range with a clear line count too
    expect(crime.witnesses).toBeGreaterThan(2);
    const reports = ofType(events, 'crime:reported').filter((r) => !r.police);
    const bystanders = reports.filter((r) => r.reporterId !== victim && r.reporterId !== sim.playerPedId);
    expect(bystanders.length).toBeGreaterThan(0);
    expect(sim.law.heat.level).toBeGreaterThan(0);
    // and they ran
    expect(ofType(events, 'ped:react').filter((r) => r.reaction === 'flee').length).toBeGreaterThan(0);
  });

  it('stops the call when the caller is knocked out', async () => {
    const sim = await jackSim();
    const events: SimEvent[] = [];
    for (let i = 0; i < 3; i++) {
      sim.pushInput(1, cmd({ buttons: Button.Interact }));
      sim.step();
      events.push(...sim.drainEvents());
    }
    // the driver is out of the car and free after about a second and a half
    events.push(...stepLog(sim, 120));
    expect(ofType(events, 'crime').length).toBeGreaterThan(0);
    const callers = sim.law.pending.map((c) => c.witnessId);
    expect(callers.length).toBeGreaterThan(2);
    // knock every one of them down before their phones are out
    for (const id of callers) knockDown(sim, sim.registry.get(id) as PedEntity, 20);
    const after = stepLog(sim, 60 * 10);
    expect(ofType(after, 'witness:silenced').length).toBe(callers.length);
    expect(ofType(after, 'crime:reported').filter((r) => !r.police).length).toBe(0);
    expect(sim.law.heat.level).toBe(0);
  });
});

describe('crossing the street', () => {
  it('starts across only on a walk light, and waits at the kerb for one', async () => {
    const sim = await pedSim({ peds: 10 });
    const A = ambient(sim);
    const j = sim.tile.junctions!.junctions[0];
    const last = new Map<number, number>();
    let starts = 0;
    let waited = 0;
    let badStarts = 0;
    stepLog(sim, 60 * 160, (tick) => {
      for (const p of A.list) {
        const a = p.amb!;
        if (a.mode === 'wait') waited++;
        const before = last.get(p.id) ?? -1;
        if (a.crossAttr >= 0 && before < 0) {
          starts++;
          const m = A.graph.attrs[a.crossAttr].crossing!;
          if (m.signals && walkState(j, m.leg!, (tick - 1) * SIM_DT) !== 'walk' && walkState(j, m.leg!, tick * SIM_DT) !== 'walk') badStarts++;
        }
        last.set(p.id, a.crossAttr);
      }
    });
    expect(starts).toBeGreaterThan(4);
    expect(waited).toBeGreaterThan(50);
    expect(badStarts).toBe(0);
  });

  it('waits for a gap in the traffic where there is no light', async () => {
    const sim = await pedSim({ peds: 0, minutes: 12 * 60, budget: 0, tile: pedTile({ signals: false }) });
    const A = ambient(sim);
    const g = A.graph;
    // the crossing on the east leg, from the north-east corner to the south-east corner
    let e = -1;
    for (let k = 0; k < g.edgeCount; k++) if (g.kindOf(k) === 'crossing' && g.x[g.ea[k]] > 0 && g.x[g.eb[k]] > 0 && g.x[g.ea[k]] < 10) e = k;
    expect(e).toBeGreaterThanOrEqual(0);
    const a = newAmbientState('locals', 1.4, 0, 0);
    a.node = g.ea[e];
    const refresh = () => (A as unknown as { refreshAround(): void }).refreshAround();
    refresh();
    expect(A.canCross(a, e)).toBe(true);
    // a car coming down the avenue at 12 m/s, 30 m from the crossing
    const car = sim.spawnVehicle('sedan', 38, 0, 0, Math.PI / 2, 0xffffff);
    car.car.body.setLinvel({ x: -12, y: 0, z: 0 }, true);
    refresh();
    expect(A.canCross(a, e)).toBe(false);
    // the same car 150 m off, or going the other way, is no reason to wait
    car.car.teleport(150, 0.5, 0, Math.PI / 2);
    car.car.body.setLinvel({ x: -12, y: 0, z: 0 }, true);
    refresh();
    expect(A.canCross(a, e)).toBe(true);
    car.car.teleport(30, 0.5, 0, -Math.PI / 2);
    car.car.body.setLinvel({ x: 12, y: 0, z: 0 }, true);
    refresh();
    expect(A.canCross(a, e)).toBe(true);
    // a car stopped on the crossing blocks it
    car.car.teleport(8, 0.5, 0, 0);
    car.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    refresh();
    expect(A.canCross(a, e)).toBe(false);
  });
});

describe('walking', () => {
  it('steps round the player in the way', async () => {
    const sim = await pedSim({ peds: 0, budget: 8 });
    const A = ambient(sim);
    const me = playerPed(sim).controller;
    me.teleport(120, 0, 8);
    stepLog(sim, 30);
    // someone walking west along the sidewalk toward the player
    const g = A.graph;
    const from = g.nearestNode(160, 8);
    const ped = A.makePed('locals', A.population.pedGroups.locals, g.x[from], g.y[from], g.z[from], from, g.nearestNode(120, 8) === from ? g.nearestNode(80, 8) : g.nearestNode(120, 8), null)!;
    ped.amb!.speed = 1.4;
    ped.amb!.lane = 0;
    let closest = Infinity;
    stepLog(sim, 60 * 55, () => {
      const c = ped.controller;
      closest = Math.min(closest, Math.hypot(c.x - me.x, c.z - me.z));
    });
    expect(ped.controller.x).toBeLessThan(105);
    expect(closest).toBeGreaterThan(0.8);
  });

  it('puts people on a bench, at a stop and in a chat, already doing it', async () => {
    const points = [
      { id: 's0', type: 'bench' as const, x: 12, y: 0, z: 10, yaw: Math.PI, cap: 2, src: 'osm' as const },
      { id: 's1', type: 'busstop' as const, x: 22, y: 0, z: 10, yaw: Math.PI, cap: 4, src: 'osm' as const },
      { id: 's2', type: 'plaza' as const, x: 12, y: 0, z: 24, yaw: 0, cap: 5, src: 'synth' as const },
    ];
    const tile = pedTile({ scenarios: { version: 1, points } });
    const pop = population(40);
    for (const g of Object.values(pop.pedGroups)) g.behaviour = { wander: 0, scenario: 1 };
    const sim = await Simulation.create({ seed: 3, tile, ambientPeds: true, population: pop, pedBudget: 20, clock: { minutes: 720, scale: 0 }, parkedCars: 0, driver: false });
    stepLog(sim, 120);
    const A = ambient(sim);
    const at = A.list.filter((p) => p.amb!.mode === 'scenario');
    expect(at.length).toBeGreaterThan(2);
    expect(A.scenarios.occupied).toBe(at.length);
    // each stands within a couple of metres of its point and in its pose
    for (const p of at) {
      const pt = A.scenarios.points[p.amb!.sc];
      expect(Math.hypot(p.controller.x - pt.x, p.controller.z - pt.z)).toBeLessThan(2.5);
    }
    expect(at.some((p) => p.amb!.scAction === 'sit')).toBe(true);
    expect(new Set(at.map((p) => p.pose)).size).toBeGreaterThan(0);
    const sitting = at.find((p) => p.amb!.scAction === 'sit')!;
    expect(sitting.pose).toBe(1);
    // and they stay put until their time is up
    const x0 = sitting.controller.x, z0 = sitting.controller.z;
    stepLog(sim, 120);
    expect(Math.hypot(sitting.controller.x - x0, sitting.controller.z - z0)).toBeLessThan(0.05);
  });
});

describe('reactions', () => {
  it('runs from an explosion', async () => {
    const sim = await pedSim({ peds: 10 });
    stepLog(sim, 120);
    const A = ambient(sim);
    // blow up a car in the middle of them
    const near = A.list.find((p) => p.amb!.mode === 'walk')!;
    const car = sim.spawnVehicle('sedan', near.controller.x + 6, 0, near.controller.z, 0, 0x222222);
    const events = [];
    sim.explodeVehicle(car);
    events.push(...stepLog(sim, 120));
    const reacts = ofType(events, 'ped:react').filter((r) => r.cause === 'explosion');
    expect(reacts.length).toBeGreaterThan(0);
    expect(reacts.every((r) => r.reaction === 'flee' || r.reaction === 'cower')).toBe(true);
    expect(A.list.some((p) => p.brain!.state === 'flee')).toBe(true);
  });

  it('jumps clear of a car on the pavement', async () => {
    const sim = await pedSim({ peds: 10 });
    stepLog(sim, 90);
    const A = ambient(sim);
    // a car driving along the sidewalk with a walker ahead of it
    const g = A.graph;
    const n = g.nearestNode(100, 8);
    const walker = A.makePed('locals', A.population.pedGroups.locals, g.x[n], g.y[n], g.z[n], n, g.nearestNode(60, 8), null)!;
    const car = sim.spawnVehicle('sedan', g.x[n] + 12, 0, g.z[n], Math.PI / 2, 0x222222);
    const events: SimEvent[] = [];
    for (let i = 0; i < 90; i++) {
      car.car.body.setLinvel({ x: -8, y: 0, z: 0 }, true);
      sim.step();
      events.push(...sim.drainEvents());
    }
    const r = ofType(events, 'ped:react').filter((e) => e.cause === 'car-on-sidewalk');
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((e) => e.pedId === walker.id)).toBe(true);
  });

  it('stares at a wreck', async () => {
    const sim = await pedSim({ peds: 14 });
    stepLog(sim, 90);
    const A = ambient(sim);
    const car = sim.spawnVehicle('sedan', 0, 0, 0, 0, 0x222222);
    car.smoking = true;
    const events = stepLog(sim, 600);
    expect(ofType(events, 'ped:react').filter((e) => e.cause === 'wreck' && (e.reaction === 'look' || e.reaction === 'film')).length).toBeGreaterThan(0);
    expect(A.list.length).toBeGreaterThan(0);
  });

  it('films a fight on a phone, or cowers, and the rest run', async () => {
    const sim = await pedSim({ peds: 10 });
    stepLog(sim, 120);
    const A = ambient(sim);
    const target = A.list.find((p) => p.amb!.mode === 'walk')!;
    const me = playerPed(sim).controller;
    me.teleport(target.controller.x - 1.2, 0, target.controller.z, Math.PI / 2);
    // hit them
    damagePed(sim, target, 20, 'melee', sim.playerPedId);
    const events = stepLog(sim, 150);
    const kinds = new Set(ofType(events, 'ped:react').map((r) => r.reaction));
    expect(kinds.has('flee')).toBe(true);
    expect(target.amb!.persistent).toBe(true);
  });
});

describe('determinism', () => {
  it('replays exactly with ambient people on', async () => {
    const a = await pedSim({ seed: 7, peds: 8 });
    const b = await pedSim({ seed: 7, peds: 8 });
    const va = new SnapshotView();
    const vb = new SnapshotView();
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < 150; i++) {
        const c = cmd({ axes: { MoveY: k % 2 }, buttons: k === 4 && i === 20 ? Button.Melee : 0 });
        a.pushInput(1, { ...c });
        b.pushInput(1, { ...c });
        a.step();
        b.step();
      }
      a.writeSnapshot(va);
      b.writeSnapshot(vb);
      expect(Buffer.from(va.buffer).equals(Buffer.from(vb.buffer))).toBe(true);
    }
    expect(ambient(a).count).toBeGreaterThan(10);
    expect(ambient(a).count).toBe(ambient(b).count);
    const c = await pedSim({ seed: 8, peds: 8 });
    stepLog(c, 600);
    const vc = new SnapshotView();
    c.writeSnapshot(vc);
    expect(Buffer.from(va.buffer).equals(Buffer.from(vc.buffer))).toBe(false);
  });
});

describe('the baked tile', () => {
  const DIR = 'public/tiles/atlanta/m1-five-points';
  const have = existsSync(`${DIR}/paths.json`);
  const fsFetch = async (url: string) => {
    const path = url.replace(/^\/?/, '');
    const ok = existsSync(path);
    const buf = ok ? readFileSync(path) : Buffer.alloc(0);
    return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };

  it.skipIf(!have)('fills Downtown with people on the real sidewalks, and they stay on the ground', async () => {
    const tile = await loadBakedTile(DIR, fsFetch);
    expect(tile.paths).toBeTruthy();
    const sim = await Simulation.create({ seed: 1, tile, ambientPeds: true, clock: { minutes: 12 * 60, scale: 0 } });
    stepLog(sim, 600);
    const A = ambient(sim);
    expect(A.count).toBeGreaterThan(40);
    for (const p of A.list) {
      const c = p.controller;
      expect(Number.isFinite(c.x + c.y + c.z)).toBe(true);
      expect(Math.abs(c.y - sim.groundAt(c.x, c.z))).toBeLessThan(8);
    }
    // someone is doing something rather than only walking
    expect(A.list.some((p) => p.amb!.mode === 'scenario')).toBe(true);
  });
});
