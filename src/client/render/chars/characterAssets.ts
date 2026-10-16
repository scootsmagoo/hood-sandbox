/**
 * The character assets: public/assets/characters/characters.glb, built by `npm run assets` from
 * tools/blender/characters. One armature (22 bones), every archetype as three skinned meshes
 * (`<archetype>_lod0..2`, about 4k, 1k and 400 triangles, one primitive each with a per-vertex
 * `_region` and the baked occlusion in the vertex colour) and the animation clips.
 *
 * What is made here and shared by everyone:
 *   - `rig`: the bones' rest pose (local and world), inverse bind matrices, parents,
 *   - a plain geometry per mesh (position, normal, `aAo`, `aRegion`, `skinIndex`, `skinWeight`),
 *   - the clips, plus `@upper` and `@lower` variants (so a gun can be held up while the legs walk).
 * Nothing here is per person. If loading fails (or `?peds=box`) the game keeps the box figures.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import manifest from '../characterAssets.manifest.json';

export interface CharRig {
  names: string[];
  parent: Int16Array;
  index: Map<string, number>;
  /** Local rest transforms (what the bones are bound at). */
  restPos: Float32Array;
  restQuat: Float32Array;
  /** Rest rotation and head position in the figure frame. */
  restWorldQuat: Float32Array;
  restWorldPos: Float32Array;
  ibm: THREE.Matrix4[];
}

export interface CharacterAssets {
  rig: CharRig;
  geos: Map<string, THREE.BufferGeometry>;
  clips: Map<string, THREE.AnimationClip>;
  tris: Record<string, number>;
}

let assets: CharacterAssets | null = null;
let loading: Promise<void> | null = null;
let failed = false;

export const characterAssets = (): CharacterAssets | null => assets;
export const characterAssetsFailed = () => failed;
export const MANIFEST = manifest;

const UPPER = /^(spine|chest|neck|head|clavicle_[LR]|upperarm_[LR]|forearm_[LR]|hand_[LR])\./;
const LOWER = /^(root|pelvis|thigh_[LR]|shin_[LR]|foot_[LR]|toe_[LR])\./;

export function loadCharacterAssets(base: string = document.baseURI): Promise<void> {
  if (loading) return loading;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('peds') === 'box') return (loading = Promise.resolve());
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loading = (async () => {
    try {
      const gltf = await loader.loadAsync(new URL(`${manifest.file}?v=${manifest.hash}`, base).href);
      assets = prepare(gltf);
      disposeTree(gltf.scene);
    } catch (err) {
      failed = true;
      console.warn('character assets failed to load; people stay box figures', err);
    }
  })();
  return loading;
}

export function disposeCharacterAssets() {
  if (assets) for (const g of assets.geos.values()) g.dispose();
  assets = null;
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

/** Turns a loaded glTF into the shared assets. Exported for tests that load the file in Node. */
export function prepare(gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }): CharacterAssets {
  gltf.scene.updateMatrixWorld(true);
  let skeleton: THREE.Skeleton | null = null;
  gltf.scene.traverse((o) => {
    if (!skeleton && (o as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (o as THREE.SkinnedMesh).skeleton;
  });
  if (!skeleton) throw new Error('no skinned mesh in the character file');
  const bones = (skeleton as THREE.Skeleton).bones;
  const n = bones.length;
  const pos = new Float32Array(n * 3);
  const quat = new Float32Array(n * 4);
  const parent = new Int16Array(n);
  bones.forEach((b, i) => {
    parent[i] = bones.indexOf(b.parent as THREE.Bone);
    b.position.toArray(pos, i * 3);
    b.quaternion.toArray(quat, i * 4);
  });
  const rig = makeRig(bones.map((b) => b.name), parent, pos, quat);
  const geos = new Map<string, THREE.BufferGeometry>();
  const tris: Record<string, number> = {};
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    geos.set(mesh.name, plainGeometry(mesh.geometry));
    tris[mesh.name] = (mesh.geometry.getIndex()?.count ?? 0) / 3;
  });
  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of gltf.animations) {
    clips.set(c.name, c);
    clips.set(`${c.name}@upper`, subset(c, UPPER));
    clips.set(`${c.name}@lower`, subset(c, LOWER));
  }
  return { rig, geos, clips, tris };
}

function subset(c: THREE.AnimationClip, keep: RegExp): THREE.AnimationClip {
  return new THREE.AnimationClip(`${c.name}`, c.duration, c.tracks.filter((t) => keep.test(t.name)).map((t) => t.clone()));
}

/** Plain float attributes under the names the ped shaders read. */
function plainGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  const nor = src.getAttribute('normal');
  const col = src.getAttribute('color');
  const reg = src.getAttribute('_region');
  const ji = src.getAttribute('skinIndex');
  const sw = src.getAttribute('skinWeight');
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const AO = new Float32Array(n);
  const COV = new Float32Array(n * 3);
  const RG = new Uint8Array(n);
  const SI = new Uint16Array(n * 4);
  const SW = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    P[i * 3] = pos.getX(i);
    P[i * 3 + 1] = pos.getY(i);
    P[i * 3 + 2] = pos.getZ(i);
    N[i * 3] = nor.getX(i);
    N[i * 3 + 1] = nor.getY(i);
    N[i * 3 + 2] = nor.getZ(i);
    AO[i] = col ? col.getX(i) : 1;
    if (col) {
      COV[i * 3] = col.getY(i);
      COV[i * 3 + 1] = col.getZ(i);
      COV[i * 3 + 2] = col.getW(i);
    }
    RG[i] = reg ? reg.getX(i) : 0;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      SI[i * 4 + k] = ji.getComponent(i, k);
      const w = sw.getComponent(i, k);
      SW[i * 4 + k] = w;
      sum += w;
    }
    for (let k = 0; k < 4; k++) SW[i * 4 + k] /= sum || 1;
  }
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aAo', new THREE.BufferAttribute(AO, 1));
  g.setAttribute('aRegion', new THREE.BufferAttribute(RG, 1));
  g.setAttribute('aCov', new THREE.BufferAttribute(COV, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
  const idx = src.getIndex()!;
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx.array), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.4);
  return g;
}

/** The rig from the bones' local rest transforms (parents before children). Also used by the tests. */
export function makeRig(names: string[], parent: Int16Array, restPos: Float32Array, restQuat: Float32Array): CharRig {
  const n = names.length;
  const rig: CharRig = { names, parent, index: new Map(), restPos, restQuat, restWorldQuat: new Float32Array(n * 4), restWorldPos: new Float32Array(n * 3), ibm: [] };
  const world: THREE.Matrix4[] = [];
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < n; i++) {
    rig.index.set(names[i], i);
    local.compose(p.fromArray(restPos, i * 3), q.fromArray(restQuat, i * 4), one);
    const w = parent[i] >= 0 ? new THREE.Matrix4().multiplyMatrices(world[parent[i]], local) : local.clone();
    world.push(w);
    w.decompose(p, q, s);
    p.toArray(rig.restWorldPos, i * 3);
    q.toArray(rig.restWorldQuat, i * 4);
    rig.ibm.push(w.clone().invert());
  }
  return rig;
}

/** A fresh bone hierarchy at the bind pose, and the matching skeleton. The first bone is the root. */
export function makeSkeleton(rig: CharRig): { root: THREE.Bone; bones: THREE.Bone[]; skeleton: THREE.Skeleton } {
  const bones = rig.names.map((name, i) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.fromArray(rig.restPos, i * 3);
    b.quaternion.fromArray(rig.restQuat, i * 4);
    return b;
  });
  bones.forEach((b, i) => {
    const p = rig.parent[i];
    if (p >= 0) bones[p].add(b);
  });
  const skeleton = new THREE.Skeleton(bones, rig.ibm.map((m) => m.clone()));
  return { root: bones[0], bones, skeleton };
}
