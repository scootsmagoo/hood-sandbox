/**
 * Shadow-pass depth materials for instanced casters.
 *
 * three.js draws every caster of the shadow map with one shared `MeshDepthMaterial`. Whether a shader program
 * is instanced, and whether it reads an instance colour, is part of its key, so each time the pass moves from
 * a plain mesh to an instanced one (or to one with an instance colour, or back) the renderer builds the
 * program's parameters and cache key afresh, a few microseconds each, nine or ten times a frame in a street
 * with cars and people. An instanced mesh with a `customDepthMaterial` of its own kind draws with the same
 * pixels (same material, same depth packing) and never makes the renderer look again.
 *
 * Use `ownDepth(mesh)` once the mesh's `instanceColor` exists (or does not).
 */
import * as THREE from 'three';

let plain: THREE.MeshDepthMaterial | null = null;
let colour: THREE.MeshDepthMaterial | null = null;

/** Gives an instanced mesh the depth material for its kind (with or without an instance colour). */
export function ownDepth(mesh: THREE.InstancedMesh): void {
  if (mesh.instanceColor) mesh.customDepthMaterial = colour ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  else mesh.customDepthMaterial = plain ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
}

/**
 * `ownDepth` for every instanced caster under `root` that has no depth material of its own (or has ours, and has
 * since gained or lost its instance colour). Meshes made by any system are covered; a few frames can pass between a
 * mesh appearing and the next scan, during which it draws as it would have.
 */
export function ownDepthAll(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh || !m.castShadow) return;
    const d = m.customDepthMaterial;
    if (d === undefined || d === plain || d === colour) ownDepth(m);
  });
}
