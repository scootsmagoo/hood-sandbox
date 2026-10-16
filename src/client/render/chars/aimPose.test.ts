import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { PedPose } from '../../../shared/snapshot';
import type { AnimInput } from './animSelect';
import { prepare, type CharacterAssets } from './characterAssets';
import { CHAR_OUTFITS, appearanceOf } from './outfits';
import { AIM_PITCH_MAX, PedActor, TORSO_MAX } from './PedActor';

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

async function load(): Promise<CharacterAssets> {
  const buf = readFileSync(resolve(__dirname, '../../../../public/assets/characters/characters.glb'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise<Parameters<typeof prepare>[0]>((ok, no) => loader.parse(ab, '', ok as never, no));
  return prepare(gltf);
}

const input = (o: Partial<AnimInput> & { long?: boolean; speed?: number }): AnimInput => ({
  speed: o.speed ?? 0, grounded: true, mode: o.mode ?? 'normal', pose: PedPose.None, swing: 0, yawRate: 0,
  extra: { aim: 0, long: o.long ?? false, crouch: false, cover: false, flinch: 0, firing: false, reload: 0, stumble: 0 } as AnimInput['extra'],
});

describe('the aim pose', async () => {
  const assets = await load();
  const app = appearanceOf(CHAR_OUTFITS[0], 1);

  /** Poses an actor aiming at `pitch` for a second of frames (a held clip: the bend must not pile up) and reads the body off the bones. */
  function pose(pitch: number, o: Parameters<typeof input>[0]) {
    const a = new PedActor(assets, app, 3);
    a.setGun('pistol');
    const inp = input(o);
    for (let i = 0; i < 60; i++) a.update(1 / 60, inp, pitch, 0);
    a.root.updateMatrixWorld(true);
    const at = (n: string) => a.bones[assets.rig.index.get(n)!].getWorldPosition(new THREE.Vector3());
    const up = (n: string) => new THREE.Vector3(0, 1, 0).applyQuaternion(a.bones[assets.rig.index.get(n)!].getWorldQuaternion(new THREE.Quaternion()));
    const r = { chestTilt: deg(up('chest').angleTo(new THREE.Vector3(0, 1, 0))), chestY: at('chest').y, headY: at('head').y, neckY: at('neck').y, pelvisY: at('pelvis').y, arm: at('upperarm_R'), hand: at('hand_R') };
    a.dispose();
    return r;
  }

  for (const [name, o] of [['pistol standing', {}], ['rifle standing', { long: true }], ['pistol walking', { speed: 1.4 }], ['seated drive-by', { mode: 'seated' as const }]] as const) {
    it(`keeps the torso upright and the head over the chest, aiming from -60 to +60 degrees (${name})`, () => {
      for (let p = -60; p <= 60; p += 10) {
        const r = pose(rad(p), o);
        if (process.env.AIMDBG) console.log(name, p, r.chestTilt.toFixed(1));
        expect(r.chestTilt, `${name} ${p}`).toBeLessThan(40);
        expect(r.headY, `${name} ${p}`).toBeGreaterThan(r.chestY);
        expect(r.neckY, `${name} ${p}`).toBeGreaterThan(r.pelvisY);
      }
    });
  }

  it('does not pile up over the frames: a held aim stays one pose for ten seconds (the mixer writes a track only when it changes)', () => {
    const a = new PedActor(assets, app, 3);
    const inp = input({});
    const chest = a.bones[assets.rig.index.get('chest')!];
    const up = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      a.update(1 / 60, inp, rad(45), 0);
      a.root.updateMatrixWorld(true);
      worst = Math.max(worst, deg(up.set(0, 1, 0).applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(0, 1, 0))));
    }
    expect(worst).toBeLessThan(40);
    a.dispose();
  });

  it('points the hand where the camera looks: higher for a positive pitch, lower for a negative one', () => {
    const lift = (p: number) => { const r = pose(rad(p), {}); return deg(Math.atan2(r.hand.y - r.arm.y, Math.hypot(r.hand.x - r.arm.x, r.hand.z - r.arm.z))); };
    for (const p of [-45, -20, 20, 45]) expect(Math.abs(lift(p) - lift(0) - p)).toBeLessThan(10);
  });

  it('bends the torso no more than its limit, however far the camera looks', () => {
    const base = pose(0, {}).chestTilt;
    expect(pose(AIM_PITCH_MAX * 2, {}).chestTilt - base).toBeLessThan(deg(TORSO_MAX) + 6);
    expect(pose(-AIM_PITCH_MAX * 2, {}).chestTilt - base).toBeLessThan(deg(TORSO_MAX) + 6);
  });
});
