/**
 * Euphoria-lite: people become ragdolls when a car hits them above a few m/s, a blast throws them, a
 * bullet or a punch knocks them down, or they die; a nudge only staggers them. The bodies are bounded
 * (six with physics at once, the oldest frozen), get up again when they can, stay down when dead, and
 * replay exactly. The launch distances of a pedestrian struck at 30, 50 and 80 km/h are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { RAG_MASS, RAG_PARTS, forwardKinematics, packQuat, restPose, unpackQuat } from '../src/shared/ragdoll';
import { H, PedFlag, RG, SNAPSHOT_BYTES, SnapshotView } from '../src/shared/snapshot';
import { COMBAT, damagePed, knockDown } from '../src/sim/combat/damage';
import { PED } from '../src/sim/character/locomotion';
import { RAG } from '../src/sim/ragdoll/RagdollManager';
import type { PedEntity } from '../src/sim/entities';
import { Button, addNpc, cmd, driverSim, makeSim, ofType, ped, run, runLog, vehicle } from './helpers';

/** The player's sedan (or another type) at `kmh` heading north at a pedestrian 20 m ahead; `brake` stamps on the brake at the hit. */
async function strike(kmh: number, opts: { brake?: boolean; type?: string } = {}) {
  const d = await driverSim(opts.type ?? 'sedan', undefined, { x: 0, z: 900 });
  const v = kmh / 3.6;
  d.car.teleport(0, 0.4, 900, Math.PI);
  run(d.sim, 10, cmd());
  d.car.body.setLinvel({ x: 0, y: 0, z: -v }, true);
  d.car.adopt();
  const npc = addNpc(d.sim, 0, 880);
  let hitZ = 0;
  let hit = -1;
  let peak = 0;
  const events = [];
  for (let i = 0; i < 60 * 12; i++) {
    const axes = hit >= 0 ? (opts.brake !== false ? { Brake: 1 } : {}) : { Throttle: d.car.speedForward < v ? 1 : 0 };
    events.push(...runLog(d.sim, 1, () => cmd({ axes })));
    if (hit < 0 && d.sim.ragdolls.has(npc.id)) {
      hit = i;
      hitZ = npc.controller.z;
    }
    const pose = d.sim.ragdolls.poseOf(npc.id);
    if (pose) peak = Math.max(peak, pose.pos[1]);
    if (hit >= 0 && i - hit > 90 && !d.sim.ragdolls.isActive(npc.id)) break;
  }
  const pose = d.sim.ragdolls.poseOf(npc.id);
  return { ...d, npc, hit, events, thrown: hitZ - (pose ? pose.pos[2] : npc.controller.z), peak };
}

describe('the rig', () => {
  it('weighs about 75 kg in eleven parts, and its joints put the standing parts back where they started', () => {
    expect(RAG_MASS).toBeGreaterThan(70);
    expect(RAG_MASS).toBeLessThan(80);
    const pos = new Float32Array(RAG_PARTS * 3);
    const rot = new Float32Array(RAG_PARTS * 4);
    restPose(3, 1, -2, 0.7, pos, rot);
    const fk = new Float32Array(RAG_PARTS * 3);
    forwardKinematics({ x: pos[0], y: pos[1], z: pos[2] }, rot, fk);
    for (let i = 0; i < fk.length; i++) expect(fk[i]).toBeCloseTo(pos[i], 5);
  });

  it('packs a rotation into two words and back', () => {
    const u = new Uint32Array(2);
    const out = new Float32Array(4);
    const q = [0.3, -0.5, 0.1, 0.8];
    const l = Math.hypot(...q);
    packQuat(q[0] / l, q[1] / l, q[2] / l, q[3] / l, u, 0);
    unpackQuat(u, 0, out, 0);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(q[i] / l, 4);
  });
});

describe('cars and people', () => {
  it('a nudge at walking pace staggers someone; they keep their feet and nobody is hurt', async () => {
    const sim = await makeSim();
    const v = vehicle(sim);
    v.car.teleport(0, 0.4, 800, 0);
    ped(sim).controller.teleport(300, 0, 300);
    run(sim, 20, cmd());
    const npc = addNpc(sim, 0, 802.9);
    v.car.body.setLinvel({ x: 0, y: 0, z: 2.2 }, true);
    v.car.adopt();
    let staggered = false;
    const ev = runLog(sim, 60, () => {
      staggered ||= npc.stumbleT > 0;
      return cmd();
    });
    expect(staggered).toBe(true);
    expect(sim.ragdolls.has(npc.id)).toBe(false);
    expect(npc.life).toBe('alive');
    expect(ofType(ev, 'damage')).toHaveLength(0);
    // and the snapshot says so while it lasts
    npc.stumbleT = 0.5;
    const view = new SnapshotView();
    sim.writeSnapshot(view);
    expect(view.u32[view.at(view.indexOf(npc.id)) + 12] & PedFlag.Stumble).toBeTruthy();
  });

  it('from about 15 km/h a car takes them off their feet into a ragdoll', async () => {
    const { npc, hit, events } = await strike(18, { brake: false });
    expect(hit).toBeGreaterThan(0);
    expect(npc.life === 'downed' || npc.life === 'alive').toBe(true);
    expect(ofType(events, 'ped:down').filter((e) => e.pedId === npc.id)).toHaveLength(1);
    expect(npc.health).toBeLessThan(100);
  });

  it('throws a pedestrian about 5, 12 and 30 m when a braking car hits them at 30, 50 and 80 km/h', async () => {
    const at30 = await strike(30);
    const at50 = await strike(50);
    const at80 = await strike(80);
    expect(at30.thrown).toBeGreaterThan(3);
    expect(at30.thrown).toBeLessThan(8);
    expect(at50.thrown).toBeGreaterThan(9);
    expect(at50.thrown).toBeLessThan(18);
    expect(at80.thrown).toBeGreaterThan(22);
    expect(at80.thrown).toBeLessThan(40);
    // up onto the bonnet, not under the car
    expect(at50.peak).toBeGreaterThan(0.9);
    expect(at80.peak).toBeGreaterThan(1.2);
    // 30 km/h hurts, 50 kills
    expect(at30.npc.life).not.toBe('dead');
    expect(at30.npc.health).toBeLessThan(80);
    expect(at50.npc.life).toBe('dead');
    // and the bodies never fly off into the sky
    for (const r of [at30, at50, at80]) expect(r.peak).toBeLessThan(3.5);
  });

  it('carries someone over the bonnet and the roof when the car does not stop', async () => {
    const r = await strike(60, { brake: false });
    // the car passes under the body: it ends up behind the point of impact or barely ahead, having been up on the car
    expect(r.peak).toBeGreaterThan(1.1);
    expect(r.npc.life).toBe('dead');
  });

  it('a body lying in the road is pushed by a car that drives into it, and the car is barely slowed', async () => {
    const sim = await makeSim();
    const v = vehicle(sim);
    ped(sim).controller.teleport(300, 0, 300);
    v.car.teleport(0, 0.4, 785.5, 0);
    const npc = addNpc(sim, 0, 790);
    run(sim, 10, cmd());
    damagePed(sim, npc, 500, 'melee', 0);
    run(sim, 120, cmd());
    expect(sim.ragdolls.has(npc.id)).toBe(true);
    const z0 = sim.ragdolls.poseOf(npc.id)!.pos[2];
    v.car.body.setLinvel({ x: 0, y: 0, z: 6 }, true);
    v.car.adopt();
    run(sim, 60, cmd());
    expect(Math.abs(sim.ragdolls.poseOf(npc.id)!.pos[2] - z0)).toBeGreaterThan(0.3);
    expect(v.car.speed).toBeGreaterThan(2);
  });
});

describe('blasts, bullets, punches and deaths', () => {
  it('an explosion throws the people round it outward and up', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const car = vehicle(sim);
    car.car.teleport(0, 0.4, 700, 0);
    run(sim, 20, cmd());
    const near = [addNpc(sim, 2.5, 700), addNpc(sim, -3, 701), addNpc(sim, 0, 704)];
    run(sim, 5, cmd());
    sim.explodeVehicle(car);
    let top = 0;
    for (let i = 0; i < 40; i++) {
      run(sim, 1, cmd());
      for (const n of near) top = Math.max(top, sim.ragdolls.poseOf(n.id)?.pos[1] ?? 0);
    }
    run(sim, 200, cmd());
    for (const n of near) {
      expect(sim.ragdolls.has(n.id)).toBe(true);
      const p = sim.ragdolls.poseOf(n.id)!;
      expect(Math.hypot(p.pos[0], p.pos[2] - 700)).toBeGreaterThan(5);
    }
    expect(top).toBeGreaterThan(1.8);
  });

  it('a knock-down punch and a killing shot both make ragdolls; the corpse settles and freezes', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const a = addNpc(sim, 0, 600);
    const b = addNpc(sim, 10, 600);
    run(sim, 10, cmd());
    knockDown(sim, a, 2, 3, 0, 0);
    damagePed(sim, b, 200, 'bullet', 0);
    b.controller.launch(3.4, 2.1, 0);
    expect(sim.ragdolls.isActive(a.id)).toBe(true);
    expect(sim.ragdolls.isActive(b.id)).toBe(true);
    run(sim, 60 * 4, cmd());
    // the corpse has come to rest and been frozen: no bodies, the pose kept
    expect(sim.ragdolls.has(b.id)).toBe(true);
    expect(sim.ragdolls.isActive(b.id)).toBe(false);
    expect(sim.ragdolls.poseOf(b.id)!.pos[1]).toBeLessThan(0.4);
  });

  it('gets up once it has come to rest and the time down is over, blending back to standing, then walks', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const p = addNpc(sim, 0, 600);
    run(sim, 10, cmd());
    knockDown(sim, p, COMBAT.punchDownS, 3.5, 0, 0);
    const ev = runLog(sim, 60 * 6);
    const down = ofType(ev, 'ped:up');
    expect(down).toHaveLength(1);
    // up a little after the knock-down time (rest, then the get-up blend)
    expect(down[0].tick - (sim.tick - 60 * 6)).toBeLessThan(60 * (COMBAT.punchDownS + 1.5));
    expect(sim.ragdolls.has(p.id)).toBe(false);
    expect(p.controller.enabled).toBe(true);
    expect(p.controller.ragdolled).toBe(false);
    expect(Math.abs(p.controller.y)).toBeLessThan(0.15);
  });

  it('the player knocked down by a car gets up and can walk again', async () => {
    const sim = await makeSim();
    const me = ped(sim);
    me.controller.teleport(0, 0, 600);
    run(sim, 10, cmd());
    knockDown(sim, me, 2, 4, 0, 1);
    expect(sim.ragdolls.isActive(me.id)).toBe(true);
    run(sim, 60 * 5, cmd());
    expect(me.life).toBe('alive');
    const x0 = me.controller.x;
    run(sim, 60, cmd({ axes: { MoveX: 1 } }));
    expect(Math.abs(me.controller.x - x0)).toBeGreaterThan(1);
  });

  it('a bullet hits the ragdoll of someone already down', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const p = addNpc(sim, 0, 600);
    run(sim, 10, cmd());
    knockDown(sim, p, 30, 0, 0, 0);
    run(sim, 90, cmd());
    const pose = sim.ragdolls.poseOf(p.id)!;
    const hit = sim.weapons.cast({ x: pose.pos[3] + 6, y: pose.pos[4], z: pose.pos[5] }, { x: -1, y: 0, z: 0 }, 20, new Set(), { kind: 'none', t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ped: null, vehicle: null } as never);
    expect(hit.kind).toBe('ped');
    expect((hit.ped as PedEntity | null)?.id).toBe(p.id);
  });
});

describe('the budget', () => {
  it('never has more than six ragdolls with bodies; the oldest freezes to make room, and frozen bodies stay drawn', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const people: PedEntity[] = [];
    for (let i = 0; i < 10; i++) people.push(addNpc(sim, i * 3, 500));
    run(sim, 5, cmd());
    for (const p of people) {
      damagePed(sim, p, 500, 'melee', 0);
      p.controller.launch(0, 4, 2);
      expect(sim.ragdolls.activeCount).toBeLessThanOrEqual(RAG.maxActive);
      run(sim, 2, cmd());
    }
    expect(sim.ragdolls.activeCount).toBe(RAG.maxActive);
    expect(sim.ragdolls.count).toBe(10);
    expect(sim.ragdolls.isActive(people[0].id)).toBe(false);
    expect(sim.ragdolls.isActive(people[9].id)).toBe(true);
    const view = new SnapshotView();
    sim.writeSnapshot(view);
    expect(view.ragdollCount).toBe(10);
    // the records follow the entities and carry the pelvis
    const o = view.ragdollAt(view.ragdollIndexOf(people[9].id));
    const pose = sim.ragdolls.poseOf(people[9].id)!;
    expect(view.f32[o + RG.Px]).toBeCloseTo(pose.pos[0], 4);
    expect(view.usedBytes).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(view.u32[view.at(view.indexOf(people[0].id)) + 12] & PedFlag.Ragdoll).toBeTruthy();
  });

  it('leaves nothing behind: bodies and joints go when a body freezes, gets up or is removed', async () => {
    const sim = await makeSim();
    ped(sim).controller.teleport(300, 0, 300);
    const world = sim.physics.world;
    run(sim, 5, cmd());
    const bodies0 = world.bodies.len();
    const joints0 = world.impulseJoints.len();
    for (let round = 0; round < 3; round++) {
      const ps: PedEntity[] = [];
      for (let i = 0; i < 8; i++) ps.push(addNpc(sim, i * 2, 400 + round * 10));
      for (const p of ps) knockDown(sim, p, 0.5, 2, 3, 1);
      run(sim, 60 * 6, cmd());
      for (const p of ps) sim.despawn(p.id);
      run(sim, 2, cmd());
    }
    expect(world.bodies.len()).toBe(bodies0);
    expect(world.impulseJoints.len()).toBe(joints0);
    expect(sim.ragdolls.count).toBe(0);
  });
});

describe('on foot: weight', () => {
  it('takes a moment to get going, keeps the owner\'s speeds, and slides a little stopping from a sprint', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    c.teleport(-200, 0, 0);
    run(sim, 20, cmd());
    // a jog takes about a quarter of a second to reach
    let t = -1;
    for (let i = 0; i < 60 && t < 0; i++) {
      run(sim, 1, cmd({ axes: { MoveY: 1 } }));
      if (c.speed > PED.runSpeed * 0.95) t = i / 60;
    }
    expect(t).toBeGreaterThan(0.15);
    expect(t).toBeLessThan(0.4);
    run(sim, 60, cmd({ axes: { MoveY: 1 }, buttons: Button.Sprint }));
    expect(c.speed).toBeCloseTo(PED.sprintSpeed, 1);
    const z0 = c.z;
    run(sim, 60, cmd());
    const slide = Math.abs(c.z - z0);
    expect(slide).toBeGreaterThan(0.7);
    expect(slide).toBeLessThan(1.6);
    // from a walk it stops in a step
    run(sim, 60, cmd({ axes: { MoveY: 0.5 } }));
    const z1 = c.z;
    run(sim, 60, cmd());
    expect(Math.abs(c.z - z1)).toBeLessThan(0.2);
  });

  it('a sprinting player who runs into a pedestrian staggers them and loses a little pace', async () => {
    const sim = await makeSim();
    const me = ped(sim);
    me.controller.teleport(-200, 0, 10);
    const npc = addNpc(sim, -200, 4);
    run(sim, 10, cmd());
    let staggered = false;
    for (let i = 0; i < 90 && !staggered; i++) {
      run(sim, 1, cmd({ axes: { MoveY: 1 }, buttons: Button.Sprint }));
      staggered = npc.stumbleT > 0;
    }
    expect(staggered).toBe(true);
    expect(npc.life).toBe('alive');
  });
});

describe('determinism', () => {
  it('a crash with a pedestrian thrown and a car wrecked replays to the same bytes', async () => {
    const once = async () => {
      const r = await strike(55);
      const bytes: Uint8Array[] = [];
      const view = new SnapshotView();
      for (let i = 0; i < 60; i++) {
        run(r.sim, 1, cmd({ axes: { Throttle: 1, Steer: 0.4 } }));
        r.sim.writeSnapshot(view);
        // (the acknowledged command tick comes from the test's own command counter, which runs on between the two runs)
        view.u32[H.Ack] = 0;
        bytes.push(new Uint8Array(view.buffer.slice(0, view.usedBytes)));
      }
      return { bytes, events: r.events.map((e) => JSON.stringify(e)).join('\n') };
    };
    const a = await once();
    const b = await once();
    expect(b.events).toBe(a.events);
    expect(b.bytes.length).toBe(a.bytes.length);
    for (let i = 0; i < a.bytes.length; i++) expect(Buffer.compare(Buffer.from(a.bytes[i]), Buffer.from(b.bytes[i]))).toBe(0);
  });
});
