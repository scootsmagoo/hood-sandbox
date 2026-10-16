/**
 * The far crowd: everyone who is not close enough to be a `PedActor`, drawn as instances of skinned
 * meshes with baked animation (see `BakedAnims`, `pedMaterial.ts`). One InstancedMesh per body and
 * level of detail; a person is written into one of them each frame, so a person changing level of
 * detail needs no bookkeeping, and nothing is allocated when people come and go. A draw call a body
 * type in use (at most fourteen) and one more for the shadows of each, however many people.
 *
 * Per person this holds the palette row (a texture row), the animation state (phase, a cross-fade
 * from the clip they were playing) and the body type.
 */
import * as THREE from 'three';
import type { Quat } from '../../../shared/math';
import { PlanBuffer, planInto, topTwo, type AnimInput, type Layer } from './animSelect';
import { BakedAnims } from './BakedAnims';
import type { CharacterAssets } from './characterAssets';
import { crowdDepthMaterial, crowdMaterial, bakedAnimUniform, crowdPaletteUniform } from './pedMaterial';
import { ARCHETYPES, REGION_COUNT, unit, type Appearance } from './outfits';

/** Crowd level of detail: LOD1 up to here (m, at lodScale 1), LOD2 beyond; actors take LOD0. */
export const CROWD_LOD1_RANGE = 30;

const linToSrgb8 = (c: number) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));

interface Person {
  slot: number;
  arch: number;
  height: number;
  width: number;
  seed: number;
  phase: number;
  clock: number;
  primary: string;
  /** The clip faded out of, and where it was; `fade` runs 0 to 1. */
  from: string;
  fromU: number;
  fade: number;
  lastU: number;
}

const FADE_S = 0.28;
const baseName = (c: string) => c.replace('@lower', '').replace('@upper', '');

export class SkinnedCrowd {
  readonly group = new THREE.Group();
  private readonly meshes: (THREE.InstancedMesh | null)[][] = [];
  private readonly people = new Map<number, Person>();
  private readonly free: number[] = [];
  private readonly palette: DataTexture8;
  private readonly depth = crowdDepthMaterial();
  private readonly mat = crowdMaterial();
  private readonly anims: BakedAnims;
  private readonly counts: number[][] = [];
  /** The instance attribute arrays of each mesh, by body and level, so a frame does no lookups. */
  private readonly arrA: (Float32Array | null)[][] = [];
  private readonly arrB: (Float32Array | null)[][] = [];
  private lodScale = 1;
  private readonly cam = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly fa = { a: 0, b: 0, t: 0 };
  private readonly fb = { a: 0, b: 0, t: 0 };
  private readonly plan = new PlanBuffer();

  constructor(readonly assets: CharacterAssets, readonly capacity = 192) {
    this.anims = new BakedAnims(assets);
    bakedAnimUniform.value = this.anims.texture;
    this.palette = new THREE.DataTexture(new Uint8Array(REGION_COUNT * capacity * 4).fill(255), REGION_COUNT, capacity, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.palette.colorSpace = THREE.SRGBColorSpace;
    this.palette.minFilter = this.palette.magFilter = THREE.NearestFilter;
    this.palette.generateMipmaps = false;
    this.palette.needsUpdate = true;
    crowdPaletteUniform.value = this.palette;
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    this.group.name = 'crowd';
    ARCHETYPES.forEach((arch) => {
      const row: (THREE.InstancedMesh | null)[] = [null, null];
      const counts = [0, 0];
      const aa: (Float32Array | null)[] = [null, null];
      const bb: (Float32Array | null)[] = [null, null];
      [1, 2].forEach((lod, li) => {
        const src = assets.geos.get(`${arch}_lod${lod}`);
        if (!src) return;
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
        g.setIndex(src.getIndex());
        g.boundingSphere = src.boundingSphere;
        const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        const b = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        a.setUsage(THREE.DynamicDrawUsage);
        b.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aAnimA', a);
        g.setAttribute('aAnimB', b);
        const mesh = new THREE.InstancedMesh(g, this.mat, capacity);
        mesh.name = `crowd-${arch}-lod${lod}`;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.customDepthMaterial = this.depth;
        mesh.count = 0;
        mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        row[li] = mesh;
        aa[li] = a.array as Float32Array;
        bb[li] = b.array as Float32Array;
      });
      this.meshes.push(row);
      this.arrA.push(aa);
      this.arrB.push(bb);
      this.counts.push(counts);
    });
  }

  get size() {
    return this.people.size;
  }

  has(id: number) {
    return this.people.has(id);
  }

  add(id: number, a: Appearance): boolean {
    if (this.people.has(id)) return true;
    const slot = this.free.pop();
    if (slot === undefined) return false;
    const arch = Math.max(0, ARCHETYPES.indexOf(a.arch));
    this.people.set(id, { slot, arch, height: a.height, width: a.width, seed: unit(id, 31) * 40, phase: unit(id, 32), clock: 0, primary: 'idle', from: 'idle', fromU: 0, fade: 1, lastU: 0 });
    const d = this.palette.image.data as Uint8Array;
    for (let r = 0; r < REGION_COUNT; r++) {
      const o = (slot * REGION_COUNT + r) * 4;
      d[o] = linToSrgb8(a.palette[r * 3]);
      d[o + 1] = linToSrgb8(a.palette[r * 3 + 1]);
      d[o + 2] = linToSrgb8(a.palette[r * 3 + 2]);
      d[o + 3] = 255;
    }
    this.palette.needsUpdate = true;
    return true;
  }

  remove(id: number) {
    const p = this.people.get(id);
    if (!p) return;
    this.free.push(p.slot);
    this.people.delete(id);
  }

  setShadows(on: boolean) {
    for (const row of this.meshes) for (const m of row) if (m) m.castShadow = on;
  }

  /** Start of a frame: forget last frame's instances. */
  begin(cam: THREE.Vector3, lodScale: number) {
    this.cam.copy(cam);
    this.lodScale = lodScale;
    for (const c of this.counts) c[0] = c[1] = 0;
  }

  /** Writes one person for this frame. */
  place(id: number, dt: number, x: number, y: number, z: number, q: Quat, input: AnimInput) {
    const plan = planInto(this.plan, input);
    const P = this.people.get(id);
    if (!P) return;
    const { layers, cadence } = plan;
    const [A, B] = topTwo(layers);
    const nameA = baseName(A.clip);
    P.clock += dt;
    P.phase = (P.phase + dt * cadence) % 1;
    if (nameA !== P.primary) {
      // a new state: fade out of the old clip, held where it was
      P.from = P.primary;
      P.fromU = P.lastU;
      P.fade = 0;
      P.primary = nameA;
    }
    const uA = this.u(P, A);
    P.lastU = uA;
    this.anims.sample(nameA, uA, this.fa);
    let wB = 0;
    let nameB = nameA;
    let uB = uA;
    if (P.fade < 1) {
      P.fade = Math.min(1, P.fade + dt / FADE_S);
      nameB = P.from;
      uB = P.fromU;
      wB = 1 - P.fade * P.fade * (3 - 2 * P.fade);
    } else if (B && B.weight > 0.01) {
      nameB = baseName(B.clip);
      uB = this.u(P, B);
      wB = B.weight / (A.weight + B.weight);
    }
    this.anims.sample(nameB, uB, this.fb);
    // where in which mesh
    const dist = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z) / Math.max(0.1, this.lodScale);
    const li = dist < CROWD_LOD1_RANGE ? 0 : 1;
    const mesh = this.meshes[P.arch][li] ?? this.meshes[0][li];
    if (!mesh) return;
    const row = this.meshes[P.arch][li] ? P.arch : 0;
    const i = this.counts[row][li]++;
    if (i >= this.capacity) return;
    this.m.compose(this.p.set(x, y, z), this.q.set(q.x, q.y, q.z, q.w), this.s.set(P.width, P.height, P.width));
    this.m.toArray(mesh.instanceMatrix.array as Float32Array, i * 16);
    const ga = this.arrA[row][li]!;
    const gb = this.arrB[row][li]!;
    ga[i * 4] = this.fa.a;
    ga[i * 4 + 1] = this.fa.b;
    ga[i * 4 + 2] = this.fa.t;
    ga[i * 4 + 3] = wB;
    gb[i * 4] = this.fb.a;
    gb[i * 4 + 1] = this.fb.b;
    gb[i * 4 + 2] = this.fb.t;
    gb[i * 4 + 3] = P.slot;
  }

  private u(P: Person, l: Layer): number {
    if (l.time === 'fixed') return l.u ?? 0;
    if (l.time === 'loco') return P.phase;
    const c = this.anims.clips.get(baseName(l.clip));
    const dur = c?.duration ?? 4;
    return ((P.clock + P.seed) / dur) % 1;
  }

  /** Call once after every `place` of the frame. */
  commit(warm = false) {
    this.meshes.forEach((row, a) =>
      row.forEach((mesh, li) => {
        if (!mesh) return;
        const n = this.counts[a][li];
        mesh.count = Math.min(n, this.capacity);
        mesh.visible = n > 0 || warm;
        if (n > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          (mesh.geometry.getAttribute('aAnimA') as THREE.InstancedBufferAttribute).needsUpdate = true;
          (mesh.geometry.getAttribute('aAnimB') as THREE.InstancedBufferAttribute).needsUpdate = true;
        }
      }),
    );
  }

  dispose() {
    for (const row of this.meshes) for (const m of row) if (m) {
      m.geometry.dispose();
      m.dispose();
    }
    this.anims.dispose();
    this.palette.dispose();
    this.mat.dispose();
    this.depth.dispose();
    bakedAnimUniform.value = null;
    crowdPaletteUniform.value = null;
  }
}

type DataTexture8 = THREE.DataTexture;
