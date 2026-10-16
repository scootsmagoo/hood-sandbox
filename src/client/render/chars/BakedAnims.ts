/**
 * The crowd's animation, baked: every clip the crowd plays sampled at 20 frames a second into one
 * texture of bone matrices (3 rows of 4 numbers a bone, half floats; a frame is a row of texels).
 * The crowd's vertex shader (`pedMaterial.ts`) reads two frames of up to two clips and blends them, so
 * 150 people cost no mixers and no bone updates at all, only a few numbers each.
 *
 * Baking runs the same clips through a real skeleton at load (a few milliseconds), so the crowd and
 * the near figures cannot drift apart.
 */
import * as THREE from 'three';
import { CROWD_CLIPS } from './animSelect';
import { makeSkeleton, type CharacterAssets } from './characterAssets';

export const BAKE_FPS = 20;

export interface BakedClip {
  /** First row of the clip in the texture, and its frame count (a loop's last frame is its first). */
  base: number;
  frames: number;
  duration: number;
  loop: boolean;
}

export class BakedAnims {
  readonly texture: THREE.DataTexture;
  readonly clips = new Map<string, BakedClip>();
  readonly bones: number;
  readonly rows: number;

  constructor(assets: CharacterAssets, names: readonly string[] = CROWD_CLIPS) {
    const rig = assets.rig;
    const bones = rig.names.length;
    this.bones = bones;
    const { root, skeleton } = makeSkeleton(rig);
    const group = new THREE.Group();
    group.add(root);
    const mixer = new THREE.AnimationMixer(group);
    let rows = 0;
    const plan: { name: string; clip: THREE.AnimationClip; frames: number }[] = [];
    for (const name of names) {
      const clip = assets.clips.get(name);
      if (!clip) continue;
      const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS) + 1);
      plan.push({ name, clip, frames });
      rows += frames;
    }
    this.rows = rows;
    const width = bones * 3;
    const data = new Uint16Array(width * rows * 4);
    let row = 0;
    const m = new THREE.Matrix4();
    for (const { name, clip, frames } of plan) {
      const action = mixer.clipAction(clip);
      action.play();
      for (let f = 0; f < frames; f++) {
        const t = Math.min(clip.duration, f / BAKE_FPS);
        action.time = t;
        mixer.update(0);
        group.updateMatrixWorld(true);
        for (let b = 0; b < bones; b++) {
          m.multiplyMatrices(skeleton.bones[b].matrixWorld, skeleton.boneInverses[b]);
          const e = m.elements;
          // rows of the 3x4: element (r, c) is e[c * 4 + r]
          for (let r = 0; r < 3; r++) {
            const o = ((row * width) + b * 3 + r) * 4;
            data[o] = THREE.DataUtils.toHalfFloat(e[r]);
            data[o + 1] = THREE.DataUtils.toHalfFloat(e[4 + r]);
            data[o + 2] = THREE.DataUtils.toHalfFloat(e[8 + r]);
            data[o + 3] = THREE.DataUtils.toHalfFloat(e[12 + r]);
          }
        }
        row++;
      }
      action.stop();
      mixer.uncacheClip(clip);
      this.clips.set(name, { base: row - frames, frames, duration: clip.duration, loop: !['punch', 'enter_car', 'exit_car', 'flinch', 'getup_back', 'getup_front'].includes(name) });
    }
    skeleton.dispose();
    this.texture = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Frame numbers (a, b, blend) of a clip at position `u` (0 to 1, a loop wraps). */
  sample(name: string, u: number, out: { a: number; b: number; t: number }) {
    const c = this.clips.get(name) ?? this.clips.get('idle')!;
    const span = c.frames - 1;
    let x = (c.loop ? u - Math.floor(u) : Math.min(1, Math.max(0, u))) * span;
    if (x >= span) x = span - 1e-4;
    const i = Math.floor(x);
    out.a = c.base + i;
    out.b = c.base + Math.min(span, i + 1);
    out.t = x - i;
    return out;
  }

  dispose() {
    this.texture.dispose();
  }
}
