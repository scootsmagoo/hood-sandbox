/**
 * Ragdolls drawn on the block figure. A ped whose body is a ragdoll (`PedFlag.Ragdoll`) is drawn from
 * its ragdoll record instead of its posed model: the same boxes as the stand-in figure (torso, head,
 * cap, arms, legs and boots, in the person's own colours) split at the waist, the elbows and the
 * knees, each placed where the sim's part is. The record is the pelvis and eleven rotations; the part
 * positions come from the joints (shared/ragdoll.ts), blended between the two snapshots around the
 * render time like every other entity.
 *
 * A pool of instanced meshes, made once (one draw per part kind, nothing while nobody is down). A
 * corpse whose record has dropped out of the snapshot (more frozen bodies than records) keeps the
 * last pose seen, so it lies as it fell.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EntityId } from '../../shared/entities';
import { nlerpQuat, type Quat } from '../../shared/math';
import { RAG_PARTS, RAG_RIG, forwardKinematics, unpackQuat } from '../../shared/ragdoll';
import { RG } from '../../shared/snapshot';
import type { Sample } from '../net/Interpolator';
import type { PedLook } from './models';

interface Pose {
  pos: Float32Array;
  rot: Float32Array;
  /** Frame it was last refreshed from a record. */
  frame: number;
}

/** Which colour of the look each part wears. */
const PART_COLOUR: ('jacket' | 'jeans' | 'skin')[] = ['jacket', 'jacket', 'skin', 'jacket', 'jacket', 'jacket', 'jacket', 'jeans', 'jeans', 'jeans', 'jeans'];

const tint = (g: THREE.BufferGeometry, v: number) => {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  return g;
};

const qa: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qb: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qo: Quat = { x: 0, y: 0, z: 0, w: 1 };
const ra = new Float32Array(4);
const rb = new Float32Array(4);

export class RagdollFigures {
  readonly group = new THREE.Group();
  /** One instanced mesh per part, and the cap. */
  private readonly parts: THREE.InstancedMesh[] = [];
  private readonly cap: THREE.InstancedMesh;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly poses = new Map<EntityId, Pose>();
  private n = 0;
  private frame = 0;
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly colour = new THREE.Color();

  constructor(readonly capacity = 24) {
    this.group.name = 'ragdolls';
    const plain = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const legs = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    this.mats.push(plain, legs, skin);
    for (let i = 0; i < RAG_PARTS; i++) {
      const d = RAG_RIG[i].draw;
      let geo: THREE.BufferGeometry;
      if (i === 2) geo = new THREE.SphereGeometry(0.115, 9, 6);
      else if (i === 8 || i === 10) {
        // a shin with its boot, as the crowd's leg is drawn
        geo = mergeGeometries([
          tint(new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]).translate(d.offset[0], d.offset[1], d.offset[2]).toNonIndexed(), 1),
          tint(new THREE.BoxGeometry(0.19, 0.12, 0.3).translate(0, -0.17, 0.02).toNonIndexed(), 0.1),
        ])!;
      } else {
        geo = new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]).translate(d.offset[0], d.offset[1], d.offset[2]);
        if (i >= 7) tint(geo, 1);
      }
      this.geos.push(geo);
      const mesh = new THREE.InstancedMesh(geo, i === 2 ? skin : i >= 7 ? legs : plain, capacity);
      this.setup(mesh);
      this.parts.push(mesh);
    }
    const capGeo = new THREE.BoxGeometry(0.25, 0.06, 0.28).translate(0, 0.09, 0.03);
    this.geos.push(capGeo);
    this.cap = new THREE.InstancedMesh(capGeo, plain, capacity);
    this.setup(this.cap);
  }

  private setup(mesh: THREE.InstancedMesh) {
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    mesh.visible = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.colour.set(0xffffff));
    this.group.add(mesh);
  }

  setShadows(on: boolean) {
    for (const m of this.parts) m.castShadow = on;
    this.cap.castShadow = on;
  }

  /** Call at the start of a frame, before any `place`. */
  begin() {
    this.n = 0;
    this.frame++;
  }

  /**
   * Refreshes a ped's pose from the snapshots around the render time. True when there is a pose to draw (from a record now,
   * or the last one seen for a body whose record has dropped out).
   */
  update(sample: Sample | null, id: EntityId): boolean {
    let pose = this.poses.get(id);
    if (sample) {
      const b = sample.b;
      const ib = b.ragdollIndexOf(id);
      if (ib >= 0) {
        if (!pose) this.poses.set(id, (pose = { pos: new Float32Array(RAG_PARTS * 3), rot: new Float32Array(RAG_PARTS * 4), frame: 0 }));
        const ob = b.ragdollAt(ib);
        const ia = sample.a === b ? ib : sample.a.ragdollIndexOf(id);
        const k = ia >= 0 ? Math.min(1, Math.max(0, sample.alpha)) : 1;
        const oa = ia >= 0 ? sample.a.ragdollAt(ia) : ob;
        const fa = ia >= 0 ? sample.a.f32 : b.f32;
        const ua = ia >= 0 ? sample.a.u32 : b.u32;
        for (let i = 0; i < RAG_PARTS; i++) {
          unpackQuat(ua, oa + RG.Rot + i * 2, ra, 0);
          unpackQuat(b.u32, ob + RG.Rot + i * 2, rb, 0);
          qa.x = ra[0]; qa.y = ra[1]; qa.z = ra[2]; qa.w = ra[3];
          qb.x = rb[0]; qb.y = rb[1]; qb.z = rb[2]; qb.w = rb[3];
          nlerpQuat(qa, qb, k, qo);
          pose.rot[i * 4] = qo.x;
          pose.rot[i * 4 + 1] = qo.y;
          pose.rot[i * 4 + 2] = qo.z;
          pose.rot[i * 4 + 3] = qo.w;
        }
        const pv = { x: 0, y: 0, z: 0 };
        pv.x = fa[oa + RG.Px] + (b.f32[ob + RG.Px] - fa[oa + RG.Px]) * k;
        pv.y = fa[oa + RG.Py] + (b.f32[ob + RG.Py] - fa[oa + RG.Py]) * k;
        pv.z = fa[oa + RG.Pz] + (b.f32[ob + RG.Pz] - fa[oa + RG.Pz]) * k;
        forwardKinematics(pv, pose.rot, pose.pos);
        pose.frame = this.frame;
      }
    }
    return !!pose;
  }

  /** Draws a ped's body from its pose in its colours. */
  place(id: EntityId, look: PedLook) {
    const pose = this.poses.get(id);
    if (!pose || this.n >= this.capacity) return;
    const slot = this.n++;
    for (let i = 0; i < RAG_PARTS; i++) {
      this.q.set(pose.rot[i * 4], pose.rot[i * 4 + 1], pose.rot[i * 4 + 2], pose.rot[i * 4 + 3]);
      this.p.set(pose.pos[i * 3], pose.pos[i * 3 + 1], pose.pos[i * 3 + 2]);
      this.m.compose(this.p, this.q, this.one);
      const mesh = this.parts[i];
      mesh.setMatrixAt(slot, this.m);
      mesh.setColorAt(slot, this.colour.set(look[PART_COLOUR[i]]));
      if (i === 2) {
        if (look.cap !== null) {
          this.cap.setMatrixAt(slot, this.m);
          this.cap.setColorAt(slot, this.colour.set(look.cap));
        } else {
          this.m.makeScale(0, 0, 0);
          this.cap.setMatrixAt(slot, this.m);
        }
      }
    }
  }

  /** Call once after placing everyone this frame. */
  end() {
    for (const mesh of [...this.parts, this.cap]) {
      mesh.count = this.n;
      mesh.visible = this.n > 0;
      if (this.n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Forgets a ped's pose (it got up, or is gone). */
  forget(id: EntityId) {
    this.poses.delete(id);
  }

  /** Whether a pose is kept for a ped. */
  has(id: EntityId): boolean {
    return this.poses.has(id);
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const mesh of [...this.parts, this.cap]) mesh.dispose();
  }
}
