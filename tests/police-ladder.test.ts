import { describe, expect, it } from 'vitest';
import { agencyAt, dispatchFor } from '../src/shared/law';
import { LAW_RULES } from '../src/shared/law';
import { POLICE_RULES, atHeat, heliFootprint, officerCone } from '../src/shared/policeRules';
import { E, H, HeliFlag, PoliceRole, SnapshotView, VehicleFlag } from '../src/shared/snapshot';
import { EntityKind } from '../src/shared/entities';
import { agenciesWanting, ordersAt } from '../src/sim/police/dispatch';
import { PoliceNav, polyline, pointAlong } from '../src/sim/police/nav';
import { RoadGraph } from '../src/sim/police/roadGraph';
import { assignRoles, interceptAlong, type RoleCandidate } from '../src/sim/police/tactics';
import { HeatModel } from '../src/sim/law/heat';
import { ped, run, cmd, vehicle } from './helpers';
import { atlanta, chase, highwayTile, ofKind, onlyAgency, agency } from './policeHelpers';
import { gridRoads } from './helpers';
import { crossroads, lanesFor, laneTile, road } from './trafficHelpers';
import { LaneGraph } from '../src/sim/traffic/LaneGraph';
import { Simulation } from '../src/sim/Simulation';

// -------------------------------------------------------------------------------------------------
// The dispatch ladder

describe('the dispatch ladder, from jurisdictions.json', () => {
  const row = (id: string, heat: number) => dispatchFor(atlanta, id, heat);

  it('gives each agency the table row for its heat level, inheriting the nearest lower one', () => {
    expect(row('acp', 1)).toMatchObject({ maxUnits: 1, spawnIntervalS: 25, unitsPerSpawn: 1, loadout: 'pistol' });
    expect(row('acp', 3)).toMatchObject({ maxUnits: 2, spawnIntervalS: 15, loadout: 'shotgun' });
    expect(row('acp', 6)).toMatchObject({ maxUnits: 3, spawnIntervalS: 10, loadout: 'rifle' });
    expect(row('ghp', 1)).toMatchObject({ maxUnits: 2, spawnIntervalS: 15, loadout: 'pistol' });
    expect(row('ghp', 3)).toMatchObject({ maxUnits: 4, spawnIntervalS: 8, unitsPerSpawn: 2, loadout: 'shotgun' });
    expect(row('ghp', 5)).toMatchObject({ maxUnits: 4, spawnIntervalS: 6, loadout: 'rifle' });
    expect(row('tap', 2)).toMatchObject({ maxUnits: 1, spawnIntervalS: 40 }); // no row for 2: heat 1's
    expect(row('gtf', 3)).toBe(null);
    expect(row('gtf', 4)).toMatchObject({ maxUnits: 2, spawnIntervalS: 30, loadout: 'rifle' });
    expect(row('fed', 4)).toBe(null);
    expect(row('fed', 5)).toMatchObject({ maxUnits: 1, spawnIntervalS: 45 });
    expect(row('guard', 5)).toBe(null);
    expect(row('guard', 6)).toMatchObject({ maxUnits: 1, spawnIntervalS: 60 });
  });

  it('adds the task force at heat 4, the feds at 5 and the Guard at 6, wherever the chase is', () => {
    const roads = gridRoads();
    const state = { nextAt: new Map<string, number>(), counts: new Map<string, number>() };
    const at = (heat: number) => ordersAt(atlanta, roads, 200, 200, agenciesWanting(atlanta, heat, state, 0)).map((o) => o.agency.id).sort();
    expect(at(1)).toEqual(['acp']);
    expect(at(3)).toEqual(['acp']);
    expect(at(4)).toEqual(['acp', 'gtf']);
    expect(at(5)).toEqual(['acp', 'fed', 'gtf']);
    expect(at(6)).toEqual(['acp', 'fed', 'gtf', 'guard']);
  });

  it('gives the freeway to the Highway Patrol and the streets to the city police', () => {
    const roads = highwayTile().roads!;
    const state = { nextAt: new Map<string, number>(), counts: new Map<string, number>() };
    const w = agenciesWanting(atlanta, 3, state, 0);
    expect(ordersAt(atlanta, roads, 100, 2, w).map((o) => o.agency.id)).toEqual(['ghp']);
    expect(ordersAt(atlanta, roads, 100, 300, w).map((o) => o.agency.id)).toEqual(['acp']);
  });

  it('on a freeway the cars that come are the Highway Patrol\'s, in its green; on the streets, the city\'s', async () => {
    const onHwy = await chase({ tile: highwayTile(), z: 0, heat: 2, severity: 3, speed: 15 });
    onHwy.drive(60 * 12, 15);
    const spawned = ofKind(onHwy.events, 'police:spawn');
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    expect(spawned.every((s) => s.agency === 'ghp')).toBe(true);
    const def = ofKind(onHwy.events, 'entity:spawn').find((e) => e.def.kind === EntityKind.Vehicle && (e.def as { police?: unknown }).police);
    expect((def!.def as { police: { body: number } }).police.body).toBe(0x1f4d3a);

    const onStreet = await chase({ heat: 2, severity: 3, speed: 15 });
    onStreet.drive(60 * 12, 15);
    const s2 = ofKind(onStreet.events, 'police:spawn');
    expect(s2.length).toBeGreaterThanOrEqual(1);
    expect(s2.every((s) => s.agency === 'acp')).toBe(true);
  });

  it('heat 5 on the streets sends the city police, the task force (unmarked) and the feds, within the table\'s unit counts', async () => {
    const c = await chase({ heat: 5, severity: 5, speed: 0, x: 0, z: 3.5 });
    // Parked at the crossing of two streets, invulnerable: let the ladder fill.
    c.coast(60 * 100, 0);
    const by = new Map<string, number>();
    for (const u of c.sim.police.units) if (!u.block && u.mode !== 'leave' && u.officerIds.some((id) => ['alive', 'downed'].includes((c.sim.registry.get(id) as ReturnType<typeof ped> | undefined)?.life ?? 'gone'))) by.set(u.agency.id, (by.get(u.agency.id) ?? 0) + 1);
    expect(by.get('acp')).toBe(row('acp', 5)!.maxUnits);
    expect(by.get('gtf')).toBe(row('gtf', 5)!.maxUnits);
    expect(by.get('fed')).toBe(row('fed', 5)!.maxUnits);
    expect(by.get('guard')).toBeUndefined();
    expect(by.get('ghp')).toBeUndefined();
    // Only the city's own cars wear its livery; the unmarked ones have the task force's body colour and no stripe.
    const gtf = c.sim.police.units.find((u) => u.agency.id === 'gtf')!;
    const veh = c.sim.registry.get(gtf.vehicleId) as ReturnType<typeof vehicle>;
    expect(veh.police!.unmarked).toBe(true);
    expect(veh.police!.stripe).toBe(veh.police!.body);
  });
});

describe('unmarked cars', () => {
  it('switch the lightbar and siren on only when chasing', async () => {
    const law = onlyAgency(atlanta, 'gtf', {}, 1);
    const c = await chase({ law, heat: 4, severity: 4, x: -300, speed: 18 });
    // The task force starts with no eyes on the target: lights off while it drives to the scene.
    const gtf = agency(law, 'gtf');
    expect(gtf.unmarked).toBe(true);
    const unit = c.sim.police.deployUnit(gtf, -520, 3.5, Math.PI / 2, 'rifle');
    const veh = c.sim.registry.get(unit.vehicleId) as ReturnType<typeof vehicle>;
    c.drive(30, 18);
    expect(veh.lightbar).toBe(false);
    expect(veh.siren).toBe(false);
    // (then it comes up behind the target, close enough to see it)
    veh.car.teleport(-340, 0.4, 3.5, Math.PI / 2);
    veh.car.body.setLinvel({ x: 24, y: 0, z: 0 }, true);
    veh.car.adopt();
    // When it has the target in sight and is after it, the strobes come on.
    let lit = false;
    c.drive(60 * 14, 18, () => {
      if (veh.lightbar && veh.siren && unit.role !== 'responder') lit = true;
    });
    expect(lit).toBe(true);
    const v = new SnapshotView();
    c.sim.writeSnapshot(v);
    const flags = v.u32[v.at(v.indexOf(veh.id)) + E.Flags];
    expect(flags & VehicleFlag.Police).toBeTruthy();
    expect(Boolean(flags & VehicleFlag.Lightbar)).toBe(veh.lightbar);
  });

  it('a marked car has its lights on from the first call', async () => {
    const c = await chase({ law: onlyAgency(atlanta, 'acp'), heat: 1, severity: 2, speed: 5 });
    const unit = c.sim.police.deployUnit(agency(atlanta, 'acp'), -460, 3.5, Math.PI / 2);
    c.drive(10, 5);
    expect((c.sim.registry.get(unit.vehicleId) as ReturnType<typeof vehicle>).lightbar).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// Roles and intercepts

describe('pursuit roles', () => {
  const rules = POLICE_RULES.roles;
  const cand = (id: number, dist: number, ahead: number, role: RoleCandidate['role'] = 'responder', heldFor = 99): RoleCandidate => ({ id, dist, ahead, role, heldFor, engaged: true });

  it('the closest car behind the target chases, the one ahead blocks, the rest come at it from the side', () => {
    const out = assignRoles([cand(1, 30, -30), cand(2, 120, 100), cand(3, 90, -80), cand(4, 160, -150)], rules);
    expect(out.get(1)).toBe('chaser');
    expect(out.get(2)).toBe('blocker');
    expect([...out.values()].filter((r) => r === 'chaser').length).toBeLessThanOrEqual(rules.maxChasers);
    expect([...out.values()]).toContain('flanker');
    expect(new Set(out.values()).size).toBeGreaterThanOrEqual(3);
  });

  it('a lone car chases; cars that may not chase are only responders', () => {
    expect([...assignRoles([cand(1, 80, -80)], rules).values()]).toEqual(['chaser']);
    const out = assignRoles([{ ...cand(1, 80, -80), engaged: false }, cand(2, 90, -90)], rules);
    expect(out.get(1)).toBe('responder');
    expect(out.get(2)).toBe('chaser');
  });

  it('keeps a role for a few seconds so the cars do not swap places', () => {
    const first = assignRoles([cand(1, 40, -40), cand(2, 100, -100)], rules);
    expect(first.get(1)).toBe('chaser');
    expect(first.get(2)).toBe('flanker'); // two cars: one chases, the other comes down a side street
    const out = assignRoles([cand(1, 120, -120, 'chaser', 1), cand(2, 30, -30, 'chaser', 1), cand(3, 70, -70, 'responder')], rules);
    expect(out.get(1)).toBe('chaser');
    expect(out.get(2)).toBe('chaser');
    expect(out.get(3)).not.toBe('chaser'); // the chaser slots are taken
  });

  it('in a real chase every kind of role turns up once there are cars for it', async () => {
    const c = await chase({ heat: 4, severity: 4, speed: 18 });
    const roles = new Set<string>();
    c.drive(60 * 40, 18, (t) => {
      if (t % 30 === 0) for (const u of c.sim.police.units) if (!u.block) roles.add(u.role);
    });
    expect(roles.has('chaser')).toBe(true);
    expect(roles.has('blocker') || roles.has('flanker')).toBe(true);
    expect(ofKind(c.events, 'police:role').length).toBeGreaterThan(3);
  });
});

describe('intercept prediction', () => {
  const straight = polyline(Array.from({ length: 100 }, (_, i) => ({ x: i * 5, z: 0 })));

  it('finds the first point on the route the unit reaches before the target, with time to spare', () => {
    // Target at the origin doing 20 m/s; a unit at (200, 60) that drives 15 m/s over a 1.3x detour.
    const eta = (p: { x: number; z: number }) => (Math.hypot(p.x - 200, p.z - 60) * 1.3) / 15;
    const hit = interceptAlong(straight, { playerSpeed: 20, margin: 4, eta })!;
    expect(hit).toBeTruthy();
    expect(hit.tUnit + 4).toBeLessThanOrEqual(hit.tPlayer);
    // It is the first such point: a step nearer would not do.
    expect(eta(pointAlong(straight, hit.s - 10)) + 4).toBeGreaterThan((hit.s - 10) / 20);
    expect(hit.point.x).toBeCloseTo(hit.s, 5);
    // Further margin means further along.
    const safer = interceptAlong(straight, { playerSpeed: 20, margin: 5, eta })!;
    expect(safer.s).toBeGreaterThan(hit.s);
  });

  it('is null when the unit cannot get ahead, and slower targets are caught nearer', () => {
    const far = (p: { x: number; z: number }) => (Math.hypot(p.x + 900, p.z) * 1.3) / 12;
    expect(interceptAlong(straight, { playerSpeed: 25, margin: 2, eta: far })).toBe(null);
    const eta = (p: { x: number; z: number }) => Math.hypot(p.x - 150, p.z - 40) / 14;
    const fast = interceptAlong(straight, { playerSpeed: 30, margin: 1, eta })!;
    const slow = interceptAlong(straight, { playerSpeed: 10, margin: 1, eta })!;
    expect(slow.s).toBeLessThan(fast.s);
  });

  it('predicts the lane a car is in, straight on through a junction, and the way it is turning', () => {
    const { roads, junctions } = crossroads('none', 300);
    const lanes = lanesFor(roads, junctions);
    const g = new LaneGraph(lanes);
    const nav = new PoliceNav(new RoadGraph([]), () => g);
    // Driving east on the eastbound lane (x < 0, the lane lies right of the centre line: z > 0).
    const straightOn = nav.predict(-150, 1.8, Math.PI / 2, 0, 250);
    expect(straightOn[straightOn.length - 1].x).toBeGreaterThan(80);
    expect(Math.abs(straightOn[straightOn.length - 1].z - 1.8)).toBeLessThan(2);
    // Turning right (negative yaw rate, which is toward +z for a car heading east): the route goes south... into the north-south street.
    const right = nav.predict(-150, 1.8, Math.PI / 2, -0.4, 250);
    const end = right[right.length - 1];
    expect(Math.abs(end.x)).toBeLessThan(40);
    expect(Math.abs(end.z)).toBeGreaterThan(60);
    // Turning left goes the other way.
    const left = nav.predict(-150, 1.8, Math.PI / 2, 0.4, 250);
    expect(Math.sign(left[left.length - 1].z)).toBe(-Math.sign(end.z));
  });

  it('follows the road centreline where there are no lanes (the freeways)', () => {
    const nav = new PoliceNav(new RoadGraph(highwayTile().roads!), () => null);
    const p = nav.predict(-200, 0, Math.PI / 2, 0, 300);
    expect(p[p.length - 1].x).toBeGreaterThan(90);
    expect(Math.abs(p[p.length - 1].z)).toBeLessThan(2);
    // against the one-way: it does not predict a path the wrong way along the motorway
    const wrong = nav.predict(-200, 0, -Math.PI / 2, 0, 300);
    expect(wrong.length).toBeLessThan(3);
  });
});

void [laneTile, road, Simulation, ped, run, cmd, H, HeliFlag, PoliceRole, LAW_RULES, atHeat, heliFootprint, officerCone, agencyAt, HeatModel];
