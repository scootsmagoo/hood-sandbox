/**
 * Vehicle assets: the .glb files `npm run assets` builds from tools/blender/ (see its README), loaded
 * once at boot and turned into plain geometries the car views share.
 *
 * Each asset has three levels of detail, and each level a few parts (`lod<N>_<part>` nodes):
 * body, door, hood, bumper_F, bumper_R, wheel, light_head, light_tail, light_reverse and, on police
 * cars, police, light_bar_a and light_bar_b. Every part's primitives are split by material name
 * (paint, livery, trim, chrome, glass, interior, tyre, ...). Here they are:
 *   - baked into the car's frame (quantised attributes dequantised, node transforms applied),
 *   - given their pivot (the door's and the bonnet's hinge, a bumper's centre, from the `anchors`
 *     the asset carries); only the wheel's geometry is moved, to its hub,
 *   - the three lamp kinds merged into one geometry with an `aLamp` attribute (0 head, 1 tail,
 *     2 reverse), so a car's lamps are one draw,
 *   - glass given an `aWin` attribute: which window (connected panel) a vertex belongs to, so a
 *     window can break on its own.
 * Nothing here is per car: `carModel.ts` builds a car from these, `TrafficInstances` merges them
 * into instanced parts. If loading fails the game keeps the stand-in box cars (models.ts).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR_ASSETS } from './carLod';

export type CarMat = 'paint' | 'livery' | 'trim' | 'chrome' | 'glass' | 'interior' | 'tyre' | 'light_head' | 'light_tail' | 'light_reverse' | 'light_bar_a' | 'light_bar_b';
export type CarPartName = 'body' | 'door' | 'hood' | 'bumper_F' | 'bumper_R' | 'wheel' | 'police';
export const LAMP_HEAD = 0;
export const LAMP_TAIL = 1;
export const LAMP_REVERSE = 2;

/** One part: a geometry per material, in the part's own frame, and where that frame sits in the car. */
export interface CarPart {
  geos: Map<CarMat, THREE.BufferGeometry>;
  /** The part's pivot in the car's frame. The geometry is in the car's frame too, except the wheel's (centred on its hub). */
  pivot: THREE.Vector3;
  /** Bounds of the geometry. */
  box: THREE.Box3;
}

export interface CarLod {
  parts: Map<CarPartName, CarPart>;
  /** Head, tail and reverse lamps in one geometry (`aLamp`), in the car's frame. */
  lamps: THREE.BufferGeometry | null;
  /** The police lightbar's two halves, in the car's frame. */
  barA: THREE.BufferGeometry | null;
  barB: THREE.BufferGeometry | null;
  tris: number;
}

export interface CarWindow {
  /** Which part's glass it is in (body or door) and its index in `aWin`. */
  part: CarPartName;
  index: number;
  /** Its centre, in the car's frame. */
  centre: THREE.Vector3;
}

export interface CarAsset {
  name: string;
  lods: [CarLod, CarLod, CarLod];
  anchors: Map<string, THREE.Vector3>;
  /** The glass panels of LOD0 (the same indices in LOD1, where they exist). */
  windows: CarWindow[];
  /** Body bounds in the car's frame (LOD0, no wheels). */
  bounds: THREE.Box3;
}

const assets = new Map<string, CarAsset>();
let loading: Promise<void> | null = null;
let failed = false;

/** The loaded asset, or null (not loaded yet, failed, or unknown): draw the stand-in then. */
export function carAsset(name: string): CarAsset | null {
  return assets.get(name) ?? null;
}

export function carAssetsReady(): boolean {
  return assets.size > 0;
}

export function carAssetsFailed(): boolean {
  return failed;
}

/**
 * Loads every vehicle in the manifest (resolves when all have loaded or failed; a failed asset is
 * logged and its cars stay stand-ins). `?cars=box` skips loading, for comparisons.
 */
export function loadCarAssets(base: string = document.baseURI): Promise<void> {
  if (loading) return loading;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('cars') === 'box') return (loading = Promise.resolve());
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loading = Promise.all(
    Object.entries(CAR_ASSETS).map(async ([name, e]) => {
      try {
        const url = new URL(`${e.file}?v=${e.hash}`, base).href;
        const gltf = await loader.loadAsync(url);
        assets.set(name, prepare(name, gltf.scene));
        disposeTree(gltf.scene);
      } catch (err) {
        failed = true;
        console.warn(`car asset ${name} failed to load; its cars stay stand-ins`, err);
      }
    }),
  ).then(() => undefined);
  return loading;
}

/** Drops every loaded asset's geometry (tests and teardown). */
export function disposeCarAssets() {
  for (const a of assets.values()) {
    for (const l of a.lods) {
      for (const p of l.parts.values()) for (const g of p.geos.values()) g.dispose();
      l.lamps?.dispose();
      l.barA?.dispose();
      l.barB?.dispose();
    }
  }
  assets.clear();
  loading = null;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    }
  });
}

/** A geometry with plain float position and normal (quantised and normalised attributes undone), in the car's frame. */
function bake(mesh: THREE.Mesh, toCar: THREE.Matrix4): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) {
      out[i * 3] = a.getX(i);
      out[i * 3 + 1] = a.getY(i);
      out[i * 3 + 2] = a.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  const idx = src.getIndex();
  if (idx) g.setIndex(new THREE.BufferAttribute(idx.array.slice() as Uint16Array | Uint32Array, 1));
  const m = new THREE.Matrix4().multiplyMatrices(toCar, mesh.matrixWorld);
  g.applyMatrix4(m);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

function matName(mesh: THREE.Mesh): CarMat {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return m.name as CarMat;
}

/** Window ids for a glass geometry: vertices joined by triangles (or sharing a position) are one panel. */
function windowIds(g: THREE.BufferGeometry, start: number): { ids: Float32Array; count: number; centres: THREE.Vector3[] } {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const idx = g.getIndex();
  if (idx) for (let t = 0; t < idx.count; t += 3) {
    join(idx.getX(t), idx.getX(t + 1));
    join(idx.getX(t), idx.getX(t + 2));
  }
  const byPos = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 500)},${Math.round(pos.getY(i) * 500)},${Math.round(pos.getZ(i) * 500)}`;
    const j = byPos.get(k);
    if (j === undefined) byPos.set(k, i);
    else join(i, j);
  }
  const ids = new Float32Array(n);
  const roots = new Map<number, number>();
  const sums: THREE.Vector3[] = [];
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let id = roots.get(r);
    if (id === undefined) {
      id = roots.size;
      roots.set(r, id);
      sums.push(new THREE.Vector3());
      counts.push(0);
    }
    ids[i] = Math.min(23, start + id);
    sums[id].x += pos.getX(i);
    sums[id].y += pos.getY(i);
    sums[id].z += pos.getZ(i);
    counts[id]++;
  }
  return { ids, count: roots.size, centres: sums.map((s, i) => s.multiplyScalar(1 / counts[i])) };
}

function prepare(name: string, scene: THREE.Object3D): CarAsset {
  scene.updateMatrixWorld(true);
  const root = scene.getObjectByName('car') ?? scene;
  const toCar = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const anchors = new Map<string, THREE.Vector3>();
  root.getObjectByName('anchors')?.children.forEach((a) => anchors.set(a.name, new THREE.Vector3().setFromMatrixPosition(a.matrixWorld).applyMatrix4(toCar)));
  const pivotOf = (part: string, box: THREE.Box3): THREE.Vector3 => {
    if (part === 'door') return anchors.get('anchor_hinge_door')?.clone() ?? new THREE.Vector3();
    if (part === 'hood') return anchors.get('anchor_hinge_hood')?.clone() ?? new THREE.Vector3();
    if (part === 'wheel') return anchors.get('anchor_wheel_FL')?.clone() ?? new THREE.Vector3();
    if (part === 'bumper_F' || part === 'bumper_R') return box.getCenter(new THREE.Vector3());
    return new THREE.Vector3();
  };
  const windows: CarWindow[] = [];
  const lods = [0, 1, 2].map((level) => {
    const grp = root.getObjectByName(`lod${level}`);
    const lod: CarLod = { parts: new Map(), lamps: null, barA: null, barB: null, tris: 0 };
    if (!grp) return lod;
    const lampGeos: THREE.BufferGeometry[] = [];
    let winStart = 0;
    for (const child of grp.children) {
      const partName = child.name.replace(/^lod\d_/, '');
      const geos = new Map<CarMat, THREE.BufferGeometry>();
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = bake(m, toCar);
        const mat = matName(m);
        const prev = geos.get(mat);
        if (prev) {
          const merged = mergeGeometries([prev, g], false)!;
          prev.dispose();
          g.dispose();
          geos.set(mat, merged);
        } else geos.set(mat, g);
      });
      for (const g of geos.values()) lod.tris += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3 * (partName === 'wheel' ? 4 : 1);
      if (partName === 'light_head' || partName === 'light_tail' || partName === 'light_reverse') {
        const kind = partName === 'light_head' ? LAMP_HEAD : partName === 'light_tail' ? LAMP_TAIL : LAMP_REVERSE;
        for (const g of geos.values()) {
          g.setAttribute('aLamp', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(kind), 1));
          lampGeos.push(g);
        }
        continue;
      }
      if (partName === 'light_bar_a' || partName === 'light_bar_b') {
        const g = [...geos.values()][0] ?? null;
        if (partName === 'light_bar_a') lod.barA = g;
        else lod.barB = g;
        continue;
      }
      // window panels: body glass first, then the door's
      const glass = geos.get('glass');
      if (glass) {
        const w = windowIds(glass, winStart);
        glass.setAttribute('aWin', new THREE.BufferAttribute(w.ids, 1));
        if (level === 0) w.centres.forEach((c, i) => windows.push({ part: partName as CarPartName, index: winStart + i, centre: c }));
        winStart += w.count;
      }
      const box = new THREE.Box3();
      for (const g of geos.values()) {
        g.computeBoundingBox();
        box.union(g.boundingBox!);
      }
      const pivot = pivotOf(partName, box);
      // Only the wheel moves to its own origin (it is drawn four times, turned and rolled about its hub). The door, bonnet and
      // bumpers stay in the car's frame (so shaders see car coordinates); their models hang them under a group at the pivot.
      if (partName === 'wheel') {
        for (const g of geos.values()) g.translate(-pivot.x, -pivot.y, -pivot.z);
        box.translate(pivot.clone().negate());
      }
      lod.parts.set(partName as CarPartName, { geos, pivot, box });
    }
    if (lampGeos.length) {
      lod.lamps = mergeGeometries(lampGeos, false);
      for (const g of lampGeos) g.dispose();
    }
    return lod;
  }) as [CarLod, CarLod, CarLod];
  const bounds = new THREE.Box3();
  for (const p of ['body', 'door', 'hood', 'bumper_F', 'bumper_R'] as const) {
    const part = lods[0].parts.get(p);
    if (part) bounds.union(part.box);
  }
  return { name, lods, anchors, windows, bounds };
}

/** Every geometry of every loaded asset (shared by all the car views), each once. */
export function allCarGeometries(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const a of assets.values()) {
    for (const l of a.lods) {
      for (const p of l.parts.values()) out.push(...p.geos.values());
      for (const g of [l.lamps, l.barA, l.barB]) if (g) out.push(g);
    }
  }
  return out;
}

let holderMat: THREE.MeshBasicMaterial | null = null;
/**
 * A hidden group holding one mesh per shared asset geometry. The geometries live as long as the game
 * (every car view draws from them), so they stay in the scene with it even when no car is using them:
 * a geometry the renderer holds that is in no scene is what the leak harness counts as a leak.
 */
export function carAssetHolder(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'car-asset-cache';
  g.visible = false;
  g.matrixAutoUpdate = false;
  holderMat ??= new THREE.MeshBasicMaterial();
  for (const geo of allCarGeometries()) {
    const m = new THREE.Mesh(geo, holderMat);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}
