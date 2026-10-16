/**
 * The transit models (public/assets/transit, built by tools/blender/transit/): the railcar and the station kit, merged at load
 * into one geometry per material per level of detail (a car is a handful of draws for every car of every train, see
 * TrainViews.ts), each in its own frame. The car's door leaves are merged into the body too: a vertex attribute `aDoor`
 * (x: the side, +1 the car's left and -1 its right, 0 for what never moves; y: which way the leaf slides along the car, -1 or
 * +1) lets the vertex shader slide them open.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import manifest from '../transitAssets.manifest.json';

/** One level of detail: a geometry per material name, in the part's frame. */
export type LodGeometry = Map<string, THREE.BufferGeometry>;

export interface CarAsset {
  lods: LodGeometry[];
  /** where each level starts, m */
  from: number[];
  travel: number;
  /** the window-view camera spot in the car's frame */
  camWindow: THREE.Vector3;
}

export interface KitPart {
  lods: LodGeometry[];
}

export interface TransitAssets {
  car: CarAsset | null;
  kit: Map<string, KitPart>;
}

type Entry = { file: string; hash: string };

const url = (e: Entry) => new URL(`${e.file}?v=${e.hash}`, document.baseURI).href;

/** Every mesh under `root`, baked into `root`'s frame, grouped by material; `tag` gives each the door attribute. */
function collect(root: THREE.Object3D, into: Map<string, THREE.BufferGeometry[]>, tag: (mesh: THREE.Mesh) => [number, number]): void {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const src = mesh.geometry;
    const groups = src.groups.length ? src.groups : [{ start: 0, count: src.index ? src.index.count : src.attributes.position.count, materialIndex: 0 }];
    const [side, slide] = tag(mesh);
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0];
      // the triangles of this group only, as a fresh non-indexed-by-others geometry
      let geo = src.clone();
      if (src.index) {
        const idx = src.index.array.slice(g.start, g.start + g.count);
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      geo.clearGroups();
      geo = geo.index ? geo.toNonIndexed() : geo;
      for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) geo.deleteAttribute(k);
      const n = geo.attributes.position.count;
      if (!geo.attributes.color) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(1), 4));
      else if (geo.attributes.color.itemSize === 3) {
        const c3 = geo.attributes.color;
        const c4 = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          c4[i * 4] = c3.getX(i);
          c4[i * 4 + 1] = c3.getY(i);
          c4[i * 4 + 2] = c3.getZ(i);
          c4[i * 4 + 3] = 1;
        }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(c4, 4));
      } else if (!(geo.attributes.color.array instanceof Float32Array)) {
        // normalized integers: to floats so that the merge agrees
        const c = geo.attributes.color;
        const f = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          f[i * 4] = c.getX(i);
          f[i * 4 + 1] = c.getY(i);
          f[i * 4 + 2] = c.getZ(i);
          f[i * 4 + 3] = c.itemSize > 3 ? c.getW(i) : 1;
        }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(f, 4));
      }
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      else if (!(geo.attributes.uv.array instanceof Float32Array)) {
        const u = geo.attributes.uv;
        const f = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          f[i * 2] = u.getX(i);
          f[i * 2 + 1] = u.getY(i);
        }
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(f, 2));
      }
      for (const k of ['position', 'normal'] as const) {
        const a = geo.attributes[k];
        if (a && !(a.array instanceof Float32Array)) {
          const f = new Float32Array(a.count * 3);
          for (let i = 0; i < a.count; i++) {
            f[i * 3] = a.getX(i);
            f[i * 3 + 1] = a.getY(i);
            f[i * 3 + 2] = a.getZ(i);
          }
          geo.setAttribute(k, new THREE.Float32BufferAttribute(f, 3));
        }
      }
      // (quantized positions are normalized integers: transformed only once they are floats, or they clamp to the unit cube)
      geo.applyMatrix4(m);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const door = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        door[i * 2] = side;
        door[i * 2 + 1] = slide;
      }
      geo.setAttribute('aDoor', new THREE.Float32BufferAttribute(door, 2));
      const name = mat?.name || 'tr_steel';
      let l = into.get(name);
      if (!l) into.set(name, (l = []));
      l.push(geo);
    }
  });
}

function merged(lists: Map<string, THREE.BufferGeometry[]>): LodGeometry {
  const out: LodGeometry = new Map();
  for (const [name, geos] of [...lists].sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = mergeGeometries(geos, false);
    if (!g) continue;
    g.computeBoundingSphere();
    out.set(name, g);
    for (const x of geos) x.dispose();
  }
  return out;
}

/** The door attribute of a node by its name (`lodN_door_L0_a`). */
function doorTag(name: string): [number, number] {
  const m = /door_([LR])\d_([ab])/.exec(name);
  if (!m) return [0, 0];
  return [m[1] === 'L' ? 1 : -1, m[2] === 'a' ? -1 : 1];
}

export async function loadTransitAssets(): Promise<TransitAssets> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const t = (manifest as { transit: Record<string, Entry> }).transit;
  const out: TransitAssets = { car: null, kit: new Map() };
  await Promise.all([
    (async () => {
      if (!t.railcar) return;
      try {
        const gltf = await loader.loadAsync(url(t.railcar));
        const root = gltf.scene.getObjectByName('railcar') ?? gltf.scene;
        const extras = (root.userData ?? {}) as { lod_from?: number[]; leafTravel?: number };
        const lods: LodGeometry[] = [];
        for (let k = 0; k < 3; k++) {
          const g = root.getObjectByName(`lod${k}`);
          if (!g) break;
          const lists = new Map<string, THREE.BufferGeometry[]>();
          // every mesh with the door tag of the nearest named ancestor (a door node holds its mesh one level down)
          collect(g, lists, (mesh) => {
            let o: THREE.Object3D | null = mesh;
            while (o && o !== g) {
              const tag = doorTag(o.name);
              if (tag[0] !== 0) return tag;
              o = o.parent;
            }
            return [0, 0];
          });
          // (collect bakes into the group's frame; the group sits at the car's origin)
          lods.push(merged(lists));
        }
        const cam = root.getObjectByName('anchor_cam_window');
        out.car = { lods, from: extras.lod_from ?? [0, 60, 220], travel: extras.leafTravel ?? 0.64, camWindow: cam ? cam.position.clone() : new THREE.Vector3(1.13, 2.3, 4.37) };
      } catch (e) {
        console.warn('transit: the railcar did not load', e);
      }
    })(),
    (async () => {
      const k = t['station-kit'];
      if (!k) return;
      try {
        const gltf = await loader.loadAsync(url(k));
        // the parts hang under one root node (`station-kit`)
        const top = gltf.scene.getObjectByName('station-kit') ?? gltf.scene;
        for (const part of [...top.children]) {
          const lods: LodGeometry[] = [];
          for (let l = 0; l < 2; l++) {
            const node = part.getObjectByName(`${part.name}_lod${l}`);
            if (!node) break;
            const lists = new Map<string, THREE.BufferGeometry[]>();
            // bake into the part's frame
            part.updateWorldMatrix(true, true);
            const inv = new THREE.Matrix4().copy(part.matrixWorld).invert();
            const holder = new THREE.Group();
            holder.matrixWorld.copy(part.matrixWorld);
            collect(node, lists, () => [0, 0]);
            // collect baked into node's frame; move into the part's
            const m = new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld);
            for (const geos of lists.values()) for (const g of geos) g.applyMatrix4(m);
            lods.push(merged(lists));
          }
          if (lods.length) out.kit.set(part.name, { lods });
        }
      } catch (e) {
        console.warn('transit: the station kit did not load', e);
      }
    })(),
  ]);
  return out;
}
