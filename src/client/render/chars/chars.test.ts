import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PedPose } from '../../../shared/snapshot';
import { RAG_PARTS, RAG_RIG, restPose } from '../../../shared/ragdoll';
import { CLIPS, checkCharacters, readCharacters } from '../../../../tools/blender/characters/verify';
import { GAIT, locoWeights, planFor, topTwo, type AnimInput } from './animSelect';
import { makeRig, makeSkeleton, type CharRig } from './characterAssets';
import { CHAR_OUTFITS, REGION_COUNT, appearanceOf, heightOf, officerOutfit } from './outfits';
import { ACTOR_LOD, actorLod } from './PedActor';
import { ACTOR_BUDGET, pickNear } from './PedViews';
import { BONE_PART, RagBones } from './ragBones';
import { CROWD_LOD1_RANGE } from './SkinnedCrowd';

const inp = (o: Partial<AnimInput> = {}): AnimInput => ({ speed: 0, grounded: true, mode: 'normal', pose: PedPose.None, swing: 0, yawRate: 0, ...o });
const top = (i: AnimInput) => [...planFor(i).layers].sort((a, b) => b.weight - a.weight)[0];

describe('pose to clip', () => {
  it('stands, walks, jogs and sprints with the speed', () => {
    expect(top(inp()).clip).toBe('idle');
    expect(top(inp({ speed: GAIT.walk.speed })).clip).toBe('walk');
    expect(top(inp({ speed: GAIT.jog.speed })).clip).toBe('jog');
    expect(top(inp({ speed: GAIT.sprint.speed })).clip).toBe('sprint');
    expect(top(inp({ speed: 4.4, mode: 'fleeing' })).clip).toBe('flee');
    expect(top(inp({ speed: 1.2, mode: 'fleeing' })).clip).toBe('walk');
  });

  it('keeps the feet on the ground: the phase runs at speed over the stride of the clips in play', () => {
    expect(planFor(inp({ speed: GAIT.walk.speed })).cadence).toBeCloseTo(GAIT.walk.speed / GAIT.walk.stride, 1);
    expect(planFor(inp({ speed: GAIT.sprint.speed })).cadence).toBeCloseTo(GAIT.sprint.speed / GAIT.sprint.stride, 1);
    // blending walk into jog: between the two
    const mid = planFor(inp({ speed: 2.5 })).cadence;
    expect(mid).toBeGreaterThan(2.5 / GAIT.jog.stride - 0.01);
    expect(mid).toBeLessThan(2.5 / GAIT.walk.stride + 0.01);
    expect(planFor(inp()).cadence).toBe(0);
  });

  it('weights of the locomotion clips sum to one and change smoothly', () => {
    let last = locoWeights(0, false);
    for (let s = 0.05; s < 7; s += 0.05) {
      const w = locoWeights(s, false);
      expect(w.idle + w.walk + w.jog + w.sprint + w.flee).toBeCloseTo(1, 5);
      for (const k of ['idle', 'walk', 'jog', 'sprint'] as const) expect(Math.abs(w[k] - last[k])).toBeLessThan(0.2);
      last = w;
    }
    const f = locoWeights(4, true);
    expect(f.flee).toBeCloseTo(1, 5);
  });

  it('maps what a standing person is doing to its clip', () => {
    const expected: [number, string][] = [[PedPose.Sit, 'sit'], [PedPose.Phone, 'phone'], [PedPose.Film, 'film'], [PedPose.Cower, 'cower'], [PedPose.Chat, 'chat'], [PedPose.Atm, 'atm'], [PedPose.Browse, 'browse']];
    for (const [pose, clip] of expected) expect(top(inp({ pose })).clip).toBe(clip);
    // walking away from the bench is walking, not sitting
    expect(top(inp({ pose: PedPose.Sit, speed: 1.4 })).clip).toBe('walk');
  });

  it('turns on the spot toward the side it is turning', () => {
    expect(top(inp({ yawRate: 2.5 })).clip).toBe('turn_l');
    expect(top(inp({ yawRate: -2.5 })).clip).toBe('turn_r');
    expect(top(inp({ yawRate: 0.3 })).clip).toBe('idle');
  });

  it('squares up, and a punch plays by its progress', () => {
    expect(top(inp({ mode: 'fighting' })).clip).toBe('fight');
    const p = planFor(inp({ mode: 'fighting', swing: 0.4 })).layers;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ clip: 'punch', time: 'fixed', u: 0.4 });
  });

  it('aims: the whole body standing, only the arms when moving, kneeling behind low cover', () => {
    expect(top(inp({ extra: { aim: 0.1 } })).clip).toBe('aim_pistol');
    expect(top(inp({ extra: { aim: 0.1, long: true } })).clip).toBe('aim_rifle');
    expect(top(inp({ extra: { aim: 0, crouch: true } })).clip).toBe('aim_crouch');
    const moving = planFor(inp({ speed: 1.4, extra: { aim: 0.1, long: true } })).layers.map((l) => l.clip);
    expect(moving).toContain('aim_rifle@upper');
    expect(moving).toContain('walk@lower');
    expect(moving).not.toContain('walk');
  });

  it('takes cover, reloads, drives, is dragged, falls, stumbles and flinches', () => {
    expect(top(inp({ extra: { cover: true } })).clip).toBe('cover');
    expect(top(inp({ extra: { crouch: true } })).clip).toBe('cover_low');
    expect(top(inp({ extra: { reload: 1 } })).clip).toBe('reload@upper');
    expect(top(inp({ mode: 'seated' })).clip).toBe('drive');
    expect(top(inp({ mode: 'dragged' })).clip).toBe('dragged');
    expect(top(inp({ grounded: false })).clip).toBe('fall');
    expect(top(inp({ extra: { stumble: 1 } })).clip).toBe('stumble');
    const hit = planFor(inp({ extra: { flinch: 1 } })).layers.map((l) => l.clip);
    expect(hit).toContain('flinch@upper');
    expect(hit).toContain('idle');
    // aiming out of a car: the car's legs, the gun's arms
    const car = planFor(inp({ mode: 'seated', extra: { aim: 0 } })).layers.map((l) => l.clip);
    expect(car).toEqual(['drive@lower', 'aim_pistol@upper']);
  });

  it('only ever asks for clips the asset has', () => {
    const names = new Set<string>();
    const modes = ['normal', 'seated', 'dragged', 'fleeing', 'fighting'] as const;
    for (const mode of modes) for (const speed of [0, 1, 2.5, 4, 6]) for (const pose of [0, 1, 2, 3, 4, 5, 6, 7]) for (const swing of [0, 0.5]) for (const grounded of [true, false]) {
      for (const extra of [undefined, { aim: 0.1 }, { aim: 0.1, long: true }, { aim: 0, crouch: true }, { crouch: true }, { cover: true }, { reload: 1 }, { stumble: 1 }, { flinch: 1 }, { aim: 0, firing: true }]) {
        for (const l of planFor(inp({ mode, speed, pose, swing, grounded, extra })).layers) names.add(l.clip.replace(/@(upper|lower)$/, ''));
      }
    }
    for (const n of names) expect(Object.keys(CLIPS), n).toContain(n);
    expect(names.size).toBeGreaterThan(20);
  });

  it('the crowd plays the two heaviest layers, masked ones as the full clip', () => {
    const [a, b] = topTwo(planFor(inp({ speed: 2.5 })).layers);
    expect(a.clip).toMatch(/walk|jog/);
    expect(b?.clip).toMatch(/walk|jog/);
  });
});

describe('levels of detail', () => {
  it('picks a level by distance, scaled by the tier, with some stickiness at the borders', () => {
    expect(actorLod(5, 1)).toBe(0);
    expect(actorLod(ACTOR_LOD.near + 5, 1)).toBe(1);
    expect(actorLod(ACTOR_LOD.far + 5, 1)).toBe(2);
    // the Low tier drops detail sooner
    expect(actorLod(ACTOR_LOD.near * 0.7, 0.55)).toBe(1);
    // held at a border
    expect(actorLod(ACTOR_LOD.near + 1, 1, 0)).toBe(0);
    expect(actorLod(ACTOR_LOD.near + 1, 1, 1)).toBe(1);
    expect(actorLod(ACTOR_LOD.near - 1, 1, 1)).toBe(1);
    expect(CROWD_LOD1_RANGE).toBeGreaterThan(ACTOR_LOD.near);
  });

  it('keeps the nearest few as actors, and a person already near stays near a little longer', () => {
    const c = [4, 9, 12, 15, 30, 7, 11].map((d, i) => ({ id: i + 1, d, was: false }));
    const near = pickNear(c, 3, 17);
    expect([...near].sort()).toEqual([1, 2, 6]);
    // 15 m away and already an actor beats 12 m away and not
    const sticky = pickNear([{ id: 1, d: 15, was: true }, { id: 2, d: 12, was: false }], 1, 17);
    expect([...sticky]).toEqual([1]);
    // nobody beyond the range, whatever the budget
    expect(pickNear(c, 99, 17).has(5)).toBe(false);
    expect(ACTOR_BUDGET.low).toBeLessThan(ACTOR_BUDGET.high);
  });
});

describe('people', () => {
  it('are made the same each time and differ from one id to the next', () => {
    const o = CHAR_OUTFITS[7];
    const a = appearanceOf(o, 42);
    const b = appearanceOf(o, 42);
    expect(Array.from(a.palette)).toEqual(Array.from(b.palette));
    expect(a.palette.length).toBe(REGION_COUNT * 3);
    const skins = new Set<number>();
    for (let id = 1; id < 200; id++) skins.add(appearanceOf(o, id).look.skin);
    expect(skins.size).toBeGreaterThan(7);
    for (let id = 1; id < 200; id++) expect(heightOf(id)).toBeGreaterThanOrEqual(0.93);
  });

  it('keep Kudzu as he is, and put an officer in the agency colour', () => {
    const k1 = appearanceOf(CHAR_OUTFITS[0], 1);
    const k2 = appearanceOf(CHAR_OUTFITS[0], 99);
    expect(k1.look.skin).toBe(k2.look.skin);
    expect(k1.arch).toBe('kudzu');
    const off = appearanceOf(officerOutfit(0x2d4a7a, 5), 5, true);
    expect(off.arch).toMatch(/^officer_/);
    expect(off.look.jacket).toBe(0x2d4a7a);
  });
});

describe('ragdoll to bones', async () => {
  const doc = await readCharacters(resolve(__dirname, '../../../../public/assets/characters/characters.glb'));
  const joints = doc.getRoot().listSkins()[0].listJoints();
  const names = joints.map((j) => j.getName());
  const parent = Int16Array.from(joints.map((j) => joints.findIndex((p) => p === j.getParentNode())));
  const pos = new Float32Array(joints.length * 3);
  const quat = new Float32Array(joints.length * 4);
  joints.forEach((j, i) => {
    pos.set(j.getTranslation(), i * 3);
    quat.set(j.getRotation(), i * 4);
  });
  const rig: CharRig = makeRig(names, parent, pos, quat);
  const rb = new RagBones(rig);
  const rest = new Float32Array(RAG_PARTS * 3);
  const rot = new Float32Array(RAG_PARTS * 4);

  const bones = () => makeSkeleton(rig);
  const world = (b: ReturnType<typeof bones>, name: string) => {
    b.root.updateMatrixWorld(true);
    return b.bones[rig.index.get(name)!].getWorldQuaternion(new THREE.Quaternion());
  };

  it('maps every ragdoll body to one bone, parents before children', () => {
    expect(Object.keys(BONE_PART)).toHaveLength(RAG_PARTS);
    expect(new Set(Object.values(BONE_PART)).size).toBe(RAG_PARTS);
    // each driven bone's nearest driven ancestor is the body the ragdoll hangs it from
    RAG_RIG.forEach((p, i) => {
      const bone = Object.keys(BONE_PART).find((k) => BONE_PART[k] === i)!;
      expect(rb.part[rig.index.get(bone)!]).toBe(i);
      expect(rb.ancestorPart[rig.index.get(bone)!], bone).toBe(p.parent);
    });
  });

  it('leaves the bind pose as it is for a ragdoll standing at rest', () => {
    restPose(0, 0, 0, 0, rest, rot);
    const b = bones();
    rb.apply(b.bones, rest, rot);
    b.bones.forEach((bone, i) => {
      const q = new THREE.Quaternion().fromArray(rig.restQuat, i * 4);
      expect(Math.abs(bone.quaternion.dot(q)), rig.names[i]).toBeGreaterThan(0.99999);
    });
    // and the pelvis sits where the bind pose has it
    expect(b.bones[rig.index.get('pelvis')!].getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(1.0, 3);
  });

  it('turns the whole figure with the pelvis, and bends a limb with its own body', () => {
    const yaw = Math.PI / 2;
    restPose(3, 0, -2, yaw, rest, rot);
    const b = bones();
    rb.apply(b.bones, rest, rot);
    const Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // every bone ends up rotated by the heading, from where it rests
    for (const n of ['pelvis', 'spine', 'head', 'upperarm_L', 'forearm_R', 'thigh_L', 'shin_R', 'foot_L', 'hand_R']) {
      const want = Q.clone().multiply(new THREE.Quaternion().fromArray(rig.restWorldQuat, rig.index.get(n)! * 4));
      expect(Math.abs(world(b, n).dot(want)), n).toBeGreaterThan(0.9999);
    }
    expect(b.bones[rig.index.get('pelvis')!].getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3))).toEqual([3, 1, -2]);
    // bend the left shin about X by 1 rad on top of the heading: the foot, which follows, goes with it
    restPose(0, 0, 0, 0, rest, rot);
    const k = RagPartKnee;
    const bend = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1);
    rot.set([bend.x, bend.y, bend.z, bend.w], k * 4);
    const b2 = bones();
    rb.apply(b2.bones, rest, rot);
    const shin = world(b2, 'shin_L');
    const wantShin = bend.clone().multiply(new THREE.Quaternion().fromArray(rig.restWorldQuat, rig.index.get('shin_L')! * 4));
    expect(Math.abs(shin.dot(wantShin))).toBeGreaterThan(0.9999);
    expect(Math.abs(world(b2, 'foot_L').dot(bend.clone().multiply(new THREE.Quaternion().fromArray(rig.restWorldQuat, rig.index.get('foot_L')! * 4))))).toBeGreaterThan(0.9999);
    // while the other shin stays put
    expect(Math.abs(world(b2, 'shin_R').dot(new THREE.Quaternion().fromArray(rig.restWorldQuat, rig.index.get('shin_R')! * 4)))).toBeGreaterThan(0.9999);
  });

  it('matches the file the checks read', async () => {
    const r = await checkCharacters(resolve(__dirname, '../../../../public/assets/characters/characters.glb'), ['kudzu']);
    expect(r.problems.filter((p) => !/missing|manifest/.test(p))).toEqual([]);
  });
});

const RagPartKnee = 8; // ShinL

describe('the baked crowd animation', () => {
  // a two-bone rig and a two-second clip that turns the pelvis a quarter turn and back
  const rig = makeRig(['root', 'pelvis'], Int16Array.from([-1, 0]), Float32Array.from([0, 0, 0, 0, 1, 0]), Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]));
  const q = (a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
  const track = new THREE.QuaternionKeyframeTrack('pelvis.quaternion', [0, 1, 2], [...q(0).toArray(), ...q(Math.PI / 2).toArray(), ...q(0).toArray()]);
  const clips = new Map([['idle', new THREE.AnimationClip('idle', 2, [track])], ['punch', new THREE.AnimationClip('punch', 2, [track.clone()])]]);
  const geos = new Map();

  it('bakes each clip into a run of rows and finds the frames of a moment in it', async () => {
    const { BakedAnims, BAKE_FPS } = await import('./BakedAnims');
    const b = new BakedAnims({ rig, geos, clips, tris: {} }, ['idle', 'punch']);
    const idle = b.clips.get('idle')!;
    expect(idle.frames).toBe(2 * BAKE_FPS + 1);
    expect(b.clips.get('punch')!.base).toBe(idle.frames);
    expect(b.rows).toBe(2 * (2 * BAKE_FPS + 1));
    expect(b.texture.image.width).toBe(2 * 3);
    const f = { a: 0, b: 0, t: 0 };
    b.sample('idle', 0, f);
    expect(f).toMatchObject({ a: 0, b: 1 });
    b.sample('idle', 0.5, f);
    expect(f.a + f.t).toBeCloseTo(BAKE_FPS, 3);
    // a loop wraps
    b.sample('idle', 1.25, f);
    expect(f.a + f.t).toBeCloseTo(0.25 * 2 * BAKE_FPS, 3);
    // a one-shot stops at its last frame
    b.sample('punch', 5, f);
    expect(f.b).toBe(b.clips.get('punch')!.base + 2 * BAKE_FPS);
    // the matrix of the turned pelvis, half way: a quarter turn about Y
    const half = new Uint16Array(b.texture.image.data!.buffer);
    const row = BAKE_FPS; // the frame at t = 1 s
    const at = (r: number, c: number) => THREE.DataUtils.fromHalfFloat(half[(row * 6 + 3 + r) * 4 + c]);
    expect(at(0, 2)).toBeCloseTo(1, 2); // x' gets +z
    expect(at(2, 0)).toBeCloseTo(-1, 2);
    b.dispose();
  });
});
