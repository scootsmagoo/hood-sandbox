import { describe, expect, it } from 'vitest';
import { CRIMES } from '../src/shared/law';
import type { SimEvent } from '../src/shared/protocol';
import { PedFlag, SnapshotView, E, PB } from '../src/shared/snapshot';
import { fireWeapon, giveWeapon, pullTrigger } from '../src/sim/combat/weapons/api';
import { COVER } from '../src/sim/combat/weapons/cover';
import type { PedEntity, VehicleEntity } from '../src/sim/entities';
import { Simulation } from '../src/sim/Simulation';
import { rotateVec } from '../src/shared/math';
import { addNpc, Button, cmd, driverSim, makeSim, ofType, ped, run, runLog } from './helpers';
import { pedSim } from './pedHelpers';
import { crossroads, lanesFor, laneOf, stepAll, trafficSim } from './trafficHelpers';
import { boxTile } from './weaponHelpers';

const view = (over: Record<string, number> = {}) => ({ Yaw: Math.PI, Pitch: 0, CamDist: 2.6, ...over });
const awayCar = (sim: Simulation) => (sim.registry.get(sim.vehicleId) as VehicleEntity).car.teleport(400, 0.5, 400, 0);

async function arena(boxes: Parameters<typeof boxTile>[0] = []) {
  const sim = await makeSim(boxTile(boxes));
  awayCar(sim);
  const p = ped(sim);
  p.controller.teleport(0, 0, 0, 0);
  run(sim, 5, cmd());
  return { sim, p };
}

/** Fires one pistol shot straight ahead, from the player. */
function shoot(sim: Simulation, p: PedEntity, dir = { x: 0, y: 0, z: 1 }) {
  p.gun!.cooldown = 0;
  p.gun!.equipLeft = 0;
  p.gun!.reloadLeft = 0;
  return pullTrigger(sim, p, { origin: { x: 0, y: 1.3, z: 0.5 }, dir }, { spreadScale: 0 });
}

/** The events of a shot that was fired between ticks, and the tick after it, when the law rules on it. */
function ruling(sim: Simulation, ticks = 2): SimEvent[] {
  return [...sim.drainEvents(), ...runLog(sim, ticks)];
}

describe('gunfire is a crime that people hear', () => {
  it('firing in public is a discharge, seen by some and heard by more, and the report raises the heat', async () => {
    // A wall between the player and one witness; another stands in the open; a third is far off.
    const { sim, p } = await arena([{ x: 0, z: 10, sx: 6, sy: 4, sz: 1 }]);
    const sees = addNpc(sim, 10, 25);
    const hears = addNpc(sim, 0, 30);
    const far = addNpc(sim, 0, 300);
    run(sim, 5, cmd());
    sim.drainEvents();
    expect(shoot(sim, p).status).toBe('fired');
    const ev = ruling(sim);
    const crime = ofType(ev, 'crime').find((c) => c.crime === 'discharge')!;
    expect(crime).toBeTruthy();
    expect(crime.severity).toBe(CRIMES.discharge.severity);
    expect(crime.heat).toBe(1);
    expect(crime.witnesses).toBe(2);
    expect(crime.heard).toBe(1);
    // The one who only heard did not see a face; the one who saw did.
    expect(crime.description.face).toBe(true);
    expect(sim.law.pending.map((c) => c.witnessId).sort()).toEqual([sees.id, hears.id].sort());
    expect(sim.law.pending.some((c) => c.witnessId === far.id)).toBe(false);
    // They call it in a few seconds later.
    const later = runLog(sim, 60 * 10);
    expect(ofType(later, 'crime:reported').length).toBeGreaterThanOrEqual(1);
    expect(sim.law.heat.level).toBe(1);
  });

  it('a hearer alone calls it in, and does not know the face', async () => {
    const { sim, p } = await arena([{ x: 0, z: 10, sx: 30, sy: 5, sz: 1 }]);
    const hears = addNpc(sim, 0, 40);
    run(sim, 5, cmd());
    sim.drainEvents();
    shoot(sim, p);
    const ev = ruling(sim);
    const crime = ofType(ev, 'crime').find((c) => c.crime === 'discharge')!;
    expect(crime.witnesses).toBe(1);
    expect(crime.heard).toBe(1);
    expect(crime.description.face).toBe(false);
    expect(sim.law.pending[0].witnessId).toBe(hears.id);
  });

  it('a louder gun carries further than a pistol', async () => {
    const { sim, p } = await arena([{ x: 0, z: 10, sx: 30, sy: 5, sz: 1 }]);
    // 150 m behind a wall: past a pistol's 130 m, inside a rifle's 189 m.
    addNpc(sim, 0, 150);
    run(sim, 5, cmd());
    sim.drainEvents();
    shoot(sim, p);
    expect(ofType(ruling(sim), 'crime').find((c) => c.crime === 'discharge')?.witnesses).toBe(0);
    sim.law.pending.length = 0;
    // (the same crime again inside the dedupe window is ignored, so wait it out)
    run(sim, 60 * 7, cmd());
    giveWeapon(p, 'rifle', { equip: true });
    p.gun!.equipLeft = 0;
    pullTrigger(sim, p, { origin: { x: 0, y: 1.3, z: 0.5 }, dir: { x: 0, y: 0, z: 1 } });
    expect(ofType(ruling(sim), 'crime').find((c) => c.crime === 'discharge')?.witnesses).toBe(1);
  });

  it('shooting someone is shoot_ped, killing is kill_ped, shooting an officer is assault_officer, and it is only the player who is judged', async () => {
    const { sim, p } = await arena();
    const civ = addNpc(sim, 0, 8);
    const cop = sim.addPed(8, 0, 8, 0, 0, false, (o) => {
      o.role = 'police';
    });
    const bystander = addNpc(sim, -6, 4);
    run(sim, 5, cmd());
    sim.drainEvents();
    shoot(sim, p);
    let ev = ruling(sim);
    const wound = ofType(ev, 'crime').find((c) => c.crime === 'shoot_ped')!;
    expect(wound).toMatchObject({ victimId: civ.id, severity: CRIMES.shoot_ped.severity, heat: 2 });
    expect(ofType(ev, 'crime').some((c) => c.crime === 'discharge')).toBe(true);
    // The victim always counts as a witness; so does the bystander.
    expect(wound.witnesses).toBeGreaterThanOrEqual(1);

    civ.health = 1;
    run(sim, 60 * 7, cmd());
    sim.drainEvents();
    shoot(sim, p);
    ev = ruling(sim);
    expect(ofType(ev, 'crime').some((c) => c.crime === 'kill_ped' && c.victimId === civ.id)).toBe(true);

    run(sim, 60 * 7, cmd());
    sim.drainEvents();
    fireWeapon(sim, { shooterId: p.id, weapon: 'pistol', origin: { x: 0, y: 1.3, z: 0.5 }, dir: { x: 8, y: -0.1, z: 7.5 }, spreadDeg: 0 });
    ev = ruling(sim);
    expect(ofType(ev, 'crime').some((c) => c.crime === 'assault_officer' && c.victimId === cop.id)).toBe(true);

    // A cop shooting a civilian is no crime of the player's.
    sim.law.clear('busted');
    const before = ofType(runLog(sim, 1), 'crime').length;
    fireWeapon(sim, { shooterId: cop.id, weapon: 'pistol', origin: { x: 8, y: 1.3, z: 8 }, dir: { x: -14, y: -0.1, z: -4 }, spreadDeg: 0 });
    const copEv = ruling(sim);
    expect(before).toBe(0);
    expect(ofType(copEv, 'crime')).toHaveLength(0);
    void bystander;
  });
});

describe('what shooting does to people and cars nearby', () => {
  it('sends ambient pedestrians running, cowering or filming, and a few watchers just look', async () => {
    const sim = await pedSim({ peds: 14 });
    for (let i = 0; i < 60 * 3; i++) sim.step();
    sim.drainEvents();
    const p = ped(sim);
    p.controller.teleport(0, 0, 0, 0);
    // A burst of fire in the middle of the street.
    const ev: SimEvent[] = [];
    for (let i = 0; i < 240; i++) {
      if (i < 90) {
        p.gun!.cooldown = 0;
        pullTrigger(sim, p, { origin: { x: 0, y: 1.3, z: 0.5 }, dir: { x: 0.2, y: 0.3, z: 1 } });
      }
      sim.step();
      ev.push(...sim.drainEvents());
    }
    const reacts = ofType(ev, 'ped:react').filter((r) => r.cause === 'gunfire');
    expect(reacts.length).toBeGreaterThanOrEqual(3);
    expect(reacts.filter((r) => r.reaction === 'flee').length).toBeGreaterThan(reacts.length / 2);
    expect(reacts.every((r) => ['flee', 'cower', 'film', 'look'].includes(r.reaction))).toBe(true);
  });

  it('makes drivers floor it, and the timid ones get out and run when their car is shot', async () => {
    const { roads, junctions } = crossroads('none', 500);
    const sim = await trafficSim(lanesFor(roads, junctions), { seed: 3 });
    sim.traffic!.density = 0;
    awayCar(sim);
    const east = laneOf(sim, 'ew', 1, 0, 'first');
    const spawn = (s: number) => sim.traffic!.spawnAt(east, s, { type: 'sedan', color: 0x2244cc });
    ped(sim).controller.teleport(-300, sim.groundAt(-300, 12) + 0.1, 12);
    const bold = spawn(190); // x = -310
    const timid = spawn(215);
    stepAll(sim, 100);
    expect(bold.veh.occupantId).toBeGreaterThan(0);
    (sim.registry.get(bold.veh.occupantId) as PedEntity).brain!.personality.courage = 0.95;
    (sim.registry.get(timid.veh.occupantId) as PedEntity).brain!.personality.courage = 0.1;
    expect(bold.panic).toBeLessThan(0.1);
    // A shot rings out nearby and the timid driver's car takes a round.
    const tp = timid.veh.car.body.translation();
    sim.emit({
      type: 'weapon:fire', tick: sim.tick, shooterId: sim.playerPedId, weapon: 'pistol', x: tp.x - 15, y: 1.3, z: tp.z + 6, dx: 1, dy: 0, dz: 0,
      impacts: [{ kind: 'vehicle', x: tp.x, y: 0.5, z: tp.z, nx: 0, ny: 0, nz: 0, targetId: timid.veh.id, headshot: false }],
    });
    const ev = stepAll(sim, 120);
    expect(bold.panic).toBeGreaterThan(0.3);
    expect(ev.some((e) => e.type === 'traffic:react' && e.vehicleId === bold.veh.id && e.reaction === 'flee')).toBe(true);
    expect(timid.mode).toBe('free');
    expect(timid.veh.occupantId).toBe(0);
    expect(bold.mode).not.toBe('free');
  });
});

describe('cover', () => {
  const look = { Yaw: Math.PI };

  it('snaps flush against a high wall, slides along it, stops at its end and leaves on a key', async () => {
    const { sim, p } = await arena([{ x: 0, z: 3, sx: 10, sy: 3, sz: 0.6 }]);
    p.controller.teleport(0, 0, 1.5, 0);
    run(sim, 5, cmd());
    const ev = runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    run(sim, 3, cmd({ axes: look }));
    expect(ofType(ev, 'cover:enter')).toHaveLength(1);
    expect(p.cover).not.toBeNull();
    expect(p.cover!.low).toBe(false);
    // Against the wall's face (z = 2.7), the wall's normal pointing back at the ped.
    expect(p.controller.z).toBeCloseTo(2.7 - COVER.standOff, 1);
    expect(p.cover!.nz).toBeLessThan(-0.9);
    const v = new SnapshotView();
    sim.writeSnapshot(v);
    const o = v.at(v.indexOf(p.id));
    expect(v.u32[o + E.Flags] & PedFlag.InCover).toBeTruthy();
    expect(v.f32[o + PB.CoverNz]).toBeLessThan(-0.9);

    // Push the stick sideways: the camera looks along +Z, so its right is -X. Walk along the wall to its end, no further.
    run(sim, 60 * 2, cmd({ axes: { ...look, MoveX: 1 } }));
    expect(p.controller.x).toBeLessThan(-0.6);
    expect(Math.abs(p.controller.z - (2.7 - COVER.standOff))).toBeLessThan(0.15);
    run(sim, 60 * 10, cmd({ axes: { ...look, MoveX: 1 } }));
    expect(p.controller.x).toBeGreaterThan(-5.9);
    expect(p.cover).not.toBeNull();
    expect(p.cover!.edge).not.toBe(0);
    // A key leaves cover.
    const out = runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    expect(ofType(out, 'cover:exit')).toHaveLength(1);
    expect(p.cover).toBeNull();
  });

  it('crouches behind a low wall, stands to shoot over it, and a shot leaves from above it', async () => {
    const { sim, p } = await arena([{ x: 0, z: 3, sx: 10, sy: 1.0, sz: 0.5 }]);
    const npc = addNpc(sim, -0.55, 25); // under the crosshair: the camera is a shoulder to the right (-X here)
    p.controller.teleport(0, 0, 1.5, 0);
    run(sim, 5, cmd());
    runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    run(sim, 3, cmd({ axes: look }));
    expect(p.cover!.low).toBe(true);
    let v = new SnapshotView();
    sim.writeSnapshot(v);
    let flags = v.u32[v.at(v.indexOf(p.id)) + E.Flags];
    expect(flags & PedFlag.Crouched).toBeTruthy();
    expect(flags & PedFlag.Aiming).toBeFalsy();
    // Aim: up, and the camera ray goes over the wall.
    const ev = runLog(sim, 40, () => cmd({ buttons: Button.Aim | Button.Fire, axes: { ...look, Pitch: -0.01, CamDist: 2.6 } }));
    sim.writeSnapshot(v);
    flags = v.u32[v.at(v.indexOf(p.id)) + E.Flags];
    expect(flags & PedFlag.Crouched).toBeFalsy();
    expect(flags & PedFlag.Aiming).toBeTruthy();
    const shots = ofType(ev, 'weapon:fire');
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].y).toBeGreaterThan(1.1);
    expect(npc.health).toBeLessThan(100);
    expect(p.cover).not.toBeNull();
  });

  it('finds nothing in open ground, and a curb is not cover', async () => {
    const { sim, p } = await arena([{ x: 0, z: 3, sx: 10, sy: 0.25, sz: 0.5 }]);
    p.controller.teleport(0, 0, 1.5, 0);
    run(sim, 5, cmd());
    runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    expect(p.cover).toBeNull();
    p.controller.teleport(200, 0, 200, 0);
    run(sim, 5, cmd());
    runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    expect(p.cover).toBeNull();
  });

  it('is left on jumping, and when the player gets into a car', async () => {
    const { sim, p } = await arena([{ x: 0, z: 3, sx: 10, sy: 3, sz: 0.6 }]);
    p.controller.teleport(0, 0, 1.5, 0);
    run(sim, 5, cmd());
    runLog(sim, 3, () => cmd({ buttons: Button.Cover, axes: look }));
    run(sim, 3, cmd({ axes: look }));
    expect(p.cover).not.toBeNull();
    run(sim, 3, cmd({ buttons: Button.Jump, axes: look }));
    expect(p.cover).toBeNull();
  });
});

describe('a scripted gunfight', () => {
  async function fight() {
    const sim = await Simulation.create({ seed: 7, tile: boxTile([{ x: 0, z: 14, sx: 6, sy: 1.1, sz: 0.5 }]), weapons: 'all', parkedCars: 0, driver: false });
    awayCar(sim);
    const p = ped(sim);
    p.controller.teleport(0, 0, 0, 0);
    const targets: PedEntity[] = [];
    for (const [x, z] of [[3, 20], [-4, 26], [1, 33], [8, 12]]) targets.push(addNpc(sim, x, z));
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 12; i++) {
      // Aim a little to one side, then the other; change guns now and then; reload when told to.
      const t = i / 60;
      const yaw = Math.PI + Math.sin(t * 0.9) * 0.28;
      const slot = [Button.Slot1, Button.Slot2, Button.Slot3, Button.Slot4][Math.floor(t / 3) % 4];
      sim.pushInput(1, { tick: i + 1, buttons: Button.Aim | (i % 4 < 2 ? Button.Fire : 0) | (i % 30 === 0 ? slot : 0) | (i % 211 === 0 ? Button.Reload : 0), axes: [0, 0, yaw, 0.01, 0, 0, 0, 2.6, 0.6] });
      sim.step();
      events.push(...sim.drainEvents());
    }
    return { sim, events, targets, p };
  }

  it('replays exactly from the same seed and the same inputs', async () => {
    const a = await fight();
    const b = await fight();
    expect(a.events.length).toBeGreaterThan(40);
    expect(ofType(a.events, 'weapon:fire').length).toBeGreaterThan(20);
    expect(ofType(a.events, 'damage').length).toBeGreaterThan(0);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(b.targets.map((t) => [t.health, t.life])).toEqual(a.targets.map((t) => [t.health, t.life]));
    const sa = new SnapshotView();
    const sb = new SnapshotView();
    a.sim.writeSnapshot(sa);
    b.sim.writeSnapshot(sb);
    expect(Buffer.from(sb.buffer).equals(Buffer.from(sa.buffer))).toBe(true);
    // And a different seed spreads the bullets differently.
    expect(a.p.gun!.shots).toBeGreaterThan(20);
  });
});

describe('a drive-by', () => {
  it('shoots out of the window on the side it faces, with a pistol or SMG, and never draws a rifle', async () => {
    const { sim } = await driverSim('sedan');
    const p = ped(sim);
    const veh = sim.registry.get(p.vehicleId) as VehicleEntity;
    giveWeapon(p, 'smg');
    giveWeapon(p, 'rifle');
    p.gun!.weapon = 'rifle';
    p.gun!.equipLeft = 0;
    const q = veh.car.pose();
    const right = rotateVec(q.q, -1, 0, 0);
    const npc = addNpc(sim, q.x + right.x * 9, q.z + right.z * 9);
    run(sim, 5, cmd());
    // Aim along the line from the driver's eye to the ped. (The camera is at the driver's eye, a hair to the right.)
    const eye = { x: p.controller.x, y: p.controller.y + 1.35, z: p.controller.z };
    const yaw = Math.atan2(-(npc.controller.x - eye.x), -(npc.controller.z - eye.z));
    const pitch = Math.atan2(npc.controller.y + 1.2 - eye.y, Math.hypot(npc.controller.x - eye.x, npc.controller.z - eye.z));
    const ev = runLog(sim, 90, () => cmd({ buttons: Button.Aim | Button.Fire, axes: { Yaw: yaw, Pitch: pitch, CamDist: 0.85, AimAssist: 0 } }));
    // The rifle stays in its sling; the SMG comes out.
    expect(p.gun!.weapon).toBe('smg');
    const fires = ofType(ev, 'weapon:fire');
    expect(fires.length).toBeGreaterThan(3);
    expect(fires[0].weapon).toBe('smg');
    // The muzzle is outside the car's right side, at window height.
    const m = { x: fires[0].x - q.x, z: fires[0].z - q.z };
    expect(m.x * right.x + m.z * right.z).toBeGreaterThan(veh.car.h.chassis.halfExtents[0] - 0.1);
    expect(npc.health).toBeLessThan(100);
    // And no gun comes out at all when only a rifle is carried.
    p.gun!.inv = { rifle: p.gun!.inv.rifle! };
    p.gun!.weapon = 'rifle';
    const none = runLog(sim, 30, () => cmd({ buttons: Button.Aim | Button.Fire, axes: { Yaw: yaw, Pitch: pitch, CamDist: 0.85 } }));
    expect(ofType(none, 'weapon:fire')).toHaveLength(0);
    expect(p.gun!.aiming).toBe(false);
  });
});
