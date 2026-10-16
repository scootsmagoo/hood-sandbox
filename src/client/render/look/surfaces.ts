/**
 * Ground, road and roof detail: the baked meshes are flat vertex colours, so the asphalt, sidewalks,
 * grass and roofs get grime in the fragment shader, from world position only: worn and patched
 * asphalt with cracks and oil, stained sidewalk slabs, olive and brown lawns, dull roofs, dirty
 * markings. Every pattern fades with distance so it neither shimmers nor costs anything where it
 * cannot be seen. Level 1 (Low) drops the patches, cracks, stains and the finest octaves.
 *
 * **Baked first.** A tile of mesh format 2 (docs/contracts/m1-tile-format.md, "Mesh attributes")
 * gives the shaders more to work with, and they use it when the geometry has it: on the roads
 * `TEXCOORD_0` (metres across, metres along) and `TEXCOORD_1` (half width, kerb) give the gutter,
 * the wheel tracks, the oil down the lane and slabs that line up with the sidewalk; on the ground
 * `_LAND` says where the lawn, the bare earth and the paving are; on the roofs `_SRF` says which
 * surface is a slope, a parapet or a rooftop box; and every surface multiplies its indirect light by
 * the baked ambient occlusion in the alpha of `COLOR_0` (facade.ts `AO_FRAGMENT`; neutral on an
 * older tile). Without them the same surfaces use world-position noise only, as the first version did.
 */
import * as THREE from 'three';
import { AO_FRAGMENT } from './facade';
import { GLSL_NOISE } from './glsl';
import { U } from './uniforms';

type Kind = 'asphalt' | 'sidewalk' | 'ground' | 'roof' | 'markings' | 'concrete' | 'rail' | 'airfield';

const KIND_BY_NAME: Record<string, Kind> = {
  road_asphalt: 'asphalt',
  road_sidewalk: 'sidewalk',
  ground: 'ground',
  bld_roof: 'roof',
  road_markings: 'markings',
  road_concrete: 'concrete',
  road_rail: 'rail',
  road_crosswalk: 'markings',
  // the airport's pavement (concrete slabs) and its paint (tools/pipeline/src/world/aerowaySurface.ts)
  road_airfield: 'airfield',
  road_aeromark: 'markings',
};

export function surfaceKind(materialName: string): Kind | null {
  return KIND_BY_NAME[materialName] ?? null;
}

const VERT_DECL = /* glsl */ `
varying vec3 vFW;
varying vec2 vUvR;
#ifdef GFX_ROAD_UV
  attribute vec2 gUv1;
  varying vec2 vRoad;
#endif
#ifdef GFX_LAND
  attribute vec4 gLand;
  varying vec4 vLand;
#endif
#ifdef GFX_SRF
  attribute vec4 gSrf;
  varying vec4 vSrf;
#endif
#ifdef GFX_LOOK
  attribute vec4 gLook;
  varying vec4 vLook;
#endif
`;

const VERT_BODY = /* glsl */ `
  vFW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vUvR = uv;
#ifdef GFX_ROAD_UV
  vRoad = gUv1;
#endif
#ifdef GFX_LAND
  vLand = gLand;
#endif
#ifdef GFX_SRF
  vSrf = gSrf;
#endif
#ifdef GFX_LOOK
  vLook = gLook;
#endif
`;

const DECL = /* glsl */ `
uniform float uAo;
varying vec3 vFW;
varying vec2 vUvR;
#ifdef GFX_ROAD_UV
  varying vec2 vRoad;
#endif
#ifdef GFX_LAND
  varying vec4 vLand;
#endif
#ifdef GFX_SRF
  varying vec4 vSrf;
#endif
#ifdef GFX_LOOK
  varying vec4 vLook;
#endif
${GLSL_NOISE}
`;

const BODY: Record<Kind, string> = {
  asphalt: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(25.0, 110.0, d);
    float pt = gfxVn(p * 0.07) * 0.6 + gfxVn(p * 0.6 + 7.0) * 0.4;
    float wear = gfxVn(vec2(p.x * 0.9, p.y * 0.9) + 31.0);
    diffuseColor.rgb *= (1.05 + 0.34 * pt) * vec3(1.04, 1.0, 0.94); // brown-grey, uneven
    // oil and rubber: darker mottling
    diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.58, 0.9, wear) * (0.4 + 0.6 * near);
    #ifndef GFX_LITE
      float grain = gfxH21(floor(p * 28.0)) - 0.5;
      diffuseColor.rgb *= 1.0 + grain * 0.10 * near;
      // repair patches: rotated rectangles of newer, darker tar, one cell in five
      vec2 cp = p / 7.0;
      vec2 ci = floor(cp);
      float hh = gfxH21(ci + 3.7);
      float ang = hh * 6.2832;
      vec2 cf = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (fract(cp) - 0.5);
      vec2 hf = vec2(0.16 + 0.22 * gfxH21(ci + 1.3), 0.1 + 0.26 * gfxH21(ci + 8.1));
      vec2 q = abs(cf - (vec2(gfxH21(ci + 5.1), gfxH21(ci + 9.7)) - 0.5) * 0.25) - hf;
      float fixP = (1.0 - smoothstep(-0.01, 0.02, max(q.x, q.y))) * step(0.87, hh);
      float fixE = fixP * smoothstep(0.0, 0.03, -max(q.x, q.y));
      diffuseColor.rgb *= mix(1.0, 0.8 + 0.08 * gfxH21(ci), fixP) * (1.0 - 0.1 * (fixP - fixE));
      // cracks: thin dark contours of a noise field, where a second field says the surface is tired
      float cr = abs(gfxVn(p * 0.8 + 11.0) - 0.5);
      float tired = smoothstep(0.5, 0.75, gfxVn(p * 0.05 + 4.0));
      float crack = (1.0 - smoothstep(0.0, 0.012 + 0.0001 * d, cr)) * tired;
      diffuseColor.rgb *= 1.0 - 0.5 * crack * (0.3 + 0.7 * near);
    #endif
    #ifdef GFX_ROAD_UV
      // baked road coordinates: u across the carriageway, v along it (a junction: world x and z); the kerb distance
      float hw = vRoad.x;
      bool ribbon = hw > 0.0;
      float dk = ribbon ? hw - abs(vUvR.x - hw) : vRoad.y;
      float gut = 1.0 - smoothstep(0.0, 0.75, dk); // the gutter: dark with grit and old oil
      diffuseColor.rgb *= 1.0 - 0.4 * gut * (0.6 + 0.4 * gfxVn(vec2(vUvR.x * 0.8 + vUvR.y * 0.3, vUvR.y * 0.9)));
      if (ribbon) {
        // wheel tracks: two darker, slightly polished strips in every lane, and oil down its middle
        float nl = max(1.0, floor(hw * 2.0 / 3.3 + 0.5));
        float lw = hw * 2.0 / nl;
        float lc = (fract(vUvR.x / lw) - 0.5) * lw;
        float tr = 1.0 - smoothstep(0.0, 0.34, abs(abs(lc) - 0.8));
        float nz = gfxVn(vec2(vUvR.x * 2.0, vUvR.y * 0.12));
        diffuseColor.rgb *= 1.0 - 0.2 * tr * (0.4 + 0.7 * nz) * (0.3 + 0.7 * near);
        float oil = (1.0 - smoothstep(0.0, 0.3, abs(lc))) * smoothstep(0.58, 0.82, gfxVn(vec2(vUvR.x * 1.5, vUvR.y * 0.3)));
        diffuseColor.rgb *= 1.0 - 0.3 * oil * near;
      }
    #endif
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
    diffuseColor.rgb *= (0.84 + 0.18 * pt + (slab - 0.5) * 0.1 * near) * (1.0 - 0.38 * joint * near) * vec3(1.03, 1.0, 0.92);
    #ifndef GFX_LITE
      // gum, oil and city dirt: dark blotches and a few slabs that are simply dirtier than the rest
      float blot = smoothstep(0.62, 0.82, gfxVn(p * 0.55 + 3.0)) * (0.3 + 0.7 * near);
      diffuseColor.rgb *= 1.0 - 0.28 * blot - 0.1 * step(0.8, slab) * near;
    #endif
    #ifdef GFX_ROAD_UV
      // baked: u across the walk, v along it, and the kerb on one edge: a pale kerb stone, the dirt behind it, slabs that line up with the walk
      float hw = vRoad.x;
      bool ribbon = hw > 0.0;
      float dk = ribbon ? (vRoad.y > 0.5 ? 2.0 * hw - vUvR.x : (vRoad.y < -0.5 ? vUvR.x : 99.0)) : vRoad.y;
      float lip = 1.0 - smoothstep(0.1, 0.2, dk);
      float dirt = (1.0 - smoothstep(0.2, 0.9, dk)) * (1.0 - lip);
      diffuseColor.rgb *= (1.0 + 0.12 * lip) * (1.0 - 0.3 * dirt * (0.6 + 0.4 * gfxVn(vec2(vUvR.x + vUvR.y * 0.7, vUvR.y * 0.8))));
      if (ribbon) {
        float ns = max(1.0, floor(hw * 2.0 / 1.5 + 0.5));
        vec2 sp = vec2(vUvR.x / (hw * 2.0 / ns), vUvR.y / 1.5);
        vec2 sg = abs(fract(sp) - 0.5);
        float sj = smoothstep(0.5 - w * 2.0, 0.5 - w, max(sg.x * 1.2, sg.y));
        diffuseColor.rgb *= 1.0 + 0.38 * joint * near - 0.38 * sj * near; // swap the world-aligned joints for the walk's own
      }
    #endif
  }`,
  ground: /* glsl */ `
  #ifdef GFX_LAND
  {
    // baked land weights: lawn, bare earth and paving; everything else keeps the colour it was baked with
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 140.0, d);
    float gW = vLand.y / 255.0;
    float dW = vLand.z / 255.0;
    float pW = vLand.w / 255.0;
    float n = gfxVn(p * 0.045) * 0.5 + gfxVn(p * 0.31 + 3.0) * 0.3 + 0.1;
    #ifndef GFX_LITE
      n += gfxVn(p * 2.4) * 0.2 * near;
    #endif
    float tint = 0.74 + 0.42 * n;
    float lumG = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 lawn = mix(vec3(lumG), diffuseColor.rgb, 0.55) * vec3(tint * (1.06 + 0.1 * (n - 0.5)), tint * 0.98, tint * (0.74 - 0.12 * (n - 0.5)));
    vec3 earth = diffuseColor.rgb * vec3(1.05, 0.95, 0.8) * (0.8 + 0.4 * n);
    diffuseColor.rgb = mix(diffuseColor.rgb, lawn, gW);
    diffuseColor.rgb = mix(diffuseColor.rgb, earth, dW);
    // paving: slabs about 1.4 m, a darker joint, a little dirt
    vec2 pg = abs(fract(p / 1.4) - 0.5);
    float pj = smoothstep(0.5 - 0.03, 0.5 - 0.012, max(pg.x, pg.y));
    float pslab = gfxH21(floor(p / 1.4));
    diffuseColor.rgb *= 1.0 - pW * ((0.28 * pj + (pslab - 0.5) * 0.1) * near + 0.12 * (1.0 - n));
  }
  #else
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 140.0, d);
    float n = gfxVn(p * 0.045) * 0.5 + gfxVn(p * 0.31 + 3.0) * 0.3;
    #ifndef GFX_LITE
      n += gfxVn(p * 2.4) * 0.2 * near;
    #else
      n += 0.1;
    #endif
    float tint = 0.74 + 0.42 * n;
    // dull olive and brown lawns, never a bright green: pull the colour toward grey, then toward yellow-brown
    float lumG = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(vec3(lumG), diffuseColor.rgb, 0.55);
    diffuseColor.rgb *= vec3(tint * (1.06 + 0.1 * (n - 0.5)), tint * 0.98, tint * (0.74 - 0.12 * (n - 0.5)));
  }
  #endif`,
  roof: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(60.0, 260.0, d);
    float nearer = 1.0 - smoothstep(25.0, 110.0, d);
    float cell = gfxH21(floor(p / 5.0));
    float n = gfxVn(p * 0.35) * 0.6 + gfxVn(p * 2.2) * 0.4;
    // the roof material (0 membrane, 1 metal, 2 tile, 3 shingle, 4 concrete, 5 green, 6 copper, 7 gold, 8 white membrane)
    float rm = 0.0;
    #ifdef GFX_LOOK
      rm = vLook.x;
    #endif
    bool rMetal = abs(rm - 1.0) < 0.5;
    bool rTile = abs(rm - 2.0) < 0.5;
    bool rConc = abs(rm - 4.0) < 0.5;
    bool rGreen = abs(rm - 5.0) < 0.5;
    bool rCopper = abs(rm - 6.0) < 0.5;
    bool rGold = abs(rm - 7.0) < 0.5;
    bool rWhite = abs(rm - 8.0) < 0.5;
    float sf = 0.0;
    #ifdef GFX_SRF
      sf = vSrf.x;
    #endif
    diffuseColor.rgb *= (0.8 + 0.2 * n + (cell - 0.5) * 0.12 * near) * vec3(1.0, 0.96, 0.88); // tar and gravel, weathered
    if (sf < 0.5) {
      // a flat roof: gravel on a membrane, standing seams, slab joints, a green roof, patina
      #ifndef GFX_LITE
      if (rMetal) {
        float sx = vUvR.y / 0.5;
        diffuseColor.rgb *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.1, abs(fract(sx) - 0.5) - 0.38)) * nearer;
      } else if (rConc) {
        vec2 g = abs(fract(vUvR / 3.5) - 0.5);
        diffuseColor.rgb *= 1.0 - 0.22 * smoothstep(0.485, 0.5, max(g.x, g.y)) * nearer;
      } else if (rGreen) {
        float sp = gfxVn(p * 3.0) * 0.6 + gfxH21(floor(p * 9.0)) * 0.4;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.085, 0.03) * (0.7 + 0.6 * sp), 0.6);
      } else if (rCopper) {
        diffuseColor.rgb *= 0.9 + 0.2 * gfxVn(vec2(vUvR.x * 0.8, vUvR.y * 0.15));
      } else if (rGold) {
        diffuseColor.rgb *= 1.35;
      } else {
        // gravel specks, and the seams of a membrane every metre
        float peb = gfxH21(floor(p * 16.0));
        diffuseColor.rgb *= 1.0 + (peb - 0.5) * 0.24 * nearer;
        diffuseColor.rgb *= 1.0 - (rWhite ? 0.1 : 0.06) * (1.0 - smoothstep(0.0, 0.05, abs(fract(vUvR.y) - 0.5) - 0.45)) * nearer;
        if (rWhite) diffuseColor.rgb *= 0.9 + 0.18 * gfxVn(p * 0.6) ;
      }
      #endif
    }
    #ifdef GFX_SRF
      // baked roof surfaces: 1 slope, 2 parapet face, 3 parapet cap, 4 gable end, 5 rooftop box, 6 soffit, 7 dome
      if (abs(sf - 1.0) < 0.5) {
        // the baked colour (the roof material's) with the pattern of its courses: shingle rows, clay tiles, standing seams
        if (rMetal) {
          float sx = vUvR.x / 0.45;
          float rib = 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.14, abs(fract(sx) - 0.5) - 0.36));
          diffuseColor.rgb *= rib * (0.92 + 0.16 * gfxH21(vec2(floor(sx), 3.0)));
        } else if (rTile) {
          float row = floor(vUvR.y / 0.42);
          float tx = vUvR.x / 0.3 + 0.5 * mod(row, 2.0);
          float tone = 0.78 + 0.34 * gfxH21(vec2(floor(tx), row));
          float curve = 0.88 + 0.12 * sin(fract(tx) * 6.2832 - 1.5708);
          float lap = smoothstep(0.0, 0.1, fract(vUvR.y / 0.42));
          diffuseColor.rgb *= tone * mix(1.0, curve * (0.8 + 0.2 * lap), near);
        } else {
          float row = floor(vUvR.y / 0.4);
          float tone = 0.72 + 0.34 * gfxH21(vec2(row, floor(vUvR.x / 0.6)));
          float rowEdge = smoothstep(0.0, 0.08, fract(vUvR.y / 0.4)) * (0.82 + 0.18 * smoothstep(0.9, 0.5, fract(vUvR.y / 0.4)));
          diffuseColor.rgb *= tone * mix(1.0, rowEdge, near) * 1.15;
        }
      } else if (abs(sf - 3.0) < 0.5) diffuseColor.rgb *= 1.25;
      else if (abs(sf - 5.0) < 0.5) diffuseColor.rgb = vec3(dot(diffuseColor.rgb, vec3(0.333))) * vec3(0.95, 0.97, 1.0) * 1.1;
      else if (abs(sf - 6.0) < 0.5) diffuseColor.rgb *= 0.55;
      else if (abs(sf - 7.0) < 0.5) diffuseColor.rgb *= vec3(0.62, 0.92, 0.8);
    #endif
  }`,
  markings: /* glsl */ `
  {
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(30.0, 120.0, d);
    float wear = gfxVn(p * 1.3) * 0.6 + gfxVn(p * 7.0) * 0.4;
    // paint worn through and dirtied to cream
    diffuseColor.rgb *= (1.0 - 0.3 * smoothstep(0.4, 0.85, wear) * near) * vec3(0.92, 0.9, 0.82);
  }`,
  rail: /* glsl */ `
  {
  }`,
  airfield: /* glsl */ `
  {
    // runway, taxiway and apron concrete: 7.5 m slabs with sealed joints, a little weathering, oil under the stands
    vec2 p = vFW.xz;
    float d = distance(vFW, cameraPosition);
    float near = 1.0 - smoothstep(40.0, 240.0, d);
    float n = gfxVn(p * 0.08) * 0.6 + gfxVn(p * 0.9) * 0.4;
    diffuseColor.rgb *= (0.92 + 0.14 * n) * vec3(1.0, 0.99, 0.96);
    vec2 g = abs(fract(p / 7.5) - 0.5);
    float w = 0.006 + 0.0025 * smoothstep(0.0, 150.0, d);
    float joint = smoothstep(0.5 - w * 2.0, 0.5 - w, max(g.x, g.y));
    diffuseColor.rgb *= 1.0 - 0.34 * joint * near;
    #ifndef GFX_LITE
      float stain = smoothstep(0.62, 0.86, gfxVn(p * 0.13 + 7.0));
      float spot = smoothstep(0.7, 0.95, gfxVn(p * 0.7 + 3.0)) * near;
      diffuseColor.rgb *= (1.0 - 0.1 * stain) * (1.0 - 0.18 * spot);
    #endif
  }`,
  concrete: /* glsl */ `
  {
    vec2 p = vFW.xz + vFW.y * 0.5;
    diffuseColor.rgb *= (0.84 + 0.2 * (gfxVn(p * 0.25) * 0.6 + gfxVn(p * 1.8) * 0.4)) * vec3(1.02, 1.0, 0.93);
  }`,
};

/** What a surface program is built with. `level` is `fx.surfaces` (1 is the cheap variant); `features` says which baked attributes the geometry has. */
export interface SurfaceOptions {
  level: () => number;
  features: { roadUv: boolean; land: boolean; srf: boolean; look?: boolean };
}

/** Names the baked attributes of a surface geometry for the shader (the same buffers) and says which of them it has. Idempotent. */
export function prepareSurfaceGeometry(mesh: THREE.Mesh): SurfaceOptions['features'] {
  const g = mesh.geometry;
  const uv1 = g.getAttribute('uv1') ?? g.getAttribute('gUv1');
  const land = g.getAttribute('_land') ?? g.getAttribute('gLand');
  const srf = g.getAttribute('_srf') ?? g.getAttribute('gSrf');
  const uv = g.getAttribute('uv');
  const roadUv = !!uv && !!uv1 && uv1.itemSize === 2;
  if (roadUv && !g.getAttribute('gUv1')) g.setAttribute('gUv1', uv1!);
  if (land && !g.getAttribute('gLand')) g.setAttribute('gLand', land);
  if (srf && !g.getAttribute('gSrf')) g.setAttribute('gSrf', srf);
  const look = g.getAttribute('_look') ?? g.getAttribute('gLook');
  if (look && !g.getAttribute('gLook')) g.setAttribute('gLook', look);
  return { roadUv, land: !!land && land.itemSize === 4, srf: !!srf && !!uv && srf.itemSize === 4, look: !!look && look.itemSize === 4 };
}

/** Patches one baked material by name. Returns false when the name is not one of the surfaces. */
export function patchSurfaceMaterial(mat: THREE.Material, opt: SurfaceOptions): boolean {
  const kind = surfaceKind(mat.name);
  if (!kind) return false;
  const m = mat as THREE.MeshStandardMaterial;
  const f = opt.features;
  const defs = () => [f.roadUv && (kind === 'asphalt' || kind === 'sidewalk') ? '#define GFX_ROAD_UV' : '', f.land && kind === 'ground' ? '#define GFX_LAND' : '', f.srf && kind === 'roof' ? '#define GFX_SRF' : '', f.look && kind === 'roof' ? '#define GFX_LOOK' : '', opt.level() < 2 ? '#define GFX_LITE' : ''].filter(Boolean).join('\n');
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uAo = U.uAo;
    const d = defs();
    shader.vertexShader = `${d}\n${shader.vertexShader}`
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = `${d}\n${shader.fragmentShader}`
      .replace('#include <common>', `#include <common>\n${DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BODY[kind]}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_FRAGMENT}`);
    // The night glow Atmosphere puts on every building material would make the roofs orange.
    if (kind === 'roof') shader.fragmentShader = shader.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vec3(0.0);');
  };
  m.customProgramCacheKey = () => `look-surface-${kind}-${opt.level() < 2 ? 'lite' : 'full'}-${f.roadUv ? 'r' : ''}${f.land ? 'l' : ''}${f.srf ? 's' : ''}${f.look ? 'k' : ''}-v4`;
  m.needsUpdate = true;
  return true;
}
