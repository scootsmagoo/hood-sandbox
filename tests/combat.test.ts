import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import { COMBAT, carHitDamage, fallDamage, pickMeleeTarget } from '../src/sim/combat/damage';
import { impactDamage, WRECK } from '../src/sim/combat/vehicleDamage';
import { LIFE } from '../src/sim/combat/systems';
import { HANDLING } from '../src/shared/handling';
import { SnapshotView, E, PedFlag, VehicleFlag, H, Overlay } from '../src/shared/snapshot';
import { addNpc, Button, cmd, driverSim, makeSim, ofType, ped, run, runLog, vehicle } from './helpers';

/** Presses the punch button for three ticks and lets the blow play out. */
const punch = (sim: Awaited<ReturnType<typeof makeSim>>) => runLog(sim, 3, () => cmd({ buttons: Button.Melee })).concat(runLog(sim, 36, () => cmd()));

describe('damage numbers', () => {
  it('cars hurt peds only above a closing speed, and harder the faster', () => {
    expect(carHitDamage(2)).toBe(0);
    expect(carHitDamage(COMBAT.carMinSpeed - 0.1)).toBe(0);
    expect(carHitDamage(6)).toBeGreaterThan(0);
    expect(carHitDamage(10)).toBeGreaterThan(carHitDamage(6));
    expect(carHitDamage(16)).toBeGreaterThanOrEqual(100);
  });
  it('falls hurt from about 3 m up and kill from about 9 m', () => {
    expect(fallDamage(COMBAT.fallSafeSpeed)).toBe(0);
    expect(fallDamage(15)).toBeGreaterThan(0);
    expect(fallDamage(22)).toBeGreaterThanOrEqual(90);
  });
  it('picks the target in the cone, ahead, in reach', () => {
    const me = { x: 0, y: 0, z: 0, yaw: 0 }; // faces +Z
    const ahead = { id: 1, x: 0, y: 0, z: 1.4 };
    const behind = { id: 2, x: 0, y: 0, z: -1 };
    const side = { id: 3, x: 1.4, y: 0, z: 0.2 };
    const far = { id: 4, x: 0, y: 0, z: 3 };
    const high = { id: 5, x: 0, y: 3, z: 1 };
    const pick = (c: { id: number; x: number; y: number; z: number }[]) => pickMeleeTarget(me, c, COMBAT.punchRange, COMBAT.punchHalfAngle)?.id ?? null;
    expect(pick([ahead, behind, side, far, high])).toBe(1);
    expect(pick([behind, side, far, high])).toBe(null);
    expect(pick([far])).toBe(null);
  });
  it('turns velocity change into body and engine damage by direction and the handling multipliers', () => {
    const sedan = HANDLING.sedan.damage;
    expect(impactDamage(0, -1, 0, sedan).body).toBe(0);
    const head = impactDamage(0, -18, 0, sedan);
    const side = impactDamage(18, 0, 0, sedan);
    const rear = impactDamage(0, 18, 0, sedan);
    expect(head.body).toBeCloseTo(side.body, 5);
    expect(head.engine).toBeGreaterThan(side.engine * 2);
    expect(head.engine).toBeGreaterThan(rear.engine * 2);
    // A coupe is more fragile, a pickup tougher.
    expect(impactDamage(0, -18, 0, HANDLING.coupe.damage).engine).toBeGreaterThan(head.engine);
    expect(impactDamage(0, -18, 0, HANDLING.pickup.damage).body).toBeLessThan(head.body);
    expect(HANDLING.pickup.damage.bodyHealth).toBeGreaterThan(HANDLING.sedan.damage.bodyHealth);
  });
});

describe('the player punches', () => {
  it('hurts and knocks down an NPC in front, who gets back up', async () => {
    const sim = await makeSim();
    const p = ped(sim);
    p.controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 100, 101.2);
    run(sim, 30, cmd());
    const ev = punch(sim);
    expect(ofType(ev, 'melee:swing')).toHaveLength(1);
    const dmg = ofType(ev, 'damage');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]).toMatchObject({ sourceId: p.id, targetId: npc.id, kind: 'melee', amount: COMBAT.punchDamage, health: 100 - COMBAT.punchDamage, fatal: false });
    expect(ofType(ev, 'ped:attack')).toHaveLength(1);
    expect(ofType(ev, 'ped:down')).toHaveLength(1);
    expect(npc.health).toBe(100 - COMBAT.punchDamage);
    // down for a couple of seconds, then up
    run(sim, 60, cmd());
    expect(npc.life).toBe('downed');
    const later = runLog(sim, 120);
    expect(ofType(later, 'ped:up')).toHaveLength(1);
    expect(npc.life).toBe('alive');
  });

  it('misses someone behind, or out of reach', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const behind = addNpc(sim, 100, 98.8);
    const far = addNpc(sim, 103, 100);
    run(sim, 30, cmd());
    const ev = punch(sim);
    expect(ofType(ev, 'melee:swing')).toHaveLength(1);
    expect(ofType(ev, 'damage')).toHaveLength(0);
    expect(behind.health).toBe(100);
    expect(far.health).toBe(100);
  });

  it('locks on to a target a little off to the side so a stick or trackpad can land a punch', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 101.4, 100.6); // ~66 degrees off the facing: outside the hit cone, inside the lock cone
    run(sim, 30, cmd());
    const ev = punch(sim);
    expect(ofType(ev, 'damage')[0]?.targetId).toBe(npc.id);
  });

  it('has a short cooldown between punches', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 100, 101.2);
    run(sim, 30, cmd());
    // Tap again and again: only one swing per cooldown.
    const ev = runLog(sim, 30, (() => {
      let n = 0;
      return () => cmd({ buttons: n++ % 2 ? Button.Melee : 0 });
    })());
    expect(ofType(ev, 'melee:swing').length).toBe(1);
    run(sim, 10, cmd());
    const ev2 = runLog(sim, 3, () => cmd({ buttons: Button.Melee }));
    expect(ofType(ev2, 'melee:swing')).toHaveLength(1); // 40+ ticks after the first: the cooldown (33 ticks) is over
    void npc;
  });

  it('kills with enough punches, and the corpse does not get up', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 100, 101.2);
    run(sim, 30, cmd());
    const all = [];
    for (let i = 0; i < 6; i++) {
      // The target is shoved away by each blow: step back up to it.
      ped(sim).controller.teleport(npc.controller.x, 0, npc.controller.z - 1.2, 0);
      run(sim, 2, cmd());
      all.push(...punch(sim));
    }
    expect(npc.life).toBe('dead');
    expect(npc.health).toBe(0);
    const dead = ofType(all, 'ped:dead');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ pedId: npc.id, sourceId: ped(sim).id, kind: 'melee' });
    expect(ofType(all, 'damage').some((d) => d.fatal)).toBe(true);
    run(sim, 300, cmd());
    expect(npc.life).toBe('dead');
  });

  it('armour soaks damage before health', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 100, 101.2);
    npc.armour = 30;
    run(sim, 30, cmd());
    const ev = punch(sim);
    const d = ofType(ev, 'damage')[0];
    expect(d.armour).toBe(10);
    expect(d.health).toBe(100);
  });

  it('shows in the snapshot: swing, downed and health', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 0, 100, 0);
    const npc = addNpc(sim, 100, 101.2);
    run(sim, 30, cmd());
    sim.pushInput(1, cmd({ buttons: Button.Melee }));
    sim.step();
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.u32[v.at(v.indexOf(ped(sim).id)) + E.Flags] & PedFlag.Punching).toBeTruthy();
    run(sim, 20, cmd());
    sim.writeSnapshot(v);
    const o = v.at(v.indexOf(npc.id));
    expect(v.u32[o + E.Flags] & PedFlag.Downed).toBeTruthy();
    expect(v.f32[o + E.Health]).toBe(80);
    expect(v.health).toBe(100);
  });
});

describe('the fighting driver hurts', () => {
  it('takes real health off the player and can kill', async () => {
    const sim = await makeSim();
    const npc = addNpc(sim, 100, 100, 0, 'fight');
    ped(sim).controller.teleport(100, 0, 101, 0);
    npc.brain!.enter('fight');
    const ev = runLog(sim, 60 * 8);
    const hits = ofType(ev, 'damage').filter((d) => d.targetId === ped(sim).id && d.sourceId === npc.id);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(ped(sim).health).toBeLessThan(100);
    expect(ped(sim).health).toBeCloseTo(100 - hits.reduce((a, d) => a + d.amount, 0), 5);
  });
});

describe('cars and peds', () => {
  /** A car rolling at `speed` toward a ped 12 m ahead, engine off. */
  async function roll(speed: number) {
    const tile = generateProceduralTile(1);
    const { sim, car } = await driverSim('sedan', tile, { x: -40, z: 800 });
    car.teleport(-40, 0.4, 800, 0);
    run(sim, 20, cmd());
    const npc = addNpc(sim, -40, 808);
    car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
    sim.drainEvents();
    const ev = runLog(sim, 90, () => cmd());
    return { sim, car, npc, ev, hits: ofType(ev, 'damage').filter((x) => x.targetId === npc.id) };
  }

  it('a fast car knocks a ped down and hurts them by the speed', async () => {
    const fast = await roll(18);
    expect(fast.hits).toHaveLength(1);
    expect(fast.hits[0]).toMatchObject({ kind: 'vehicle', sourceId: ped(fast.sim).id, vehicleId: vehicle(fast.sim).id });
    const slower = await roll(7);
    expect(slower.hits).toHaveLength(1);
    expect(slower.hits[0].amount).toBeGreaterThan(10);
    expect(fast.hits[0].amount).toBeGreaterThan(slower.hits[0].amount * 1.5);
    expect(ofType(slower.ev, 'ped:down')).toHaveLength(1);
    expect(slower.npc.life === 'downed' || slower.npc.life === 'alive').toBe(true);
    expect(fast.npc.life).toBe('dead');
  });

  it('a slow car does not hurt anyone', async () => {
    const slow = await roll(2);
    expect(slow.hits).toHaveLength(0);
    expect(slow.npc.health).toBe(100);
  });

  it('a car with nobody driving still hurts, but nobody is to blame', async () => {
    const tile = generateProceduralTile(1);
    const sim = await makeSim(tile);
    const v = vehicle(sim);
    v.car.teleport(-40, 0.4, 800, 0);
    ped(sim).controller.teleport(300, 0, 300);
    run(sim, 20, cmd());
    const npc = addNpc(sim, -40, 805);
    v.car.body.setLinvel({ x: 0, y: 0, z: 10 }, true);
    const hits = ofType(runLog(sim, 90), 'damage').filter((x) => x.targetId === npc.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceId).toBe(0);
  });

  it('standing next to a parked car hurts nobody', async () => {
    const sim = await makeSim();
    const npc = addNpc(sim, 3, 3);
    run(sim, 60, cmd());
    expect(npc.health).toBe(100);
  });
});

describe('falls', () => {
  it('a short drop is free, a tall one hurts and a very tall one kills', async () => {
    const sim = await makeSim();
    const a = addNpc(sim, 100, 100);
    const b = addNpc(sim, 110, 100);
    const c = addNpc(sim, 120, 100);
    a.controller.teleport(100, 2, 100);
    b.controller.teleport(110, 6, 100);
    c.controller.teleport(120, 16, 100);
    const ev = runLog(sim, 180);
    const falls = ofType(ev, 'damage').filter((d) => d.kind === 'fall');
    expect(falls.find((d) => d.targetId === a.id)).toBeUndefined();
    const fb = falls.find((d) => d.targetId === b.id)!;
    expect(fb.amount).toBeGreaterThan(5);
    expect(fb.fatal).toBe(false);
    expect(falls.find((d) => d.targetId === c.id)!.fatal).toBe(true);
    expect(c.life).toBe('dead');
  });

  it('the player takes fall damage too', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(100, 8, 100);
    const ev = runLog(sim, 120);
    const f = ofType(ev, 'damage').find((d) => d.kind === 'fall' && d.targetId === ped(sim).id)!;
    expect(f).toBeTruthy();
    expect(ped(sim).health).toBeLessThan(100);
  });
});

describe('wrecking a car', () => {
  /** Drives into the tile's north wall at `speed` m/s (rolling up to it a few metres out), then holds the throttle. */
  async function crash(speed: number, type = 'sedan') {
    const tile = generateProceduralTile(1);
    const { sim, car } = await driverSim(type, tile, { x: -40, z: 985 });
    // the wall's face is at z 1000: start with the bumper a metre and a half short of it
    car.teleport(-40, 0.4, 1000 - car.h.chassis.halfExtents[2] - 1.5, 0);
    run(sim, 10, cmd());
    car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
    car.adopt();
    const v = vehicle(sim);
    const events = runLog(sim, 60 * 12, () => cmd({ axes: { Throttle: 1 } }));
    return { sim, v, events };
  }

  it('a gentle bump does nothing; a hard hit smokes the engine', async () => {
    const soft = await crash(4);
    expect(soft.v.engine).toBeGreaterThan(900);
    expect(soft.v.smoking).toBe(false);
    const hard = await crash(19);
    expect(hard.v.smoking).toBe(true);
    expect(hard.v.engineDead).toBe(false);
    expect(hard.v.engine).toBeLessThan(WRECK.smokeAt);
    expect(ofType(hard.events, 'vehicle:smoke')).toHaveLength(1);
    expect(ofType(hard.events, 'vehicle:damage').length).toBeGreaterThan(0);
    const v = new SnapshotView();
    hard.sim.writeSnapshot(v);
    const o = v.at(v.indexOf(hard.v.id));
    expect(v.u32[o + E.Flags] & VehicleFlag.Smoking).toBeTruthy();
    expect(v.f32[o + E.Health2]).toBeCloseTo(hard.v.engine, 3);
  });

  it('a harder one kills the engine: no more driving', async () => {
    const r = await crash(24);
    expect(r.v.engineDead).toBe(true);
    expect(ofType(r.events, 'vehicle:engine-dead')).toHaveLength(1);
    // Reversing away does nothing: the engine is dead.
    const p0 = r.v.car.pose();
    run(r.sim, 120, cmd({ axes: { Throttle: 1 } }));
    const p1 = r.v.car.pose();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(2);
  });

  it('a very hard one sets it on fire, and then it explodes: burnt out, disabled for good', async () => {
    const r = await crash(31);
    expect(ofType(r.events, 'vehicle:fire')).toHaveLength(1);
    expect(ofType(r.events, 'vehicle:explode')).toHaveLength(1);
    expect(r.v.burnt).toBe(true);
    expect(r.v.onFire).toBe(false);
    // The player was still at the wheel: the blast killed them (and the WASTED screen may already have put them back at the spawn).
    const blast = ofType(r.events, 'vehicle:explode')[0];
    expect(ofType(r.events, 'player:wasted').filter((e) => e.tick === blast.tick)).toHaveLength(1);
    const v = new SnapshotView();
    r.sim.writeSnapshot(v);
    expect(v.u32[v.at(v.indexOf(r.v.id)) + E.Flags] & VehicleFlag.Burnt).toBeTruthy();
  });

  it('a pickup takes less damage than a coupe from the same crash', async () => {
    const coupe = await crash(22, 'coupe');
    const pickup = await crash(22, 'pickup');
    expect(coupe.v.engine / coupe.v.maxEngine).toBeLessThan(pickup.v.engine / pickup.v.maxEngine);
  });

  it('moving a car by hand (a reset) is not a crash', async () => {
    const { sim, car } = await driverSim();
    run(sim, 120, cmd({ axes: { Throttle: 1 } }));
    run(sim, 2, cmd({ buttons: Button.Reset }));
    run(sim, 60, cmd());
    expect(vehicle(sim).engine).toBe(1000);
    void car;
  });
});

describe('wasted', () => {
  it('fades, then puts the player back at the spawn, healed, with the heat gone', async () => {
    const sim = await makeSim();
    const p = ped(sim);
    p.controller.teleport(300, 0, 300);
    run(sim, 30, cmd());
    sim.law.heat.report(2, 3, 300, 300);
    expect(sim.law.heat.level).toBe(2);
    p.health = 5;
    p.armour = 0;
    const { damagePed } = await import('../src/sim/combat/damage');
    damagePed(sim, p, 50, 'melee', 0);
    expect(p.life).toBe('dead');
    const ev = runLog(sim, 30);
    expect(ofType(ev, 'player:wasted')).toHaveLength(1);
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    expect(v.u32[H.Overlay]).toBe(Overlay.Wasted);
    expect(v.health).toBe(0);
    // no control while wasted
    const x0 = p.controller.x;
    run(sim, 60, cmd({ axes: { MoveY: 1 } }));
    expect(Math.hypot(p.controller.x - x0, 0)).toBeLessThan(1);
    const later = runLog(sim, Math.ceil(LIFE.wastedS * 60));
    const r = ofType(later, 'player:respawn');
    expect(r).toHaveLength(1);
    expect(r[0].reason).toBe('wasted');
    const sp = sim.tile.manifest.spawns.player;
    expect(Math.hypot(p.controller.x - sp.x, p.controller.z - sp.z)).toBeLessThan(1);
    expect(p.health).toBe(100);
    expect(p.life).toBe('alive');
    expect(sim.law.heat.level).toBe(0);
    sim.writeSnapshot(v);
    expect(v.u32[H.Overlay]).toBe(Overlay.None);
  });

  it('dying in a car puts the body out beside it', async () => {
    const { sim } = await driverSim();
    const { damagePed } = await import('../src/sim/combat/damage');
    damagePed(sim, ped(sim), 500, 'explosion', 0);
    run(sim, 5, cmd());
    expect(ped(sim).vehicleId).toBe(0);
    expect(vehicle(sim).occupantId).toBe(0);
  });

  it('health comes back slowly when nothing hurts the player', async () => {
    const sim = await makeSim();
    ped(sim).health = 50;
    ped(sim).lastDamageTick = sim.tick;
    run(sim, 60 * 8, cmd());
    expect(ped(sim).health).toBe(50);
    run(sim, 60 * 10, cmd());
    expect(ped(sim).health).toBeGreaterThan(55);
  });
});
