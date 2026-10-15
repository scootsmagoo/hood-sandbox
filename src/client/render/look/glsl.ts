/** GLSL shared by the `?gfx=next` shaders: cheap hashes and value noise. No textures. */
export const GLSL_NOISE = /* glsl */ `
float gfxH11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float gfxH21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gfxVn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gfxH21(i), gfxH21(i + vec2(1.0, 0.0)), f.x), mix(gfxH21(i + vec2(0.0, 1.0)), gfxH21(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;
