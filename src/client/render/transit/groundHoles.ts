/**
 * The stairwells of the station entrances go down through the ground: the ground and the street meshes are not drawn over them.
 * A wrap of the world's ground and road materials (after the look has patched them) discards the fragments inside the nearest
 * few wells, the rectangles of `transit.json` `holes`. The uniforms are shared, so the cost is one small loop per fragment of
 * those materials, and nothing at all where no well is near.
 */
import * as THREE from 'three';

export const MAX_HOLES = 6;

export const HOLES = {
  /** (centre x, centre z, half size x, half size z) per hole */
  uHoleA: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  /** (cos yaw, sin yaw) */
  uHoleB: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector2(1, 0)) },
  uHoleN: { value: 0 },
};

const NAMES = /^(ground|road_asphalt|road_sidewalk|road_markings|road_crosswalk|road_concrete)$/;
const DONE = new WeakSet<THREE.Material>();

/**
 * Wraps the materials under `root` that the wells cut. Returns how many it wrapped (call again later: the look patches some late).
 * With the look on (`afterLook`), a material is wrapped only once the look has patched it, or the look's patch would replace ours.
 */
export function patchHoles(root: THREE.Object3D, afterLook = false): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (DONE.has(m) || !NAMES.test(m.name)) continue;
      if (afterLook && !m.customProgramCacheKey().startsWith('look-')) continue;
      DONE.add(m);
      n++;
      const prev = m.onBeforeCompile;
      const prevKey = m.customProgramCacheKey.bind(m);
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);
        Object.assign(shader.uniforms, HOLES);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vHoleXZ;')
          .replace('#include <project_vertex>', '#include <project_vertex>\n  vHoleXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
varying vec2 vHoleXZ;
uniform vec4 uHoleA[${MAX_HOLES}];
uniform vec2 uHoleB[${MAX_HOLES}];
uniform int uHoleN;`,
          )
          .replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
  for (int i = 0; i < ${MAX_HOLES}; i++) {
    if (i >= uHoleN) break;
    vec2 d = vHoleXZ - uHoleA[i].xy;
    // the box's local axes: +Z along (sin, cos), +X along (cos, -sin)
    float lx = d.x * uHoleB[i].x - d.y * uHoleB[i].y;
    float lz = d.x * uHoleB[i].y + d.y * uHoleB[i].x;
    if (abs(lx) < uHoleA[i].z && abs(lz) < uHoleA[i].w) discard;
  }`,
          );
      };
      m.customProgramCacheKey = () => `${prevKey()}-holes`;
      m.needsUpdate = true;
    }
  });
  return n;
}

/** Points the uniforms at the wells nearest (x, z). */
export function selectHoles(holes: [number, number, number, number, number][], x: number, z: number): void {
  const near = holes
    .map((h, i) => ({ i, d: Math.hypot(h[0] - x, h[1] - z) }))
    .filter((q) => q.d < 400)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_HOLES);
  near.forEach((q, k) => {
    const h = holes[q.i];
    HOLES.uHoleA.value[k].set(h[0], h[1], h[2], h[3]);
    HOLES.uHoleB.value[k].set(Math.cos(h[4]), Math.sin(h[4]));
  });
  HOLES.uHoleN.value = near.length;
}
