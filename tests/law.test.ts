import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRIMES, LAW_RULES, agencyAt, cityOfTile, dispatchFor, parseCrimes, parseJurisdictions } from '../src/shared/law';
import { generateProceduralTile, propsToMesh } from '../src/shared/proceduralTile';
import { HeatModel, type HeatChange } from '../src/sim/law/heat';
import { loadLawForTile, GENERIC_LAW } from '../src/sim/law/cityPack';
import { Simulation } from '../src/sim/Simulation';
import { damagePed, knockDown } from '../src/sim/combat/damage';
import { addNpc, Button, cmd, everyoneCalls, flatTile, makeSim, ofType, ped, run, runLog, vehicle } from './helpers';

describe('the crime table', () => {
  it('matches the contract and validates', () => {
    expect(Object.keys(CRIMES).sort()).toEqual(['assault', 'assault_officer', 'carjack', 'discharge', 'hit_ped', 'kill_ped', 'shoot_ped', 'vehicle_theft']);
    expect(CRIMES.carjack).toEqual({ severity: 2, heat: 1, witnessRadius: 35, points: 2, violent: false });
    expect(CRIMES.hit_ped.heat).toBe(2);
    // A single kill is two stars; three needs sustained violence (see the heat model) or an attack on police.
    expect(CRIMES.kill_ped.heat).toBe(2);
    expect(CRIMES.assault_officer.heat).toBe(3);
    // Gunfire carries further than it can be seen.
    expect(CRIMES.discharge).toMatchObject({ severity: 1, heat: 1 });
    expect(CRIMES.discharge.hearRadius!).toBeGreaterThan(CRIMES.discharge.witnessRadius);
    expect(CRIMES.shoot_ped.severity).toBeGreaterThanOrEqual(4);
    expect(CRIMES.shoot_ped.hearRadius!).toBeGreaterThan(CRIMES.shoot_ped.witnessRadius);
    expect(LAW_RULES.cooldownS[2]).toBeGreaterThan(LAW_RULES.cooldownS[1]);
    expect(() => parseCrimes({ crimes: { x: { severity: 9, heat: 1, witnessRadius: 5 } } })).toThrow(/severity/);
    // The escalation rules are checked when the table loads: heat 2 and up needs a severity of 3, heat 3 and up a violent crime.
    expect(() => parseCrimes({ crimes: { x: { severity: 2, heat: 2, witnessRadius: 5 } } })).toThrow(/severity of 3/);
    expect(() => parseCrimes({ crimes: { x: { severity: 4, heat: 3, witnessRadius: 5 } } })).toThrow(/violent/);
    for (const [id, c] of Object.entries(CRIMES)) {
      if (c.heat >= 2) expect(c.severity, id).toBeGreaterThanOrEqual(3);
      if (c.heat >= 3) expect(c.violent, id).toBe(true);
    }
    // Witnesses: about half to two thirds call, it takes 8 to 20 s, and hearing it from behind a wall is less likely to get a call.
    expect(LAW_RULES.callChance).toBeGreaterThanOrEqual(0.5);
    expect(LAW_RULES.callChance).toBeLessThanOrEqual(0.7);
    expect(LAW_RULES.heardCallChance).toBeLessThanOrEqual(LAW_RULES.callChance);
    expect(LAW_RULES.callDelayS).toEqual([8, 20]);
    // Cooling a star or two out of sight: 15 to 25 s for one, 30 to 40 s for two; higher heat stays sticky.
    expect(LAW_RULES.cooldownS[1]).toBeGreaterThanOrEqual(15);
    expect(LAW_RULES.cooldownS[1]).toBeLessThanOrEqual(25);
    expect(LAW_RULES.cooldownS[2]).toBeGreaterThanOrEqual(30);
    expect(LAW_RULES.cooldownS[2]).toBeLessThanOrEqual(40);
    for (let i = 3; i <= 6; i++) expect(LAW_RULES.cooldownS[i]).toBeGreaterThanOrEqual(LAW_RULES.cooldownS[i - 1]);
    expect(() => parseCrimes({})).toThrow();
  });
});

describe('the jurisdiction tables', () => {
  const atlanta = parseJurisdictions(JSON.parse(readFileSync('data/cities/atlanta/jurisdictions.json', 'utf8')));
  it('parses the Atlanta pack and finds the city pack from the tile id', async () => {
    expect(cityOfTile('atlanta/m1-five-points')).toBe('atlanta');
    expect(cityOfTile('procedural/test-ground')).toBe('procedural');
    expect(cityOfTile('nope')).toBe(null);
    const loaded = await loadLawForTile('atlanta/m1-five-points');
    expect(loaded.agencies.map((a) => a.id)).toEqual(atlanta.agencies.map((a) => a.id));
    // A city without a pack gets the generic law.
    expect(await loadLawForTile('procedural/test-ground')).toBe(GENERIC_LAW);
  });
  it('lets dispatch levels inherit the nearest lower one', () => {
    expect(dispatchFor(atlanta, 'acp', 2)?.maxUnits).toBe(2);
    expect(dispatchFor(atlanta, 'acp', 1)?.maxUnits).toBe(1);
    expect(dispatchFor(atlanta, 'tap', 2)?.heat).toBe(1);
    expect(dispatchFor(atlanta, 'gtf', 3)).toBe(null);
    expect(dispatchFor(atlanta, 'gtf', 5)?.heat).toBe(5);
    expect(dispatchFor(atlanta, 'nope', 1)).toBe(null);
  });
  it('picks the agency by road class, falling back to the default', () => {
    const roads = [
      { id: 'a', class: 'motorway', lanes: 4, oneway: true, bridge: false, layer: 0, width: 14, points: [[0, 0, 0], [100, 0, 0]] as [number, number, number][] },
      { id: 'b', class: 'secondary', lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points: [[0, 0, 100], [100, 0, 100]] as [number, number, number][] },
    ];
    expect(agencyAt(atlanta, roads, 50, 5)?.id).toBe('ghp');
    expect(agencyAt(atlanta, roads, 50, 100)?.id).toBe('acp');
    expect(agencyAt(atlanta, roads, 50, 40)?.id).toBe('acp');
  });
  it('rejects a pack that names an unknown agency', () => {
    expect(() => parseJurisdictions({ agencies: [{ id: 'a', pursuit: 'standard', livery: { body: '#000', stripe: '#000', lightbar: ['#000', '#000'] }, vehicle: 'sedan' }], areas: [{ agency: 'b', default: true }] })).toThrow(/unknown agency/);
    expect(() => parseJurisdictions({ agencies: [] })).toThrow();
  });
});

describe('the heat model', () => {
  const make = () => {
    const changes: HeatChange[] = [];
    return { h: new HeatModel(LAW_RULES, (c) => changes.push(c)), changes };
  };

  it('a report gives hollow stars and the crime scene as the last known position', () => {
    const { h, changes } = make();
    h.report(1, 2, 10, 20);
    expect(h.level).toBe(1);
    expect(h.phase).toBe('reported');
    expect(h.lastKnown).toEqual({ x: 10, z: 20 });
    expect(h.anchor).toEqual({ x: 10, z: 20 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ level: 1, prevLevel: 0, phase: 'reported', prevPhase: 'none', reason: 'crime' });
  });

  it('a sighting makes the stars solid and tracks the player; losing them makes the stars flash', () => {
    const { h } = make();
    h.report(2, 3, 0, 0);
    h.sight(5, 6);
    expect(h.phase).toBe('seen');
    expect(h.lastKnown).toEqual({ x: 5, z: 6 });
    h.step(0.5, false);
    expect(h.phase).toBe('seen'); // a short grace
    h.step(LAW_RULES.seenGraceS, false);
    expect(h.phase).toBe('lost');
    expect(h.lastKnown).toEqual({ x: 5, z: 6 });
    // a fresh sighting turns them solid again
    h.sight(8, 8);
    expect(h.phase).toBe('seen');
  });

  it('a new crime raises heat to at least its level, never lowers it', () => {
    const { h } = make();
    h.report(3, 4, 0, 0);
    h.report(1, 2, 0, 0);
    expect(h.level).toBe(3);
    h.report(2, 3, 0, 0);
    expect(h.level).toBe(3);
    h.report(6, 5, 0, 0);
    h.report(9, 5, 0, 0);
    expect(h.level).toBe(6);
    expect(h.severity).toBe(5);
  });

  it('a report while the police have eyes on you does not move the last known position', () => {
    const { h } = make();
    h.report(1, 2, 0, 0);
    h.sight(50, 50);
    h.report(2, 3, 0, 0);
    expect(h.lastKnown).toEqual({ x: 50, z: 50 });
    expect(h.phase).toBe('seen');
  });

  it('cools down after N seconds out of sight, longer at higher heat', () => {
    for (const level of [1, 2, 3, 6]) {
      const { h, changes } = make();
      h.report(level, 2, 0, 0);
      // Hollow stars wait out the report hold (the police are still coming) before they begin to cool.
      const need = LAW_RULES.reportedHoldS + LAW_RULES.cooldownS[level];
      let t = 0;
      for (; h.level > 0 && t < 300; t += 0.1) h.step(0.1, false);
      expect(t).toBeGreaterThanOrEqual(need - 0.2);
      expect(t).toBeLessThanOrEqual(need + 0.3);
      expect(changes[changes.length - 1]).toMatchObject({ level: 0, phase: 'none', reason: 'cooldown' });
      expect(h.lastKnown).toBe(null);
    }
    expect(LAW_RULES.cooldownS[4]).toBeGreaterThan(LAW_RULES.cooldownS[2]);
  });

  it('does not cool while the police see you; sight resets the clock', () => {
    const { h } = make();
    h.report(1, 2, 0, 0);
    for (let t = 0; t < 120; t += 0.1) {
      h.sight(1, 1);
      h.step(0.1, true);
    }
    expect(h.level).toBe(1);
    h.step(LAW_RULES.seenGraceS + 0.1, false);
    expect(h.phase).toBe('lost');
    h.step(LAW_RULES.cooldownS[1] - 1, false);
    expect(h.level).toBe(1);
    h.step(2, false);
    expect(h.level).toBe(0);
  });

  it('shows how far it has cooled', () => {
    const { h } = make();
    expect(h.cooldownFrac).toBe(0);
    h.report(1, 2, 0, 0);
    h.step(LAW_RULES.reportedHoldS, false);
    expect(h.cooldownFrac).toBe(0);
    h.step(LAW_RULES.cooldownS[1] / 2, false);
    expect(h.cooldownFrac).toBeCloseTo(0.5, 2);
  });
});

/** The player at (100, 100) facing +Z, a victim 1.2 m ahead, and a helper to punch. */
async function assaultScene(extra: (sim: Simulation) => void = () => {}, tile = flatTile(), rules: (sim: Simulation) => void = everyoneCalls) {
  const sim = await makeSim(tile);
  rules(sim);
  const p = ped(sim);
  p.controller.teleport(100, 0, 100, 0);
  const victim = addNpc(sim, 100, 101.2);
  extra(sim);
  run(sim, 30, cmd());
  sim.drainEvents();
  const events = runLog(sim, 3, () => cmd({ buttons: Button.Melee }));
  return { sim, p, victim, events };
}

describe('crimes and witnesses', () => {
  it('punching someone is an assault, and a witness in sight calls it in after a few seconds', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim, events, victim } = await assaultScene((s) => {
      bystander = addNpc(s, 112, 100);
    });
    const all = [...events, ...runLog(sim, 30)];
    const crimes = ofType(all, 'crime');
    expect(crimes).toHaveLength(1);
    expect(crimes[0]).toMatchObject({ crime: 'assault', severity: 2, heat: 1, victimId: victim.id, perpetratorId: ped(sim).id });
    expect(crimes[0].witnesses).toBe(1); // the bystander; the victim is on the ground
    expect(crimes[0].description.clothes).toBe(0);
    expect(sim.law.heat.level).toBe(0); // nobody has called yet
    // the bystander is calling: the phone is out and the snapshot says so (they do not run)
    expect(bystander.brain!.state).toBe('idle');
    expect(bystander.dial).toBeGreaterThanOrEqual(0);
    const t0 = sim.tick;
    const later = runLog(sim, 60 * 10);
    const rep = ofType(later, 'crime:reported');
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ crime: 'assault', reporterId: bystander.id, police: false });
    const heat = ofType(later, 'heat:change');
    expect(heat[0]).toMatchObject({ level: 1, prevLevel: 0, phase: 'reported' });
    expect(heat[0].lastKnown!.x).toBeCloseTo(100, 2);
    expect(heat[0].lastKnown!.z).toBeCloseTo(101.2, 1);
    expect(sim.law.heat.level).toBe(1);
    expect(bystander.dial).toBe(-1); // the call is over
    void t0;
  });

  it('not everyone calls: a witness who declines just runs, and is not asked again straight away', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim, events } = await assaultScene(
      (s) => {
        bystander = addNpc(s, 112, 100);
      },
      flatTile(),
      (s) => {
        s.law.rules.callChance = 0;
      },
    );
    const all = [...events, ...runLog(sim, 60 * 25)];
    expect(ofType(all, 'crime')[0].witnesses).toBe(1);
    expect(bystander.brain!.state === 'flee' || bystander.brain!.state === 'calm').toBe(true);
    expect(sim.law.pending).toHaveLength(0);
    expect(ofType(all, 'crime:reported')).toHaveLength(0);
    expect(sim.law.heat.level).toBe(0);
  });

  it('about 50 to 70 percent of witnesses call (the chance is in crimes.json)', async () => {
    // 40 bystanders in the open watch the same assault; the shares are the table's, give or take chance.
    const { sim } = await assaultScene((s) => {
      for (let i = 0; i < 40; i++) addNpc(s, 100 + 6 + (i % 8) * 2.2, 100 - 10 + Math.floor(i / 8) * 4);
    }, flatTile(), () => {});
    run(sim, 20, cmd());
    const calling = sim.law.pending.length;
    expect(calling).toBeGreaterThanOrEqual(40 * 0.4);
    expect(calling).toBeLessThanOrEqual(40 * 0.8);
  });

  it('a caller who loses sight of the culprit hangs up, and one who runs far off does too', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim, events } = await assaultScene((s) => {
      bystander = addNpc(s, 112, 100);
    });
    const all = [...events, ...runLog(sim, 20)];
    expect(sim.law.pending).toHaveLength(1);
    expect(bystander.dial).toBeGreaterThanOrEqual(0);
    // Away from the scene beyond the run-away distance: the call is dropped.
    bystander.controller.teleport(100 + sim.law.rules.giveUp.runAwayM + 10, 0, 100, 0);
    const rest = [...all, ...runLog(sim, 60 * 3)];
    const gave = ofType(rest, 'witness:gave-up');
    expect(gave).toHaveLength(1);
    expect(gave[0]).toMatchObject({ pedId: bystander.id, reason: 'ran-off' });
    expect(sim.law.pending).toHaveLength(0);
    expect(bystander.dial).toBe(-1);
    expect(ofType(runLog(sim, 60 * 20), 'crime:reported')).toHaveLength(0);
  });

  it('a caller who loses sight of the culprit for a few seconds hangs up', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim, events } = await assaultScene(
      (s) => {
        bystander = addNpc(s, 112, 100);
      },
      flatTile(),
      (s) => {
        everyoneCalls(s);
        s.law.rules.callDelayS = [15, 15];
      },
    );
    const all = [...events, ...runLog(sim, 20)];
    expect(sim.law.pending).toHaveLength(1);
    // The culprit leaves the caller's range (a car, a sprint): after lostSightS without a clear line the call is dropped.
    ped(sim).controller.teleport(100, 0, 100 - sim.law.rules.giveUp.sightRangeM - 40, 0);
    const rest = [...all, ...runLog(sim, 60 * 8)];
    const gave = ofType(rest, 'witness:gave-up');
    expect(gave).toHaveLength(1);
    expect(gave[0]).toMatchObject({ pedId: bystander.id, reason: 'lost-sight' });
    expect(ofType(rest, 'crime:reported')).toHaveLength(0);
    expect(sim.law.heat.level).toBe(0);
  });

  it('several calls about one crime raise heat once: the first counts, the rest are duplicates', async () => {
    const { sim, events } = await assaultScene((s) => {
      for (let i = 0; i < 4; i++) addNpc(s, 108 + i * 1.5, 100);
    });
    const all = [...events, ...runLog(sim, 60 * 25)];
    const reports = ofType(all, 'crime:reported');
    expect(reports).toHaveLength(4);
    expect(reports.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(sim.law.heat.level).toBe(1);
    // One assault is two points, not eight.
    expect(sim.law.heat.points).toBe(CRIMES.assault.points);
  });

  it('the delay is 8 to 20 s, seeded: the same run gives the same call tick', async () => {
    const callTick = async () => {
      const { sim } = await assaultScene((s) => addNpc(s, 112, 100), flatTile(), (s) => {
        everyoneCalls(s);
        s.law.rules.callDelayS = LAW_RULES.callDelayS;
      });
      const ev = runLog(sim, 60 * 10);
      const idx = ev.findIndex((e) => e.type === 'crime:reported');
      return { idx, tick: (ev[idx] as { tick: number }).tick };
    };
    const a = await callTick();
    const b = await callTick();
    expect(a).toEqual(b);
    expect(a.tick).toBeGreaterThanOrEqual(8 * 60);
    expect(a.tick).toBeLessThanOrEqual(20 * 60 + 40);
  });

  it('a lone victim who is knocked down cannot call: no witnesses, no heat', async () => {
    const { sim, events } = await assaultScene();
    const all = [...events, ...runLog(sim, 60 * 12)];
    expect(ofType(all, 'crime')[0].witnesses).toBe(0);
    expect(ofType(all, 'crime:reported')).toHaveLength(0);
    expect(sim.law.heat.level).toBe(0);
  });

  it('a witness who is knocked down before the call is silenced: the call never happens', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim, events } = await assaultScene((s) => {
      bystander = addNpc(s, 102.5, 100);
    });
    const all = [...events, ...runLog(sim, 20)];
    expect(ofType(all, 'crime')[0].witnesses).toBe(1);
    expect(sim.law.pending).toHaveLength(1);
    knockDown(sim, bystander, 3);
    const rest = runLog(sim, 60 * 12);
    const silenced = ofType(rest, 'witness:silenced');
    expect(silenced).toHaveLength(1);
    expect(silenced[0]).toMatchObject({ pedId: bystander.id, crime: 'assault' });
    expect(ofType(rest, 'crime:reported')).toHaveLength(0);
    expect(sim.law.heat.level).toBe(0);
  });

  it('killing a witness before the call silences them too', async () => {
    let bystander!: ReturnType<typeof addNpc>;
    const { sim } = await assaultScene((s) => {
      bystander = addNpc(s, 105, 100);
    });
    run(sim, 20, cmd());
    damagePed(sim, bystander, 500, 'melee', ped(sim).id);
    const ev = runLog(sim, 60 * 12);
    expect(ofType(ev, 'crime:reported')).toHaveLength(0);
    // the kill is a second crime, with no witnesses left
    expect(sim.law.heat.level).toBe(0);
    expect(ofType(ev, 'witness:silenced').length).toBeGreaterThanOrEqual(1);
  });

  it('only counts witnesses inside the radius and in line of sight', async () => {
    // A 3 m thick, 10 m tall wall along z = 150, between the scene at z = 140 and a witness at z = 160.
    const mesh = propsToMesh([{ kind: 'box', x: 100, y: 0, z: 150, sx: 60, sy: 10, sz: 3, yaw: 0, color: [0.5, 0.5, 0.5] }]);
    const base = flatTile();
    const tile = {
      ...base,
      collisionPositions: new Float32Array(mesh.positions),
      collisionIndices: new Uint32Array(mesh.indices),
      manifest: { ...base.manifest, collision: { file: 'collision.bin', vertexCount: mesh.positions.length / 3, indexCount: mesh.indices.length } },
    };
    const sim = everyoneCalls(await makeSim(tile));
    ped(sim).controller.teleport(100, 0, 140, 0);
    addNpc(sim, 100, 141.2);
    const behindWall = addNpc(sim, 100, 158);
    const clear = addNpc(sim, 85, 140);
    const tooFar = addNpc(sim, 100 + CRIMES.assault.witnessRadius + 10, 140);
    run(sim, 30, cmd());
    sim.drainEvents();
    const ev = runLog(sim, 40, (() => {
      let n = 0;
      return () => cmd({ buttons: n++ < 3 ? Button.Melee : 0 });
    })());
    expect(ofType(ev, 'crime')).toHaveLength(1);
    expect(ofType(ev, 'crime')[0].witnesses).toBe(1);
    const pending = sim.law.pending.map((c) => c.witnessId);
    expect(pending).toEqual([clear.id]);
    expect(behindWall.brain!.state).toBe('idle');
    expect(tooFar.brain!.state).toBe('idle');
  });

  it('repeated punches on the same victim are one crime inside the dedupe window', async () => {
    let victimPos = { x: 100, z: 101.2 };
    const { sim, events, victim } = await assaultScene((s) => addNpc(s, 112, 100));
    const ev = [...events];
    for (let i = 0; i < 3; i++) {
      run(sim, 40, cmd());
      victimPos = { x: victim.controller.x, z: victim.controller.z };
      ped(sim).controller.teleport(victimPos.x, 0, victimPos.z - 1.2, 0);
      run(sim, 3, cmd());
      ev.push(...runLog(sim, 4, () => cmd({ buttons: Button.Melee })), ...runLog(sim, 20));
    }
    expect(ofType(ev, 'damage').length).toBeGreaterThanOrEqual(3);
    expect(ofType(ev, 'crime')).toHaveLength(1);
  });

  it('killing someone is a kill_ped: two stars, and three only for sustained violence', async () => {
    const { sim } = await assaultScene((s) => addNpc(s, 112, 100));
    const victim = [...sim.peds()].find((p) => p.controller.z > 101 && p.controller.z < 105)!;
    const ev0 = runLog(sim, 30);
    damagePed(sim, victim, 500, 'melee', ped(sim).id);
    const ev = [...ev0, ...runLog(sim, 60 * 22)];
    const crime = ofType(ev, 'crime').find((c) => c.crime === 'kill_ped')!;
    expect(crime).toBeTruthy();
    expect(crime.heat).toBe(2);
    expect(sim.law.heat.level).toBe(2);
    expect(sim.law.heat.severity).toBe(4);
    // The assault (2) and the kill (4) are six violent points, short of the seven that make heat 3.
    expect(sim.law.heat.violence).toBe(CRIMES.assault.points + CRIMES.kill_ped.points);
    expect(sim.law.heat.violence).toBeLessThan(LAW_RULES.escalation.heat3ViolencePoints);
  });

  it('a second kill is sustained violence: heat 3', async () => {
    const { sim } = await assaultScene((s) => {
      addNpc(s, 112, 100);
      addNpc(s, 112, 104);
    });
    const [a, b] = [...sim.peds()].filter((p) => p.role !== 'player' && p.life === 'alive');
    runLog(sim, 30);
    damagePed(sim, a, 500, 'melee', ped(sim).id);
    runLog(sim, 60 * 7);
    damagePed(sim, b, 500, 'melee', ped(sim).id);
    runLog(sim, 60 * 22);
    expect(sim.law.heat.level).toBe(3);
  });

  it('entering an unowned car is a theft only if someone sees it', async () => {
    const lone = everyoneCalls(await makeSim());
    ped(lone).controller.teleport(vehicle(lone).car.pose().x - 2.5, 0, vehicle(lone).car.pose().z);
    run(lone, 20, cmd());
    const ev1 = runLog(lone, 6, () => cmd({ buttons: Button.Interact }));
    expect(ped(lone).vehicleId).toBe(vehicle(lone).id);
    expect(ofType(ev1, 'crime')).toHaveLength(0);

    const seen = everyoneCalls(await makeSim());
    const car = vehicle(seen).car.pose();
    ped(seen).controller.teleport(car.x - 2.5, 0, car.z);
    addNpc(seen, car.x - 10, car.z + 6);
    run(seen, 20, cmd());
    const ev2 = runLog(seen, 6, () => cmd({ buttons: Button.Interact }));
    const crimes = ofType(ev2, 'crime');
    expect(crimes).toHaveLength(1);
    expect(crimes[0]).toMatchObject({ crime: 'vehicle_theft', heat: 1, vehicleId: vehicle(seen).id });
    expect(crimes[0].description.vehicle?.plate).toMatch(/^[A-Z]{3}\d{4}$/);
    expect(crimes[0].description.vehicle?.typeId).toBe('sedan');
    // Getting back in later is not a second theft.
    run(seen, 4, cmd());
    runLog(seen, 6, () => cmd({ buttons: Button.Interact }));
    run(seen, 4, cmd());
    const ev3 = runLog(seen, 6, () => cmd({ buttons: Button.Interact }));
    expect(ofType(ev3, 'crime')).toHaveLength(0);
  });
});

describe('a carjacking is a crime', () => {
  it('records the crime with the car and plate, the victim calls it in, and the heat appears', async () => {
    const sim = everyoneCalls(await Simulation.create({ seed: 1, tile: generateProceduralTile(1), driverMood: 'flee', parkedCars: 0 }));
    const hero = vehicle(sim);
    const g = await import('../src/shared/doors');
    const { rotateVec } = await import('../src/shared/math');
    const pose = hero.car.pose();
    const door = g.doorGeometry(hero.car.h);
    const w = rotateVec(pose.q, door.stand.x, 0, door.stand.z);
    ped(sim).controller.teleport(pose.x + w.x, pose.y - 0.3, pose.z + w.z);
    run(sim, 30, cmd());
    sim.drainEvents();
    const ev = runLog(sim, 6, () => cmd({ buttons: Button.Interact }));
    const crime = ofType(ev, 'carjack');
    expect(crime).toHaveLength(1);
    const all = [...ev, ...runLog(sim, 60 * 12)];
    const c = ofType(all, 'crime')[0];
    expect(c).toMatchObject({ crime: 'carjack', severity: 2, heat: 1, vehicleId: hero.id, victimId: crime[0].victimId, witnesses: 1 });
    expect(c.description.vehicle).toMatchObject({ id: hero.id, typeId: 'sedan', plate: hero.plate });
    expect(c.description.clothes).toBe(0);
    const rep = ofType(all, 'crime:reported');
    expect(rep).toHaveLength(1);
    expect(rep[0].reporterId).toBe(crime[0].victimId);
    expect(sim.law.heat).toMatchObject({ level: 1, phase: 'reported' });
    expect(sim.law.description.vehicle?.plate).toBe(hero.plate);
    // not a theft too: the car was taken, not entered
    expect(ofType(all, 'crime').filter((x) => x.crime === 'vehicle_theft')).toHaveLength(0);
  });
});

describe('running people over', () => {
  async function runOver(speed: number, withWitness: boolean) {
    const { driverSim } = await import('./helpers');
    const { sim, car } = await driverSim('sedan', generateProceduralTile(1), { x: -40, z: 800 });
    everyoneCalls(sim);
    car.teleport(-40, 0.4, 800, 0);
    run(sim, 20, cmd());
    const victim = addNpc(sim, -40, 808);
    if (withWitness) addNpc(sim, -25, 790);
    car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
    sim.drainEvents();
    const ev = runLog(sim, 60 * 11, () => cmd());
    return { sim, ev, victim };
  }

  it('a witnessed hit is a hit_ped: heat 2', async () => {
    const r = await runOver(9, true);
    const crimes = ofType(r.ev, 'crime');
    expect(crimes.map((c) => c.crime)).toEqual(['hit_ped']);
    expect(crimes[0]).toMatchObject({ severity: 3, heat: 2, victimId: r.victim.id });
    expect(crimes[0].description.vehicle?.typeId).toBe('sedan');
    expect(r.sim.law.heat.level).toBe(2);
    expect(r.sim.law.heat.severity).toBe(3);
  });

  it('a hit nobody else sees is not reported: the victim is on the ground', async () => {
    const r = await runOver(9, false);
    expect(ofType(r.ev, 'crime')).toHaveLength(1);
    expect(r.sim.law.heat.level).toBe(0);
  });

  it('killing with the car is a kill_ped', async () => {
    const r = await runOver(18, true);
    expect(ofType(r.ev, 'crime').map((c) => c.crime)).toEqual(['kill_ped']);
    expect(r.sim.law.heat.level).toBe(2);
  });
});

void vehicle;

describe('escalation is earned', () => {
  const make = () => new HeatModel(LAW_RULES);
  const rep = (h: HeatModel, id: keyof typeof CRIMES) => h.report(CRIMES[id].heat, CRIMES[id].severity, 0, 0, false, { points: CRIMES[id].points, violent: CRIMES[id].violent });

  it('a minor crime stays at one star, however many times it is reported', () => {
    const h = make();
    rep(h, 'vehicle_theft');
    rep(h, 'discharge');
    expect(h.level).toBe(1);
    h.step(100, false); // time alone never raises it
    expect(h.level === 1 || h.level === 0).toBe(true);
  });

  it('repeated crimes reach two stars (points), a severity 3 crime does at once', () => {
    const h = make();
    rep(h, 'carjack');
    expect(h.level).toBe(1);
    rep(h, 'assault');
    expect(h.level).toBe(1); // 4 points
    rep(h, 'vehicle_theft');
    expect(h.level).toBe(2); // 5
    const hit = make();
    rep(hit, 'hit_ped');
    expect(hit.level).toBe(2);
  });

  it('three stars need killing, an attack on police or sustained violence, never minor crimes alone', () => {
    const minor = make();
    for (let i = 0; i < 12; i++) rep(minor, i % 2 ? 'carjack' : 'discharge');
    expect(minor.level).toBe(2); // plenty of points, no violence
    const killer = make();
    rep(killer, 'kill_ped');
    expect(killer.level).toBe(2);
    rep(killer, 'hit_ped'); // 4 + 3 violent points
    expect(killer.level).toBe(3);
    const cop = make();
    rep(cop, 'assault_officer');
    expect(cop.level).toBe(3);
  });

  it('hollow stars hold while the police are still coming, and only then begin to cool', () => {
    const h = make();
    rep(h, 'carjack');
    h.step(LAW_RULES.reportedHoldS - 1, false);
    expect(h.cooldownFrac).toBe(0);
    h.step(1.5, false);
    h.step(LAW_RULES.cooldownS[1] / 2, false);
    expect(h.cooldownFrac).toBeGreaterThan(0.3);
    // Once seen and lost, there is no hold: it cools from the moment they lose you.
    const s = make();
    rep(s, 'carjack');
    s.sight(0, 0);
    s.step(LAW_RULES.seenGraceS + 0.1, false);
    expect(s.phase).toBe('lost');
    s.step(LAW_RULES.cooldownS[1] + 0.2, false);
    expect(s.level).toBe(0);
  });
});
