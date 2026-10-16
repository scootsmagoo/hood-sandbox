/**
 * Sodium street light on things that are not the road: cars, people, trees. No real lights (a light
 * that comes and goes would recompile every material); instead the few street lamps nearest the
 * action are handed to the shaders as an analytic sum, and a material adds
 *
 *     outgoingLight += sodiumLight(worldPosition, worldNormal) * diffuseColor.rgb;
 *
 * The roads get their light from the lamp pool cards (lamps.ts); this is the same light, felt by
 * what stands in it. It is 0 by day and without lamps (`uSodOn`), and costs a uniform branch then.
 *
 * HOW A MATERIAL USES IT (cars: carMaterials.ts; people: the ped material; trees: Trees.ts)
 *
 *   import { addSodium } from '../look/sodium';
 *   mat.onBeforeCompile = (shader) => { ...; addSodium(shader); };
 *
 * `addSodium(shader)` for a MeshStandard/Lambert/Phong-derived material:
 *   - adds the uniforms (shared objects, so every material sees the same lamps) and `sodiumLight()`
 *     after `#include <common>` in the fragment shader;
 *   - adds the line above before `#include <opaque_fragment>` (outside any block, using `normal` and
 *     `vViewPosition`, which every lit three.js fragment shader has).
 * It must run after the material's own replacement of `#include <opaque_fragment>` if it has one
 * (that replacement keeps the include at its end, which is where the line goes), and it works on
 * instanced and plain meshes alike. The program is the same for every material that calls it, so
 * add `sodium` to `customProgramCacheKey` only if the material had a different key before.
 * A material with its own lighting code can call `sodiumLight(P, N)` directly: `P` and `N` in world
 * space, the result is radiance to multiply by albedo (HDR; the bloom takes the bright ones).
 *
 * The lamps: `lamps.ts` (StreetLamps) calls `sodiumField.select(...)` when the camera has moved and
 * writes `sodiumUniforms.uSodOn`. The 8 lamps that matter most are chosen by distance from a point
 * 12 m ahead of the camera, so the car in front of the chase camera and the sidewalk beyond it are
 * lit properly. Each lamp is a head position and a reach (m): cobra 18, post-top 9, mast 24.
 */
import * as THREE from 'three';
import { U } from './uniforms';

export const SODIUM_MAX = 8;

/** Shared uniform objects: every material that calls `addSodium` reads these. */
export const sodiumUniforms = {
  /** xyz: the lamp head in world space, w: its reach, m. */
  uSodLamps: { value: Array.from({ length: SODIUM_MAX }, () => new THREE.Vector4(0, -1e5, 0, 1)) },
  uSodN: { value: 0 },
  /** 0 by day, 1 at night; 0 also when the tile has no lamps. */
  uSodOn: { value: 0 },
  /** Scales the whole effect (the tier can lower it). */
  uSodGain: { value: 7 },
  uSodium: U.uSodium,
};

export const SODIUM_GLSL = /* glsl */ `
uniform vec4 uSodLamps[${SODIUM_MAX}];
uniform int uSodN;
uniform float uSodOn;
uniform float uSodGain;
uniform vec3 uSodium;
vec3 sodiumLight(vec3 P, vec3 N) {
  float acc = 0.0;
  for (int i = 0; i < ${SODIUM_MAX}; i++) {
    if (i >= uSodN) break;
    vec4 L = uSodLamps[i];
    vec3 d = L.xyz - P;
    float r2 = dot(d, d);
    float f = clamp(1.0 - r2 / (L.w * L.w), 0.0, 1.0);
    float nd = dot(N, d * inversesqrt(r2 + 0.05)) * 0.5 + 0.5;
    acc += f * f * (0.2 + 0.8 * nd * nd);
  }
  return uSodium * (acc * uSodOn * uSodGain);
}
`;

/** The fragment line a lit material adds before its output. */
export const SODIUM_APPLY = /* glsl */ `
if (uSodOn > 0.001) {
  vec3 sodN = normalize(inverseTransformDirection(normal, viewMatrix));
  vec3 sodP = cameraPosition + inverseTransformDirection(-vViewPosition, viewMatrix);
  outgoingLight += sodiumLight(sodP, sodN) * diffuseColor.rgb * SODIUM_STRENGTH;
}
`;

/** Adds the sodium light to a three.js shader being compiled (see the header). */
/**
 * `strength` scales the light for this material (1 = trees, furniture and the ground's tuning). Glossy, bright car paint
 * wants much less, or a car under a lamp reads as neon orange.
 */
export function addSodium(shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string }, strength = 1): void {
  Object.assign(shader.uniforms, sodiumUniforms);
  if (shader.fragmentShader.includes('sodiumLight(')) return;
  const apply = SODIUM_APPLY.replace('SODIUM_STRENGTH', strength.toFixed(3));
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${SODIUM_GLSL}`).replace('#include <opaque_fragment>', `${apply}\n#include <opaque_fragment>`);
}

/** Which lamps light the scene: the nearest to a point ahead of the camera. Written by StreetLamps. */
export class SodiumField {
  private readonly best = new Float64Array(SODIUM_MAX);
  private readonly pick = new Int32Array(SODIUM_MAX);

  /**
   * `heads` is x, y, z, reach per lamp (a flat array of 4n); `maxLamps` is how many to hand to the
   * shaders (the Low tier uses fewer). Writes the uniforms.
   */
  select(heads: Float32Array, n: number, camera: THREE.Camera, maxLamps: number): void {
    const cam = camera.position;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const fx = cam.x + fwd.x * 12;
    const fz = cam.z + fwd.z * 12;
    const k = Math.min(SODIUM_MAX, maxLamps);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const dx = heads[i * 4] - fx;
      const dz = heads[i * 4 + 2] - fz;
      const reach = heads[i * 4 + 3];
      // a lamp matters by how far inside its reach the focus is
      const score = (dx * dx + dz * dz) / (reach * reach);
      if (score > 4) continue;
      if (m < k) {
        let j = m++;
        while (j > 0 && this.best[j - 1] > score) {
          this.best[j] = this.best[j - 1];
          this.pick[j] = this.pick[j - 1];
          j--;
        }
        this.best[j] = score;
        this.pick[j] = i;
      } else if (score < this.best[k - 1]) {
        let j = k - 1;
        while (j > 0 && this.best[j - 1] > score) {
          this.best[j] = this.best[j - 1];
          this.pick[j] = this.pick[j - 1];
          j--;
        }
        this.best[j] = score;
        this.pick[j] = i;
      }
    }
    const L = sodiumUniforms.uSodLamps.value;
    for (let j = 0; j < m; j++) {
      const i = this.pick[j];
      L[j].set(heads[i * 4], heads[i * 4 + 1], heads[i * 4 + 2], heads[i * 4 + 3]);
    }
    sodiumUniforms.uSodN.value = m;
  }
}

export const sodiumField = new SodiumField();
