/**
 * Pedestrians drawn as instances. A per-ped model is thirteen meshes, so sixty people would cost
 * about eight hundred draw calls; here every person is a few instances of five shared meshes (the
 * torso, the head, the arms, the legs and a cap), so the whole crowd costs five draws (ten with
 * shadows) however many people there are. The matrices come from the same pose solver as the
 * individual model (`pedPose.ts`).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Quat } from '../../shared/math';
import type { PedLook } from './models';
import type { PedJoints } from './pedPose';

const tint = (g: THREE.BufferGeometry, v: number) => {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  return g;
};

interface Geos {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
}
let geos: Geos | null = null;
function geometries(): Geos {
  if (geos) return geos;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const leg = mergeGeometries([tint(box(0.17, 0.86, 0.2, 0, -0.43, 0).toNonIndexed(), 1), tint(box(0.19, 0.12, 0.3, 0, -0.82, 0.05).toNonIndexed(), 0.1)])!;
  geos = {
    torso: new THREE.BoxGeometry(0.44, 0.6, 0.26).translate(0, 0.3, 0),
    head: new THREE.SphereGeometry(0.115, 9, 6).translate(0, 0.72, 0.01),
    cap: new THREE.BoxGeometry(0.25, 0.06, 0.28).translate(0, 0.81, 0.04),
    arm: new THREE.BoxGeometry(0.12, 0.6, 0.14).translate(0, -0.3, 0),
    leg,
  };
  return geos;
}

/** A cheap hash of an entity id to 0..1, per salt. */
const unit = (id: number, salt: number) => {
  let h = (Math.imul(id + 1, 2654435761) ^ Math.imul(salt + 7, 40503)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

/** The five outfits worn by a hundred people look alike: shift each person's colours a little, from their id. */
export function varyLook(look: PedLook, id: number): PedLook {
  const shift = (rgb: number, hue: number, sat: number, lum: number) => {
    const c = new THREE.Color(rgb);
    c.offsetHSL(hue, sat, lum);
    return c.getHex();
  };
  return {
    jacket: shift(look.jacket, (unit(id, 1) - 0.5) * 0.22, (unit(id, 2) - 0.5) * 0.25, (unit(id, 3) - 0.5) * 0.2),
    jeans: shift(look.jeans, (unit(id, 4) - 0.5) * 0.1, (unit(id, 5) - 0.5) * 0.15, (unit(id, 6) - 0.5) * 0.14),
    skin: shift(look.skin, 0, 0, (unit(id, 7) - 0.5) * 0.2),
    cap: look.cap !== null ? shift(look.cap, (unit(id, 8) - 0.5) * 0.4, 0, (unit(id, 9) - 0.5) * 0.12) : unit(id, 10) < 0.16 ? shift(0x2a2d33, (unit(id, 11) - 0.5) * 0.8, 0.1, 0) : null,
  };
}

/** Body height of a person, 0.93 to 1.07 of the standard figure. */
export const heightOf = (id: number) => 0.93 + unit(id, 12) * 0.14;

const X = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const colour = new THREE.Color();

export class PedCrowd {
  readonly group = new THREE.Group();
  private readonly meshes: { torso: THREE.InstancedMesh; head: THREE.InstancedMesh; cap: THREE.InstancedMesh; arms: THREE.InstancedMesh; legs: THREE.InstancedMesh };
  private readonly ids: number[] = [];
  private readonly index = new Map<number, number>();
  private readonly hasCap: boolean[] = [];
  private readonly height: number[] = [];
  private readonly mats: THREE.MeshStandardMaterial[];
  // scratch
  private readonly root = new THREE.Matrix4();
  private readonly inner = new THREE.Matrix4();
  private readonly m0 = new THREE.Matrix4();
  private readonly t = new THREE.Matrix4();
  private readonly r = new THREE.Matrix4();
  private readonly part = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(readonly capacity = 192) {
    const g = geometries();
    const plain = () => new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const legsMat = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.frustumCulled = false;
      m.castShadow = true;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    const torsoMat = plain(), headMat = new THREE.MeshStandardMaterial({ roughness: 0.7 }), capMat = plain();
    this.mats = [torsoMat, headMat, capMat, legsMat];
    this.meshes = {
      torso: mk(g.torso, torsoMat, capacity),
      head: mk(g.head, headMat, capacity),
      cap: mk(g.cap, capMat, capacity),
      arms: mk(g.arm, torsoMat, capacity * 2),
      legs: mk(g.leg, legsMat, capacity * 2),
    };
    this.group.name = 'crowd';
    // colours exist from the start so the first setColorAt does not allocate mid-frame
    for (const m of Object.values(this.meshes)) m.setColorAt(0, colour.set(0xffffff));
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: number): boolean {
    return this.index.has(id);
  }

  /** Adds a person; false when the crowd is full. */
  add(id: number, look: PedLook): boolean {
    if (this.index.has(id)) return true;
    const i = this.ids.length;
    if (i >= this.capacity) return false;
    this.ids.push(id);
    this.index.set(id, i);
    this.hasCap.push(look.cap !== null);
    this.height.push(heightOf(id));
    this.colourise(i, look);
    this.setCounts();
    return true;
  }

  private colourise(i: number, look: PedLook) {
    const m = this.meshes;
    m.torso.setColorAt(i, colour.set(look.jacket));
    m.head.setColorAt(i, colour.set(look.skin));
    m.cap.setColorAt(i, colour.set(look.cap ?? 0));
    m.arms.setColorAt(2 * i, colour.set(look.jacket));
    m.arms.setColorAt(2 * i + 1, colour.set(look.jacket));
    m.legs.setColorAt(2 * i, colour.set(look.jeans));
    m.legs.setColorAt(2 * i + 1, colour.set(look.jeans));
    for (const mesh of Object.values(m)) mesh.instanceColor!.needsUpdate = true;
  }

  private setCounts() {
    const n = this.ids.length;
    const m = this.meshes;
    m.torso.count = m.head.count = m.cap.count = n;
    m.arms.count = m.legs.count = 2 * n;
  }

  remove(id: number) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const last = this.ids.length - 1;
    if (i !== last) {
      const moved = this.ids[last];
      this.ids[i] = moved;
      this.index.set(moved, i);
      this.hasCap[i] = this.hasCap[last];
      this.height[i] = this.height[last];
      const m = this.meshes;
      copy(m.torso, last, i);
      copy(m.head, last, i);
      copy(m.cap, last, i);
      copy(m.arms, 2 * last, 2 * i);
      copy(m.arms, 2 * last + 1, 2 * i + 1);
      copy(m.legs, 2 * last, 2 * i);
      copy(m.legs, 2 * last + 1, 2 * i + 1);
    }
    this.ids.pop();
    this.hasCap.pop();
    this.height.pop();
    this.index.delete(id);
    this.setCounts();
  }

  setShadows(on: boolean) {
    for (const m of Object.values(this.meshes)) m.castShadow = on;
  }

  /** Writes one person's matrices from where they stand and how they are posed. */
  place(id: number, x: number, y: number, z: number, q: Quat, j: PedJoints) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const m = this.meshes;
    this.root.compose(this.p.set(x, y, z), this.q.set(q.x, q.y, q.z, q.w), ONE);
    this.q.setFromAxisAngle(X, j.tiltX);
    this.inner.compose(this.p.set(0, j.shiftY, j.shiftZ), this.q, this.s.setScalar(j.scale * this.height[i]));
    this.m0.multiplyMatrices(this.root, this.inner);
    // torso, head and cap share a matrix: hips, then twist, then lean
    this.part.multiplyMatrices(this.m0, this.t.makeTranslation(0, 0.9 + j.torsoLift, 0));
    this.tmp.makeRotationY(j.torsoY);
    this.part.multiply(this.tmp);
    this.tmp.makeRotationX(j.torsoX);
    this.part.multiply(this.tmp);
    this.part.toArray(m.torso.instanceMatrix.array as Float32Array, i * 16);
    this.part.toArray(m.head.instanceMatrix.array as Float32Array, i * 16);
    if (this.hasCap[i]) this.part.toArray(m.cap.instanceMatrix.array as Float32Array, i * 16);
    else this.hidden.toArray(m.cap.instanceMatrix.array as Float32Array, i * 16);
    // limbs hang from the hips and the shoulders
    this.limb(m.legs, 2 * i, 0.1, 0.9, j.legL, 0);
    this.limb(m.legs, 2 * i + 1, -0.1, 0.9, j.legR, 0);
    this.limb(m.arms, 2 * i, 0.27, 1.48, j.armL, j.armLz);
    this.limb(m.arms, 2 * i + 1, -0.27, 1.48, j.armR, j.armRz);
  }

  private limb(mesh: THREE.InstancedMesh, slot: number, px: number, py: number, rx: number, rz: number) {
    this.part.multiplyMatrices(this.m0, this.t.makeTranslation(px, py, 0));
    this.tmp.makeRotationX(rx);
    this.part.multiply(this.tmp);
    if (rz !== 0) {
      this.tmp.makeRotationZ(rz);
      this.part.multiply(this.tmp);
    }
    this.part.toArray(mesh.instanceMatrix.array as Float32Array, slot * 16);
  }

  /** Call once after placing everyone this frame. */
  commit() {
    for (const m of Object.values(this.meshes)) m.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of Object.values(this.meshes)) m.dispose();
    for (const mt of this.mats) mt.dispose();
  }
}

function copy(mesh: THREE.InstancedMesh, from: number, to: number) {
  const a = mesh.instanceMatrix.array as Float32Array;
  a.copyWithin(to * 16, from * 16, from * 16 + 16);
  if (mesh.instanceColor) {
    const c = mesh.instanceColor.array as Float32Array;
    c.copyWithin(to * 3, from * 3, from * 3 + 3);
    mesh.instanceColor.needsUpdate = true;
  }
}
