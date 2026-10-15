/**
 * The GTA IV sky dome: a hazy gradient with a thick horizon band, a soft sun glare (no hard disc),
 * a slow overcast cloud layer lit from below by the city at night, a few stars, and a pale moon.
 * Drawn after the opaque scene with its depth pushed to the far plane, so it is shaded only where
 * nothing else is (a full-screen fbm behind a city that covers most of the view would be a waste).
 *
 * Uniform names uHorizon and uZenith match the classic dome's, so Atmosphere sets them the same way.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uNight;
uniform float uTime;
varying vec3 vDir;
${GLSL_NOISE}
float gfxFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < GFX_SKY_OCTAVES; i++) {
    s += a * gfxVn(p);
    p = p * 2.03 + 17.3;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float y = max(d.y, 0.0);
  float day = 1.0 - uNight;
  // a hazy gradient: the horizon colour climbs a long way up the sky
  float t = pow(y, 0.5);
  vec3 sky = mix(uHorizon, uZenith, t);

  // overcast: soft cloud, drifting, brighter where the sun is behind it
  vec2 cp = d.xz / (y + 0.14) * 0.85 + vec2(uTime * 0.004, uTime * 0.0015);
  float n = gfxFbm(cp);
  float cloud = smoothstep(0.34, 0.78, n) * smoothstep(0.0, 0.22, y);
  float sunSide = max(dot(d, uSunDir), 0.0);
  vec3 cloudCol = mix(uHorizon * 0.78, uHorizon * 1.05, smoothstep(0.35, 0.7, n)) * (1.0 + day * 0.18 * pow(sunSide, 3.0));
  sky = mix(sky, cloudCol, cloud * 0.7);

  // the sun: a wide soft glare through the haze, no hard disc
  float glare = pow(sunSide, 5.0) * 0.22 + pow(sunSide, 48.0) * 0.45 + pow(sunSide, 600.0) * 0.8;
  sky += uSunColor * glare * smoothstep(-0.08, 0.12, uSunDir.y) * (1.0 - 0.5 * cloud) * (0.5 + 0.5 * day);

  // night: a few stars through the glow of the city, and a pale moon
  #if GFX_SKY_OCTAVES > 2
  if (uNight > 0.3) {
    vec3 q = d * 110.0;
    vec3 f = floor(q);
    float h = gfxH21(f.xy + f.z * 17.0);
    float star = step(0.9965, h) * (1.0 - smoothstep(0.0, 0.3, length(fract(q) - 0.5)));
    sky += vec3(0.7, 0.8, 1.0) * star * 0.9 * (uNight - 0.3) * smoothstep(0.1, 0.4, y) * (1.0 - cloud);
  }
  #endif
  float cm = dot(d, uMoonDir);
  vec3 moonCol = vec3(0.78, 0.84, 1.0);
  sky += moonCol * (smoothstep(0.99935, 0.99965, cm) * 1.4 + pow(max(cm, 0.0), 220.0) * 0.5) * uNight * (1.0 - 0.8 * cloud);

  gl_FragColor = vec4(sky, 1.0);
}`;

export interface SkyUniforms {
  uHorizon: THREE.IUniform<THREE.Color>;
  uZenith: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uNight: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

/** The dome's material. `octaves` is the cloud detail (Low uses 2 and no stars). */
export function createSkyMaterial(octaves: 2 | 4): THREE.ShaderMaterial {
  const uniforms: SkyUniforms = {
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    defines: { GFX_SKY_OCTAVES: octaves },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}
