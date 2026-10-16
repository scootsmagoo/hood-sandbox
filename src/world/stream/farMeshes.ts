/**
 * The skyline level of detail (docs/contracts/city-tiles.md section 8): a far tile's `far.bin` as one mesh, its buildings as prisms
 * and its ground as a coarse grid, vertex-coloured. Far tiles share one material whose haze reaches about three times as far as the
 * scene's (the GTA IV haze would hide anything beyond 2 km), so Midtown shows from Downtown as a hazy silhouette.
 */
import * as THREE from 'three';
import type { FarTile } from '../../shared/farTile';

/**
 * The far meshes are hazed as the scene is up to `FAR_HAZE_FROM` m (about where a tile turns from far to near, so it does not jump),
 * and beyond it as if each further metre were `FAR_HAZE` of one: the skyline stays a silhouette in the haze rather than vanishing.
 */
export const FAR_HAZE = 0.33;
export const FAR_HAZE_FROM = 1150;
/** The most haze a far mesh takes: a skyline keeps a little contrast out to the far ring. */
export const FAR_HAZE_MAX = 0.62;

export function farMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.name = 'far_lod';
  m.customProgramCacheKey = () => 'far-lod';
  m.onBeforeCompile = (shader) => {
    const from = FAR_HAZE_FROM.toFixed(1);
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>\n  #ifdef USE_FOG\n  vFogDepth = vFogDepth < ${from} ? vFogDepth : ${from} + (vFogDepth - ${from}) * ${FAR_HAZE.toFixed(3)};\n  #endif`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', THREE.ShaderChunk.fog_fragment.replace('fogColor, fogFactor )', `fogColor, min( fogFactor, ${FAR_HAZE_MAX.toFixed(2)} ) )`));
  };
  return m;
}

/** Colours of the building kinds (`buildingKinds`), a little darker than the near ones: far walls are mostly in shade. */
const KIND: Record<number, [number, number, number]> = {
  1: [0.5, 0.5, 0.5],
  2: [0.36, 0.43, 0.5],
  3: [0.5, 0.35, 0.28],
  4: [0.5, 0.5, 0.48],
  6: [0.58, 0.55, 0.48],
  9: [0.55, 0.5, 0.44],
  10: [0.6, 0.55, 0.5],
};

export function farGeometry(t: FarTile): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const { n, minX, minZ, size, heights } = t.grid;
  const step = size / (n - 1);
  // the ground, a little below the near tiles' (it is only ever seen far off)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      pos.push(minX + c * step, heights[r * n + c] - 0.4, minZ + r * step);
      col.push(0.3, 0.33, 0.27);
    }
  }
  for (let r = 0; r + 1 < n; r++) {
    for (let c = 0; c + 1 < n; c++) {
      const a = r * n + c;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  for (const b of t.buildings) {
    const m = b.ring.length / 2;
    if (m < 3) continue;
    const shade = KIND[b.kind] ?? [0.52, 0.5, 0.47];
    // walls
    for (let k = 0; k < m; k++) {
      const ax = b.ring[k * 2], az = b.ring[k * 2 + 1];
      const bx = b.ring[((k + 1) % m) * 2], bz = b.ring[((k + 1) % m) * 2 + 1];
      const v = pos.length / 3;
      pos.push(ax, b.baseY, az, bx, b.baseY, bz, bx, b.topY, bz, ax, b.topY, az);
      // (far walls are mostly in shade, and a little blue with distance: a silhouette, not a lit facade)
      for (let q = 0; q < 4; q++) {
        const k = (q < 2 ? 0.5 : 0.7) * 0.85;
        col.push(shade[0] * k * 0.92, shade[1] * k * 0.97, shade[2] * k * 1.08);
      }
      // (drawn double-sided: footprints come either way round)
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    // roof
    const contour = [];
    for (let k = 0; k < m; k++) contour.push(new THREE.Vector2(b.ring[k * 2], b.ring[k * 2 + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const v0 = pos.length / 3;
    for (let k = 0; k < m; k++) {
      pos.push(b.ring[k * 2], b.topY, b.ring[k * 2 + 1]);
      col.push(shade[0] * 0.8, shade[1] * 0.8, shade[2] * 0.8);
    }
    for (const [a, c, d] of tris) idx.push(v0 + a, v0 + c, v0 + d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
