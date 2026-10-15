import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOADOUTS, WEAPONS, WEAPON_ORDER, falloffMult, lockOnFor, parseWeapons, spreadDeg } from '../src/shared/weapons';
import { PB, PedFlag, SnapshotView, E, gunMag, gunReserve, gunWeapon } from '../src/shared/snapshot';
import { Axis } from '../src/shared/protocol';
import { AIM, aimCameraPosition, viewDirection } from '../src/shared/aim';
import { solvePlayerAim } from '../src/sim/combat/weapons/WeaponSystem';
import { assistDirection, pickLockTarget } from '../src/sim/combat/weapons/lockOn';
import { scatter } from '../src/sim/combat/weapons/ballistics';
import { Rng } from '../src/shared/rng';
import {
  ammoStatus, cycleWeapon, fireWeapon, giveLoadout, giveWeapon, pullTrigger, selectWeapon, shootAt, startReload, muzzleOf,
} from '../src/sim/combat/weapons/api';
import { boxTile } from './weaponHelpers';
import { addNpc, Button, cmd, makeSim, ofType, ped, run, runLog } from './helpers';

const east = { x: 0, y: 0, z: 1 };

/** Puts the player at (x, z) facing +Z with a pistol, and returns the muzzle-height origin used for raw shots. */
async function range(boxes: Parameters<typeof boxTile>[0] = []) {
  const sim = await makeSim(boxTile(boxes));
  // The starting car is out of the way.
  (sim.registry.get(sim.vehicleId) as import('../src/sim/entities').VehicleEntity).car.teleport(400, 0.5, 400, 0);
  const p = ped(sim);
  p.controller.teleport(0, 0, 0, 0);
  run(sim, 5, cmd());
  return { sim, p };
}
const chest = (z: number) => ({ origin: { x: 0, y: 1.3, z }, dir: east });

describe('the weapon table', () => {
  it('has the four weapons in slot order and the police loadouts resolve', () => {
    expect(WEAPON_ORDER).toEqual(['pistol', 'smg', 'shotgun', 'rifle']);
    for (const w of WEAPON_ORDER) {
      const d = WEAPONS[w];
      expect(d.damage).toBeGreaterThan(0);
      expect(d.spread.hip).toBeGreaterThanOrEqual(d.spread.aimed);
      expect(d.magazine).toBeGreaterThan(0);
      expect(d.reloadS).toBeGreaterThan(0);
      expect(d.index).toBe(WEAPON_ORDER.indexOf(w) + 1);
    }
    expect(WEAPONS.shotgun.pellets).toBeGreaterThan(1);
    expect(WEAPONS.pistol.driveBy && WEAPONS.smg.driveBy).toBe(true);
    expect(WEAPONS.shotgun.driveBy || WEAPONS.rifle.driveBy).toBe(false);
    const pack = JSON.parse(readFileSync('data/cities/atlanta/jurisdictions.json', 'utf8')) as { dispatch: Record<string, { loadout: string }[]> };
    for (const rows of Object.values(pack.dispatch)) for (const r of rows) expect(LOADOUTS[r.loadout], r.loadout).toBeDefined();
    expect(LOADOUTS.rifle).toContain('rifle');
  });

  it('rejects a broken table', () => {
    expect(() => parseWeapons({})).toThrow();
    const raw = JSON.parse(readFileSync('src/shared/data/weapons.json', 'utf8'));
    raw.weapons.pistol.spread = { hip: 0.1, aimed: 1 };
    expect(() => parseWeapons(raw)).toThrow(/spread/);
  });

  it('falls off with distance and widens with bloom', () => {
    const s = WEAPONS.shotgun;
    expect(falloffMult(s, 3)).toBe(1);
    expect(falloffMult(s, 100)).toBe(s.falloff.minMult);
    expect(falloffMult(s, 16)).toBeLessThan(falloffMult(s, 10));
    expect(falloffMult(s, 16)).toBeGreaterThan(falloffMult(s, 22));
    expect(spreadDeg(s, true, 0)).toBeLessThan(spreadDeg(s, false, 0));
    expect(spreadDeg(WEAPONS.rifle, true, 2)).toBeCloseTo(WEAPONS.rifle.spread.aimed + 2);
    expect(lockOnFor(1).coneDeg).toBeGreaterThan(lockOnFor(0.1).coneDeg);
    expect(lockOnFor(1).pull).toBeGreaterThan(lockOnFor(0.1).pull);
  });

  it('throws spread into a cone and is repeatable from its seed', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    const out = { x: 0, y: 0, z: 0 };
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      scatter(east, 4, a, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 5);
      worst = Math.max(worst, (Math.acos(Math.min(1, out.z)) * 180) / Math.PI);
    }
    expect(worst).toBeLessThanOrEqual(4.001);
    expect(worst).toBeGreaterThan(3);
    const x1 = scatter(east, 4, b, { x: 0, y: 0, z: 0 });
    const x2 = scatter(east, 4, new Rng(5), { x: 0, y: 0, z: 0 });
    expect(x1).toEqual(x2);
  });
});

describe('hitscan', () => {
  it('stops at a wall, and what is behind it is safe', async () => {
    const { sim, p } = await range([{ x: 0, z: 20, sx: 10, sy: 4, sz: 1 }]);
    const behind = addNpc(sim, 0, 24);
    run(sim, 5, cmd());
    const r = fireWeapon(sim, { shooterId: p.id, weapon: 'rifle', ...chest(0), spreadDeg: 0 });
    expect(r.primary.kind).toBe('world');
    expect(r.primary.distance).toBeCloseTo(19.5, 0);
    expect(r.primary.nz).toBeLessThan(-0.9);
    expect(behind.health).toBe(100);
    expect(r.damage).toBe(0);
  });

  it('hits a ped for the weapon damage, headshots for more, and the event comes first', async () => {
    const { sim, p } = await range();
    const npc = addNpc(sim, 0, 8);
    run(sim, 5, cmd());
    sim.drainEvents();
    const r = fireWeapon(sim, { shooterId: p.id, weapon: 'pistol', origin: { x: 0, y: 1.0, z: 0 }, dir: east, spreadDeg: 0 });
    const ev = sim.drainEvents();
    expect(ev.map((e) => e.type).slice(0, 2)).toEqual(['weapon:fire', 'damage']);
    expect(r.primary).toMatchObject({ kind: 'ped', targetId: npc.id, headshot: false });
    expect(npc.health).toBeCloseTo(100 - WEAPONS.pistol.damage, 5);
    const dmg = ofType(ev, 'damage')[0];
    expect(dmg).toMatchObject({ kind: 'bullet', sourceId: p.id, targetId: npc.id });
    const head = fireWeapon(sim, { shooterId: p.id, weapon: 'pistol', origin: { x: 0, y: 1.6, z: 0 }, dir: east, spreadDeg: 0 });
    expect(head.primary.headshot).toBe(true);
    expect(head.damage).toBeCloseTo(WEAPONS.pistol.damage * WEAPONS.pistol.headshotMult, 5);
  });

  it('loses damage with distance', async () => {
    const { sim, p } = await range();
    const near = addNpc(sim, 0, 5);
    const far = addNpc(sim, 3, 45);
    run(sim, 5, cmd());
    const a = fireWeapon(sim, { shooterId: p.id, weapon: 'smg', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 }, spreadDeg: 0 });
    const b = fireWeapon(sim, { shooterId: p.id, weapon: 'smg', origin: { x: 0, y: 1, z: 0 }, dir: { x: 3, y: 0, z: 45 }, spreadDeg: 0 });
    expect(a.damage).toBeCloseTo(WEAPONS.smg.damage, 3);
    expect(b.damage).toBeLessThan(a.damage * 0.7);
    expect(b.damage).toBeGreaterThan(0);
    expect(near.health).toBeLessThan(far.health);
  });

  it('lets a bullet go through a corpse', async () => {
    const { sim, p } = await range();
    const front = addNpc(sim, 0, 6);
    const back = addNpc(sim, 0, 12);
    run(sim, 5, cmd());
    front.health = 1;
    fireWeapon(sim, { shooterId: p.id, weapon: 'pistol', origin: { x: 0, y: 1, z: 0 }, dir: east, spreadDeg: 0 });
    expect(front.life).toBe('dead');
    sim.drainEvents();
    const r = fireWeapon(sim, { shooterId: p.id, weapon: 'pistol', origin: { x: 0, y: 1, z: 0 }, dir: east, spreadDeg: 0 });
    expect(r.primary.targetId).toBe(back.id);
  });

  it('throws pellets: all hit up close, a few at range, and a volley is one damage event', async () => {
    const { sim, p } = await range();
    const close = addNpc(sim, 0, 3);
    run(sim, 5, cmd());
    sim.drainEvents();
    const a = fireWeapon(sim, { shooterId: p.id, weapon: 'shotgun', origin: { x: 0, y: 1, z: 0 }, dir: east });
    const ev = sim.drainEvents();
    expect(a.hits).toHaveLength(WEAPONS.shotgun.pellets);
    expect(ofType(ev, 'weapon:fire')[0].impacts).toHaveLength(8);
    expect(ofType(ev, 'damage')).toHaveLength(1);
    const landed = a.hits.filter((h) => h.kind === 'ped').length;
    expect(landed).toBeGreaterThanOrEqual(5);
    expect(close.life).not.toBe('alive'); // 8 x 11 at point blank takes someone down or out
    // At 30 m with a ped-sized target most pellets miss.
    const far = addNpc(sim, 0, 30);
    run(sim, 5, cmd());
    const b = fireWeapon(sim, { shooterId: p.id, weapon: 'shotgun', origin: { x: 0, y: 1, z: 6 }, dir: east, aimed: true });
    expect(b.hits.filter((h) => h.targetId === far.id).length).toBeLessThan(landed);
  });

  it('wrecks a car quicker from the bonnet, hurts its driver through the cabin and can flatten a tyre', async () => {
    const sim = await makeSim(boxTile([]), 'sedan');
    const v = sim.registry.get(sim.vehicleId) as import('../src/sim/entities').VehicleEntity;
    v.car.teleport(0, 0.5, 20, 0);
    run(sim, 30, cmd());
    const p = ped(sim);
    p.controller.teleport(0, 0, 0, 0);
    const driver = sim.seatDriver(v);
    run(sim, 5, cmd());
    sim.drainEvents();
    // Along the car's length at bonnet height (the nose is toward +Z).
    const eng0 = v.engine;
    const body0 = v.health;
    fireWeapon(sim, { shooterId: p.id, weapon: 'rifle', origin: { x: 0, y: 0.45, z: 40 }, dir: { x: 0, y: 0, z: -1 }, spreadDeg: 0 });
    const ev = sim.drainEvents();
    expect(ofType(ev, 'vehicle:damage')).toHaveLength(1);
    expect(v.health).toBeLessThan(body0);
    expect(eng0 - v.engine).toBeGreaterThan(body0 - v.health);
    // A shot into the cabin from the side hurts the driver (sometimes: it is a roll), so fire a burst.
    v.car.teleport(0, 0.5, 20, Math.PI / 2);
    run(sim, 20, cmd());
    let hurt = false;
    for (let i = 0; i < 12 && !hurt; i++) {
      fireWeapon(sim, { shooterId: p.id, weapon: 'rifle', origin: { x: -10, y: v.car.pose().y + 0.8, z: 20 }, dir: { x: 1, y: 0, z: 0 }, spreadDeg: 0 });
      hurt = driver.health < 100;
    }
    expect(hurt).toBe(true);
    // A low shot at a wheel.
    let flat = false;
    for (let i = 0; i < 30 && !flat; i++) {
      v.car.teleport(0, 0.5, 20, Math.PI / 2);
      run(sim, 3, cmd());
      // The car is turned a quarter: its nose is toward +X and its left side toward -Z. Shoot the rear left tyre from that side.
      const w = v.car.wheels[2];
      const pos = v.car.pose();
      fireWeapon(sim, { shooterId: p.id, weapon: 'rifle', origin: { x: pos.x + w.mz, y: pos.y - 0.05, z: pos.z - 10 }, dir: { x: 0, y: 0, z: 1 }, spreadDeg: 0 });
      flat = v.car.flatMask !== 0;
    }
    expect(flat).toBe(true);
  });
});

describe('ammo, rate of fire and reloading', () => {
  it('fires at the weapon rate, counts rounds, and reloads when empty', async () => {
    const { sim, p } = await range();
    giveWeapon(p, 'smg', { equip: true });
    p.gun!.equipLeft = 0;
    const origin = { x: 0, y: 1.3, z: 0 };
    let shots = 0;
    for (let i = 0; i < 60; i++) {
      const r = pullTrigger(sim, p, { origin, dir: east }, { spreadScale: 0 });
      if (r.status === 'fired') shots++;
      sim.step();
    }
    // 11 rounds a second for one second: 11 or 12 (the first is immediate).
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(12);
    expect(ammoStatus(p)!.mag).toBe(WEAPONS.smg.magazine - shots);

    // Hold the trigger until it runs dry: it clicks, then reloads for the reload time, and is full again.
    const ev = [] as ReturnType<typeof sim.drainEvents>;
    sim.drainEvents();
    for (let i = 0; i < 6 * 60 && p.gun!.inv.smg!.mag > 0; i++) {
      pullTrigger(sim, p, { origin, dir: east });
      sim.step();
      ev.push(...sim.drainEvents());
    }
    expect(p.gun!.inv.smg!.mag).toBe(0);
    const t0 = sim.tick;
    for (let i = 0; i < 2; i++) {
      pullTrigger(sim, p, { origin, dir: east });
      sim.step();
    }
    ev.push(...sim.drainEvents());
    expect(ofType(ev, 'weapon:reload').length).toBe(1);
    expect(p.gun!.reloadLeft).toBeGreaterThan(0);
    // Nothing fires while it reloads.
    expect(pullTrigger(sim, p, { origin, dir: east }).status).toBe('reloading');
    const reserve0 = p.gun!.inv.smg!.reserve;
    let done = -1;
    for (let i = 0; i < 4 * 60; i++) {
      sim.step();
      if (p.gun!.reloadLeft === 0 && done < 0) done = sim.tick - t0;
      if (done >= 0) break;
    }
    expect(done / 60).toBeGreaterThan(WEAPONS.smg.reloadS - 0.15);
    expect(done / 60).toBeLessThan(WEAPONS.smg.reloadS + 0.2);
    expect(p.gun!.inv.smg!.mag).toBe(WEAPONS.smg.magazine);
    expect(p.gun!.inv.smg!.reserve).toBe(reserve0 - WEAPONS.smg.magazine);
  });

  it('spends the reserve, tops up a part magazine, and refuses a reload with nothing to load', async () => {
    const { sim, p } = await range();
    p.gun!.inv.pistol = { mag: 5, reserve: 3 };
    expect(startReload(sim, p)).toBe(true);
    run(sim, 100, cmd());
    expect(ammoStatus(p)).toMatchObject({ mag: 8, reserve: 0 });
    expect(startReload(sim, p)).toBe(false);
    p.gun!.inv.pistol!.mag = 0;
    expect(startReload(sim, p)).toBe(false);
    expect(pullTrigger(sim, p, { origin: { x: 0, y: 1, z: 0 }, dir: east }).status).toBe('empty');
  });

  it('semi-automatics fire once per press and a switch takes time', async () => {
    const { sim, p } = await range();
    giveLoadout(p, 'shotgun');
    expect(p.gun!.weapon).toBe('shotgun');
    expect(selectWeapon(sim, p, 'pistol')).toBe(true);
    expect(pullTrigger(sim, p, { origin: { x: 0, y: 1, z: 0 }, dir: east }).status).toBe('equipping');
    run(sim, 30, cmd());
    expect(pullTrigger(sim, p, { origin: { x: 0, y: 1, z: 0 }, dir: east }).status).toBe('fired');
    expect(pullTrigger(sim, p, { origin: { x: 0, y: 1, z: 0 }, dir: east }).status).toBe('cooldown');
    expect(selectWeapon(sim, p, 'rifle')).toBe(false);
    expect(cycleWeapon(sim, p, 1)).toBe(true);
    expect(p.gun!.weapon).toBe('shotgun');
  });
});

describe('the player at the controls', () => {
  const view = (axes: Partial<Record<keyof typeof Axis, number>> = {}) => ({ Yaw: Math.PI, Pitch: 0, CamDist: 2.6, ...axes });

  it('aims with the camera and shoots what is under the crosshair', async () => {
    const { sim, p } = await range();
    // Camera yaw PI looks along +Z (forward is (-sin yaw, -cos yaw)); the camera is a shoulder to its right, which is -X here.
    const npc = addNpc(sim, -0.55, 12);
    run(sim, 3, cmd()); // a new body joins the world's ray queries on the first step
    const ev = runLog(sim, 30, () => cmd({ buttons: Button.Aim | Button.Fire, axes: view() }));
    expect(ofType(ev, 'weapon:fire').length).toBeGreaterThanOrEqual(1);
    expect(npc.health).toBeLessThan(100);
    expect(p.gun!.aiming).toBe(true);
    // The body faces where the camera looks.
    expect(Math.abs(p.controller.yaw)).toBeLessThan(0.01);
  });

  it('rebuilds the crosshair ray the client draws: the aim point lies on the camera ray, so the bullet goes where the crosshair is', async () => {
    const { sim, p } = await range([{ x: 8, z: 30, sx: 40, sy: 8, sz: 1 }]);
    for (const [yaw, pitch] of [[Math.PI, 0], [Math.PI * 0.8, 0.1], [Math.PI * 1.3, -0.05], [2.4, 0.2]]) {
      sim.players.get(1)!.axes = [0, 0, yaw, pitch, 0, 0, 0, AIM.arm + 0.4, 0];
      sim.players.get(1)!.camClear = 99;
      const a = solvePlayerAim(sim, sim.players.get(1)!, p, null);
      // The camera as the client places it, and its view ray.
      const c = p.controller;
      const cam = aimCameraPosition({ x: c.x, y: c.y + AIM.pivotFoot, z: c.z }, yaw, pitch, AIM.arm, AIM.shoulder);
      const f = viewDirection(yaw, pitch);
      const rel = { x: a.point.x - cam.x, y: a.point.y - cam.y, z: a.point.z - cam.z };
      const along = rel.x * f.x + rel.y * f.y + rel.z * f.z;
      const off = Math.hypot(rel.x - f.x * along, rel.y - f.y * along, rel.z - f.z * along);
      expect(along).toBeGreaterThan(AIM.arm);
      expect(off).toBeLessThan(1e-3);
      // And the shot leaves the muzzle for that point.
      const toPoint = Math.hypot(a.point.x - a.origin.x, a.point.y - a.origin.y, a.point.z - a.origin.z);
      expect(a.origin.x + a.dir.x * toPoint).toBeCloseTo(a.point.x, 2);
      expect(a.origin.z + a.dir.z * toPoint).toBeCloseTo(a.point.z, 2);
    }
  });

  it('leans the shot toward a threat when the device assists, and not when it does not', async () => {
    const { sim } = await range();
    const npc = addNpc(sim, 3.2, 20); // a few degrees from the crosshair
    run(sim, 3, cmd());
    const strong = runLog(sim, 40, () => cmd({ buttons: Button.Aim | Button.Fire, axes: view({ AimAssist: 1 }) }));
    expect(ofType(strong, 'damage').some((d) => d.targetId === npc.id)).toBe(true);
    expect(ped(sim).gun!.lock).toBe(npc.id);

    const b = await range();
    const npc2 = addNpc(b.sim, 3.2, 20);
    run(b.sim, 3, cmd());
    const none = runLog(b.sim, 40, () => cmd({ buttons: Button.Aim | Button.Fire, axes: view({ AimAssist: 0 }) }));
    expect(ofType(none, 'damage').some((d) => d.targetId === npc2.id)).toBe(false);
    expect(b.p.gun!.lock).toBe(0);
  });

  it('fires from the hip on the trigger alone: no lock-on, hip spread, and the gun still goes off', async () => {
    const { sim } = await range();
    const npc = addNpc(sim, 3.2, 20);
    run(sim, 3, cmd());
    const hip = runLog(sim, 40, () => cmd({ buttons: Button.Fire, axes: view({ AimAssist: 1 }) }));
    expect(ofType(hip, 'weapon:fire').length).toBeGreaterThan(0);
    expect(ped(sim).gun!.lock).toBe(0);
    expect(ofType(hip, 'damage').some((d) => d.targetId === npc.id)).toBe(false);
  });

  it('switches weapons with the slot keys and the cycle keys, and reloads on its key', async () => {
    const sim = await (await import('../src/sim/Simulation')).Simulation.create({ seed: 1, tile: boxTile([]), driver: false, parkedCars: 0, weapons: 'all' });
    const p = ped(sim);
    run(sim, 5, cmd());
    expect(p.gun!.weapon).toBe('pistol');
    runLog(sim, 3, () => cmd({ buttons: Button.Slot3 }));
    run(sim, 2, cmd());
    expect(p.gun!.weapon).toBe('shotgun');
    runLog(sim, 3, () => cmd({ buttons: Button.WeaponNext }));
    run(sim, 2, cmd());
    expect(p.gun!.weapon).toBe('rifle');
    runLog(sim, 3, () => cmd({ buttons: Button.WeaponPrev }));
    run(sim, 2, cmd());
    expect(p.gun!.weapon).toBe('shotgun');
    p.gun!.inv.shotgun!.mag = 2;
    run(sim, 60, cmd());
    const ev = runLog(sim, 3, () => cmd({ buttons: Button.Reload }));
    expect(ofType(ev, 'weapon:reload')).toHaveLength(1);
    run(sim, 200, cmd());
    expect(p.gun!.inv.shotgun!.mag).toBe(WEAPONS.shotgun.magazine);
  });

  it('starts with a pistol, and with everything on ?weapons=all, and nothing on none', async () => {
    const { Simulation } = await import('../src/sim/Simulation');
    const a = await makeSim();
    expect(Object.keys(ped(a).gun!.inv)).toEqual(['pistol']);
    const b = await Simulation.create({ seed: 1, tile: boxTile([]), weapons: 'all' });
    expect(Object.keys(ped(b).gun!.inv).sort()).toEqual([...WEAPON_ORDER].sort());
    const c = await Simulation.create({ seed: 1, tile: boxTile([]), weapons: 'none' });
    expect(ped(c).gun).toBeNull();
  });

  it('writes the gun into the snapshot', async () => {
    const { sim, p } = await range();
    runLog(sim, 30, () => cmd({ buttons: Button.Aim, axes: view() }));
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    const o = v.at(v.indexOf(p.id));
    expect(v.u32[o + E.Flags] & PedFlag.Aiming).toBeTruthy();
    expect(v.u32[o + E.Flags] & PedFlag.Armed).toBeTruthy();
    const w = v.u32[o + PB.Gun];
    expect(gunWeapon(w)).toBe(1);
    expect(gunMag(w)).toBe(WEAPONS.pistol.magazine);
    expect(gunReserve(w)).toBe(WEAPONS.pistol.startReserve);
    expect(v.f32[o + PB.Bloom]).toBeCloseTo(WEAPONS.pistol.spread.aimed, 3);
  });
});

describe('lock-on', () => {
  const origin = { x: 0, y: 1.5, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };
  const at = (id: number, x: number, z: number, threat = 0.3) => ({ id, x, y: 1.2, z, threat });

  it('picks the one closest to the centre of the crosshair, inside the cone', () => {
    const c = [at(1, 3, 20), at(2, 1, 20), at(3, 6, 60), at(4, -8, 20)];
    expect(pickLockTarget(origin, dir, c, { coneDeg: 12, rangeM: 80 })?.id).toBe(2);
    // The cone is the only filter: a narrow one finds nobody off to the side.
    expect(pickLockTarget(origin, dir, [at(1, 3, 20)], { coneDeg: 4, rangeM: 80 })).toBeNull();
    expect(pickLockTarget(origin, dir, [at(1, 3, 20)], { coneDeg: 12, rangeM: 80 })?.id).toBe(1);
  });

  it('ignores anyone behind, out of range, or too close to be a target', () => {
    expect(pickLockTarget(origin, dir, [at(1, 0, -10), at(2, 0, 100), at(3, 0, 0.2)], { coneDeg: 30, rangeM: 80 })).toBeNull();
  });

  it('prefers threats among near equals and sticks to its target', () => {
    const c = [at(1, 1, 20, 0.3), at(2, -1.2, 20, 1)];
    expect(pickLockTarget(origin, dir, c, { coneDeg: 12, rangeM: 80 })?.id).toBe(2);
    // Locked on 1, which has drifted toward the cone's edge: it stays while it is inside the sticky cone.
    const drift = [at(1, 4.2, 20, 0.3)]; // 11.9 degrees: outside a 10 degree cone, inside the sticky one
    expect(pickLockTarget(origin, dir, drift, { coneDeg: 10, rangeM: 80 })).toBeNull();
    expect(pickLockTarget(origin, dir, drift, { coneDeg: 10, rangeM: 80, current: 1, stickyMult: 1.4 })?.id).toBe(1);
    expect(pickLockTarget(origin, dir, drift, { coneDeg: 10, rangeM: 80, current: 2, stickyMult: 1.4 })).toBeNull();
  });

  it('bends the shot by the pull at the centre of the cone and not at its edge', () => {
    const t = pickLockTarget(origin, dir, [at(1, 2, 20)], { coneDeg: 12, rangeM: 80 })!;
    const strong = assistDirection(dir, origin, t, 12, 0.9);
    const weak = assistDirection(dir, origin, t, 12, 0.2);
    // At 5.7 degrees of a 12 degree cone it is in the middle half: the full pull. Further out the pull eases away.
    expect(angle(assistDirection(dir, origin, { ...t, angleDeg: 9 }, 12, 0.9))).toBeLessThan(angle(strong));
    const goal = Math.atan2(2, 20);
    function angle(v: { x: number; z: number }) {
      return Math.atan2(v.x, v.z);
    }
    expect(angle(strong)).toBeGreaterThan(angle(weak));
    expect(angle(strong)).toBeLessThanOrEqual(goal + 1e-6);
    expect(angle(weak)).toBeGreaterThan(0);
    const edge = { ...t, angleDeg: 12 };
    expect(assistDirection(dir, origin, edge, 12, 0.9).x).toBeCloseTo(0, 6);
  });
});

describe('armed NPCs', () => {
  it('shootAt faces, fires on the weapon rhythm and stops by itself', async () => {
    const { sim, p } = await range();
    const cop = sim.addPed(10, 0, 0, 0, 0, false, (o) => {
      o.role = 'police';
    });
    giveLoadout(cop, 'pistol', { infinite: true });
    cop.gun!.equipLeft = 0;
    run(sim, 5, cmd());
    sim.drainEvents();
    let fired = 0;
    for (let i = 0; i < 120; i++) {
      if (shootAt(sim, cop, p, { skill: 1 }).status === 'fired') fired++;
      sim.step();
    }
    expect(fired).toBeGreaterThanOrEqual(6);
    expect(fired).toBeLessThanOrEqual(8);
    expect(cop.controller.yaw).toBeCloseTo(Math.atan2(-10, 0), 0);
    expect(p.health).toBeLessThan(100);
    // The raised gun comes down once nobody tells it to aim.
    run(sim, 90, cmd());
    expect(cop.gun!.aiming).toBe(false);
    expect(muzzleOf(sim, cop).y).toBeGreaterThan(1);
  });
});
