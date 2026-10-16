/**
 * Tree and street-furniture assets: public/assets/props/{trees,furniture}.glb, built by
 * `npm run assets` from tools/blender/props/. Loaded once, turned into plain float geometries
 * (quantised attributes undone, node transforms applied) with `color` (RGBA: the albedo, and the
 * vertex alpha code of tools/blender/props/geo.py), `normal` and `uv`.
 *
 *   trees.glb      tree_<name>_lod0 (near: bark, core blobs, leaf cards) and _lod1 (mid: bark, blobs)
 *   furniture.glb  lamp_cobra / lamp_post / lamp_mast / hydrant / bin / bollard, `<name>_mesh`, and
 *                  for lamps `<name>_anchor`: the lamp head (glow, pool, sodium light)
 *
 * Sizes and species order are those of src/shared/data/propDims.json (src/shared/props.ts).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { parseProps, type PropsData } from '../../shared/tile';
import manifest from './propAssets.manifest.json';

export const TREE_NAMES = ['oak', 'sweetgum', 'pine', 'myrtle', 'redoak'] as const;
export const FURNITURE_NAMES = ['lamp_cobra', 'lamp_post', 'lamp_mast', 'hydrant', 'bin', 'bollard'] as const;
export type FurnitureName = (typeof FURNITURE_NAMES)[number];

export interface TreeModel {
  /** [near, mid]. */
  lods: [THREE.BufferGeometry, THREE.BufferGeometry];
}

export interface PropAssets {
  trees: TreeModel[];
  furniture: Record<FurnitureName, THREE.BufferGeometry>;
  /** The lamp head of each lamp model, in the model's frame (the arm reaches along +Z). */
  lampHeads: THREE.Vector3[];
}

/** `colourSize` 3 drops the alpha code (furniture has none), 4 keeps it (trees). */
function bake(mesh: THREE.Mesh, colourSize: 3 | 4): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  const floats = (name: string, size: number) => {
    const a = src.getAttribute(name);
    if (!a) return;
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  };
  floats('position', 3);
  floats('normal', 3);
  floats('uv', 2);
  const c = src.getAttribute('color');
  if (c) floats('color', colourSize);
  const idx = src.getIndex();
  if (idx) g.setIndex(new THREE.BufferAttribute(idx.array.slice() as Uint16Array | Uint32Array, 1));
  g.applyMatrix4(mesh.matrixWorld);
  return g;
}

let loading: Promise<PropAssets | null> | null = null;
let loaded: PropAssets | null = null;

export function propAssets(): PropAssets | null {
  return loaded;
}

/** Loads both files (null if either fails: trees and furniture stay undrawn, lamps keep their stand-in poles). */
export function loadPropAssets(base: string = document.baseURI): Promise<PropAssets | null> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const url = (e: { file: string; hash: string }) => new URL(`${e.file}?v=${e.hash}`, base).href;
  loading = (async () => {
    try {
      const [t, f] = await Promise.all([loader.loadAsync(url(manifest.props.trees)), loader.loadAsync(url(manifest.props.furniture))]);
      t.scene.updateMatrixWorld(true);
      f.scene.updateMatrixWorld(true);
      const find = (root: THREE.Object3D, name: string) => {
        const o = root.getObjectByName(name);
        if (!o) throw new Error(`prop asset has no ${name}`);
        return o;
      };
      const trees: TreeModel[] = TREE_NAMES.map((n) => ({ lods: [bake(find(t.scene, `tree_${n}_lod0`) as THREE.Mesh, 4), bake(find(t.scene, `tree_${n}_lod1`) as THREE.Mesh, 4)] }));
      const furniture = {} as Record<FurnitureName, THREE.BufferGeometry>;
      for (const n of FURNITURE_NAMES) furniture[n] = bake(find(f.scene, `${n}_mesh`) as THREE.Mesh, 3);
      const lampHeads = ['lamp_cobra', 'lamp_post', 'lamp_mast'].map((n) => new THREE.Vector3().setFromMatrixPosition(find(f.scene, `${n}_anchor`).matrixWorld));
      for (const root of [t.scene, f.scene]) {
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
          }
        });
      }
      loaded = { trees, furniture, lampHeads };
      return loaded;
    } catch (e) {
      console.warn('tree and furniture assets failed to load; no trees, stand-in lamp poles', e);
      return null;
    }
  })();
  return loading;
}

/** The anchors of the tile's `props.json` (the client reads the file again; the sim has its own copy), or null. */
export async function loadAnchors(tileBase: string, propsFile: string | undefined, signal?: AbortSignal): Promise<PropsData | null> {
  if (!propsFile) return null;
  try {
    const res = await fetch(new URL(propsFile, tileBase), { signal });
    return res.ok ? parseProps(await res.json()) : null;
  } catch {
    return null;
  }
}
