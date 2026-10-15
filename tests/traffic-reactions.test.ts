import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBakedTile } from '../src/shared/tile';
import { SIM_DT, type SimEvent } from '../src/shared/protocol';
import { Simulation } from '../src/sim/Simulation';
import { AI_OWNER, type PedEntity, type VehicleEntity } from '../src/sim/entities';
import { TRAFFIC, type TrafficCar } from '../src/sim/traffic/TrafficManager';
import { Button, addNpc, cmd, ped, run } from './helpers';
import { crossroads, lanesFor, laneOf, stepAll, trafficSim } from './trafficHelpers';

const KIND = { type: 'sedan', color: 0x2244cc };

/** A long straight street (a crossroads far from where the action is), no random traffic. */
async function street(seed = 1) {
  const { roads, junctions } = crossroads('none', 500);
  const sim = await trafficSim(lanesFor(roads, junctions), { seed });
  sim.traffic!.density = 0;
  const hero = sim.registry.get(sim.vehicleId) as VehicleEntity;
  hero.car.teleport(300, 0.5, 300, 0);
  return { sim, hero, east: laneOf(sim, 'ew', 1, 0, 'first') };
}

const tp = (sim: Simulation, x: number, z: number) => ped(sim).controller.teleport(x, sim.groundAt(x, z) + 0.1, z);
const posOf = (c: TrafficCar) => c.veh.car.body.translation();
function collect(sim: Simulation, ticks: number, into: SimEvent[], each?: (i: number) => void) {
  for (let i = 0; i < ticks; i++) {
    sim.step();
    into.push(...sim.drainEvents());
    each?.(i);
  }
}

/** Puts the player in the hero car, parked in the eastbound lane at (x, 1.8) facing `yaw`. */
function playerInHero(sim: Simulation, hero: VehicleEntity, x: number, yaw: number) {
  hero.car.teleport(x, 0.6, 1.8, yaw);
  stepAll(sim, 40);
  const p = hero.car.pose();
  ped(sim).controller.teleport(p.x, p.y, p.z + 2.4);
  stepAll(sim, 5);
  sim.pushInput(1, { tick: 100, buttons: Button.Interact, axes: [0, 0, 0, 0, 0, 0, 0, 5] });
  stepAll(sim, 4);
  sim.pushInput(1, { tick: 101, buttons: 0, axes: [0, 0, 0, 0, 0, 0, 0, 5] });
  stepAll(sim, 2);
  expect(ped(sim).vehicleId).toBe(hero.id);
}

describe('what drivers do about the people and cars in front of them', () => {
  it('honks at a player who sits in the lane, then drives on when the road clears', async () => {
    const { sim, hero, east } = await street();
    playerInHero(sim, hero, -120, Math.PI / 2);
    const c = sim.traffic!.spawnAt(east, 330, KIND); // x = -170, behind the hero car
    c.v = 8;
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 20 && !events.some((e) => e.type === 'traffic:honk'); i++) collect(sim, 1, events);
    const honks = events.filter((e) => e.type === 'traffic:honk' && e.vehicleId === c.veh.id);
    expect(honks.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === 'crime').length).toBe(0);
    // it stopped behind the car, not through it
    expect(c.veh.car.pose().x).toBeLessThan(hero.car.pose().x - 3);
    expect(c.veh.car.speed).toBeLessThan(0.5);
    // the player drives off, and the traffic carries on
    for (let i = 0; i < 60 * 8; i++) {
      sim.pushInput(1, { tick: 200 + i, buttons: 0, axes: [0, 0, 0, 0, 1, 0, 0, 5] });
      sim.step();
    }
    expect(posOf(c).x).toBeGreaterThan(-165);
  });

  it('does not honk at a parked car; it goes round it', async () => {
    const { sim, east } = await street();
    sim.spawnVehicle('sedan', -90, 0, 2.15, Math.PI / 2, 0x888888);
    tp(sim, -120, 8);
    const c = sim.traffic!.spawnAt(east, 340, KIND);
    const events: SimEvent[] = [];
    collect(sim, 60 * 25, events);
    expect(events.some((e) => e.type === 'traffic:honk')).toBe(false);
    expect(posOf(c).x).toBeGreaterThan(-60); // past it
    expect(c.mode === 'free').toBe(false);
  });

  it('stops for a pedestrian standing in the lane, and goes on when they have moved', async () => {
    const { sim, east } = await street();
    tp(sim, -150, 12);
    const npc = addNpc(sim, -100, 1.8);
    const c = sim.traffic!.spawnAt(east, 370, KIND); // x = -130
    c.v = 9;
    stepAll(sim, 60 * 12);
    expect(c.veh.car.speed).toBeLessThan(0.5);
    const gap = npc.controller.x - c.veh.car.pose().x;
    expect(gap).toBeGreaterThan(c.len / 2 + 0.5);
    expect(gap).toBeLessThan(14);
    npc.controller.teleport(-100, 0, 12);
    stepAll(sim, 60 * 10);
    expect(posOf(c).x).toBeGreaterThan(-90);
    expect(npc.life).toBe('alive');
  });

  it('brakes hard and swerves for a car coming at it in its own lane', async () => {
    const { sim, hero, east } = await street();
    playerInHero(sim, hero, 0, -Math.PI / 2); // facing west, in the eastbound lane
    const c = sim.traffic!.spawnAt(east, 340, KIND); // x = -160, heading east
    c.v = 12;
    let minAcc = 0;
    let maxSwerve = 0;
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 7; i++) {
      sim.pushInput(1, { tick: 300 + i, buttons: 0, axes: [0, 0, 0, 0, i < 60 * 3 ? 1 : 0, 0, 0, 5] });
      sim.step();
      events.push(...sim.drainEvents());
      minAcc = Math.min(minAcc, c.acc);
      maxSwerve = Math.max(maxSwerve, Math.abs(c.swerve));
    }
    expect(minAcc).toBeLessThan(-6);
    expect(maxSwerve).toBeGreaterThan(0.8);
    expect(events.some((e) => e.type === 'traffic:react' && e.vehicleId === c.veh.id && (e.reaction === 'swerve' || e.reaction === 'brake'))).toBe(true);
  });

  it('a car that is hit stays a physics car, with a frightened driver', async () => {
    const { sim, hero, east } = await street();
    playerInHero(sim, hero, -60, Math.PI / 2);
    const c = sim.traffic!.spawnAt(east, 460, KIND); // x = -40, ahead of the hero car, going the same way slowly
    c.v = 3;
    c.idm.v0 = 3;
    c.speedFactor = 0.2;
    for (let i = 0; i < 60 * 8; i++) {
      sim.pushInput(1, { tick: 400 + i, buttons: 0, axes: [0, 0, 0, 0, 1, 0, 0, 5] });
      sim.step();
    }
    expect(c.touched).toBe(true);
    expect(c.panic).toBeGreaterThan(0.5);
    // the player drives far away; a car that was touched is not turned into a spline follower
    tp(sim, 700, 8);
    hero.car.teleport(700, 0.6, 12, 0);
    stepAll(sim, 60 * 10);
    if (sim.traffic!.cars.includes(c)) expect(c.mode).not.toBe('kin');
  });
});

describe('fright', () => {
  async function runWith(setup?: (sim: Simulation, c: TrafficCar) => void) {
    const { sim, east } = await street(4);
    tp(sim, -300, 12);
    const c = sim.traffic!.spawnAt(east, 100, KIND); // x = -400
    c.speedFactor = 0.9;
    stepAll(sim, 120);
    setup?.(sim, c);
    let sum = 0;
    let n = 0;
    let maxPanic = 0;
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      sim.step();
      events.push(...sim.drainEvents());
      maxPanic = Math.max(maxPanic, c.panic);
      sum += c.v;
      n++;
      // the camera follows
      if (i % 30 === 0) tp(sim, posOf(c).x + 100, 12);
    }
    return { mean: sum / n, panic: maxPanic, events, c };
  }

  it('drives faster and wilder after an explosion nearby', async () => {
    const calm = await runWith();
    const scared = await runWith((sim, c) => {
      const p = posOf(c);
      sim.emit({ type: 'vehicle:explode', tick: sim.tick, vehicleId: 0, x: p.x + 40, y: 0, z: p.z + 15 });
    });
    expect(calm.panic).toBeLessThan(0.1);
    expect(scared.panic).toBeGreaterThan(0.3);
    expect(scared.mean).toBeGreaterThan(calm.mean * 1.12);
    expect(scared.events.some((e) => e.type === 'traffic:react' && e.reaction === 'flee')).toBe(true);
  });

  it('flees a crime committed near it', async () => {
    const calm = await runWith();
    const scared = await runWith((sim, c) => {
      const p = posOf(c);
      sim.emit({
        type: 'crime', tick: sim.tick, crime: 'assault', severity: 3, heat: 2, x: p.x + 30, y: 0, z: p.z + 10, perpetratorId: sim.playerPedId, victimId: 0, vehicleId: 0, witnesses: 1,
        description: { vehicle: null, clothes: 0, face: false, cctv: false },
      });
    });
    expect(scared.panic).toBeGreaterThan(0.3);
    expect(scared.mean).toBeGreaterThan(calm.mean * 1.1);
  });

  it('is calm when the danger is far away', async () => {
    const far = await runWith((sim, c) => {
      const p = posOf(c);
      sim.emit({ type: 'vehicle:explode', tick: sim.tick, vehicleId: 0, x: p.x + 400, y: 0, z: p.z, });
    });
    expect(far.panic).toBeLessThan(0.1);
  });
});

describe('police', () => {
  it('traffic pulls over for a police car with its lights on coming up behind it', async () => {
    const { sim, east } = await street();
    tp(sim, -250, 12);
    const c = sim.traffic!.spawnAt(east, 250, KIND); // x = -250
    c.v = 10;
    c.speedFactor = 0.8;
    stepAll(sim, 90);
    const cop = sim.spawnVehicle('sedan', posOf(c).x - 30, 0, 1.8, Math.PI / 2, 0x111122, (v) => {
      v.owner = AI_OWNER;
      v.police = { agency: 'acp', body: 0x111122, stripe: 0xffffff, lightbar: [0xff0000, 0x0000ff] };
      v.lightbar = true;
    });
    const events: SimEvent[] = [];
    let slowest = 99;
    let maxRight = 0;
    for (let i = 0; i < 60 * 6; i++) {
      // the police car races up the road at 25 m/s
      const q = cop.car.pose();
      cop.car.body.setLinvel({ x: 25, y: 0, z: 0 }, true);
      cop.input.throttle = 0;
      void q;
      sim.step();
      events.push(...sim.drainEvents());
      slowest = Math.min(slowest, c.v);
      maxRight = Math.max(maxRight, -c.swerve);
    }
    expect(events.some((e) => e.type === 'traffic:react' && e.vehicleId === c.veh.id && e.reaction === 'pullover')).toBe(true);
    expect(slowest).toBeLessThan(5);
    expect(maxRight).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const DIR = 'public/tiles/atlanta/m1-five-points';
const have = existsSync(`${DIR}/tile.json`) && existsSync(`${DIR}/lanes.json`);
const fsFetch = async (url: string) => {
  const path = url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

describe.skipIf(!have)('traffic on the baked Five Points tile', () => {
  it('fills the streets, runs for three minutes without wrecking itself, and keeps the entity count down', async () => {
    const tile = await loadBakedTile(DIR, fsFetch);
    expect(tile.lanes).toBeTruthy();
    const sim = await Simulation.create({ seed: 1, tile, traffic: 1 });
    const t = sim.traffic!;
    const events: SimEvent[] = [];
    let most = 0;
    let mostEntities = 0;
    const spots = [[0, 0], [-300, -200], [250, 150]];
    for (let i = 0; i < 60 * 180; i++) {
      if (i > 0 && i % (60 * 60) === 0) {
        const s = spots[(i / 3600) % spots.length];
        ped(sim).controller.teleport(s[0], sim.groundAt(s[0], s[1]) + 0.3, s[1]);
      }
      run(sim, 1, cmd());
      events.push(...sim.drainEvents());
      most = Math.max(most, t.cars.length);
      mostEntities = Math.max(mostEntities, sim.registry.size);
    }
    expect(t.stats.spawned).toBeGreaterThan(40);
    expect(most).toBeLessThanOrEqual(TRAFFIC.cap + 3);
    expect(mostEntities).toBeLessThan(150);
    // mostly healthy: wrecks and stuck cars are rare
    expect(t.stats.honks).toBeLessThan(40);
    const wrecked = events.filter((e) => e.type === 'vehicle:explode').length;
    expect(wrecked).toBe(0);
    expect(t.count('free')).toBeLessThanOrEqual(3);
  });

  it('police still reach a crime and make the arrest with traffic on the streets', async () => {
    const tile = await loadBakedTile(DIR, fsFetch);
    const sim = await Simulation.create({ seed: 1, tile, parkedCars: 0, traffic: 1 });
    run(sim, 60, cmd());
    sim.law.heat.report(1, 2, ped(sim).controller.x, ped(sim).controller.z);
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 90 && !events.some((e) => e.type === 'player:busted'); i++) {
      run(sim, 1, cmd());
      events.push(...sim.drainEvents());
    }
    expect(events.some((e) => e.type === 'police:spawn')).toBe(true);
    expect(events.some((e) => e.type === 'police:dismount')).toBe(true);
    expect(events.some((e) => e.type === 'player:busted')).toBe(true);
  });
});

void SIM_DT;
void ({} as PedEntity);
