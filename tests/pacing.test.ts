/**
 * How fast the police response builds, from a scripted crime on the procedural test ground (the flat tile
 * with the street grid, five or six bystanders in the open): seconds from the crime to the first call, the
 * first car, the stars and the helicopter. The numbers are the pacing targets in docs/contracts/law-data.md;
 * the windows are the targets, the data is `crimes.json` rules, `police.json` and the pack's dispatch rows.
 * Deterministic: a seed gives the same timeline every run.
 */
import { describe, expect, it } from 'vitest';
import { CRIMES, LAW_RULES } from '../src/shared/law';
import { POLICE_RULES } from '../src/shared/policeRules';
import { Simulation } from '../src/sim/Simulation';
import { cmd, ped, run } from './helpers';
import { pacingRun, pacingTile, RAMPAGE_GAP_S, type PacingCrime, type Timeline } from './pacingHelpers';
import { vehicle } from './helpers';

const SEEDS = [1, 2, 3];
const runs = new Map<string, Promise<Timeline>>();
/** One run per scene and seed, shared by the tests below. */
const timeline = (kind: PacingCrime, seed: number, seconds = 150) => {
  const key = `${kind}:${seed}:${seconds}`;
  if (!runs.has(key)) runs.set(key, pacingRun(kind, { seed, seconds }));
  return runs.get(key)!;
};

/** Seconds from the first call to when the first car is within 40 m of the scene. */
const arrival = (t: Timeline) => t.onScene! - t.call!;

describe('witnesses', () => {
  it.each(['carjack', 'gunshot', 'kill'] as const)('after a %s the first call comes 8 to 20 s later, not at once', async (kind) => {
    for (const seed of SEEDS) {
      const t = await timeline(kind, seed);
      expect(t.witnesses, `${kind} ${seed}`).toBeGreaterThanOrEqual(5);
      expect(t.call, `${kind} ${seed}`).not.toBeNull();
      expect(t.call!, `${kind} ${seed}`).toBeGreaterThanOrEqual(LAW_RULES.callDelayS[0]);
      expect(t.call!, `${kind} ${seed}`).toBeLessThanOrEqual(LAW_RULES.callDelayS[1] + 0.5);
    }
  });

  it('not all of them call: of five or six witnesses, about half to two thirds get through, and several calls about one crime are one report', async () => {
    let witnesses = 0;
    let calls = 0;
    for (const kind of ['carjack', 'gunshot', 'kill'] as const)
      for (const seed of SEEDS) {
        const t = await timeline(kind, seed);
        witnesses += t.witnesses;
        calls += t.calls;
      }
    expect(calls).toBeGreaterThan(witnesses * 0.35);
    expect(calls).toBeLessThan(witnesses * 0.8);
    // However many called, a carjack was reported once: the stars did not stack.
    const t = await timeline('carjack', 1);
    expect(t.calls).toBeGreaterThan(1);
    expect(t.maxHeat).toBe(1);
  });
});

describe('heat 1: a carjack, or a gunshot', () => {
  it.each(['carjack', 'gunshot'] as const)('a %s never makes more than one star, however long the police are about', async (kind) => {
    for (const seed of SEEDS) {
      const t = await timeline(kind, seed);
      expect(t.maxHeat).toBe(1);
      expect(t.heat2).toBeNull();
      expect(t.heat3).toBeNull();
      expect(t.heli).toBeNull();
    }
  });

  it.each(['carjack', 'gunshot'] as const)('after a %s the first car is sent 6 to 12 s after the call, from far out, and takes 25 to 45 s to reach the scene', async (kind) => {
    for (const seed of SEEDS) {
      const t = await timeline(kind, seed);
      const label = `${kind} ${seed}`;
      expect(t.carSpawned! - t.call!, label).toBeGreaterThanOrEqual(POLICE_RULES.dispatch.delayS[1][0]);
      expect(t.carSpawned! - t.call!, label).toBeLessThanOrEqual(POLICE_RULES.dispatch.delayS[1][1] + 1);
      expect(t.spawnDistance!, label).toBeGreaterThanOrEqual(POLICE_RULES.dispatch.spawnMinM[1] * 0.7);
      expect(arrival(t), label).toBeGreaterThanOrEqual(25);
      expect(arrival(t), label).toBeLessThanOrEqual(45);
    }
  });

  it.each(['carjack', 'gunshot'] as const)('a %s brings one unit and no more', async (kind) => {
    for (const seed of SEEDS) {
      const t = await timeline(kind, seed);
      expect(t.peakCars).toBe(1);
      expect(t.secondSpawn).toBeNull();
    }
  });
});

describe('heat 2 and 3', () => {
  it('a single kill is two stars and no helicopter: three needs more violence', async () => {
    for (const seed of SEEDS) {
      const t = await timeline('kill', seed);
      expect(t.heat2, `kill ${seed}`).not.toBeNull();
      expect(t.heat2! - t.call!, `kill ${seed}`).toBeLessThan(1);
      expect(t.maxHeat).toBe(2);
      expect(t.heat3).toBeNull();
      expect(t.heli).toBeNull();
    }
  });

  it('at heat 2 the second car comes about 30 s after the first, not with it', async () => {
    for (const seed of SEEDS) {
      const t = await timeline('kill', seed);
      expect(t.secondSpawn, `kill ${seed}`).not.toBeNull();
      expect(t.secondSpawn! - t.carSpawned!, `kill ${seed}`).toBeGreaterThanOrEqual(25);
      expect(t.peakCars).toBe(2);
    }
  });

  it('sustained violence (a second kill) reaches three stars, and the helicopter comes about 30 s after that, not at once', async () => {
    for (const seed of [1, 2]) {
      const t = await timeline('rampage', seed, 160);
      const label = `rampage ${seed}`;
      expect(t.maxHeat, label).toBe(3);
      // Someone has to call it in first: three stars come with a call (it covers both kills), never at once.
      expect(t.heat3!, label).toBeGreaterThanOrEqual(LAW_RULES.callDelayS[0]);
      expect(t.heat3!, label).toBeGreaterThan(RAMPAGE_GAP_S);
      expect(t.heli, label).not.toBeNull();
      const delay = t.heli! - t.heat3!;
      expect(delay, label).toBeGreaterThanOrEqual(POLICE_RULES.helicopter.delayS[0] - 0.5);
      expect(delay, label).toBeLessThanOrEqual(POLICE_RULES.helicopter.delayS[1] + 0.5);
    }
  });
});

describe('the rest of the pacing', () => {
  it('a minor crime nobody sees creates no heat at all', async () => {
    const sim = await Simulation.create({ seed: 1, tile: pacingTile(), driver: false, parkedCars: 0 });
    const car = vehicle(sim);
    car.car.teleport(14, 0.4, 14, 0);
    ped(sim).controller.teleport(11, 0, 14, 0);
    run(sim, 30, cmd());
    sim.drainEvents();
    const { Button } = await import('./helpers');
    run(sim, 6, cmd({ buttons: Button.Interact }));
    run(sim, 60 * 60, cmd());
    expect(ped(sim).vehicleId).toBe(car.id);
    expect(sim.law.heat.level).toBe(0);
    expect(sim.police.stats.spawned).toBe(0);
  });

  it('losing one star out of sight takes 15 to 25 s, and two stars 30 to 40 s', async () => {
    for (const [level, lo, hi] of [[1, 15, 25], [2, 30, 40]] as const) {
      // A tile with no roads: the police have nowhere to come from, so only the clock is under test.
      const sim = await Simulation.create({ seed: 1, tile: { ...pacingTile(), roads: [] }, driver: false, parkedCars: 0 });
      ped(sim).controller.teleport(500, 0, 500, 0);
      run(sim, 30, cmd());
      // An officer saw it (solid stars), then nobody sees the player any more.
      sim.law.heat.report(level, 3, 500, 500, true);
      let lostAt = -1;
      let clearAt = -1;
      for (let t = 0; t < 60 * 120 && clearAt < 0; t++) {
        sim.step();
        if (lostAt < 0 && sim.law.heat.phase === 'lost') lostAt = sim.tick;
        if (sim.law.heat.level === 0) clearAt = sim.tick;
      }
      const s = (clearAt - lostAt) / 60;
      expect(s, `${level} star(s)`).toBeGreaterThanOrEqual(lo);
      expect(s, `${level} star(s)`).toBeLessThanOrEqual(hi);
    }
    // Higher heat stays sticky.
    expect(LAW_RULES.cooldownS[4]).toBeGreaterThanOrEqual(90);
  });

  it('the numbers are data: nothing in the crime table lets a minor crime reach two stars by itself', () => {
    for (const [id, c] of Object.entries(CRIMES)) if (c.heat >= 2) expect(c.severity, id).toBeGreaterThanOrEqual(3);
    expect(LAW_RULES.escalation.heat2Points).toBeGreaterThan(CRIMES.carjack.points + CRIMES.assault.points);
  });
});
