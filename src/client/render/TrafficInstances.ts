/**
 * Traffic cars drawn as instances. A full car model is some 20 meshes; forty of them would eat the
 * draw-call budget on their own (and every one is built and torn down as cars come and go). So every
 * ambient traffic car is drawn from a handful of InstancedMeshes per vehicle type and level of detail:
 * the Blender asset's parts (carAssets.ts) merged by how they are shaded, with the paint colour, the
 * grime, the brake, reverse and head lamps set per instance, and the four wheels as instances of
 * their own so they roll and steer. Only a car that is damaged, smokes, burns or has a door open (or
 * that stopped being traffic) gets a full model (carModel.ts).
 *
 *   paint   body panels (body, door, bonnet, bumpers), tinted per car (instance colour), grime per car
 *   detail  trim, chrome and the interior: vertex colours, with roughness and metalness per vertex
 *   glass   the windows: see-through, so the driver shows
 *   lamp    head, tail and reverse lamps in one mesh, the brightness of each kind per car
 *   wheel   tyre and rim, one instance per wheel (the right-hand ones turned half round)
 *
 * Levels of detail by distance from the camera (scaled by the tier's lodScale): LOD0 only very close
 * (the full 8k-triangle model, within 9 m), LOD1 to 55 m, LOD2 beyond. Only the paint casts a shadow (and
 * the wheels at LOD0). That is 5 draws per type and level in use.
 * Without assets (failed to load, or `?cars=box`) the stand-in box car is merged the same way.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HandlingData } from '../../shared/handling';
import { WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import { buildVehicleModel } from './models';
import { carAsset, LAMP_HEAD, LAMP_TAIL, type CarAsset, type CarMat, type CarPartName } from './carAssets';
import { pickLod } from './carLod';
import { BURNT, newCarUniforms, newGlass, newLamp, newPaint, patchCar } from './carMaterials';
import { ownDepth } from './depthMaterials';

type Part = 'paint' | 'detail' | 'glass' | 'lamp' | 'wheel';
const PARTS: Part[] = ['paint', 'detail', 'glass', 'lamp', 'wheel'];
const MAX_PER_SET = 64;
/** Instanced traffic is only drawn at LOD0 this close (m, at lodScale 1): the full model is 8k triangles. */
export const TRAFFIC_LOD0 = 9;

/** Vertex colour and (roughness, metalness) of each detail material, matching carMaterials' shared ones. */
const DETAIL: Partial<Record<CarMat, [number, number, number]>> = {
  trim: [0x18191b, 0.62, 0.1],
  chrome: [0xc9ccd1, 0.18, 1],
  interior: [0x1d1c1b, 0.9, 0],
  tyre: [0x141416, 0.92, 0],
  light_head: [0xcccccc, 0.3, 0],
};

interface LodSet {
  meshes: Record<Part, THREE.InstancedMesh>;
  geos: THREE.BufferGeometry[];
  count: number;
  dirt: THREE.InstancedBufferAttribute;
  lampB: THREE.InstancedBufferAttribute;
}

interface TypeSet {
  lods: LodSet[];
  mounts: { x: number; y: number; z: number }[];
}

const tmpColor = new THREE.Color();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpQ3 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const HALF_TURN = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI);

/** A copy with only position and normal, plus constant vertex colour and shine when asked. */
function prep(g: THREE.BufferGeometry, detail?: [number, number, number]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position').clone());
  out.setAttribute('normal', g.getAttribute('normal').clone());
  const idx = g.getIndex();
  out.setIndex(idx ? idx.clone() : null);
  if (!idx) {
    const n = g.getAttribute('position').count;
    out.setIndex(Array.from({ length: n }, (_, i) => i));
  }
  if (detail) {
    const n = out.getAttribute('position').count;
    const c = tmpColor.setHex(detail[0]);
    const col = new Float32Array(n * 3);
    const shine = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      shine[i * 2] = detail[1];
      shine[i * 2 + 1] = detail[2];
    }
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aShine', new THREE.BufferAttribute(shine, 2));
  }
  return out;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = list.length ? (mergeGeometries(list, false) ?? new THREE.BufferGeometry()) : new THREE.BufferGeometry();
  for (const x of list) x.dispose();
  return g;
}

/** The asset's level `level` merged into the five instanced parts. */
function assetParts(a: CarAsset, level: number): Record<Part, THREE.BufferGeometry> {
  const lod = a.lods[level];
  const lists: Record<Part, THREE.BufferGeometry[]> = { paint: [], detail: [], glass: [], lamp: [], wheel: [] };
  for (const name of ['body', 'door', 'hood', 'bumper_F', 'bumper_R'] as CarPartName[]) {
    const part = lod.parts.get(name);
    if (!part) continue;
    for (const [m, g] of part.geos) {
      if (m === 'paint' || m === 'livery') lists.paint.push(prep(g));
      else if (m === 'glass') lists.glass.push(prep(g));
      else lists.detail.push(prep(g, DETAIL[m] ?? DETAIL.trim));
    }
  }
  if (lod.lamps) {
    const g = prep(lod.lamps);
    g.setAttribute('aLamp', lod.lamps.getAttribute('aLamp').clone());
    lists.lamp.push(g);
  }
  const wheel = lod.parts.get('wheel');
  if (wheel) for (const [m, g] of wheel.geos) lists.wheel.push(prep(g, DETAIL[m] ?? DETAIL.trim));
  return { paint: merge(lists.paint), detail: merge(lists.detail), glass: merge(lists.glass), lamp: merge(lists.lamp), wheel: merge(lists.wheel) };
}

/** The stand-in box car merged the same way (assets missing). */
function standInParts(h: HandlingData): Record<Part, THREE.BufferGeometry> {
  const model = buildVehicleModel(h, 0xffffff);
  model.root.updateMatrixWorld(true);
  const lists: Record<Part, THREE.BufferGeometry[]> = { paint: [], detail: [], glass: [], lamp: [], wheel: [] };
  let wheelPivot: THREE.Object3D | null = null;
  model.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const tag = mat.userData.part as string | undefined;
    if (tag === 'skip') return;
    const isWheel = m.parent?.parent?.parent === model.root;
    if (isWheel) {
      wheelPivot ??= m.parent!.parent!;
      if (m.parent!.parent !== wheelPivot) return;
    }
    const g = m.geometry.clone().applyMatrix4(isWheel ? m.matrix : m.matrixWorld);
    if (isWheel) lists.wheel.push(prep(g, [mat.color.getHex(), 0.8, 0.1]));
    else if (tag === 'paint') lists.paint.push(prep(g));
    else if (tag === 'glass') lists.glass.push(prep(g));
    else if (tag === 'head' || tag === 'tail') {
      const p = prep(g);
      p.setAttribute('aLamp', new THREE.BufferAttribute(new Float32Array(p.getAttribute('position').count).fill(tag === 'head' ? LAMP_HEAD : LAMP_TAIL), 1));
      lists.lamp.push(p);
    } else lists.detail.push(prep(g, [mat.color.getHex(), 0.7, 0.2]));
    g.dispose();
  });
  model.dispose();
  return { paint: merge(lists.paint), detail: merge(lists.detail), glass: merge(lists.glass), lamp: merge(lists.lamp), wheel: merge(lists.wheel) };
}

export class TrafficInstances {
  readonly group = new THREE.Group();
  private readonly types = new Map<string, TypeSet>();
  private readonly mats: Record<Part, THREE.Material>;
  private shadows = false;
  private readonly cam = new THREE.Vector3();
  private lodScale = 1;

  constructor() {
    this.group.name = 'traffic-instances';
    this.group.matrixAutoUpdate = false;
    const detail = patchCar(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }), { kind: 'detail', instanced: true });
    const u = newCarUniforms();
    this.mats = {
      paint: newPaint(0xffffff, u, true),
      detail,
      // its own glass: a material shared with the plain car meshes would be re-resolved at every switch
      glass: patchCar(newGlass(), { kind: 'glass', instanced: true }),
      lamp: newLamp(u, true),
      wheel: detail,
    };
  }

  setShadows(on: boolean) {
    this.shadows = on;
    for (const t of this.types.values()) for (const [level, s] of t.lods.entries()) this.applyShadows(s, level);
  }

  private applyShadows(s: LodSet, level: number) {
    // the body's paint carries the car's shadow; the wheels add theirs only up close
    s.meshes.paint.castShadow = this.shadows && level < 2;
    s.meshes.detail.castShadow = false;
    s.meshes.wheel.castShadow = this.shadows && level === 0;
  }

  /** Which asset (or the stand-in) a type is drawn with. */
  private keyFor(h: HandlingData): { key: string; asset: CarAsset | null } {
    const asset = carAsset(h.id) ?? carAsset('sedan');
    return asset ? { key: `${asset.name}`, asset } : { key: `box-${h.id}`, asset: null };
  }

  private typeFor(h: HandlingData): TypeSet {
    const { key, asset } = this.keyFor(h);
    let t = this.types.get(key);
    if (t) return t;
    const sets: LodSet[] = [];
    const levels = asset ? 3 : 1;
    for (let level = 0; level < levels; level++) {
      const geos = asset ? assetParts(asset, level) : standInParts(h);
      const meshes = {} as Record<Part, THREE.InstancedMesh>;
      const dirt = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_SET), 1);
      const lampB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_SET * 3), 3);
      dirt.setUsage(THREE.DynamicDrawUsage);
      lampB.setUsage(THREE.DynamicDrawUsage);
      geos.paint.setAttribute('aDirt', dirt);
      geos.lamp.setAttribute('aLampB', lampB);
      // the four body parts sit where the car sits: one matrix buffer for them, written and uploaded once
      const bodyMatrix = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_SET * 16), 16);
      bodyMatrix.setUsage(THREE.DynamicDrawUsage);
      for (const p of PARTS) {
        const cap = p === 'wheel' ? MAX_PER_SET * WHEEL_COUNT : MAX_PER_SET;
        const m = new THREE.InstancedMesh(geos[p], this.mats[p], cap);
        m.name = `traffic-${key}-${level}-${p}`;
        m.count = 0;
        m.visible = false;
        m.frustumCulled = false;
        m.matrixAutoUpdate = false; // (identity: the instances carry the poses)
        if (p !== 'wheel') m.instanceMatrix = bodyMatrix;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (p === 'paint') {
          m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
          m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        ownDepth(m);
        m.receiveShadow = p === 'paint' || p === 'detail';
        if (p === 'glass') m.renderOrder = 2;
        this.group.add(m);
        meshes[p] = m;
      }
      const set: LodSet = { meshes, geos: PARTS.map((p) => geos[p]), count: 0, dirt, lampB };
      this.applyShadows(set, level);
      sets.push(set);
    }
    const wb = h.wheels;
    const mounts: TypeSet['mounts'] = [];
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      mounts.push({ x: (left ? 1 : -1) * (front ? wb.trackFront : wb.trackRear) * 0.5, y: wb.mountY, z: front ? wb.frontZ : wb.rearZ });
    }
    t = { lods: sets, mounts };
    this.types.set(key, t);
    return t;
  }

  /** Start of a frame: nothing is drawn until `add` says so. `cam` and `lodScale` pick each car's level of detail. */
  begin(cam?: THREE.Vector3, lodScale = 1) {
    for (const t of this.types.values()) for (const s of t.lods) s.count = 0;
    if (cam) this.cam.copy(cam);
    this.lodScale = lodScale;
  }

  /**
   * Adds one car to this frame. `wear` is 0 to 1 (darkens the paint), `brake` and `reverse` light the
   * tail lamps, `headlamps` is the brightness of the front lamps, `wheels` the snapshot's wheel block
   * (steer, roll, suspension length, slip for each), `dirt` the grime (0 to 1).
   */
  add(
    h: HandlingData,
    color: number,
    x: number,
    y: number,
    z: number,
    q: { x: number; y: number; z: number; w: number },
    wheels: Float32Array,
    wear: number,
    brake: boolean,
    reverse: boolean,
    headlamps: number,
    dirt = 0.3,
  ) {
    const t = this.typeFor(h);
    let level = 0;
    if (t.lods.length > 1) {
      const d = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
      level = d < TRAFFIC_LOD0 * this.lodScale ? 0 : Math.max(1, pickLod(d, this.lodScale));
    }
    const s = t.lods[level];
    const i = s.count;
    if (i >= MAX_PER_SET) return;
    s.count = i + 1;
    tmpP.set(x, y, z);
    tmpQ.set(q.x, q.y, q.z, q.w);
    tmpM.compose(tmpP, tmpQ, one);
    s.meshes.paint.setMatrixAt(i, tmpM); // (the body parts share this buffer)
    // paint: the car's colour, worn toward char
    tmpColor.setHex(color);
    const k = Math.min(0.55, wear * 0.55);
    if (k > 0) tmpColor.lerp(BURNT, k);
    s.meshes.paint.setColorAt(i, tmpColor);
    s.dirt.setX(i, dirt);
    s.lampB.setXYZ(i, headlamps, brake ? 2.4 : 0.3 + Math.max(0, headlamps - 0.5) * 0.35, reverse ? 1.5 : 0);
    // wheels: at the mount point, below it by the suspension's length, turned by the steering and rolled
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const m = t.mounts[w];
      const o = w * WHEEL_FLOATS;
      const left = w % 2 === 0;
      tmpV.set(m.x, m.y - wheels[o + 2], m.z).applyQuaternion(tmpQ);
      tmpP.set(x + tmpV.x, y + tmpV.y, z + tmpV.z);
      tmpQ3.copy(tmpQ).multiply(tmpQ2.setFromAxisAngle(AXIS_Y, wheels[o]));
      if (!left) tmpQ3.multiply(HALF_TURN);
      tmpQ3.multiply(tmpQ2.setFromAxisAngle(AXIS_X, left ? wheels[o + 1] : -wheels[o + 1]));
      tmpM.compose(tmpP, tmpQ3, one);
      s.meshes.wheel.setMatrixAt(i * WHEEL_COUNT + w, tmpM);
    }
  }

  /** Puts one car of each type at every level of detail at `pos` for one frame (the boot's warm-up draw; `end` hides them again). */
  prewarm(types: HandlingData[], pos: THREE.Vector3) {
    tmpM.makeTranslation(pos.x, pos.y, pos.z);
    for (const h of types) {
      for (const s of this.typeFor(h).lods) {
        for (const p of PARTS) {
          const m = s.meshes[p];
          m.setMatrixAt(0, tmpM);
          m.count = 1;
          m.visible = true;
          m.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  /** End of a frame: uploads what changed and hides unused sets. */
  end() {
    for (const t of this.types.values()) {
      for (const s of t.lods) {
        for (const p of PARTS) {
          const m = s.meshes[p];
          m.count = p === 'wheel' ? s.count * WHEEL_COUNT : s.count;
          m.visible = s.count > 0;
          if (!m.visible) continue;
          if (p === 'paint' || p === 'wheel') m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
        if (s.count > 0) {
          s.dirt.needsUpdate = true;
          s.lampB.needsUpdate = true;
        }
      }
    }
  }

  /** Cars drawn this frame at each level of detail (tests and the perf report). */
  counts(): number[] {
    const out = [0, 0, 0];
    for (const t of this.types.values()) t.lods.forEach((s, i) => (out[i] += s.count));
    return out;
  }

  dispose() {
    for (const t of this.types.values()) {
      for (const s of t.lods) {
        for (const g of s.geos) g.dispose();
        for (const p of PARTS) s.meshes[p].dispose();
      }
    }
    this.types.clear();
    this.group.removeFromParent();
    this.mats.paint.dispose();
    this.mats.detail.dispose();
    this.mats.glass.dispose();
    this.mats.lamp.dispose();
  }
}
