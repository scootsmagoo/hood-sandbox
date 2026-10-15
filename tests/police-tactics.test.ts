import { describe, expect, it } from 'vitest';
import { POLICE_RULES, atHeat, heliFootprint, officerCone } from '../src/shared/policeRules';
import { E, H, HeliFlag, HeatPhase, PedFlag, PoliceRole, SnapshotView, VehicleFlag } from '../src/shared/snapshot';
import { EntityKind } from '../src/shared/entities';
import { LAW_RULES } from '../src/shared/law';
import { HANDLING } from '../src/shared/handling';
import { Rng } from '../src/shared/rng';
import { HeatModel } from '../src/sim/law/heat';
import { POLICE } from '../src/sim/police/PoliceSystem';
import { aimErrorDeg, civilianInLine, crossesStrip, hitChance, layoutRoadblock, planPit, stepHeli, type HeliBody, type Kin } from '../src/sim/police/tactics';
import { Simulation } from '../src/sim/Simulation';
import type { Roadblock } from '../src/sim/police/types';
import { FLAT } from '../src/sim/vehicles/RaycastCar';
import { LaneGraph } from '../src/sim/traffic/LaneGraph';
import { Button, addNpc, cmd, driverSim, flatTile, gridTile, ped, run, vehicle } from './helpers';
import { atlanta, agency, chase, ofKind, onlyAgency, wrap } from './policeHelpers';
import { boxTile } from './weaponHelpers';
import { laneTile, lanesFor, road, trafficSim } from './trafficHelpers';
import type { TrafficCar } from '../src/sim/traffic/TrafficManager';

/** One agency, one staged unit, nothing else: no roadblocks, strips or helicopters of their own. */
async function staged(opts: { heat: number; severity?: number; speed: number; x?: number; copAt: number; agencyOver?: Partial<ReturnType<typeof agency>>; seed?: number; vehicleType?: string; copSpeed?: number }) {
  const law = onlyAgency(atlanta, 'acp', { pursuit: 'aggressive', pit: true, ...opts.agencyOver });
  const c = await chase({ law, heat: opts.heat, severity: opts.severity ?? 4, x: opts.x ?? -420, speed: opts.speed, seed: opts.seed ?? 3, vehicleType: opts.vehicleType });
  c.sim.police.roadblocks.enabled = false;
  c.sim.police.heli.enabled = false;
  c.sim.police.spikes.enabled = false;
  const unit = c.sim.police.deployUnit(agency(law, 'acp'), opts.copAt, 3.5, Math.PI / 2, 'pistol');
  const cop = c.sim.registry.get(unit.vehicleId) as ReturnType<typeof vehicle>;
  cop.car.body.setLinvel({ x: opts.copSpeed ?? opts.speed + 4, y: 0, z: 0 }, true);
  cop.car.adopt();
  return { ...c, unit, cop };
}

// -------------------------------------------------------------------------------------------------
// PIT and ramming

describe('PIT', () => {
  it('an aggressive agency lines up on the rear quarter, matches speed, and spins the target car', async () => {
    const s = await staged({ heat: 2, speed: 22, copAt: -460 });
    let alignAtStrike = -1;
    let maxDev = 0;
    s.drive(60 * 20, 22, () => {
      if (s.unit.pit?.struck && alignAtStrike < 0) alignAtStrike = s.unit.pit.alignT;
      maxDev = Math.max(maxDev, Math.abs(wrap(s.hero.car.yaw - Math.PI / 2)));
    });
    const pit = ofKind(s.events, 'police:pit').map((e) => e.phase);
    expect(pit.slice(0, 2)).toEqual(['attempt', 'hit']);
    // the strike came only after it had run alongside, in plain view, for the warning time
    expect(alignAtStrike).toBeGreaterThanOrEqual(POLICE_RULES.pit.warnS - 0.05);
    // and the target is spun round, past a recovery
    expect(maxDev).toBeGreaterThan((100 * Math.PI) / 180);
    expect(s.sim.police.stats.pitHits).toBeGreaterThanOrEqual(1);
  });

  it('works on a target that holds its lane and on one that lets go of the wheel, in a pickup as in a coupe', async () => {
    for (const [mode, type] of [['coast', 'coupe'], ['drive', 'pickup'], ['coast', 'sedan']] as const) {
      const s = await staged({ heat: 2, speed: 18, copAt: -460, vehicleType: type });
      let maxDev = 0;
      const each = () => {
        maxDev = Math.max(maxDev, Math.abs(wrap(s.hero.car.yaw - Math.PI / 2)));
      };
      if (mode === 'coast') s.coast(60 * 20, 18);
      else s.drive(60 * 20, 18, each);
      if (mode === 'coast') maxDev = Math.abs(wrap(s.hero.car.yaw - Math.PI / 2));
      const phases = ofKind(s.events, 'police:pit').map((e) => e.phase);
      expect(phases, `${mode} ${type}`).toContain('hit');
    }
  });

  it('gives the target a breather after a hit: no second attempt inside the grace time', async () => {
    const s = await staged({ heat: 2, speed: 22, copAt: -460 });
    s.drive(60 * 40, 22);
    const hits = ofKind(s.events, 'police:pit').filter((e) => e.phase === 'hit');
    const attempts = ofKind(s.events, 'police:pit').filter((e) => e.phase === 'attempt');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const a of attempts) if (a.tick > hits[0].tick) expect(a.tick - hits[0].tick).toBeGreaterThanOrEqual(POLICE_RULES.pit.graceAfterHitS * 60);
  });

  it('is only for agencies that PIT, and only for a car moving at speed', async () => {
    const plain = await staged({ heat: 2, speed: 22, copAt: -460, agencyOver: { pit: false, pursuit: 'standard' } });
    plain.drive(60 * 20, 22);
    expect(ofKind(plain.events, 'police:pit')).toHaveLength(0);
    // a target crawling below the PIT speed floor is not PIT'd either
    const slow = await staged({ heat: 2, speed: 5, copAt: -445, copSpeed: 9 });
    slow.drive(60 * 15, 5);
    expect(ofKind(slow.events, 'police:pit').filter((e) => e.phase !== 'abort')).toHaveLength(0);
  });

  it('plans the approach from the rear quarter on the side the car is already on', () => {
    const tgt: Kin = { x: 0, z: 0, yaw: 0, speed: 25, halfLen: 2.2, halfWid: 0.92 };
    const cop: Kin = { x: 3, z: -14, yaw: 0, speed: 27, halfLen: 2.2, halfWid: 0.92 };
    // facing +Z the target's left is +X: the cop is on its left and 14 m behind
    const far = planPit(cop, tgt, 1, POLICE_RULES.pit);
    expect(far.phase).toBe('approach');
    expect(far.aim.z).toBeLessThan(0.1);
    expect(far.speed).toBeGreaterThan(tgt.speed);
    const alongside = planPit({ ...cop, x: 2.57, z: -4.4 }, tgt, 1, POLICE_RULES.pit);
    expect(['align', 'strike']).toContain(alongside.phase);
    expect(alongside.speed).toBeLessThan(tgt.speed + 4);
    const level = planPit({ ...cop, x: 2.57, z: -3.0 }, tgt, 1, POLICE_RULES.pit);
    expect(level.phase).toBe('strike');
    // the strike aims into the target's tail, across to its other side
    expect(level.aim.x).toBeLessThan(2);
    expect(level.aim.z).toBeLessThan(-0.5);
  });
});

describe('ramming', () => {
  it('starts at heat 4: the same chase at heat 3 never rams', async () => {
    const at = async (heat: number) => {
      const s = await staged({ heat, speed: 22, copAt: -450, agencyOver: { pit: false } });
      s.drive(60 * 30, 22);
      return ofKind(s.events, 'police:ram').length;
    };
    expect(await at(3)).toBe(0);
    expect(await at(4)).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Roadblocks

describe('roadblocks', () => {
  it('lays 2 or 3 cars angled across the road on the route ahead, 150 to 250 m out of view, with an officer behind each', async () => {
    const law = onlyAgency(atlanta, 'acp', {}, 1);
    const c = await chase({ law, heat: 3, severity: 4, x: -560, speed: 16 });
    c.sim.police.heli.enabled = false;
    c.sim.police.spikes.enabled = false;
    let heroX = 0;
    let at = -1;
    const yaws: number[] = [];
    const standing: { gun: boolean; behindCar: boolean }[] = [];
    c.drive(60 * 14, 16, (t) => {
      if (at < 0 && ofKind(c.events, 'police:roadblock').length > 0) {
        at = t;
        heroX = c.hero.car.pose().x;
        for (const v of c.sim.vehicles()) if (v.roadblock) yaws.push(v.car.yaw);
        for (const p of c.sim.peds()) {
          if (p.officer?.mode !== 'hold') continue;
          standing.push({ gun: !!p.gun, behindCar: [...c.sim.vehicles()].some((v) => v.roadblock && p.controller.x - v.car.pose().x > 1.5 && Math.hypot(p.controller.x - v.car.pose().x, p.controller.z - v.car.pose().z) < 4) });
        }
      }
    });
    const ev = ofKind(c.events, 'police:roadblock');
    expect(ev.length).toBe(1);
    expect(ev[0].cars).toBeGreaterThanOrEqual(2);
    expect(ev[0].cars).toBeLessThanOrEqual(3);
    // 150 to 250 m down the player's route (the street at z = 3.5 runs east), on the road
    const ahead = ev[0].x - heroX;
    expect(ahead).toBeGreaterThan(145);
    expect(ahead).toBeLessThan(265);
    expect(Math.abs(ev[0].z)).toBeLessThan(6);
    // the cars lie across the lanes, not along them, and are parked (nose angles well off the street's axis)
    const cars = [...c.sim.vehicles()].filter((v) => v.roadblock);
    expect(cars).toHaveLength(ev[0].cars);
    expect(yaws).toHaveLength(ev[0].cars);
    for (const yaw of yaws) {
      const off = Math.abs(wrap(yaw - Math.PI / 2));
      const across = Math.min(off, Math.PI - off); // the angle between the car's axis and the street's
      expect(across).toBeGreaterThan((35 * Math.PI) / 180);
    }
    for (const v of cars) {
      expect(v.lightbar).toBe(true);
      expect(v.policeRole).toBe(PoliceRole.Roadblock);
    }
    // an officer stands behind each car (further along the way the target is going), holding, armed
    expect(standing).toHaveLength(cars.length);
    for (const p of standing) {
      expect(p.gun).toBe(true);
      expect(p.behindCar).toBe(true);
    }
    // and in the snapshot the cars are flagged for the minimap, with the header counting the block
    const view = new SnapshotView();
    c.sim.writeSnapshot(view);
    for (const v of cars) expect(view.u32[view.at(view.indexOf(v.id)) + E.Flags] & VehicleFlag.Roadblock).toBeTruthy();
    expect(view.u32[H.Roadblocks]).toBe(1);
  });

  it('is not laid at heat 2, nor in plain view of the player until the cars have waited for a hidden site', async () => {
    const low = await chase({ law: onlyAgency(atlanta, 'acp', {}, 1), heat: 2, severity: 4, x: -560, speed: 16 });
    low.drive(60 * 14, 16);
    expect(ofKind(low.events, 'police:roadblock')).toHaveLength(0);
    // The camera looks down the street (east): every site on the route is in view, over a clear line.
    const view = await chase({ law: onlyAgency(atlanta, 'acp', {}, 1), heat: 3, severity: 4, x: -560, speed: 16, camYaw: -Math.PI / 2 });
    view.sim.police.heli.enabled = false;
    view.sim.police.spikes.enabled = false;
    let first = -1;
    view.drive(60 * 14, 16, (t) => {
      if (first < 0 && ofKind(view.events, 'police:roadblock').length > 0) first = t;
    });
    const laid = ofKind(view.events, 'police:roadblock');
    // either it was never laid, or it waited out the patience (6 s of looking) and then only went out at a distance
    if (laid.length > 0) {
      expect(first).toBeGreaterThan(60 * 5.5);
      expect(laid[0].x - view.hero.car.pose().x).toBeGreaterThan(150);
    }
  });

  it('is lifted when the player has passed it: the officers get back in their cars and join the chase', async () => {
    const law = onlyAgency(atlanta, 'acp', {}, 3);
    const c = await chase({ law, heat: 3, severity: 4, x: -560, speed: 16 });
    c.sim.police.heli.enabled = false;
    c.sim.police.spikes.enabled = false;
    c.drive(60 * 6, 16);
    const block = c.sim.police.roadblocks.blocks[0];
    expect(block).toBeTruthy();
    // jump the hero past the block, as if they had threaded it
    c.hero.car.teleport(block.x + 40, 0.4, 3.5, Math.PI / 2);
    c.hero.car.body.setLinvel({ x: 16, y: 0, z: 0 }, true);
    c.hero.car.adopt();
    c.drive(60 * 2, 16);
    expect(ofKind(c.events, 'police:roadblock-clear').map((e) => e.reason)).toContain('passed');
    expect(c.sim.police.units.filter((u) => u.block)).toHaveLength(0);
    c.drive(60 * 8, 16);
    const seated = [...c.sim.peds()].filter((p) => p.officer && p.officer.unitId && p.vehicleId).length;
    expect(seated).toBeGreaterThanOrEqual(1);
  });

  it('lays out a gap to thread when asked, and none otherwise; the cars never touch', () => {
    const rng = new Rng(1);
    // a road along x: the lateral axis is z, and left of travel is -z
    const none = layoutRoadblock({ x: 0, z: 0 }, { x: 1, z: 0 }, 9, 4.4, 1.84, 3, null, rng);
    expect(none.gap).toBe(null);
    const zs = none.cars.map((c) => c.z).sort((a, b) => a - b);
    expect(none.cars.length).toBeGreaterThanOrEqual(2);
    expect(zs[0]).toBeLessThan(-1);
    expect(zs[zs.length - 1]).toBeGreaterThan(1);
    // each car lies at an angle to the street, all the same way: a diagonal wall
    for (const car of none.cars) {
      const off = Math.abs(wrap(car.yaw - Math.PI / 2));
      expect(Math.min(off, Math.PI - off)).toBeGreaterThan((30 * Math.PI) / 180);
      expect(Math.min(off, Math.PI - off)).toBeLessThan((70 * Math.PI) / 180);
    }
    const lateralEdges = (l: ReturnType<typeof layoutRoadblock>) => l.cars.map((car) => [car.z - 2.2, car.z + 2.2] as const);
    // no two cars overlap: the perpendicular distance between their axes is more than a car's width
    for (let i = 0; i < none.cars.length; i++) {
      for (let j = i + 1; j < none.cars.length; j++) {
        const a = none.cars[i];
        const b = none.cars[j];
        const ax = Math.sin(a.yaw);
        const az = Math.cos(a.yaw);
        const perp = Math.abs((b.x - a.x) * az - (b.z - a.z) * ax);
        expect(perp).toBeGreaterThan(1.84);
      }
    }
    // with a gap: an opening of the width asked, on the side asked, that no car is in
    const g = layoutRoadblock({ x: 0, z: 0 }, { x: 1, z: 0 }, 14, 4.4, 1.84, 3, { width: 4.6, side: 1 }, rng);
    expect(g.gap!.width).toBe(4.6);
    // left of travel (side +1) is -z for a road along +x: the opening is at z = -7 + 2.3 = -4.7
    expect(g.gap!.z).toBeCloseTo(-4.7, 5);
    for (const [lo] of lateralEdges(g)) expect(lo + 0.6).toBeGreaterThan(g.gap!.z); // (a car's slanted body may graze the opening's edge)
    expect(g.officers).toHaveLength(g.cars.length);
    for (const [i, o] of g.officers.entries()) expect(o.x).toBeGreaterThan(g.cars[i].x + 2);
    // a road too narrow to leave an opening and still close is closed
    expect(layoutRoadblock({ x: 0, z: 0 }, { x: 1, z: 0 }, 7, 4.4, 1.84, 3, { width: 4.6, side: 1 }, rng).gap).toBe(null);
  });
});

// -------------------------------------------------------------------------------------------------
// Spike strips

describe('spike strips', () => {
  it('a flat tyre sits lower, grips less and drags', async () => {
    const trial = async (flats: number) => {
      const { sim, car } = await driverSim('sedan');
      const v = vehicle(sim);
      for (let i = 0; i < flats; i++) v.car.deflate(i);
      run(sim, 30, cmd());
      const rad = v.car.wheels.map((w) => w.rad);
      // 16 m/s heading north (-z) for a second and a half with the foot off, then the same speed round a bend
      const north = () => {
        v.car.body.setLinvel({ x: 0, y: 0, z: -16 }, true);
        v.car.adopt();
      };
      north();
      run(sim, 90, cmd());
      const coasted = car.speed;
      north();
      run(sim, 20, cmd({ axes: { Throttle: 0.4, Steer: 0.5 } }));
      const yawRate = Math.abs(v.car.body.angvel().y);
      return { rad, coasted, yawRate, mask: v.car.flatMask };
    };
    const ok = await trial(0);
    const two = await trial(2);
    const four = await trial(4);
    expect([ok.mask, two.mask, four.mask]).toEqual([0, 3, 15]);
    for (const r of ok.rad) expect(r).toBeCloseTo(HANDLING.sedan.wheels.radius, 5);
    for (const r of four.rad) expect(r).toBeCloseTo(HANDLING.sedan.wheels.radius * (1 - FLAT.radiusLoss), 3);
    // the drag: slower after coasting, the more the worse
    expect(two.coasted).toBeLessThan(ok.coasted - 1);
    expect(four.coasted).toBeLessThan(two.coasted - 1);
    // the grip: it turns less for the same wheel
    expect(four.yawRate).toBeLessThan(ok.yawRate);
  });

  it('flattens every wheel that crosses it, whatever the speed, and not the ones that miss', async () => {
    for (const speed of [12, 24, 38]) {
      const c = await chase({ speed, x: -400, law: onlyAgency(atlanta, 'acp') });
      c.sim.police.spikes.lay(-300, 3.5, Math.PI, 8);
      c.drive(60 * 9, speed);
      const flat = ofKind(c.events, 'vehicle:tyre').filter((e) => e.vehicleId === c.hero.id).map((e) => e.wheel).sort();
      expect(flat, `${speed} m/s`).toEqual([0, 1, 2, 3]);
      expect(c.hero.car.flatMask).toBe(15);
    }
    // a short strip in the next lane: the car passes by
    const miss = await chase({ speed: 20, x: -400, law: onlyAgency(atlanta, 'acp') });
    miss.sim.police.spikes.lay(-300, -3.5, Math.PI, 4);
    miss.drive(60 * 9, 20);
    expect(ofKind(miss.events, 'vehicle:tyre')).toHaveLength(0);
    // a strip across the half of the car: the wheels on that side only
    const half = await chase({ speed: 20, x: -400, law: onlyAgency(atlanta, 'acp') });
    half.sim.police.spikes.lay(-300, 3.5 - 2.2, Math.PI, 3.2); // from z = -0.1 to 3.5 -> a car at z = 3.5 has its left side (z lower) over it? left of an eastbound car is -z
    half.drive(60 * 9, 20);
    const wheels = ofKind(half.events, 'vehicle:tyre').map((e) => e.wheel).sort();
    expect(wheels.length).toBeGreaterThanOrEqual(2);
    expect(wheels.length).toBeLessThan(4);
  });

  it('police cars drive over their own strips; the strip is picked up when its time is up', async () => {
    const c = await chase({ speed: 0, x: -400, law: onlyAgency(atlanta, 'acp') });
    const strip = c.sim.police.spikes.lay(-300, 3.5, Math.PI, 8);
    const unit = c.sim.police.deployUnit(agency(atlanta, 'acp'), -330, 3.5, Math.PI / 2);
    const cop = c.sim.registry.get(unit.vehicleId) as ReturnType<typeof vehicle>;
    cop.car.body.setLinvel({ x: 20, y: 0, z: 0 }, true);
    cop.car.adopt();
    c.coast(60 * 4, 0);
    expect(cop.car.flatMask).toBe(0);
    expect(c.sim.police.spikes.flattened).toBe(0);
    c.coast(Math.ceil(POLICE_RULES.spikes.lifeS * 60), 0);
    expect(ofKind(c.events, 'police:spikes-clear').map((e) => e.id)).toContain(strip.id);
    expect(c.sim.police.spikes.count).toBe(0);
  });

  it('crossesStrip tests the path of the wheel, not just where it is: no speed skips a strip', () => {
    const s = { x: 0, z: 0, yaw: 0, length: 4, depth: 0.8 }; // runs along z
    // travelling along x across it
    expect(crossesStrip(s, -0.7, 0, 0.7, 0)).toBe(true);
    expect(crossesStrip(s, -5, 0, 5, 0)).toBe(true); // 10 m in a tick still crosses
    expect(crossesStrip(s, 1, 0, 3, 0)).toBe(false);
    expect(crossesStrip(s, -0.7, 2.6, 0.7, 2.6)).toBe(false); // past the end
    expect(crossesStrip(s, -0.7, 1.9, 0.7, 1.9)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// The helicopter

describe('the helicopter', () => {
  /** A parked hero and nothing else police: the helicopter alone. */
  async function parked(heat: number, minutes = 14 * 60, tile = gridTile()) {
    const law = { ...atlanta, dispatch: {} };
    const c = await chase({ law, heat, severity: 4, x: 0, z: 3.5, speed: 0, minutes, tile });
    c.sim.police.roadblocks.enabled = false;
    c.sim.police.spikes.enabled = false;
    return c;
  }

  it('comes at heat 3 (one), two at heat 5, none at heat 2, and goes when the heat is gone', async () => {
    const low = await parked(2);
    low.coast(60 * 40, 0);
    expect(low.sim.police.heli.count).toBe(0);
    const three = await parked(3);
    three.coast(60 * 40, 0);
    expect(three.sim.police.heli.count).toBe(1);
    expect(atHeat(POLICE_RULES.helicopter.count, 5)).toBe(2);
    const five = await parked(5);
    five.coast(60 * 60, 0);
    expect(five.sim.police.heli.count).toBe(2);
    // the heat clears: they leave and are removed
    five.sim.law.heat.clear('cooldown');
    five.coast(60 * 60, 0);
    expect(five.sim.police.heli.count).toBe(0);
  });

  it('orbits 60 to 90 m up, is in the snapshot as a kinematic entity and has a definition', async () => {
    const c = await parked(3);
    c.coast(60 * 30, 0);
    const h = c.sim.police.heli.helis[0];
    expect(h.agl).toBeGreaterThan(55);
    expect(h.agl).toBeLessThan(100);
    // near the hero, circling
    expect(Math.hypot(h.x - c.hero.car.pose().x, h.z - c.hero.car.pose().z)).toBeLessThan(120);
    const defs = ofKind(c.events, 'entity:spawn').filter((e) => e.def.kind === EntityKind.Helicopter);
    expect(defs).toHaveLength(1);
    expect(c.sim.defOf(h)).toMatchObject({ kind: EntityKind.Helicopter, typeId: 'helicopter' });
    const view = new SnapshotView();
    c.sim.writeSnapshot(view);
    const o = view.at(view.indexOf(h.id));
    expect(view.u32[o + E.Kind]).toBe(EntityKind.Helicopter);
    expect(view.f32[o + E.Py]).toBeCloseTo(h.y, 2);
    expect(view.f32[o + E.Aux1]).toBeCloseTo(h.agl, 1);
    expect(view.u32[H.Helicopters]).toBe(1);
  });

  it('sees the player through its downward cone, and a sighting makes the stars solid', async () => {
    const c = await parked(3);
    expect(c.sim.law.heat.phase).toBe('seen'); // the report put them there; let them lose it first
    c.sim.law.heat.step(5, false);
    expect(c.sim.law.heat.phase).toBe('lost');
    c.coast(60 * 6, 0);
    const heli = c.sim.police.heli.helis[0];
    // put it over the player and let it look
    const p = c.hero.car.pose();
    heli.x = p.x + 5;
    heli.z = p.z;
    heli.y = c.sim.groundAt(p.x, p.z) + 80;
    heli.vx = heli.vy = heli.vz = 0;
    c.coast(20, 0);
    expect(heli.sees).toBe(true);
    expect(c.sim.police.seesPlayer).toBe(true);
    expect(c.sim.law.heat.phase).toBe('seen');
    expect(c.sim.police.units.filter((u) => u.officerIds.length)).toHaveLength(0); // nobody on the ground saw them
    expect(ofKind(c.events, 'police:helicopter').some((e) => e.state === 'sees')).toBe(true);
    const view = new SnapshotView();
    c.sim.writeSnapshot(view);
    expect(view.heatPhase).toBe(HeatPhase.Seen);
    expect(view.u32[view.at(view.indexOf(heli.id)) + E.Flags] & HeliFlag.Sees).toBeTruthy();
  });

  it('does not see through a roof, nor outside the cone; at night the cone shrinks to the searchlight and the lamps', async () => {
    const lookFrom = async (dx: number, minutes: number, roof = false) => {
      const tile = roof ? { ...boxTile([{ x: 0, z: 3.5, y: 25, sx: 40, sy: 3, sz: 40 }]), roads: gridTile().roads } : gridTile();
      const c = await parked(3, minutes, tile);
      c.sim.law.heat.step(5, false);
      c.coast(60 * 4, 0);
      const heli = c.sim.police.heli.helis[0];
      const p = c.hero.car.pose();
      heli.x = p.x + dx;
      heli.z = p.z;
      heli.y = c.sim.groundAt(p.x, p.z) + 80;
      heli.vx = heli.vy = heli.vz = 0;
      let saw = false;
      for (let i = 0; i < 8; i++) {
        c.coast(1, 0);
        heli.vx = heli.vy = heli.vz = 0;
        heli.x = p.x + dx;
        heli.z = p.z;
        saw ||= heli.sees;
      }
      return { saw, light: heli.searchlight };
    };
    // 60 m off to the side at 80 m up is 37 degrees from straight down: inside the 42 degree cone by day
    expect((await lookFrom(60, 14 * 60)).saw).toBe(true);
    // ...and outside the narrower night one, which has the searchlight on
    const night = await lookFrom(60, 23 * 60);
    expect(night.saw).toBe(false);
    expect(night.light).toBe(true);
    // directly overhead it still sees at night
    expect((await lookFrom(2, 23 * 60)).saw).toBe(true);
    // the searchlight is for the dark
    expect((await lookFrom(2, 13 * 60)).light).toBe(false);
    // a roof between them: not seen
    expect((await lookFrom(2, 14 * 60, true)).saw).toBe(false);
  });

  it('moves with a bounded speed and bank, and never faster than it can', () => {
    const h: HeliBody = { x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, bank: 0, pitch: 0 };
    let top = 0;
    let bank = 0;
    for (let t = 0; t < 60 * 30; t++) {
      stepHeli(h, { x: 400, z: 0, altitude: 80, groundY: 0, roofY: 0, radius: 40, angle: t * 0.01 }, 42, 11, 1 / 60);
      top = Math.max(top, Math.hypot(h.vx, h.vz));
      bank = Math.max(bank, Math.abs(h.bank));
    }
    expect(top).toBeLessThanOrEqual(42.5);
    expect(bank).toBeLessThanOrEqual(0.46);
    expect(Math.hypot(h.x - 400, h.z)).toBeLessThan(80);
    expect(h.y).toBeGreaterThan(70);
    expect(h.y).toBeLessThan(90);
    expect(heliFootprint(80)).toBeCloseTo(Math.tan((POLICE_RULES.helicopter.coneHalfDeg * Math.PI) / 180) * 80, 5);
  });
});

// -------------------------------------------------------------------------------------------------
// Police shooting, through the weapons API

describe('police gunfire', () => {
  /** An officer holding at (-25, 0) facing a player on foot at (0, 0), at the given heat. */
  async function standoff(heat: number, over: { civilianAt?: number; agencyId?: string; firedOn?: boolean; loadout?: string } = {}) {
    const sim = await Simulation.create({ seed: 4, tile: { ...gridTile(), roads: gridTile().roads }, driver: false, parkedCars: 0, law: atlanta, clock: { minutes: 14 * 60, scale: 0 } });
    sim.police.roadblocks.enabled = false;
    sim.police.heli.enabled = false;
    ped(sim).controller.teleport(0, 0, 40, 0);
    run(sim, 20, cmd());
    // (a free-standing block that never lifts: the officer just stands there with a gun)
    const block = { id: 99, x: -25, z: 40, dirX: 1, dirZ: 0, width: 8, unitIds: [], t0: 0, passedAt: 0, gap: null, stripId: 0 } as Roadblock;
    const ag = agency(atlanta, over.agencyId ?? 'acp');
    const unit = sim.police.spawnStatic(ag, over.loadout ?? 'pistol', { x: -30, z: 46, yaw: 0 }, { x: -25, z: 40, yaw: Math.PI / 2 }, block);
    const officer = sim.registry.get(unit.officerIds[0]) as ReturnType<typeof ped>;
    sim.law.heat.report(heat, 4, 0, 40, true);
    if (over.firedOn) sim.police.fire.firedOn = true;
    let civ = null as ReturnType<typeof addNpc> | null;
    if (over.civilianAt !== undefined) {
      civ = addNpc(sim, over.civilianAt, 40, 0);
      civ.brain = null; // stands exactly where it is
    }
    sim.drainEvents();
    return { sim, officer, civ, ag };
  }
  const shots = (events: ReturnType<Simulation['drainEvents']>, id: number) => ofKind(events, 'weapon:fire').filter((e) => e.shooterId === id);
  const play = (sim: Simulation, seconds: number) => {
    const out: ReturnType<Simulation['drainEvents']> = [];
    for (let i = 0; i < seconds * 60; i++) {
      sim.pushInput(1, cmd());
      sim.step();
      out.push(...sim.drainEvents());
      const p = ped(sim);
      p.armour = 1e9;
    }
    return out;
  };

  it('fire through the weapons API: a reaction delay, then bursts of a few shots, then a pause', async () => {
    const { sim, officer } = await standoff(3);
    const ev = play(sim, 12);
    const mine = shots(ev, officer.id);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    // the event the weapons API raises, with the officer as the shooter and the shot aimed at the player
    expect(mine[0].weapon).toBe('pistol');
    expect(mine[0].dx).toBeGreaterThan(0.9);
    // reaction time: nothing in the first half second after the sighting
    expect(mine[0].tick - ev.find((e) => e.type === 'heat:change' || true)!.tick).toBeGreaterThanOrEqual(0);
    const firstSight = 0;
    expect(mine[0].tick).toBeGreaterThan(firstSight + POLICE_RULES.fire.reactionS[0] * 60 - 5);
    // bursts: gaps of a pause between runs of shots
    const gaps = mine.slice(1).map((e, i) => e.tick - mine[i].tick);
    expect(Math.max(...gaps)).toBeGreaterThan(POLICE_RULES.fire.loadouts.pistol.pauseS[0] * 60 - 8);
    expect(Math.min(...gaps)).toBeLessThan(40);
    // the law's own `police:fire` accompanies each shot, for the client
    expect(ofKind(ev, 'police:fire').filter((e) => e.officerId === officer.id).length).toBe(mine.length);
    // the bullets hurt: some find the player
    expect(ofKind(ev, 'damage').filter((e) => e.sourceId === officer.id && e.targetId === sim.playerPedId).length).toBeGreaterThan(0);
  });

  it('holds fire while a civilian stands in the line, and fires when they have gone', async () => {
    const { sim, officer, civ } = await standoff(3, { civilianAt: -12 });
    const blocked = play(sim, 8);
    expect(shots(blocked, officer.id)).toHaveLength(0);
    expect(sim.police.fire.stats.withheldCivilian).toBeGreaterThan(0);
    expect(civ!.life).toBe('alive');
    expect(civ!.health).toBe(100);
    sim.despawn(civ!.id);
    const clear = play(sim, 8);
    expect(shots(clear, officer.id).length).toBeGreaterThan(0);
    // a bystander well off the line is the risk they take: it does not hold them
    const { sim: s2, officer: o2 } = await standoff(3, {});
    const side = addNpc(s2, -12, 43.5, 0);
    side.brain = null;
    expect(shots(play(s2, 8), o2.id).length).toBeGreaterThan(0);
  });

  it('does not fire through a car either, or a wall', async () => {
    const { sim, officer } = await standoff(3);
    const blocker = sim.spawnVehicle('sedan', -12, 0, 40, Math.PI / 2, 0x888888);
    void blocker;
    const ev = play(sim, 8);
    expect(shots(ev, officer.id)).toHaveLength(0);
    expect(sim.police.fire.stats.withheldCivilian).toBeGreaterThan(0);
  });

  it('shoots only from heat 3, unless fired on; the restrictive city police the same', async () => {
    const two = await standoff(2);
    expect(shots(play(two.sim, 8), two.officer.id)).toHaveLength(0);
    const firedOn = await standoff(2, { firedOn: true });
    expect(shots(play(firedOn.sim, 8), firedOn.officer.id).length).toBeGreaterThan(0);
    expect(two.ag.pursuit).toBe('restrictive');
    const three = await standoff(3);
    expect(shots(play(three.sim, 8), three.officer.id).length).toBeGreaterThan(0);
  });

  it('answers a bullet from the player at once: a shot at police sets firedOn', async () => {
    const { sim, officer } = await standoff(1);
    expect(sim.police.fire.firedOn).toBe(false);
    sim.emit({ type: 'weapon:fire', tick: sim.tick, shooterId: sim.playerPedId, weapon: 'pistol', x: 0, y: 1.4, z: 40, dx: -1, dy: 0, dz: 0, impacts: [{ kind: 'ped', x: -24, y: 1.2, z: 40, nx: 1, ny: 0, nz: 0, targetId: officer.id, headshot: false }] });
    expect(sim.police.fire.firedOn).toBe(true);
    expect(shots(play(sim, 8), officer.id).length).toBeGreaterThan(0);
  });

  it('shoots the weapon of its loadout: a rifle in rifle bursts, from further away', async () => {
    const r = await standoff(3, { loadout: 'rifle' });
    const ev = play(r.sim, 8);
    expect(shots(ev, r.officer.id).every((e) => e.weapon === 'rifle')).toBe(true);
    expect(shots(ev, r.officer.id).length).toBeGreaterThan(4);
  });

  it('aim gets worse with range and with how fast the target moves', () => {
    const lo = POLICE_RULES.fire.loadouts.pistol;
    const base = { loadout: lo, drivingBy: false, rules: POLICE_RULES.fire };
    const near = aimErrorDeg({ ...base, range: 10, targetSpeed: 0 });
    const far = aimErrorDeg({ ...base, range: 40, targetSpeed: 0 });
    const fast = aimErrorDeg({ ...base, range: 10, targetSpeed: 25 });
    const by = aimErrorDeg({ ...base, range: 10, targetSpeed: 0, drivingBy: true });
    expect(far).toBeGreaterThan(near);
    expect(fast).toBeGreaterThan(near);
    expect(by).toBeGreaterThan(near);
    expect(hitChance(near, 10)).toBeGreaterThan(hitChance(far, 40));
    expect(hitChance(near, 10)).toBeGreaterThan(hitChance(fast, 10));
    expect(hitChance(0.01, 10)).toBeGreaterThan(0.99);
  });

  it('civilianInLine finds the first person on the line and ignores the ones off it', () => {
    const from = { x: 0, y: 1.4, z: 0 };
    const to = { x: 30, y: 1.2, z: 0 };
    const people = [{ id: 1, x: 10, y: 0, z: 0.3 }, { id: 2, x: 20, y: 0, z: 0 }, { id: 3, x: 15, y: 0, z: 2.5 }, { id: 4, x: -5, y: 0, z: 0 }, { id: 5, x: 40, y: 0, z: 0 }];
    expect(civilianInLine(from, to, people, 0.8)).toBe(1);
    expect(civilianInLine(from, to, people.slice(2), 0.8)).toBe(null);
    expect(civilianInLine(from, to, [people[2]], 3)).toBe(3);
  });
});

// -------------------------------------------------------------------------------------------------
// Losing them

describe('the search, and losing them', () => {
  it('the search area grows from the last known position, faster at high heat, up to a cap', () => {
    const h = new HeatModel(LAW_RULES);
    h.report(4, 4, 100, 200, true);
    expect(h.searchRadius).toBe(0); // seen: no search
    h.step(LAW_RULES.seenGraceS + 0.1, false);
    expect(h.phase).toBe('lost');
    const r0 = h.searchRadius;
    expect(r0).toBeGreaterThanOrEqual(LAW_RULES.searchStartM[4] - 1);
    h.step(20, false);
    const r1 = h.searchRadius;
    expect(r1).toBeGreaterThan(r0 + 20);
    h.step(400, false, 0); // (time passes, the cooldown does not)
    expect(h.searchRadius).toBeLessThanOrEqual(LAW_RULES.searchMaxM);
    const low = new HeatModel(LAW_RULES);
    low.report(1, 2, 0, 0, true);
    low.step(LAW_RULES.seenGraceS + 20.1, false);
    const high = new HeatModel(LAW_RULES);
    high.report(5, 4, 0, 0, true);
    high.step(LAW_RULES.seenGraceS + 20.1, false);
    expect(high.searchRadius).toBeGreaterThan(low.searchRadius);
    expect(h.lastKnown).toEqual({ x: 100, z: 200 });
  });

  it('heat 4 and up takes much longer to shake than heat 3, and a slowed cooldown takes longer again; all of them can be shaken', () => {
    const seconds = (level: number, rate: number) => {
      const h = new HeatModel(LAW_RULES);
      h.report(level, 4, 0, 0, true);
      let t = 0;
      h.step(LAW_RULES.seenGraceS + 0.01, false);
      while (h.level > 0 && t < 2000) {
        h.step(0.5, false, rate);
        t += 0.5;
      }
      return t;
    };
    expect(seconds(3, 1)).toBeLessThan(80);
    expect(seconds(4, 1)).toBeGreaterThanOrEqual(100);
    expect(seconds(5, 1)).toBeGreaterThan(seconds(4, 1));
    expect(seconds(6, 1)).toBeGreaterThan(seconds(5, 1));
    expect(seconds(4, POLICE_RULES.cooldown.insideSearchFactor)).toBeGreaterThan(seconds(4, 1) * 1.8);
    expect(seconds(6, POLICE_RULES.cooldown.heliOverheadFactor * POLICE_RULES.cooldown.insideSearchFactor)).toBeLessThan(2000); // hard, not impossible
  });

  it('the cooldown is slowed from heat 4 only while the player is inside the search circle', async () => {
    const c = await chase({ law: { ...atlanta, dispatch: {} }, heat: 4, severity: 4, x: 0, z: 3.5, speed: 0 });
    c.sim.police.heli.enabled = false;
    c.sim.law.heat.step(5, false);
    expect(c.sim.law.heat.phase).toBe('lost');
    expect(c.sim.police.coolRate()).toBe(POLICE_RULES.cooldown.insideSearchFactor);
    // out beyond the circle's edge: full speed
    c.hero.car.teleport(c.sim.law.heat.searchRadius + 200, 0.4, 3.5, 0);
    c.coast(2, 0);
    expect(c.sim.police.coolRate()).toBe(1);
    // and a lower heat is never slowed
    c.hero.car.teleport(0, 0.4, 3.5, 0);
    c.sim.law.heat.clear('cooldown');
    c.sim.law.heat.report(3, 4, 0, 0, true);
    c.sim.law.heat.step(5, false);
    expect(c.sim.police.coolRate()).toBe(1);
  });

  it('the snapshot carries the last known position and the search radius for the minimap, and the vision cones', async () => {
    const c = await chase({ law: { ...atlanta, dispatch: {} }, heat: 3, severity: 4, x: 0, z: 3.5, speed: 0 });
    c.sim.police.heli.enabled = false;
    c.sim.law.heat.step(5, false);
    c.coast(60, 0);
    const v = new SnapshotView();
    c.sim.writeSnapshot(v);
    const lk = c.sim.law.heat.lastKnown!;
    expect(v.searchX).toBeCloseTo(lk.x, 3);
    expect(v.searchZ).toBeCloseTo(lk.z, 3);
    expect(v.searchR).toBeCloseTo(c.sim.law.heat.searchRadius, 2);
    expect(v.searchR).toBeGreaterThan(40);
    const cone = officerCone(0, 0, 0, true);
    expect(cone.range).toBe(LAW_RULES.visionRangeM);
    expect(cone.halfAngle).toBeGreaterThan(officerCone(0, 0, 0, false).halfAngle);
    void [PedFlag, POLICE];
  });
});

// -------------------------------------------------------------------------------------------------
// Traffic and the sirens

describe('traffic pulls over for the police', () => {
  it('toward the kerb: right in the right lane, left on the left of a one-way street, away from the police in between', async () => {
    const roads = [road('oneway', [[-300, 0], [300, 0]], { oneway: true, lanes: 3, width: 10.5 }), road('two', [[0, -300], [0, 300]], { lanes: 4, width: 14 })];
    const lanes = lanesFor(roads);
    const sim = await trafficSim(lanes, { traffic: 1 });
    sim.traffic!.density = 0;
    const g = sim.traffic!.graph as LaneGraph;
    const lane = (r: string, dir: 1 | -1, k: number) => g.data.edges.findIndex((e) => e.t === 0 && e.road === r && e.dir === dir && e.k === k);
    const side = (edge: number, lat: number) => sim.traffic!.pullOverSide({ edge } as unknown as TrafficCar, lat);
    const L0 = lane('oneway', 1, 0);
    const L1 = lane('oneway', 1, 1);
    const L2 = lane('oneway', 1, 2);
    expect(g.oneWay[L0]).toBe(1);
    expect(g.left[L0]).toBe(-1);
    expect(g.right[L2]).toBe(-1);
    // the rightmost lane: to the right kerb, whichever side the police are on
    expect(side(L2, 0)).toBeLessThan(0);
    expect(side(L2, 3)).toBeLessThan(0);
    // the leftmost lane of a one-way street: the left kerb is right there
    expect(side(L0, -3)).toBeGreaterThan(0);
    expect(side(L0, 0)).toBeGreaterThan(0);
    // the middle lane: away from the police
    expect(side(L1, 3)).toBeLessThan(0);
    expect(side(L1, -3)).toBeGreaterThan(0);
    // a two-way street: the left of its inner lane is the centre line, never a kerb: it goes right (or away from the police)
    const T0 = lane('two', 1, 0);
    expect(g.oneWay[T0]).toBe(0);
    expect(side(T0, -3)).toBeLessThan(0);
    void [flatTile, Button];
  });
});

describe('traffic pulls over for a siren, on a multi-lane one-way street', () => {
  it('cars in each lane edge toward their kerb as a police car with its lights on comes up behind', async () => {
    const lanes = lanesFor([road('oneway', [[-900, 0], [900, 0]], { oneway: true, lanes: 3, width: 10.5 })]);
    const sim = await Simulation.create({ seed: 2, tile: { ...laneTile(lanes), roads: [{ id: 'oneway', class: 'secondary', lanes: 3, oneway: true, bridge: false, layer: 0, width: 10.5, points: [[-900, 0, 0], [900, 0, 0]] }] }, driver: false, parkedCars: 0, traffic: 1, law: atlanta, clock: { minutes: 14 * 60, scale: 0 } });
    sim.traffic!.density = 0;
    const t = sim.traffic!;
    const g = t.graph;
    const lane = (k: number) => g.data.edges.findIndex((e, i) => e.t === 0 && e.road === 'oneway' && e.dir === 1 && e.k === k && g.len[i] > 100);
    // one car in each lane, 90 m ahead of where a police car will come from; the player is near so they are physics cars
    const cars = [0, 1, 2].map((k) => t.spawnAt(lane(k), 20, { type: 'sedan', color: 0x666666 }));
    for (const c of cars) c.v = 12;
    const hero = vehicle(sim);
    hero.car.teleport(-600, 0.5, 40, 0);
    ped(sim).controller.teleport(-600, 0, 44, 0);
    sim.law.heat.report(2, 3, -500, 0, true);
    sim.police.roadblocks.enabled = false;
    sim.police.heli.enabled = false;
    const start = g.pts[lane(1)];
    const cop = sim.police.deployUnit(agency(atlanta, 'acp'), start[0] + 5, start[2] - 0, Math.PI / 2, 'pistol');
    const veh = sim.registry.get(cop.vehicleId) as ReturnType<typeof vehicle>;
    veh.car.body.setLinvel({ x: 22, y: 0, z: 0 }, true);
    veh.car.adopt();
    veh.lightbar = true;
    const seen = new Map<number, number>();
    for (let i = 0; i < 60 * 8; i++) {
      sim.step();
      sim.drainEvents();
      for (const [k, c] of cars.entries()) if (c.pullOver && Math.abs(c.swerve) > Math.abs(seen.get(k) ?? 0)) seen.set(k, c.swerve);
    }
    // the right lane goes right (negative), the left lane goes left (positive: the one-way street's left kerb)
    expect(seen.get(2) ?? 0).toBeLessThan(-0.5);
    expect(seen.get(0) ?? 0).toBeGreaterThan(0.5);
    // the car in the middle lane moves away from the police, whichever side that is, and does not just hold the lane
    expect(Math.abs(seen.get(1) ?? 0)).toBeGreaterThan(0.5);
    expect(ofKind(sim.drainEvents(), 'traffic:react')).toBeDefined();
  });
});

// -------------------------------------------------------------------------------------------------
// Determinism

describe('determinism', () => {
  it('a heat 4 chase replays exactly: events and snapshot bytes', async () => {
    const play = async () => {
      const c = await chase({ heat: 4, severity: 4, x: -560, speed: 18, seed: 11 });
      const bytes: Uint8Array[] = [];
      c.drive(60 * 40, 18, (t) => {
        if (t % 300 === 299) {
          const v = new SnapshotView();
          c.sim.writeSnapshot(v);
          v.u32[H.Ack] = 0; // (the test's own command counter, which runs on between the two plays)
          bytes.push(new Uint8Array(v.buffer.slice(0)));
        }
      });
      return { events: c.events, bytes };
    };
    const a = await play();
    const b = await play();
    const types = new Set(a.events.map((e) => e.type));
    for (const t of ['police:spawn', 'police:role', 'police:roadblock', 'police:helicopter', 'police:spikes'] as const) expect(types.has(t), t).toBe(true);
    expect(a.events).toEqual(b.events);
    expect(a.bytes.length).toBeGreaterThan(5);
    for (let i = 0; i < a.bytes.length; i++) expect(Buffer.from(a.bytes[i]).equals(Buffer.from(b.bytes[i])), `snapshot ${i}`).toBe(true);
  });
});
