/**
 * Trees, GTA IV Atlanta style: a city in a forest. The 4,185 anchors of `props.json` (class 0
 * broadleaf, 1 conifer, 2 ornamental) become one of five species (willow oak, sweetgum, red oak,
 * loblolly pine, crape myrtle: `treeSpecies` in shared/props.ts, so the sim's trunk colliders and
 * these draws agree), scaled across by crown radius and up by height.
 *
 * THREE LEVELS, by distance divided by the tier's `lodScale`
 *   near     (to 30 m)   bark, branches, an opaque core and ALPHA-TESTED LEAF CARDS whose leaves are
 *                        computed in the fragment shader (no texture): about 700 to 1200 triangles. Off on Low.
 *   mid      (to 80 m)   bark and a few low-poly leaf clumps, no alpha: about 450 triangles
 *   impostor (to 640 m)  one camera-facing card from an atlas the game BAKES from the near models at
 *                        load (8 views of each species, 128 px each, one render target), two
 *                        neighbouring views blended; 2 triangles
 *
 * INSTANCING. One InstancedMesh per species and level (10 draws) and one InstancedBufferGeometry for
 * every impostor (1 draw), refilled when the camera has moved 4 m (at most every 0.35 s): the trees
 * are binned in a 64 m grid (the chunk pass: a cell is skipped as a whole beyond the impostor range)
 * and the nearest ones fill the per-level caps. Caps fall with the tier; a tree past its level's cap
 * drops to the next. Per-instance: matrix (yaw, scale from `treeScale`), and `aTint` (autumn amount,
 * red-versus-yellow, brightness), all derived from the anchor's position so nothing flickers.
 *
 * LOOK. Lambert lighting from the scene's hemisphere and sun (so the tile's shadows and the time of
 * day work as for everything), muted baked leaf colours, darker under the canopy (baked in the vertex
 * colours: the crown is dark inside and low), an October tint (sweetgum burgundy, oaks yellowing,
 * pines green), a sine sway in the vertex shader (stronger higher up, a flutter on the cards), and
 * sodium street light from below at night (`look/sodium.ts`, the same hook as cars and people).
 * The vertex alpha code of tools/blender/props/geo.py: a = 0.5 + wind on a leaf card, wind/2 else.
 *
 * COST (High, desktop): about +10 draws, +50k triangles in the dense park, shadow pass about the same
 * again within the shadow radius. Low: no cards, no shadow, 36 mid-level trees and the impostors.
 */
import * as THREE from 'three';
import { placeHash, TREE_SPECIES, treeScale, treeSpecies } from '../../shared/props';
import type { PropsData } from '../../shared/tile';
import type { Game, System } from '../Game';
import { addSodium } from './look/sodium';
import { U } from './look/uniforms';
import { propAssets, TREE_NAMES, type PropAssets } from './propAssets';

export interface TreeCaps {
  near: number;
  mid: number;
  impostor: number;
  /** Ranges at lodScale 1, m. */
  nearR: number;
  midR: number;
  farR: number;
}

/** By `fx.trees`: 1 = Low (no leaf cards), 2 = Medium and High. */
export const TREE_CAPS: Record<1 | 2, TreeCaps> = {
  1: { near: 0, mid: 36, impostor: 600, nearR: 30, midR: 80, farR: 640 },
  2: { near: 20, mid: 80, impostor: 1500, nearR: 30, midR: 80, farR: 640 },
};
const CELL = 64;

// ------------------------------------------------------------------ shaders

const LEAF_GLSL = /* glsl */ `
float tHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// a field of leaves on a card: x = coverage, y = a shade per leaf. P = (cells across, aspect, lobes, lobe depth)
vec2 leafMask(vec2 uv, vec4 P) {
  vec2 g = uv * P.x;
  vec2 c0 = floor(g - 0.5);
  float cov = 0.0;
  float shade = 0.5;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 c = c0 + vec2(float(i), float(j));
      float h1 = tHash(c + 3.7);
      float h2 = tHash(c + 11.3);
      float h3 = tHash(c + 29.1);
      vec2 centre = c + 0.5 + (vec2(h1, h2) - 0.5) * 0.55;
      float a = h3 * 6.2831;
      vec2 d = g - centre;
      vec2 q = vec2(cos(a) * d.x + sin(a) * d.y, -sin(a) * d.x + cos(a) * d.y);
      float L = 0.44 * sqrt(P.y);
      float r = length(vec2(q.x / L, q.y * P.y / L));
      if (P.z > 0.5) r /= 1.0 + P.w * cos(P.z * atan(q.y, q.x) + h1 * 6.0);
      if (r < 1.0 && r < cov * 0.0 + 1.0) {
        cov = 1.0;
        shade = h1;
      }
    }
  }
  return vec2(cov, shade);
}
`;

const NOISE_GLSL = /* glsl */ `
float tNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = tHash(i.xy + i.z * 17.0), b = tHash(i.xy + vec2(1.0, 0.0) + i.z * 17.0);
  float c = tHash(i.xy + vec2(0.0, 1.0) + i.z * 17.0), d = tHash(i.xy + vec2(1.0, 1.0) + i.z * 17.0);
  float a2 = tHash(i.xy + (i.z + 1.0) * 17.0), b2 = tHash(i.xy + vec2(1.0, 0.0) + (i.z + 1.0) * 17.0);
  float c2 = tHash(i.xy + vec2(0.0, 1.0) + (i.z + 1.0) * 17.0), d2 = tHash(i.xy + vec2(1.0, 1.0) + (i.z + 1.0) * 17.0);
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(a2, b2, f.x), mix(c2, d2, f.x), f.y), f.z);
}
`;

/** October on a leaf colour: `t` = (amount, red versus yellow, brightness). Leaves are the green ones (g > r); bark is not touched. */
const AUTUMN_GLSL = /* glsl */ `
vec3 treeAutumn(vec3 alb, vec3 t) {
  float lum = dot(alb, vec3(0.299, 0.587, 0.114));
  float leaf = smoothstep(1.02, 1.25, alb.g / max(alb.r, 1e-3));
  vec3 warm = mix(vec3(0.95, 0.66, 0.2), vec3(0.8, 0.24, 0.1), t.y) * lum * mix(2.3, 1.8, t.y);
  vec3 o = mix(alb, warm, t.x * leaf);
  return o * t.z;
}
`;

type Leaf = [number, number, number, number];
/** Per species: leaf cells across a card, aspect (long over wide), lobes, lobe depth. */
const LEAF: Leaf[] = [
  [9, 2.4, 0, 0], // willow oak: narrow leaves
  [6, 1.0, 5, 0.38], // sweetgum: stars
  [7, 5.5, 0, 0], // pine: needle tufts
  [9, 1.5, 0, 0], // crape myrtle: small ovals
  [6, 1.6, 7, 0.3], // red oak: lobed
];

export interface TreeUniforms {
  uTime: { value: number };
  uWind: { value: number };
  /** 1: the mid-level clumps get a ragged alpha-tested edge (Medium and High). */
  uErode: { value: number };
}

function treeMaterial(cards: boolean, leaf: Leaf, uniforms: TreeUniforms): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: cards ? THREE.DoubleSide : THREE.FrontSide });
  mat.customProgramCacheKey = () => (cards ? 'tree-cards' : 'tree-blobs');
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.uniforms.uLeaf = { value: new THREE.Vector4(...leaf) };
    shader.uniforms.uErode = uniforms.uErode;
    shader.uniforms.uNightT = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 color;
attribute vec3 aTint;
uniform float uTime;
uniform float uWind;
varying vec3 vTCol;
varying float vLeaf;
varying vec3 vTint;
varying vec3 vObj;
varying vec2 vTUv;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float tLeaf = step(0.5, color.a);
float tW = tLeaf > 0.5 ? clamp((color.a - 0.55) / 0.45, 0.0, 1.0) : clamp(color.a / 0.44, 0.0, 1.0);
float tPh = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.27;
float tSw = sin(uTime * 1.3 + tPh + position.y * 0.1) + 0.5 * sin(uTime * 2.9 + tPh * 1.7 + position.y * 0.2);
transformed.x += tSw * tW * uWind * 0.011 * position.y;
transformed.z += 0.6 * sin(uTime * 1.7 + tPh * 1.3) * tW * uWind * 0.009 * position.y;
transformed += tLeaf * tW * uWind * 0.028 * vec3(sin(uTime * 4.1 + dot(position, vec3(1.7, 2.3, 1.1)) + tPh), 0.5 * sin(uTime * 5.3 + dot(position, vec3(2.1, 0.7, 1.9))), cos(uTime * 3.7 + dot(position, vec3(1.3, 1.9, 2.7)) + tPh));
vTCol = color.rgb;
vLeaf = tLeaf;
vTint = aTint;
vObj = position;
vTUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 uLeaf;
uniform float uErode;
uniform float uNightT;
varying vec3 vTCol;
varying float vLeaf;
varying vec3 vTint;
varying vec3 vObj;
varying vec2 vTUv;
${LEAF_GLSL}
${NOISE_GLSL}
${AUTUMN_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `vec3 tAlb = treeAutumn(vTCol, vTint);
${
  cards
    ? `if (vLeaf > 0.5) {
  vec2 lm = leafMask(vTUv, uLeaf);
  if (lm.x < 0.5) discard;
  tAlb *= 0.8 + 0.4 * lm.y;
}`
    : `{
  // leafy speckle on the clumps, darker in the pits
  float lf = smoothstep(1.02, 1.25, vTCol.g / max(vTCol.r, 1e-3));
  float n = tNoise(vObj * 2.7) * 0.6 + tNoise(vObj * 7.1) * 0.4;
  tAlb *= mix(1.0, 0.55 + 0.85 * n, lf);
  if (uErode > 0.5 && lf > 0.5) {
    // a ragged, leafy edge: erode the clump where the surface turns away from the eye
    vec3 gn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    float nv = abs(dot(gn, normalize(vViewPosition)));
    float e = smoothstep(0.3, 0.7, tNoise(vObj * 5.3) * 0.55 + tNoise(vObj * 13.0) * 0.45);
    if (e > 0.5 + 0.85 * nv) discard;
  }
}`
}
// the ambient of a night street is dim and orange-grey; the lamps add their own (sodium.ts)
diffuseColor.rgb = tAlb * mix(1.0, 0.5, uNightT);`,
      )
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\nnormal = normalize(vNormal);`);
    addSodium(shader);
  };
  return mat;
}

/** Shadow depth for the leaf cards: the same alpha test, so the shade has holes in it. */
function cardDepthMaterial(leaf: Leaf): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'tree-card-depth';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLeaf = { value: new THREE.Vector4(...leaf) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 color;\nvarying vec2 vDUv;\nvarying float vDLeaf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDUv = uv;\nvDLeaf = step(0.5, color.a);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uLeaf;\nvarying vec2 vDUv;\nvarying float vDLeaf;\n${LEAF_GLSL}`)
      .replace('void main() {', 'void main() {\n  if (vDLeaf > 0.5 && leafMask(vDUv, uLeaf).x < 0.5) discard;');
  };
  return mat;
}

const IMP_VERT = /* glsl */ `
attribute vec4 aPos;
attribute vec4 aInfo;
attribute vec3 aTint;
uniform vec4 uSpr[5];
uniform float uTime;
uniform float uWind;
varying vec2 vUv;
varying vec2 vCell;
varying float vBlend;
varying vec3 vTint;
#include <fog_pars_vertex>
void main() {
  float sp = aInfo.y;
  vec4 S = uSpr[int(sp + 0.5)];
  vec3 base = aPos.xyz;
  vec3 toCam = cameraPosition - base;
  float phi = atan(toCam.x, toCam.z);
  float local = mod(phi - aInfo.z, 6.2831853) / 0.7853982;
  float v0 = floor(local);
  vBlend = local - v0;
  vCell = vec2(mod(v0, 8.0), sp);
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
  float hs = S.x;
  vec3 centre = base + vec3(0.0, S.y * aInfo.x, 0.0);
  vec3 wp = centre + right * (position.x * hs * aPos.w) + vec3(0.0, position.y * hs * aInfo.x, 0.0);
  float top = position.y * 0.5 + 0.5;
  wp += right * sin(uTime * 1.3 + base.x * 0.31 + base.z * 0.27) * uWind * 0.12 * top * top * aInfo.x;
  vUv = position.xy * 0.5 + 0.5;
  vTint = aTint;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const IMP_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;
varying vec2 vUv;
varying vec2 vCell;
varying float vBlend;
varying vec3 vTint;
${AUTUMN_GLSL}
#include <fog_pars_fragment>
void main() {
  vec2 a = (vCell + vUv) * vec2(0.125, 0.2);
  vec2 b = (vec2(mod(vCell.x + 1.0, 8.0), vCell.y) + vUv) * vec2(0.125, 0.2);
  vec4 c0 = texture2D(uAtlas, a);
  vec4 c1 = texture2D(uAtlas, b);
  vec4 c = mix(c0, c1, vBlend);
  if (c.a < 0.5) discard;
  vec3 alb = treeAutumn(c.rgb, vTint);
  gl_FragColor = vec4(alb * uLight, 1.0);
  #include <fog_fragment>
}`;

// ------------------------------------------------------------------ the system

interface SpeciesSet {
  geo: [THREE.BufferGeometry, THREE.BufferGeometry];
  mats: [THREE.MeshLambertMaterial, THREE.MeshLambertMaterial];
  depth: THREE.MeshDepthMaterial;
  mesh: [THREE.InstancedMesh, THREE.InstancedMesh];
  tint: [THREE.InstancedBufferAttribute, THREE.InstancedBufferAttribute];
}

export class Trees implements System {
  readonly name = 'trees';
  readonly priority = 170;
  readonly group = new THREE.Group();
  private readonly uniforms: TreeUniforms = { uTime: { value: 0 }, uWind: { value: 1 }, uErode: { value: 1 } };
  private n: number;
  // per tree
  private tx: Float32Array;
  private ty: Float32Array;
  private tz: Float32Array;
  private tsp: Uint8Array;
  private tsx: Float32Array;
  private tsy: Float32Array;
  private tyaw: Float32Array;
  private ttint: Float32Array;
  private readonly cells = new Map<number, number[]>();
  private sets: SpeciesSet[] = [];
  private imp: { geo: THREE.InstancedBufferGeometry; mat: THREE.ShaderMaterial; mesh: THREE.Mesh; pos: THREE.InstancedBufferAttribute; info: THREE.InstancedBufferAttribute; tint: THREE.InstancedBufferAttribute; atlas: THREE.WebGLRenderTarget } | null = null;
  private level: 0 | 1 | 2 = 2;
  private readonly lastCam = new THREE.Vector3(1e9, 0, 1e9);
  private cool = 0;
  private dirty = true;
  private hemi: THREE.HemisphereLight | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private bakeLight = new THREE.Color(1, 1, 1);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private time = 0;
  private disposed = false;
  private counts = { near: 0, mid: 0, impostor: 0 };

  constructor(
    private readonly game: Game,
    anchors: PropsData,
    assets: PropAssets,
  ) {
    this.n = 0;
    this.tx = this.ty = this.tz = this.tsx = this.tsy = this.tyaw = this.ttint = new Float32Array(0);
    this.tsp = new Uint8Array(0);
    this.fill(anchors);
    this.group.name = 'trees';
    this.buildSets(assets);
    this.buildImpostors(assets);
    game.scene.add(this.group);
  }

  /** The trees of `anchors` (a streamed city hands in the union of its loaded tiles' when it changes: `setAnchors`). */
  private fill(anchors: PropsData) {
    const t = anchors.trees;
    this.n = t.length;
    this.tx = new Float32Array(this.n);
    this.ty = new Float32Array(this.n);
    this.tz = new Float32Array(this.n);
    this.tsp = new Uint8Array(this.n);
    this.tsx = new Float32Array(this.n);
    this.tsy = new Float32Array(this.n);
    this.tyaw = new Float32Array(this.n);
    this.ttint = new Float32Array(this.n * 3);
    t.forEach((a, i) => {
      const [x, y, z, h, r, cls] = a;
      const sp = treeSpecies(x, z, cls);
      const s = treeScale(sp, h, r);
      this.tx[i] = x;
      this.ty[i] = y - 0.05;
      this.tz[i] = z;
      this.tsp[i] = sp;
      this.tsx[i] = s.xz;
      this.tsy[i] = s.y;
      this.tyaw[i] = placeHash(x + 13.7, z - 7.1) * Math.PI * 2;
      const [aut, red, bright] = autumnFor(sp, x, z);
      this.ttint[i * 3] = aut;
      this.ttint[i * 3 + 1] = red;
      this.ttint[i * 3 + 2] = bright;
      const key = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
      const c = this.cells.get(key);
      if (c) c.push(i);
      else this.cells.set(key, [i]);
    });
  }

  /** Replaces the trees (the models, the impostor atlas and the instance buffers stay). */
  setAnchors(anchors: PropsData): void {
    this.cells.clear();
    this.fill(anchors);
    this.dirty = true;
    this.lastCam.set(1e9, 0, 1e9);
  }

  private buildSets(assets: PropAssets) {
    const capNear = TREE_CAPS[2].near;
    const capMid = TREE_CAPS[2].mid;
    TREE_NAMES.forEach((_, s) => {
      const model = assets.trees[s];
      const geo = [model.lods[0].clone(), model.lods[1].clone()] as [THREE.BufferGeometry, THREE.BufferGeometry];
      const mats: [THREE.MeshLambertMaterial, THREE.MeshLambertMaterial] = [treeMaterial(true, LEAF[s], this.uniforms), treeMaterial(false, LEAF[s], this.uniforms)];
      const caps = [capNear, capMid];
      const mesh = [0, 1].map((l) => {
        const m = new THREE.InstancedMesh(geo[l], mats[l], caps[l]);
        m.count = 0;
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.name = `tree-${TREE_NAMES[s]}-${l === 0 ? 'near' : 'mid'}`;
        m.receiveShadow = true;
        m.visible = false;
        this.group.add(m);
        return m;
      }) as unknown as [THREE.InstancedMesh, THREE.InstancedMesh];
      const tint = [0, 1].map((l) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(caps[l] * 3), 3);
        a.setUsage(THREE.DynamicDrawUsage);
        geo[l].setAttribute('aTint', a);
        return a;
      }) as unknown as [THREE.InstancedBufferAttribute, THREE.InstancedBufferAttribute];
      const depth = cardDepthMaterial(LEAF[s]);
      mesh[0].customDepthMaterial = depth;
      this.sets.push({ geo, mats, depth, mesh, tint });
    });
  }

  /** Bakes 8 views of each species' near model into one atlas, and makes the card geometry that draws them. */
  private buildImpostors(assets: PropAssets) {
    const r = this.game.renderer;
    const hdr = r.extensions.has('EXT_color_buffer_half_float') || r.extensions.has('EXT_color_buffer_float');
    const CELLPX = 128;
    const atlas = new THREE.WebGLRenderTarget(CELLPX * 8, CELLPX * 5, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true });
    atlas.texture.name = 'tree-impostors';
    const scene = new THREE.Scene();
    // a neutral light to bake in: the same arithmetic as the runtime (hemisphere + a sun), recorded in `bakeLight`
    const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 2.2);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-0.5, 0.8, 0.6);
    scene.add(hemi, sun);
    this.bakeLight.setScalar(lightLevel(hemi, sun));
    const bakeU: TreeUniforms = { uTime: { value: 0 }, uWind: { value: 0 }, uErode: { value: 0 } };
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.enabled;
    const prevViewport = r.getViewport(new THREE.Vector4());
    r.shadowMap.enabled = false;
    r.autoClear = false;
    r.setRenderTarget(atlas);
    r.setScissorTest(true);
    r.setClearColor(0x445533, 0);
    const spr: THREE.Vector4[] = [];
    TREE_NAMES.forEach((_, s) => {
      const sp = TREE_SPECIES[s];
      const W = sp.refR * 1.3;
      const top = sp.refH * 1.05;
      const half = Math.max(W, (top + 0.2) / 2);
      const yc = (top - 0.2) / 2;
      spr.push(new THREE.Vector4(half, yc, 0, 0));
      const geo = assets.trees[s].lods[0].clone();
      const tint = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1]), 3);
      geo.setAttribute('aTint', tint);
      const mesh = new THREE.InstancedMesh(geo, treeMaterial(true, LEAF[s], bakeU), 1);
      mesh.setMatrixAt(0, new THREE.Matrix4());
      mesh.frustumCulled = false;
      scene.add(mesh);
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 200);
      for (let v = 0; v < 8; v++) {
        const az = (v * Math.PI) / 4;
        const el = (10 * Math.PI) / 180;
        cam.position.set(Math.sin(az) * Math.cos(el) * 60, yc + Math.sin(el) * 60, Math.cos(az) * Math.cos(el) * 60);
        cam.lookAt(0, yc, 0);
        cam.updateMatrixWorld();
        r.setViewport(v * CELLPX, s * CELLPX, CELLPX, CELLPX);
        r.setScissor(v * CELLPX, s * CELLPX, CELLPX, CELLPX);
        r.clear(true, true, false);
        r.render(scene, cam);
      }
      scene.remove(mesh);
      geo.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    });
    r.setScissorTest(false);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAuto;
    r.shadowMap.enabled = prevShadow;
    r.setViewport(prevViewport);
    hemi.dispose();
    sun.dispose();

    const cap = TREE_CAPS[2].impostor;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(2, 2);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [pos, info, tint]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', pos);
    geo.setAttribute('aInfo', info);
    geo.setAttribute('aTint', tint);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: IMP_VERT,
      fragmentShader: IMP_FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uAtlas: { value: null }, uSpr: { value: spr }, uLight: { value: new THREE.Color(1, 1, 1) }, uTime: this.uniforms.uTime, uWind: this.uniforms.uWind },
      ]),
      fog: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    mat.uniforms.uAtlas.value = atlas.texture;
    mat.uniforms.uSpr.value = spr;
    mat.uniforms.uTime = this.uniforms.uTime;
    mat.uniforms.uWind = this.uniforms.uWind;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'tree-impostors';
    mesh.visible = false;
    this.group.add(mesh);
    this.imp = { geo, mat, mesh, pos, info, tint, atlas };
  }

  setLevel(level: 0 | 1 | 2): void {
    this.level = level;
    this.group.visible = level > 0;
    this.uniforms.uErode.value = level === 2 ? 1 : 0;
    const shadows = this.game.tier.shadowMap > 0;
    for (const s of this.sets) {
      for (const m of s.mesh) {
        m.castShadow = shadows;
      }
    }
    this.dirty = true;
  }

  update(dt: number): void {
    if (this.disposed) return;
    if (this.level === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uWind.value = 0.75 + 0.35 * Math.sin(this.time * 0.17) + 0.15 * Math.sin(this.time * 0.43 + 1);
    this.cool -= dt;
    if (this.imp) this.updateLight();
    const cam = this.game.camera.position;
    const moved = (cam.x - this.lastCam.x) ** 2 + (cam.z - this.lastCam.z) ** 2 > 16;
    if (!this.dirty && (!moved || this.cool > 0)) return;
    this.dirty = false;
    this.cool = 0.35;
    this.lastCam.copy(cam);
    this.rebuild(cam);
  }

  /** The impostors are lit by what the scene's lights add up to, relative to the light they were baked in. */
  private updateLight() {
    if (!this.hemi || !this.sun) {
      this.game.scene.traverse((o) => {
        if ((o as THREE.HemisphereLight).isHemisphereLight) this.hemi ??= o as THREE.HemisphereLight;
        if ((o as THREE.DirectionalLight).isDirectionalLight) this.sun ??= o as THREE.DirectionalLight;
      });
    }
    if (!this.hemi || !this.sun) return;
    const c = this.imp!.mat.uniforms.uLight.value as THREE.Color;
    // per channel: (mean of the sky and ground colours) x intensity + the sun's x 0.35, over the bake's
    const h = this.hemi;
    const s = this.sun;
    const base = this.bakeLight.r;
    c.setRGB(
      (((h.color.r + h.groundColor.r) / 2) * h.intensity + s.color.r * s.intensity * 0.35) / base,
      (((h.color.g + h.groundColor.g) / 2) * h.intensity + s.color.g * s.intensity * 0.35) / base,
      (((h.color.b + h.groundColor.b) / 2) * h.intensity + s.color.b * s.intensity * 0.35) / base,
    );
  }

  private rebuild(cam: THREE.Vector3): void {
    const caps = TREE_CAPS[this.level === 1 ? 1 : 2];
    const ls = Math.max(0.2, this.game.tier.lodScale);
    const nearR = caps.near > 0 ? caps.nearR * ls : 0;
    const midR = caps.midR * ls;
    const farR = caps.farR * ls;
    const far2 = farR * farR;
    const idx: number[] = [];
    const key: number[] = [];
    const c0x = Math.floor((cam.x - farR) / CELL);
    const c1x = Math.floor((cam.x + farR) / CELL);
    const c0z = Math.floor((cam.z - farR) / CELL);
    const c1z = Math.floor((cam.z + farR) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const cell = this.cells.get(cx * 4096 + cz);
        if (!cell) continue;
        for (const i of cell) {
          const d2 = (this.tx[i] - cam.x) ** 2 + (this.tz[i] - cam.z) ** 2;
          if (d2 < far2) {
            idx.push(i);
            key.push(d2);
          }
        }
      }
    }
    const order = idx.map((_, k) => k).sort((a, b) => key[a] - key[b]);
    const count = [new Int32Array(5), new Int32Array(5)];
    let nNear = 0;
    let nMid = 0;
    let nImp = 0;
    const ip = this.imp!.pos.array as Float32Array;
    const ii = this.imp!.info.array as Float32Array;
    const it = this.imp!.tint.array as Float32Array;
    const nearCap = caps.near;
    const midCap = caps.mid;
    for (const k of order) {
      const i = idx[k];
      const d = Math.sqrt(key[k]);
      const sp = this.tsp[i];
      const lod = d < nearR && nNear < nearCap ? 0 : d < midR && nMid < midCap ? 1 : 2;
      if (lod === 2) {
        if (nImp >= caps.impostor) continue;
        ip[nImp * 4] = this.tx[i];
        ip[nImp * 4 + 1] = this.ty[i];
        ip[nImp * 4 + 2] = this.tz[i];
        ip[nImp * 4 + 3] = this.tsx[i];
        ii[nImp * 4] = this.tsy[i];
        ii[nImp * 4 + 1] = sp;
        ii[nImp * 4 + 2] = this.tyaw[i];
        it[nImp * 3] = this.ttint[i * 3];
        it[nImp * 3 + 1] = this.ttint[i * 3 + 1];
        it[nImp * 3 + 2] = this.ttint[i * 3 + 2];
        nImp++;
        continue;
      }
      const set = this.sets[sp];
      const n = count[lod][sp]++;
      this.q.setFromAxisAngle(this.up, this.tyaw[i]);
      this.pos.set(this.tx[i], this.ty[i], this.tz[i]);
      this.sc.set(this.tsx[i], this.tsy[i], this.tsx[i]);
      this.m.compose(this.pos, this.q, this.sc);
      set.mesh[lod].setMatrixAt(n, this.m);
      const ta = set.tint[lod].array as Float32Array;
      ta[n * 3] = this.ttint[i * 3];
      ta[n * 3 + 1] = this.ttint[i * 3 + 1];
      ta[n * 3 + 2] = this.ttint[i * 3 + 2];
      if (lod === 0) nNear++;
      else nMid++;
    }
    this.sets.forEach((s, sp) => {
      for (const l of [0, 1] as const) {
        const m = s.mesh[l];
        m.count = count[l][sp];
        m.visible = m.count > 0;
        if (m.count > 0) {
          m.instanceMatrix.needsUpdate = true;
          s.tint[l].needsUpdate = true;
        }
      }
    });
    const imp = this.imp!;
    imp.geo.instanceCount = nImp;
    imp.mesh.visible = nImp > 0;
    imp.pos.needsUpdate = imp.info.needsUpdate = imp.tint.needsUpdate = true;
    this.counts = { near: nNear, mid: nMid, impostor: nImp };
  }

  /** The impostor atlas as an image (8 views of each of the 5 species), for debugging and screenshots. */
  atlasImage(): { width: number; height: number; rgba: Uint8Array } | null {
    const a = this.imp?.atlas;
    if (!a) return null;
    const r = this.game.renderer;
    const out = new Uint8Array(a.width * a.height * 4);
    if (a.texture.type === THREE.UnsignedByteType) r.readRenderTargetPixels(a, 0, 0, a.width, a.height, out);
    else {
      const f = new Uint16Array(a.width * a.height * 4);
      r.readRenderTargetPixels(a, 0, 0, a.width, a.height, f);
      for (let i = 0; i < f.length; i++) out[i] = Math.round(255 * Math.min(1, Math.max(0, Math.pow(THREE.DataUtils.fromHalfFloat(f[i]), i % 4 === 3 ? 1 : 1 / 2.2))));
    }
    return { width: a.width, height: a.height, rgba: out };
  }

  /** Counts for tests and diagnostics. */
  stats() {
    return { trees: this.n, ...this.counts };
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    for (const s of this.sets) {
      for (const m of s.mesh) m.dispose();
      for (const g of s.geo) g.dispose();
      for (const m of s.mats) m.dispose();
      s.depth.dispose();
    }
    this.sets = [];
    if (this.imp) {
      this.imp.geo.dispose();
      this.imp.mat.dispose();
      this.imp.atlas.dispose();
      this.imp = null;
    }
  }
}

function lightLevel(h: THREE.HemisphereLight, s: THREE.DirectionalLight): number {
  return ((h.color.r + h.groundColor.r) / 2) * h.intensity + s.color.r * s.intensity * 0.35;
}

/**
 * October in Atlanta: sweetgums burn burgundy and orange, crape myrtles turn rust, oaks are yellowing at
 * the edges, pines stay green. Amount, red versus yellow, and a brightness variation, from the place.
 */
export function autumnFor(species: number, x: number, z: number): [number, number, number] {
  const h1 = placeHash(x * 1.7 + 3, z * 1.3 - 9);
  const h2 = placeHash(x - 21, z + 17);
  const h3 = placeHash(x + 5.5, z + 41);
  const bright = 0.86 + 0.28 * h3;
  switch (species) {
    case 0:
      return [0.05 + 0.3 * h1, 0.1 * h2, bright];
    case 1:
      return [0.35 + 0.65 * h1, 0.25 + 0.75 * h2, bright];
    case 2:
      return [0, 0, bright];
    case 3:
      return [0.25 + 0.6 * h1, 0.5 + 0.5 * h2, bright];
    default:
      return [0.1 + 0.6 * h1, 0.5 + 0.5 * h2, bright];
  }
}

export { propAssets };
