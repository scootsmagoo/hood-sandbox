/**
 * Humid-air haze. three.js's linear fog is a straight ramp, so the air stays clear until `near` and
 * then turns to a wall. The humid look wants the opposite: a little haze from the first block that
 * thickens smoothly with distance (an exponential), and no near plane to set. The fog chunk is
 * replaced once for every material (the sky dome has no fog, so it is not touched):
 *
 *   fog.near < 0   exponential: nearly all fog at `far`, a quarter at far / 4
 *   fog.near >= 0  three's own smoothstep ramp, as before
 *
 * `Atmosphere` writes the mode and the range. A plain uniform test, so one program serves both.
 */
import * as THREE from 'three';

let patched = false;

/** The share of the surface's colour that survives the haze at `distance`, for an exponential fog of range `far`. */
export function hazeClear(distance: number, far: number): number {
  const k = (distance * 2.2) / far;
  return Math.exp(-k * k);
}

export function patchFogChunk(): void {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float gfxFk = vFogDepth * 2.2 / fogFar;
    float fogFactor = fogNear < 0.0 ? 1.0 - exp( - gfxFk * gfxFk ) : smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
}
