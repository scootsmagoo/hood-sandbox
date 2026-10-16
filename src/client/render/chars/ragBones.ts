/**
 * Ragdoll to bones. The sim's ragdoll is eleven rigid parts (shared/ragdoll.ts); each gives the world
 * rotation of its part (identity is the standing rest pose) and the pelvis gives the position. The
 * skeleton's bones follow that rule: a bone's pose is a rotation `d` in the figure's rest axes,
 * carried by its parent (see tools/blender/characters/anim.py), so a bone driven by part k whose
 * nearest driven ancestor is part j gets d = Q_j^-1 Q_k, and bones with no part keep d = identity
 * and ride along. In three.js terms the bone's local quaternion is R_parent^-1 . d . R_bone, with R the
 * bones' rest rotations in the figure frame.
 */
import * as THREE from 'three';
import { RAG_PARTS, RagPart } from '../../../shared/ragdoll';
import type { CharRig } from './characterAssets';

/** Which ragdoll part drives each bone (by name); the others follow their parent. */
export const BONE_PART: Readonly<Record<string, number>> = {
  pelvis: RagPart.Pelvis,
  spine: RagPart.Torso,
  head: RagPart.Head,
  upperarm_L: RagPart.UpperArmL,
  forearm_L: RagPart.LowerArmL,
  upperarm_R: RagPart.UpperArmR,
  forearm_R: RagPart.LowerArmR,
  thigh_L: RagPart.ThighL,
  shin_L: RagPart.ShinL,
  thigh_R: RagPart.ThighR,
  shin_R: RagPart.ShinR,
};

export class RagBones {
  /** Per bone: its part (or -1) and the part of its nearest driven ancestor (or -1). */
  readonly part: Int8Array;
  readonly ancestorPart: Int8Array;
  private readonly rest: THREE.Quaternion[];
  private readonly restInv: THREE.Quaternion[];
  private readonly q = new THREE.Quaternion();
  private readonly qp = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();

  constructor(readonly rig: CharRig) {
    const n = rig.names.length;
    this.part = new Int8Array(n).fill(-1);
    this.ancestorPart = new Int8Array(n).fill(-1);
    this.rest = [];
    this.restInv = [];
    for (let i = 0; i < n; i++) {
      this.part[i] = BONE_PART[rig.names[i]] ?? -1;
      const p = rig.parent[i];
      if (p >= 0) this.ancestorPart[i] = this.part[p] >= 0 ? this.part[p] : this.ancestorPart[p];
      const r = new THREE.Quaternion().fromArray(rig.restWorldQuat, i * 4);
      this.rest.push(r);
      this.restInv.push(r.clone().invert());
    }
  }

  /**
   * Sets the bones' local rotations (and the pelvis' position) from a ragdoll pose: `pos` is 11 x 3
   * part positions, `rot` 11 x 4 part rotations (x, y, z, w), world frame.
   */
  apply(bones: readonly THREE.Bone[], pos: ArrayLike<number>, rot: ArrayLike<number>) {
    const rig = this.rig;
    for (let i = 0; i < bones.length; i++) {
      const k = this.part[i];
      const pa = this.ancestorPart[i];
      const parent = rig.parent[i];
      // d = Q_parent^-1 Q_k
      if (k >= 0) {
        this.q.fromArray(rot as number[], k * 4);
        if (pa >= 0) this.q.premultiply(this.qp.fromArray(rot as number[], pa * 4).invert());
      } else this.q.identity();
      // local = R_parent^-1 . d . R_bone
      this.q.multiply(this.rest[i]);
      if (parent >= 0) this.q.premultiply(this.restInv[parent]);
      bones[i].quaternion.copy(this.q);
    }
    // the pelvis bone follows the ragdoll's pelvis centre; the root bone stays at the feet's origin
    const pelvis = rig.index.get('pelvis')!;
    const parent = rig.parent[pelvis];
    this.v.set(pos[0], pos[1], pos[2]);
    if (parent >= 0) {
      this.v.x -= rig.restWorldPos[parent * 3];
      this.v.y -= rig.restWorldPos[parent * 3 + 1];
      this.v.z -= rig.restWorldPos[parent * 3 + 2];
      this.v.applyQuaternion(this.restInv[parent]);
    }
    bones[pelvis].position.copy(this.v);
  }

  /** Back to the bind pose (for a figure that stops being a ragdoll). */
  reset(bones: readonly THREE.Bone[]) {
    const rig = this.rig;
    for (let i = 0; i < bones.length; i++) {
      bones[i].position.fromArray(rig.restPos, i * 3);
      bones[i].quaternion.fromArray(rig.restQuat, i * 4);
    }
  }
}

export { RAG_PARTS };
