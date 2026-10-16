/**
 * The airliners and the airside vehicles (public/assets/airport/ac-*.glb, built by tools/blender/airport/aircraft.py and
 * ground.py; manifest src/client/render/airportAssets.manifest.json), loaded once and turned into plain geometries baked into each
 * model's frame (+X its left, +Y up, +Z its nose; origin on the ground at the main gear's centre):
 *
 *   aircraft  per class, per level of detail (`lod0`..`lod2`), the body and the gear (`lodN_gear`: hidden when retracted), each
 *             a geometry per material (`ac_paint`, `ac_grey`, `ac_metal`, `ac_dark`, `ac_window`, `ac_light`)
 *   ground    per vehicle (`tug`, `baggageTractor`, `baggageCart`, `beltLoader`), two levels, a geometry per material
 *
 * A model that fails to load leaves its class undrawn (a stand-in box is drawn instead, see AircraftViews); the game goes on.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import manifest from '../airportAssets.manifest.json';

export const AC_MATERIALS = ['ac_paint', 'ac_grey', 'ac_metal', 'ac_dark', 'ac_window', 'ac_light'] as const;
export type AcMat = (typeof AC_MATERIALS)[number];

export interface AcLod {
  body: Map<AcMat, THREE.BufferGeometry>;
  gear: Map<AcMat, THREE.BufferGeometry>;
  tris: number;
}
export interface AircraftAsset {
  cls: string;
  lods: AcLod[];
  /** the distances (m) each level is drawn from */
  from: number[];
  anchors: Map<string, THREE.Vector3>;
  box: THREE.Box3;
}
export interface GroundAsset {
  /** per vehicle: per level, a geometry per material */
  parts: Map<string, Map<AcMat, THREE.BufferGeometry>[]>;
}

const CLASS_FILES: Record<string, string> = { narrowbody: 'ac-narrowbody', widebody: 'ac-widebody', regional: 'ac-regional' };
const aircraft = new Map<string, AircraftAsset>();
let ground: GroundAsset | null = null;
let loading: Promise<void> | null = null;

export const aircraftAsset = (cls: string): AircraftAsset | null => aircraft.get(cls) ?? null;
export const groundAsset = (): GroundAsset | null => ground;

type Entry = { file: string; hash: string };
const entries = (manifest as { airport: Record<string, Entry> }).airport;

/** The material name of a mesh, folded to the six the game draws (unknown names are plain grey). */
function matOf(m: THREE.Material | THREE.Material[]): AcMat {
  const n = (Array.isArray(m) ? m[0] : m).name ?? '';
  const hit = AC_MATERIALS.find((k) => n === k || n.startsWith(`${k}.`) || n.startsWith(k));
  return hit ?? 'ac_grey';
}

/** Bakes every mesh under `root` into the frame of `frame` (geometry per material), dequantised, non-indexed attributes kept. */
function collect(root: THREE.Object3D, frame: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean): Map<AcMat, THREE.BufferGeometry> {
  const lists = new Map<AcMat, THREE.BufferGeometry[]>();
  frame.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (skip?.(mesh)) return;
    const g = mesh.geometry.clone();
    // dequantise (KHR_mesh_quantization): plain float attributes so geometries merge
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      if (a.array instanceof Float32Array && !a.normalized) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
    }
    if (!g.getAttribute('color')) {
      const c = new Float32Array(g.attributes.position.count * 4).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(c, 4));
    } else if (g.getAttribute('color').itemSize === 3) {
      const c3 = g.getAttribute('color');
      const c = new Float32Array(c3.count * 4);
      for (let i = 0; i < c3.count; i++) {
        c[i * 4] = c3.getX(i);
        c[i * 4 + 1] = c3.getY(i);
        c[i * 4 + 2] = c3.getZ(i);
        c[i * 4 + 3] = 1;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 4));
    }
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.index) {
      const n = g.attributes.position.count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    g.applyMatrix4(m);
    const k = matOf(mesh.material);
    const l = lists.get(k);
    if (l) l.push(g);
    else lists.set(k, [g]);
  });
  const out = new Map<AcMat, THREE.BufferGeometry>();
  for (const [k, gs] of lists) {
    const merged = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
    if (merged) out.set(k, merged);
    for (const g of gs) if (g !== merged) g.dispose();
  }
  return out;
}

const tris = (m: Map<AcMat, THREE.BufferGeometry>) => [...m.values()].reduce((a, g) => a + (g.index ? g.index.count : g.attributes.position.count) / 3, 0);
const isGear = (o: THREE.Object3D) => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (/gear/i.test(p.name)) return true;
  return false;
};

async function loadAircraft(loader: GLTFLoader, cls: string, name: string, e: Entry) {
  const gltf = await loader.loadAsync(new URL(`${e.file}?v=${e.hash}`, document.baseURI).href);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const lods: AcLod[] = [];
  for (let i = 0; i < 4; i++) {
    const g = root.getObjectByName(`lod${i}`);
    if (!g) break;
    const body = collect(g, root, (o) => isGear(o));
    const gear = new Map<AcMat, THREE.BufferGeometry>();
    g.traverse((o) => {
      if (o !== g && /gear/i.test(o.name) && !isGear(o.parent!)) for (const [k, v] of collect(o, root)) gear.set(k, v);
    });
    lods.push({ body, gear, tris: tris(body) + tris(gear) });
  }
  const anchors = new Map<string, THREE.Vector3>();
  root.traverse((o) => {
    if (o.name.startsWith('anchor_')) anchors.set(o.name.slice(7), o.getWorldPosition(new THREE.Vector3()));
  });
  const ex = (root.getObjectByName('aircraft') ?? root.children[0])?.userData as { lod_from?: number[] } | undefined;
  const box = new THREE.Box3();
  for (const geo of lods[0]?.body.values() ?? []) {
    geo.computeBoundingBox();
    box.union(geo.boundingBox!);
  }
  aircraft.set(cls, { cls, lods, from: ex?.lod_from ?? [0, 220, 1100], anchors, box });
  void name;
}

async function loadGround(loader: GLTFLoader, e: Entry) {
  const gltf = await loader.loadAsync(new URL(`${e.file}?v=${e.hash}`, document.baseURI).href);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts = new Map<string, Map<AcMat, THREE.BufferGeometry>[]>();
  for (const name of ['tug', 'baggageTractor', 'baggageCart', 'beltLoader']) {
    const levels: Map<AcMat, THREE.BufferGeometry>[] = [];
    for (let i = 0; i < 2; i++) {
      const n = root.getObjectByName(`${name}_lod${i}`);
      if (n) levels.push(collect(n, root));
    }
    if (levels.length) parts.set(name, levels);
  }
  ground = { parts };
}

/** Loads every airport model the manifest lists (once). Failures are logged and skipped. */
export function loadAircraftAssets(): Promise<void> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const jobs: Promise<void>[] = [];
  for (const [cls, name] of Object.entries(CLASS_FILES)) {
    const e = entries[name];
    if (e) jobs.push(loadAircraft(loader, cls, name, e).catch((err) => console.warn(`[aircraft] ${name}: ${(err as Error).message}`)));
  }
  const g = entries['ac-ground'];
  if (g) jobs.push(loadGround(loader, g).catch((err) => console.warn(`[aircraft] ac-ground: ${(err as Error).message}`)));
  loading = Promise.all(jobs).then(() => undefined);
  return loading;
}
