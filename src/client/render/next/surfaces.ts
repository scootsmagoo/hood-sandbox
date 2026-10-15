/**
 * Ground, road and roof detail (`?gfx=next`): the baked meshes are flat vertex colours, so the
 * asphalt, sidewalks, grass and roofs get noise in the fragment shader, from world position only.
 * Every pattern fades with distance so it neither shimmers nor costs anything where it cannot be seen.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

type Kind = 'asphalt' | 'sidewalk' | 'ground' | 'roof' | 'markings' | 'concrete';

const KIND_BY_NAME: Record<string, Kind> = {
  road_asphalt: 'asphalt',
  road_sidewalk: 'sidewalk',
  ground: 'ground',
  bld_roof: 'roof',
  road_markings: 'markings',
  road_concrete: 'concrete',
};

export function surfaceKind(materialName: string): Kind | null {
  return KIND_BY_NAME[materialName] ?? null;
}

const DECL = /* glsl */ `
varying vec3 vFW;
${GLSL_NOISE}
`;

const BODY: Record<Kind, string> = {
  asphalt: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(25.0, 110.0, d);
    float pt = gfxVn(p * 0.07) * 0.6 + gfxVn(p * 0.6 + 7.0) * 0.4;
    float grain = gfxH21(floor(p * 28.0)) - 0.5;
    float wear = gfxVn(vec2(p.x * 0.9, p.y * 0.9) + 31.0);
    diffuseColor.rgb *= 0.86 + 0.26 * pt + grain * 0.10 * near;
    // oil and rubber: a slightly darker, glossier mottling
    diffuseColor.rgb *= 1.0 - 0.18 * smoothstep(0.62, 0.9, wear) * (0.4 + 0.6 * near);
  }`,
  sidewalk: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 100.0, d);
    vec2 g = abs(fract(p / 1.6) - 0.5);
    float w = 0.012 + 0.004 * smoothstep(0.0, 60.0, d);
    float joint = smoothstep(0.5 - w * 2.0, 0.5 - w, max(g.x, g.y));
    float slab = gfxH21(floor(p / 1.6));
    float pt = gfxVn(p * 0.2) * 0.5 + gfxVn(p * 1.5) * 0.5;
    diffuseColor.rgb *= (0.88 + 0.16 * pt + (slab - 0.5) * 0.08 * near) * (1.0 - 0.32 * joint * near);
  }`,
  ground: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 140.0, d);
    float n = gfxVn(p * 0.045) * 0.5 + gfxVn(p * 0.31 + 3.0) * 0.3 + gfxVn(p * 2.4) * 0.2 * near + 0.2 * near * 0.0;
    float tint = 0.78 + 0.42 * n;
    // vary the hue a little as well as the value, so a lawn is not one green
    diffuseColor.rgb *= vec3(tint * (1.02 + 0.06 * (n - 0.5)), tint, tint * (1.0 - 0.08 * (n - 0.5)));
  }`,
  roof: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(60.0, 260.0, d);
    float cell = gfxH21(floor(p / 5.0));
    float n = gfxVn(p * 0.35) * 0.6 + gfxVn(p * 2.2) * 0.4;
    diffuseColor.rgb *= 0.9 + 0.2 * n + (cell - 0.5) * 0.12 * near;
  }`,
  markings: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 120.0, d);
    float wear = gfxVn(p * 1.3) * 0.6 + gfxVn(p * 7.0) * 0.4;
    diffuseColor.rgb *= 1.0 - 0.16 * smoothstep(0.45, 0.9, wear) * near;
  }`,
  concrete: /* glsl */ `
  {
    vec2 p = vFW.xz + vFW.y * 0.5;
    diffuseColor.rgb *= 0.88 + 0.2 * (gfxVn(p * 0.25) * 0.6 + gfxVn(p * 1.8) * 0.4);
  }`,
};

/** Patches one baked material by name. Returns false when the name is not one of the surfaces. */
export function patchSurfaceMaterial(mat: THREE.Material): boolean {
  const kind = surfaceKind(mat.name);
  if (!kind) return false;
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vFW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BODY[kind]}`);
    // The night glow Atmosphere puts on every building material would make the roofs orange.
    if (kind === 'roof') shader.fragmentShader = shader.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vec3(0.0);');
  };
  m.customProgramCacheKey = () => `gfxnext-surface-${kind}-v1`;
  m.needsUpdate = true;
  return true;
}
