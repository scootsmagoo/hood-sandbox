/**
 * The ped material: one MeshStandardMaterial with a few injected lines, in two flavours that share
 * the shading.
 *
 *  - `actor`: a SkinnedMesh (three's own skinning); the palette is a uniform array on the material.
 *  - `crowd`: an InstancedMesh whose bones come from a baked animation texture (`BakedAnims`): each
 *    vertex blends up to four bone matrices read from two frames of up to two clips; the palette is a
 *    texture with a row a person.
 *
 * Shading (GTA IV, cheap): every region takes its colour from the person's palette and the baked
 * ambient occlusion in the vertex colour; cloth is matte, skin gets a little roughness variation and
 * a warm wrap of the light round the terminator (a stand-in for subsurface scattering); shoes are
 * glossier. At night the sodium of the street lamps washes over what faces up (heads, shoulders),
 * through the look's night and spill uniforms, so people pick up the orange without a real light.
 */
import * as THREE from 'three';
import { addSodium } from '../look/sodium';
import { R, REGION_COUNT } from './outfits';

const REGION_FRAG = /* glsl */ `
float pedRegionRough(int r) {
  // skin, lip, eye, sclera, hair, top, top2, bottom, shoe, sole, belt, hat, gear, trim, stubble
  if (r == ${R.skin} || r == ${R.stubble} || r == ${R.face}) return 0.62;
  if (r == ${R.lip}) return 0.45;
  if (r == ${R.eye} || r == ${R.sclera}) return 0.3;
  if (r == ${R.hair}) return 0.7;
  if (r == ${R.shoe}) return 0.5;
  if (r == ${R.belt} || r == ${R.trim}) return 0.55;
  return 0.93;
}
`;

const FACE_FRAG = /* glsl */ `
float pedHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pedBlob(vec2 d, vec2 r, float soft) { return 1.0 - smoothstep(1.0 - soft, 1.0, length(d / r)); }
// The face is drawn here, not modelled in colour: eyes, brows, lips, nostrils from the bind-pose position, the hairline and beard from the cover the mesh carries.
vec3 pedFace(vec3 p, vec3 cov, vec3 skin, vec3 hair, vec3 stub, vec3 lip, vec3 eyeC, vec3 sclera) {
  vec3 c = skin;
  float ax = abs(p.x);
  float front = smoothstep(0.045, 0.075, p.z);
  // stubble and beards
  float bd = smoothstep(0.35, 0.65, cov.y + (pedHash(p * 90.0) - 0.5) * 0.18);
  c = mix(c, cov.z > 0.5 ? hair * 0.9 : stub, bd * (cov.z > 0.5 ? 0.95 : 0.8));
  // lips, the line between them
  float up = pedBlob(vec2(p.x, p.y - 1.5755), vec2(0.0235, 0.0062), 0.45);
  float lo = pedBlob(vec2(p.x, p.y - 1.5585), vec2(0.0215, 0.0072), 0.45);
  c = mix(c, lip, max(up, lo) * front);
  float ml = (1.0 - smoothstep(0.0006, 0.0017, abs(p.y - 1.5668))) * (1.0 - smoothstep(0.022, 0.026, ax));
  c = mix(c, lip * 0.28, ml * front);
  // nostrils
  float nos = pedBlob(vec2(ax - 0.0128, p.y - 1.5872), vec2(0.0034, 0.0026), 0.5);
  c = mix(c, skin * 0.18, nos * front);
  // eyes: an almond of white, the iris, a dark lid line
  vec2 ed = vec2(ax - 0.0345, p.y - 1.6405);
  float almond = length(ed / vec2(0.0150, 0.0072));
  float eyeIn = 1.0 - smoothstep(0.82, 1.0, almond);
  c = mix(c, sclera, eyeIn * front);
  float iris = 1.0 - smoothstep(0.7, 1.0, length((ed - vec2(0.0005, 0.0)) / vec2(0.0076, 0.0076)));
  c = mix(c, eyeC, iris * eyeIn * front);
  float lid = smoothstep(0.92, 1.05, almond) * (1.0 - smoothstep(1.1, 1.38, almond)) * smoothstep(-0.0035, 0.0045, ed.y);
  c = mix(c, skin * 0.3, lid * front * 0.85);
  // brows
  float bx = clamp((ax - 0.014) / 0.049, 0.0, 1.0);
  float by = 1.6545 + 0.0105 * sin(bx * 3.14159) * (1.0 - 0.35 * bx) + 0.0035 * bx;
  float brow = (1.0 - smoothstep(0.0028, 0.0052, abs(p.y - by))) * smoothstep(0.012, 0.018, ax) * (1.0 - smoothstep(0.060, 0.066, ax));
  c = mix(c, hair, brow * front * 0.92);
  // hair over it all, with a ragged edge
  float h = smoothstep(0.4, 0.62, cov.x + (pedHash(p * 120.0) - 0.5) * 0.16);
  c = mix(c, hair * (0.85 + 0.3 * pedHash(p * 260.0)), h);
  return c;
}
`;

const WRAP = /* glsl */ `
float pedWrap = 0.0;
`;

function patchDirect(chunk: string): string {
  // the wrap lights the diffuse only: adding it to the irradiance would feed the specular lobe and flare at the silhouette
  const out = chunk.replace(
    'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;',
    `float dotNLraw = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( dotNLraw );
	vec3 irradiance = dotNL * directLight.color;
	vec3 pedExtra = vec3( 0.0 );
	if ( pedWrap > 0.0 ) {
		float wrapped = saturate( ( dotNLraw + pedWrap ) / ( 1.0 + pedWrap ) );
		pedExtra = ( wrapped - dotNL ) * directLight.color * vec3( 0.7, 0.34, 0.24 );
	}`,
  )
    .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );', 'reflectedLight.directDiffuse += ( irradiance + pedExtra ) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );');
  if (!out.includes('pedExtra ) * BRDF_Lambert') || out === chunk) console.warn('ped material: the direct-light chunk changed, skin wrap is off');
  return out;
}

/** The skinning shared by the crowd's vertex and depth shaders: bone matrices from the animation texture. */
const BAKED_VERT_DECL = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aAnimA;   // frame a0, frame a1, blend a, share of clip B
attribute vec4 aAnimB;   // frame b0, frame b1, blend b, palette slot
uniform highp sampler2D uAnim;
vec4 pedRow(float frame, float bone, int r) { return texelFetch(uAnim, ivec2(int(bone) * 3 + r, int(frame)), 0); }
void pedBone(float bone, out vec4 r0, out vec4 r1, out vec4 r2) {
  r0 = mix(pedRow(aAnimA.x, bone, 0), pedRow(aAnimA.y, bone, 0), aAnimA.z);
  r1 = mix(pedRow(aAnimA.x, bone, 1), pedRow(aAnimA.y, bone, 1), aAnimA.z);
  r2 = mix(pedRow(aAnimA.x, bone, 2), pedRow(aAnimA.y, bone, 2), aAnimA.z);
  if (aAnimA.w > 0.003) {
    vec4 s0 = mix(pedRow(aAnimB.x, bone, 0), pedRow(aAnimB.y, bone, 0), aAnimB.z);
    vec4 s1 = mix(pedRow(aAnimB.x, bone, 1), pedRow(aAnimB.y, bone, 1), aAnimB.z);
    vec4 s2 = mix(pedRow(aAnimB.x, bone, 2), pedRow(aAnimB.y, bone, 2), aAnimB.z);
    r0 = mix(r0, s0, aAnimA.w);
    r1 = mix(r1, s1, aAnimA.w);
    r2 = mix(r2, s2, aAnimA.w);
  }
}
void pedSkinBaked(inout vec3 pos, inout vec3 nor) {
  vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float w = skinWeight[k];
    if (w <= 0.0) continue;
    vec4 r0, r1, r2;
    pedBone(skinIndex[k], r0, r1, r2);
    a0 += r0 * w; a1 += r1 * w; a2 += r2 * w;
  }
  vec4 p = vec4(pos, 1.0);
  pos = vec3(dot(a0, p), dot(a1, p), dot(a2, p));
  nor = vec3(dot(a0.xyz, nor), dot(a1.xyz, nor), dot(a2.xyz, nor));
}
`;

export const bakedAnimUniform = { value: null as THREE.Texture | null };
export const crowdPaletteUniform = { value: null as THREE.Texture | null };

function inject(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, instanced: boolean, palette: Float32Array | null) {
  if (instanced) {
    shader.uniforms.uAnim = bakedAnimUniform;
    shader.uniforms.uPalTex = crowdPaletteUniform;
  } else {
    shader.uniforms.uPal = { value: palette };
  }
  const D = instanced ? '#define PED_INSTANCED\n' : '';
  shader.vertexShader = `${D}${shader.vertexShader}`
    .replace('#include <common>', `#include <common>\nattribute float aAo;\nattribute float aRegion;\nattribute vec3 aCov;\nvarying float vAo;\nvarying float vRegion;\nvarying vec3 vCov;\nvarying vec3 vBind;\n${instanced ? 'varying float vSlot;\n' + BAKED_VERT_DECL : ''}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAo = aAo;\nvRegion = aRegion;\nvCov = aCov;\nvBind = position;\n${instanced ? 'vSlot = aAnimB.w;' : ''}`);
  if (instanced) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinnormal_vertex>', 'vec3 pedP = position; pedSkinBaked(pedP, objectNormal);')
      .replace('#include <skinning_vertex>', 'transformed = pedP;');
  }
  shader.fragmentShader = `${D}${shader.fragmentShader}`
    .replace('#include <lights_physical_pars_fragment>', () => `${WRAP}${patchDirect(THREE.ShaderChunk.lights_physical_pars_fragment)}`)
    .replace('#include <common>', `#include <common>
varying float vAo;
varying float vRegion;
varying vec3 vCov;
varying vec3 vBind;
${instanced ? 'varying float vSlot;\nuniform highp sampler2D uPalTex;' : `uniform vec3 uPal[${REGION_COUNT}];`}
${REGION_FRAG}
${FACE_FRAG}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
  int pedR = int(vRegion + 0.5);
  ${instanced ? 'int pedS = int(vSlot + 0.5);\n  #define PAL(r) texelFetch(uPalTex, ivec2(r, pedS), 0).rgb' : '#define PAL(r) uPal[r]'}
  vec3 pedBase = PAL(pedR);
  if (pedR == ${R.face}) pedBase = pedFace(vBind, vCov, PAL(${R.skin}), PAL(${R.hair}), PAL(${R.stubble}), PAL(${R.lip}), PAL(${R.eye}), PAL(${R.sclera}));
  {
    // a grain of weave and pores, so cloth and skin are not flat plastic up close
    float pg = pedHash(floor(vBind * 150.0)) - 0.5;
    float amp = (pedR == ${R.skin} || pedR == ${R.face}) ? 0.035 : pedR == ${R.hair} ? 0.10 : 0.075;
    pedBase *= 1.0 + pg * 2.0 * amp;
  }
  diffuseColor.rgb *= pedBase;
  diffuseColor.rgb *= mix(1.0, vAo, 0.72);
  pedWrap = (pedR == ${R.skin} || pedR == ${R.lip} || pedR == ${R.stubble} || pedR == ${R.face}) ? 0.18 : 0.0;`)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = pedRegionRough(pedR);');
  // sodium from the street lamps nearest the camera, on what stands in it (look/sodium.ts)
  addSodium(shader);
}

function make(instanced: boolean, palette: Float32Array | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => inject(shader, instanced, palette);
  m.customProgramCacheKey = () => `ped-${instanced ? 'crowd' : 'actor'}-v2`;
  return m;
}

/** A near person's material: its own palette (REGION_COUNT x 3, linear). */
export function actorMaterial(palette: Float32Array): THREE.MeshStandardMaterial {
  return make(false, palette);
}

/** The crowd's one material (per tier it is the same). */
export function crowdMaterial(): THREE.MeshStandardMaterial {
  return make(true, null);
}

/** The crowd's shadow shader: the baked skinning on a depth material. */
export function crowdDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uAnim = bakedAnimUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BAKED_VERT_DECL}`)
      .replace('#include <skinning_vertex>', 'vec3 pedN = vec3(0.0, 1.0, 0.0); vec3 pedP = position; pedSkinBaked(pedP, pedN); transformed = pedP;');
  };
  m.customProgramCacheKey = () => 'ped-crowd-depth-v1';
  return m;
}
