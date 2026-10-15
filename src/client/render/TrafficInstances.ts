/**
 * Traffic cars drawn as instances. A full car model is some 25 meshes; forty of them would eat the
 * draw-call budget on their own (and every one is built and torn down as cars come and go). So every
 * ambient traffic car is drawn from a handful of InstancedMeshes per vehicle type: the same stand-in
 * model (`buildVehicleModel`) merged into parts, with the paint colour, the brake lights and the
 * headlamps set per instance, and the four wheels as instances of their own so they roll and steer.
 * Only a car that smokes, burns or has a door open (or that stopped being traffic) gets a full model.
 *
 *   paint   body panels, tinted per car (instance colour)
 *   detail  trim, bumpers: fixed colours
 *   glass   the greenhouse: see-through, so the driver shows
 *   tail    tail lamps, brightness per car: dim, brake, reverse
 *   head    headlamps, brightness per car: dim by day, bright at night
 *   wheel   tyres and spokes, one instance per wheel
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HandlingData } from '../../shared/handling';
import { WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import { buildVehicleModel } from './models';

type Part = 'paint' | 'detail' | 'glass' | 'tail' | 'head' | 'wheel';

const PARTS: Part[] = ['paint', 'detail', 'glass', 'tail', 'head', 'wheel'];
/** Parts that take the whole car's matrix (the wheels have their own). */
const BODY_PARTS: Part[] = ['paint', 'detail', 'glass', 'tail', 'head'];
const MAX_PER_TYPE = 64;

/** Charred colour of a burnt-out shell and of heavy wear, matching the full model. */
const CHAR = new THREE.Color(0x1b1a19);

interface TypeSet {
  meshes: Record<Part, THREE.InstancedMesh>;
  geos: THREE.BufferGeometry[];
  count: number;
  /** wheel mount points in the body's frame (x, y at full extension, z) and the radius */
  mounts: { x: number; z: number; y: number; front: boolean }[];
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

/** The model of a car as merged geometries, one per part, with the material colours baked in as vertex colours. */
function mergedParts(h: HandlingData): Record<Part, THREE.BufferGeometry> {
  const model = buildVehicleModel(h, 0xffffff);
  model.root.updateMatrixWorld(true);
  const lists: Record<Part, THREE.BufferGeometry[]> = { paint: [], detail: [], glass: [], tail: [], head: [], wheel: [] };
  let wheelPivot: THREE.Object3D | null = null;
  model.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const tag = mat.userData.part as Part | 'skip' | undefined;
    if (tag === 'skip') return;
    // wheels are root > pivot > roller > mesh; everything else sits higher up (the door is root > hinge > mesh)
    const isWheel = m.parent?.parent?.parent === model.root;
    // one wheel's parts; the instances put it at all four mounts
    if (isWheel) {
      wheelPivot ??= m.parent!.parent!;
      if (m.parent!.parent !== wheelPivot) return;
    }
    const part: Part = isWheel ? 'wheel' : (tag ?? 'detail');
    const g = m.geometry.clone();
    // a wheel part is kept in its roller's frame, so the instance can spin it about its own axle
    if (isWheel) g.applyMatrix4(m.matrix);
    else g.applyMatrix4(m.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    // Lamps are drawn by colour times instance brightness: a lamp's own colour is its emissive one.
    const c = part === 'tail' ? tmpColor.set(0xff2a1a) : part === 'head' ? tmpColor.set(0xfff1c9) : tmpColor.copy(mat.color);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    lists[part].push(g);
  });
  const geos = {} as Record<Part, THREE.BufferGeometry>;
  for (const p of PARTS) {
    const merged = lists[p].length ? mergeGeometries(lists[p], false) : new THREE.BufferGeometry();
    for (const g of lists[p]) g.dispose();
    geos[p] = merged ?? new THREE.BufferGeometry();
  }
  model.dispose();
  return geos;
}

export class TrafficInstances {
  readonly group = new THREE.Group();
  private readonly types = new Map<string, TypeSet>();
  private readonly mats: Record<Part, THREE.Material>;
  private shadows = false;

  constructor() {
    this.group.name = 'traffic-instances';
    const paintLike = { vertexColors: true, roughness: 0.7, metalness: 0.2 } as const;
    this.mats = {
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.45 }),
      detail: new THREE.MeshStandardMaterial(paintLike),
      glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.5, transparent: true, opacity: 0.55, depthWrite: false }),
      tail: new THREE.MeshBasicMaterial({ vertexColors: true }),
      head: new THREE.MeshBasicMaterial({ vertexColors: true }),
      wheel: new THREE.MeshStandardMaterial({ ...paintLike, roughness: 0.9 }),
    };
  }

  setShadows(on: boolean) {
    this.shadows = on;
    for (const t of this.types.values()) {
      t.meshes.paint.castShadow = on;
      t.meshes.detail.castShadow = on;
      t.meshes.wheel.castShadow = on;
    }
  }

  private typeFor(h: HandlingData): TypeSet {
    let t = this.types.get(h.id);
    if (t) return t;
    const geos = mergedParts(h);
    const meshes = {} as Record<Part, THREE.InstancedMesh>;
    for (const p of PARTS) {
      const cap = p === 'wheel' ? MAX_PER_TYPE * WHEEL_COUNT : MAX_PER_TYPE;
      const m = new THREE.InstancedMesh(geos[p], this.mats[p], cap);
      m.name = `traffic-${h.id}-${p}`;
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (p === 'paint' || p === 'tail' || p === 'head') {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      m.castShadow = this.shadows && (p === 'paint' || p === 'detail' || p === 'wheel');
      m.receiveShadow = p === 'paint' || p === 'detail';
      if (p === 'glass') m.renderOrder = 2;
      this.group.add(m);
      meshes[p] = m;
    }
    const wb = h.wheels;
    const mounts: TypeSet['mounts'] = [];
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      mounts.push({ x: (left ? 1 : -1) * (front ? wb.trackFront : wb.trackRear) * 0.5, y: wb.mountY, z: front ? wb.frontZ : wb.rearZ, front });
    }
    t = { meshes, geos: PARTS.map((p) => geos[p]), count: 0, mounts };
    this.types.set(h.id, t);
    return t;
  }

  /** Start of a frame: nothing is drawn until `add` says so. */
  begin() {
    for (const t of this.types.values()) t.count = 0;
  }

  /**
   * Adds one car to this frame. `wear` is 0 to 1 (darkens the paint), `brake` and `reverse` light the
   * tail lamps, `headlamps` is the brightness of the front lamps, `wheels` the snapshot's wheel block
   * (steer, roll, suspension length, slip for each).
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
  ) {
    const t = this.typeFor(h);
    const i = t.count;
    if (i >= MAX_PER_TYPE) return;
    t.count = i + 1;
    tmpP.set(x, y, z);
    tmpQ.set(q.x, q.y, q.z, q.w);
    tmpM.compose(tmpP, tmpQ, one);
    for (const p of BODY_PARTS) t.meshes[p].setMatrixAt(i, tmpM);
    // paint: the car's colour, worn toward char
    tmpColor.setHex(color);
    const k = Math.min(0.55, wear * 0.55);
    if (k > 0) tmpColor.lerp(CHAR, k);
    t.meshes.paint.setColorAt(i, tmpColor);
    const tail = brake ? 2.4 : reverse ? 1.1 : 0.28;
    tmpColor.setRGB(tail, tail, tail);
    t.meshes.tail.setColorAt(i, tmpColor);
    tmpColor.setRGB(headlamps, headlamps, headlamps);
    t.meshes.head.setColorAt(i, tmpColor);
    // wheels: at the mount point, below it by the suspension's length, turned by the steering and rolled
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const m = t.mounts[w];
      const o = w * WHEEL_FLOATS;
      tmpV.set(m.x, m.y - wheels[o + 2], m.z).applyQuaternion(tmpQ);
      tmpP.set(x + tmpV.x, y + tmpV.y, z + tmpV.z);
      tmpQ3.copy(tmpQ).multiply(tmpQ2.setFromAxisAngle(AXIS_Y, wheels[o]));
      tmpQ3.multiply(tmpQ2.setFromAxisAngle(AXIS_X, wheels[o + 1]));
      tmpM.compose(tmpP, tmpQ3, one);
      t.meshes.wheel.setMatrixAt(i * WHEEL_COUNT + w, tmpM);
    }
  }

  /** End of a frame: uploads what changed and hides unused slots. */
  end() {
    for (const t of this.types.values()) {
      for (const p of PARTS) {
        const m = t.meshes[p];
        m.count = p === 'wheel' ? t.count * WHEEL_COUNT : t.count;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.visible = t.count > 0;
      }
    }
  }

  dispose() {
    for (const t of this.types.values()) {
      for (const g of t.geos) g.dispose();
      for (const p of PARTS) t.meshes[p].dispose();
    }
    this.types.clear();
    this.group.removeFromParent();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
