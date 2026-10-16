/**
 * Car materials, GTA IV style: paint with a grime factor (dirt gathers low on the body and in
 * blotches, and dulls the shine), chrome, tinted glass, and a cheap environment reflection taken
 * from the sky's colours (no cube map: the reflected direction picks between ground, horizon and
 * zenith, weighted by Fresnel), so cars catch the sky at a glancing angle by day and go dark at
 * night. Lamps are one material with a lamp kind per vertex (head, tail, reverse) and a brightness
 * per kind; glass can show broken (crazed and darker) panel by panel.
 *
 * Every material here is a MeshStandardMaterial with a few lines injected, and the variants share
 * programs (`customProgramCacheKey`), so a car of any colour costs no new shader. The instanced
 * traffic uses the same code with per-instance attributes in place of per-car uniforms.
 */
import * as THREE from 'three';
import { addSodium } from './look/sodium';

/** The sky colours the reflections take; `EntityViews` updates them from the time of day. */
export const CAR_SKY = {
  uSkyTop: { value: new THREE.Color(0x4a82c4) },
  uSkyHorizon: { value: new THREE.Color(0xc9d8e2) },
  uSkyGround: { value: new THREE.Color(0x4a4740) },
};

/** Headlamp brightness on every car (raised at night). */
export const CAR_HEAD = { value: 0.8 };

const NOISE = /* glsl */ `
float carHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float carNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(carHash(i), carHash(i + vec3(1, 0, 0)), f.x), mix(carHash(i + vec3(0, 1, 0)), carHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(carHash(i + vec3(0, 0, 1)), carHash(i + vec3(1, 0, 1)), f.x), mix(carHash(i + vec3(0, 1, 1)), carHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
vec3 carSky(vec3 r) {
  return r.y > 0.0 ? mix(uSkyHorizon, uSkyTop, pow(r.y, 0.55)) : mix(uSkyHorizon, uSkyGround, clamp(-r.y * 4.0, 0.0, 1.0));
}
`;

export type CarShader = 'paint' | 'chrome' | 'glass' | 'lamp' | 'plain' | 'detail';

export interface CarShaderOptions {
  kind: CarShader;
  /** Per-instance attributes (aDirt, aLampB) in place of uniforms. */
  instanced?: boolean;
  /** Reflection strength and its value head-on (F0). */
  refl?: number;
  f0?: number;
}

/** The uniforms a car's own materials carry (per car); shared materials use the defaults. */
export interface CarUniforms {
  uDirt: { value: number };
  uLampB: { value: THREE.Vector3 };
  uBroken: { value: number };
}

export function newCarUniforms(): CarUniforms {
  return { uDirt: { value: 0 }, uLampB: { value: new THREE.Vector3(0.8, 0.28, 0) }, uBroken: { value: 0 } };
}

/** Injects the car shading into a standard material. */
export function patchCar(mat: THREE.MeshStandardMaterial, o: CarShaderOptions, u: CarUniforms = newCarUniforms()): THREE.MeshStandardMaterial {
  const kind = o.kind;
  const inst = !!o.instanced;
  const refl = o.refl ?? (kind === 'chrome' ? 1 : kind === 'glass' ? 0.9 : kind === 'paint' ? 0.85 : 0.25);
  const f0 = o.f0 ?? (kind === 'chrome' ? 0.65 : kind === 'glass' ? 0.06 : 0.05);
  mat.userData.car = u;
  mat.defines = { ...(mat.defines ?? {}), CAR_SHADING: '', [`CAR_${kind.toUpperCase()}`]: '', ...(inst ? { CAR_INSTANCED: '' } : {}) };
  mat.customProgramCacheKey = () => `car-${kind}-${inst ? 1 : 0}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyTop = CAR_SKY.uSkyTop;
    shader.uniforms.uSkyHorizon = CAR_SKY.uSkyHorizon;
    shader.uniforms.uSkyGround = CAR_SKY.uSkyGround;
    shader.uniforms.uDirt = u.uDirt;
    shader.uniforms.uLampB = u.uLampB;
    shader.uniforms.uBroken = u.uBroken;
    shader.uniforms.uHead = CAR_HEAD;
    shader.uniforms.uRefl = { value: refl };
    shader.uniforms.uF0 = { value: f0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCarPos;
varying float vDirt;
varying vec3 vLampB;
varying float vLamp;
varying float vWin;
uniform float uDirt;
uniform vec3 uLampB;
uniform float uHead;
#if defined(CAR_INSTANCED) && defined(CAR_PAINT)
attribute float aDirt;
#endif
#if defined(CAR_INSTANCED) && defined(CAR_LAMP)
attribute vec3 aLampB;
#endif
#ifdef CAR_LAMP
attribute float aLamp;
#endif
#ifdef CAR_GLASS
attribute float aWin;
#endif
#ifdef CAR_DETAIL
attribute vec2 aShine;
varying vec2 vShine;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vCarPos = position;
#if defined(CAR_INSTANCED) && defined(CAR_PAINT)
vDirt = aDirt;
#else
vDirt = uDirt;
#endif
#if defined(CAR_INSTANCED) && defined(CAR_LAMP)
vLampB = aLampB;
#else
vLampB = vec3(uHead, uLampB.yz);
#endif
#ifdef CAR_LAMP
vLamp = aLamp;
#else
vLamp = 0.0;
#endif
#ifdef CAR_GLASS
vWin = aWin;
#else
vWin = 0.0;
#endif
#ifdef CAR_DETAIL
vShine = aShine;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCarPos;
varying float vDirt;
varying vec3 vLampB;
varying float vLamp;
varying float vWin;
uniform float uBroken;
uniform float uRefl;
uniform float uF0;
#ifdef CAR_DETAIL
varying vec2 vShine;
#endif
${NOISE}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float dirtMask = 0.0;
#ifdef CAR_PAINT
{
  float dn = carNoise(vCarPos * 6.0) * 0.6 + carNoise(vCarPos * 21.0) * 0.4;
  float low = clamp((0.2 - vCarPos.y) * 2.4, 0.0, 1.0);
  dirtMask = clamp(vDirt * (low * (0.45 + 0.75 * dn) + 0.28 * dn * dn), 0.0, 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.18, 0.155), dirtMask);
}
#endif
#ifdef CAR_LAMP
vec3 lampGlow = vec3(0.0);
{
  vec3 lens = vLamp < 0.5 ? vec3(0.8, 0.8, 0.75) : vLamp < 1.5 ? vec3(0.42, 0.03, 0.03) : vec3(0.78);
  lampGlow = vLamp < 0.5 ? vec3(1.0, 0.92, 0.75) * vLampB.x : vLamp < 1.5 ? vec3(1.0, 0.07, 0.03) * vLampB.y : vec3(1.0, 0.98, 0.95) * vLampB.z;
  diffuseColor.rgb = lens;
}
#endif
float broken = 0.0;
#ifdef CAR_GLASS
broken = mod(floor(uBroken / exp2(floor(vWin + 0.5))), 2.0);
if (broken > 0.5) {
  // crazed safety glass: a web of pale cracks over a milky, darker pane
  float n1 = carNoise(vCarPos * 5.0) + 0.35 * carNoise(vCarPos * 17.0);
  float lines = 1.0 - smoothstep(0.0, 0.045, abs(fract(n1 * 3.0) - 0.5));
  float fine = 1.0 - smoothstep(0.0, 0.03, abs(fract(carNoise(vCarPos * 13.0 + 7.0) * 2.0) - 0.5));
  diffuseColor.rgb = mix(vec3(0.1, 0.11, 0.115), vec3(0.62, 0.65, 0.68), max(lines * 0.8, fine * 0.45));
  diffuseColor.a = 0.9;
}
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
#ifdef CAR_DETAIL
roughnessFactor = vShine.x;
#endif
roughnessFactor = mix(roughnessFactor, 0.95, dirtMask);
#ifdef CAR_GLASS
roughnessFactor = mix(roughnessFactor, 0.6, broken);
#endif`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
#ifdef CAR_DETAIL
metalnessFactor = vShine.y;
#endif
metalnessFactor *= 1.0 - dirtMask;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  vec3 Vw = normalize(inverseTransformDirection(vViewPosition, viewMatrix));
  vec3 Nw = normalize(inverseTransformDirection(normal, viewMatrix));
  vec3 Rw = reflect(-Vw, Nw);
  float f0 = uF0;
#ifdef CAR_DETAIL
  f0 = mix(0.04, 0.65, vShine.y);
#endif
  float fres = f0 + (1.0 - f0) * pow(1.0 - clamp(dot(Nw, Vw), 0.0, 1.0), 5.0);
  float k = uRefl;
#ifdef CAR_DETAIL
  k *= vShine.y * 0.9 + 0.1;
#endif
  float rk = clamp(fres * k * (1.0 - roughnessFactor * 0.9) * (1.0 - dirtMask), 0.0, 1.0);
#ifdef CAR_CHROME
  outgoingLight = mix(outgoingLight, carSky(Rw) * diffuseColor.rgb * 1.15, rk);
#elif defined(CAR_DETAIL)
  outgoingLight = mix(outgoingLight, carSky(Rw) * mix(vec3(1.0), diffuseColor.rgb * 1.15, vShine.y), rk);
#else
  outgoingLight = mix(outgoingLight, carSky(Rw), rk);
#endif
#ifdef CAR_GLASS
  diffuseColor.a = clamp(diffuseColor.a + fres * 0.45 * (1.0 - broken), 0.0, 1.0);
#endif
#ifdef CAR_LAMP
  outgoingLight += lampGlow;
#endif
}
#include <opaque_fragment>`,
      );
    // sodium street light from the nearest lamps at night (look/sodium.ts); a no-op by day. Paint is bright and glossy, so a third.
    addSodium(shader, 0.35);
  };
  return mat;
}

/** Charred: what a burnt-out shell is drawn in (every part). */
export const BURNT = new THREE.Color(0x1b1a19);

type SharedName = 'trim' | 'chrome' | 'glass' | 'interior' | 'tyre' | 'burnt' | 'burntGlass' | 'wheelTrim' | 'wheelChrome' | 'wheelTyre' | 'wheelBurnt';
let shared: Record<SharedName, THREE.MeshStandardMaterial> | null = null;

/**
 * The materials every car shares (one program each). The wheels (InstancedMeshes) have their own copies: a material drawn by
 * both instanced and plain meshes has its program looked up again at every switch, which costs CPU on every draw.
 */
export function sharedCarMaterials() {
  if (shared) return shared;
  shared = {
    wheelTrim: patchCar(new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.62, metalness: 0.1 }), { kind: 'plain' }),
    wheelChrome: patchCar(new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.18, metalness: 1 }), { kind: 'chrome' }),
    wheelTyre: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.92 }),
    wheelBurnt: new THREE.MeshStandardMaterial({ color: BURNT, roughness: 0.97, metalness: 0.05 }),
    trim: patchCar(new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.62, metalness: 0.1 }), { kind: 'plain' }),
    chrome: patchCar(new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.18, metalness: 1 }), { kind: 'chrome' }),
    glass: patchCar(newGlass(), { kind: 'glass' }),
    interior: new THREE.MeshStandardMaterial({ color: 0x1d1c1b, roughness: 0.9 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.92 }),
    burnt: new THREE.MeshStandardMaterial({ color: BURNT, roughness: 0.97, metalness: 0.05 }),
    burntGlass: patchCar(newGlass(), { kind: 'glass' }, { ...newCarUniforms(), uBroken: { value: 0xffffff } }),
  };
  return shared;
}

/**
 * A car window: see-through, seen from both sides. three.js draws a transparent double-sided material twice (inside
 * faces, then outside faces), flipping `side` and setting `needsUpdate` around each draw, and a changed `version`
 * means a new shader program lookup (parameters, cache key string) for each draw, every frame, and a program switch
 * between the two passes. One pass (`forceSinglePass`) draws every face once. The only difference is the blend order
 * where two panes overlap on screen (the dark tint is nearly the same on both, so the pixels agree to within a
 * level: rendering the same frames both ways differed by 0 of 255 on every pixel).
 */
export function newGlass(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0f1518, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide });
  m.forceSinglePass = true;
  return m;
}

export function newPaint(color: number, u: CarUniforms, instanced = false): THREE.MeshStandardMaterial {
  return patchCar(new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.35, vertexColors: false }), { kind: 'paint', instanced }, u);
}

export function newLamp(u: CarUniforms, instanced = false): THREE.MeshStandardMaterial {
  return patchCar(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0 }), { kind: 'lamp', instanced, refl: 0.6 }, u);
}
