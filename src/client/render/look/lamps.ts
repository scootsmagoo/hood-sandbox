/**
 * Sodium street lamps: the orange that makes GTA IV's night. No real lights (a hundred of them
 * would be a hundred shader variants and a fill-rate disaster on a phone). Lamps are anchors, and
 * the ones near the camera are shown by instanced draws:
 *
 *   glow    a camera-facing additive card at each lamp head (HDR, so the bloom takes it), out to ~900 m
 *   pool    a flat card on the road under each lamp that lights what is below it: it MULTIPLIES the
 *           surface (blend = dst * (1 + sodium * falloff)), so white paint and pale slabs glow and dark
 *           asphalt stays dark, which an additive card would flatten into a uniform orange disc; a weak
 *           additive twin gives the black asphalt a little light of its own. Lifted 14 cm with a polygon
 *           offset so a slope does not swallow it
 *   pole    a thin pole with an arm and a head (a short post with a lantern for the pedestrian lamps),
 *           lit like any other prop, by day as well
 *
 * **Where the lamps are.** The tile's `props.json` (docs/contracts/m1-tile-format.md) lists them
 * with a yaw (the way the arm points, toward the road), a pole height and a kind (0 cobra-head arm
 * lamp, 1 pedestrian post-top lamp, 2 tall highway mast). A tile without it gets a stand-in: along
 * every street that is not a motorway or a service road, one lamp every 34 m (44 m on small streets),
 * alternating sides, 1.1 m past the kerb, not within 11 m of a junction centre or 12 m of another
 * lamp (`placeLamps`, from `roads.json` and `junctions.json`). The poles are visual only: nothing in
 * the sim knows about them (the signal poles and bus stops are solid; these would need colliders).
 *
 * The lists are rebuilt when the camera has moved 15 m (at most every 0.4 s), and not at all by day.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseProps } from '../../../shared/tile';
import { U } from './uniforms';

interface RoadJson {
  id: string;
  class: string;
  width: number;
  layer: number;
  points: [number, number, number][];
}

const SKIP = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'service', 'busway', 'footway', 'path', 'pedestrian', 'track', 'steps', 'cycleway', 'secondary_link', 'tertiary_link', 'primary_link', 'living_street']);
/** The height the cobra-head geometry is built for; taller and shorter poles scale it. */
const POLE_H = 10;
const ARM = 2.4;
const JUNCTION_CLEAR = 11;
const LAMP_CLEAR = 12;
const KERB_OFFSET = 1.1;

export interface LampSet {
  /** x, y, z of the pole base. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** The yaw of the direction the arm points (toward the road): forward is (sin, cos) in (x, z). */
  inward: Float32Array;
  /** The road's grade along the direction across `inward` (0 when unknown). */
  slope: Float32Array;
  /** Pole height, m. */
  h: Float32Array;
  /** 0 cobra-head arm lamp, 1 pedestrian post-top lamp, 2 tall mast. */
  kind: Uint8Array;
  count: number;
}

/** The lamps of `props.json`, as they are. */
export function lampsFromProps(lamps: readonly (readonly number[])[]): LampSet {
  const n = lamps.length;
  const L: LampSet = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), inward: new Float32Array(n), slope: new Float32Array(n), h: new Float32Array(n), kind: new Uint8Array(n), count: n };
  lamps.forEach((l, i) => {
    L.x[i] = l[0];
    L.y[i] = l[1];
    L.z[i] = l[2];
    L.inward[i] = l[3];
    L.h[i] = l[4];
    L.kind[i] = l[5];
  });
  return L;
}

/** Lamps along the streets of a tile, for a tile that has no props.json. Pure: takes the road list and the junction centres. */
export function placeLamps(roads: RoadJson[], junctions: { x: number; z: number }[]): LampSet {
  const cell = 16;
  const jgrid = new Map<number, { x: number; z: number }[]>();
  const key = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  for (const j of junctions) {
    const k = key(Math.floor(j.x / cell), Math.floor(j.z / cell));
    (jgrid.get(k) ?? jgrid.set(k, []).get(k)!).push(j);
  }
  const nearJunction = (x: number, z: number) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of jgrid.get(key(cx + a, cz + b)) ?? []) if ((j.x - x) ** 2 + (j.z - z) ** 2 < JUNCTION_CLEAR ** 2) return true;
    return false;
  };
  const lgrid = new Map<number, number[]>();
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const inw: number[] = [];
  const slp: number[] = [];
  const nearLamp = (x: number, z: number) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of lgrid.get(key(cx + a, cz + b)) ?? []) if ((xs[i] - x) ** 2 + (zs[i] - z) ** 2 < LAMP_CLEAR ** 2) return true;
    return false;
  };
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  };
  for (const r of roads) {
    if (SKIP.has(r.class) || r.layer < 0 || r.points.length < 2) continue;
    const spacing = r.width >= 11 ? 34 : 44;
    let side = hash(r.id) < 0.5 ? 1 : -1;
    let next = spacing * (0.3 + 0.4 * hash(r.id + 'o'));
    let run = 0;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const [x0, y0, z0] = r.points[i];
      const [x1, y1, z1] = r.points[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      const tx = (x1 - x0) / len;
      const tz = (z1 - z0) / len;
      while (next <= run + len) {
        const f = (next - run) / len;
        const px = x0 + (x1 - x0) * f;
        const pz = z0 + (z1 - z0) * f;
        const py = y0 + (y1 - y0) * f;
        // the normal to the right of travel is (-tz, tx) with +Z south; `side` picks the kerb
        const nx = -tz * side;
        const nz = tx * side;
        const off = r.width / 2 + KERB_OFFSET;
        const x = px + nx * off;
        const z = pz + nz * off;
        if (!nearJunction(x, z) && !nearJunction(px, pz) && !nearLamp(x, z)) {
          const i2 = xs.length;
          xs.push(x);
          ys.push(py);
          zs.push(z);
          const ix = -nx;
          const iz = -nz;
          inw.push(Math.atan2(ix, iz));
          // grade along the road, signed along the pool's own axis (a quarter turn from `inward`)
          const ax = iz;
          const az = -ix;
          slp.push(((y1 - y0) / len) * (tx * ax + tz * az));
          const k = key(Math.floor(x / cell), Math.floor(z / cell));
          (lgrid.get(k) ?? lgrid.set(k, []).get(k)!).push(i2);
        }
        next += spacing;
        side = -side;
      }
      run += len;
    }
  }
  const n = xs.length;
  return { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), inward: Float32Array.from(inw), slope: Float32Array.from(slp), h: new Float32Array(n).fill(8.6), kind: new Uint8Array(n), count: n };
}

const POOL_VERT = /* glsl */ `
attribute vec4 aA;
attribute vec3 aB;
uniform float uRadius;
uniform float uFogFar;
varying vec2 vC;
varying float vVis;
varying float vI;
void main() {
  vC = position.xy;
  float ca = cos(aA.w);
  float sa = sin(aA.w);
  vec2 perp = vec2(ca, -sa);
  vec2 along = vec2(sa, ca);
  float R = uRadius * aB.y;
  vec2 l = position.x * perp * R + position.y * along * R * 1.35;
  vec3 w = vec3(aA.x + l.x, aA.y + dot(l, along) * aB.x + 0.14, aA.z + l.y);
  float d = distance(w, cameraPosition);
  float k = d * 2.2 / uFogFar;
  vVis = exp(-k * k);
  vI = aB.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const POOL_FRAG = /* glsl */ `
uniform vec3 uSodium;
uniform float uOn;
uniform float uStrength;
varying vec2 vC;
varying float vVis;
varying float vI;
void main() {
  float r2 = dot(vC, vC);
  float f = (1.0 - min(r2, 1.0));
  f = f * f * (0.45 + 0.55 * exp(-r2 * 5.0));
  gl_FragColor = vec4(uSodium * (f * uOn * uStrength * vVis * vI), 1.0);
}`;

const GLOW_VERT = /* glsl */ `
attribute vec4 aP;
uniform float uSize;
uniform float uFogFar;
varying vec2 vC;
varying float vVis;
varying float vI;
void main() {
  vC = position.xy;
  vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
  float d = -mv.z;
  float s = max(uSize * aP.w, d * 0.0042);
  mv.xy += position.xy * s;
  float k = d * 2.2 / uFogFar;
  vVis = exp(-k * k);
  vI = aP.w;
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uSodium;
uniform float uOn;
varying vec2 vC;
varying float vVis;
varying float vI;
void main() {
  float r = length(vC);
  float core = exp(-r * r * 22.0);
  float halo = exp(-r * 3.4) * (1.0 - smoothstep(0.7, 1.0, r));
  vec3 c = uSodium * (core * 7.0 + halo * 1.1) * (0.6 + 0.4 * vI);
  gl_FragColor = vec4(c * (uOn * vVis), 1.0);
}`;

const colored = (g: THREE.BufferGeometry, c: THREE.Color) => {
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
};

const GREY = new THREE.Color(0x4a4d50);
const DARK = new THREE.Color(0x2c2e30);

/** A cobra-head lamp: a tapered pole, an arm reaching along +Z, a flat head on its end. Built for POLE_H and scaled in Y. */
function cobraGeometry(): THREE.BufferGeometry {
  const pole = colored(new THREE.CylinderGeometry(0.065, 0.11, POLE_H, 6, 1, true).translate(0, POLE_H / 2, 0), GREY);
  const arm = colored(new THREE.BoxGeometry(0.07, 0.07, ARM + 0.2).translate(0, POLE_H - 0.15, ARM / 2), GREY);
  const head = colored(new THREE.BoxGeometry(0.34, 0.12, 0.85).translate(0, POLE_H - 0.12, ARM), DARK);
  return mergeGeometries([pole, arm, head])!;
}

/** A pedestrian lamp: a slim post (4 m) with a lantern on top. Built for 4 m and scaled in Y. */
function postGeometry(): THREE.BufferGeometry {
  const pole = colored(new THREE.CylinderGeometry(0.05, 0.08, 4, 6, 1, true).translate(0, 2, 0), GREY);
  const lantern = colored(new THREE.CylinderGeometry(0.2, 0.14, 0.45, 6).translate(0, 4.2, 0), DARK);
  return mergeGeometries([pole, lantern])!;
}

export interface LampCaps {
  glow: number;
  pool: number;
  pole: number;
}

/** Caps by `fx.lamps` level (1 = Low, 2 = Medium and High). */
export const LAMP_CAPS: Record<1 | 2, LampCaps> = { 1: { glow: 500, pool: 28, pole: 36 }, 2: { glow: 1000, pool: 56, pole: 80 } };

export class StreetLamps {
  readonly group = new THREE.Group();
  private lamps: LampSet | null = null;
  private level: 0 | 1 | 2 = 2;
  private readonly cobras: THREE.InstancedMesh;
  private readonly posts: THREE.InstancedMesh;
  private readonly poleMat: THREE.MeshStandardMaterial;
  private readonly poolGeo: THREE.InstancedBufferGeometry;
  private readonly glowGeo: THREE.InstancedBufferGeometry;
  private readonly poolMat: THREE.ShaderMaterial;
  private readonly poolAddMat: THREE.ShaderMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly poolA: THREE.InstancedBufferAttribute;
  private readonly poolB: THREE.InstancedBufferAttribute;
  private readonly glowP: THREE.InstancedBufferAttribute;
  private readonly lastCam = new THREE.Vector3(1e9, 0, 1e9);
  private cool = 0;
  private lastOn = -1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly pos = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const maxGlow = LAMP_CAPS[2].glow;
    const maxPool = LAMP_CAPS[2].pool;
    const maxPole = LAMP_CAPS[2].pole;

    this.poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.25 });
    this.cobras = new THREE.InstancedMesh(cobraGeometry(), this.poleMat, maxPole);
    this.posts = new THREE.InstancedMesh(postGeometry(), this.poleMat, maxPole);
    for (const m of [this.cobras, this.posts]) {
      m.count = 0;
      m.frustumCulled = false;
    }
    this.cobras.name = 'lamp-poles';
    this.posts.name = 'lamp-posts';

    const quad = new THREE.PlaneGeometry(2, 2);
    this.poolGeo = new THREE.InstancedBufferGeometry();
    this.poolGeo.index = quad.index;
    this.poolGeo.setAttribute('position', quad.getAttribute('position'));
    this.poolA = new THREE.InstancedBufferAttribute(new Float32Array(maxPool * 4), 4);
    this.poolB = new THREE.InstancedBufferAttribute(new Float32Array(maxPool * 3), 3);
    this.poolA.setUsage(THREE.DynamicDrawUsage);
    this.poolB.setUsage(THREE.DynamicDrawUsage);
    this.poolGeo.setAttribute('aA', this.poolA);
    this.poolGeo.setAttribute('aB', this.poolB);
    this.poolGeo.instanceCount = 0;
    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: { uSodium: U.uSodium, uOn: { value: 0 }, uStrength: { value: 20 }, uRadius: { value: 11 }, uFogFar: { value: 900 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide, // the card is laid flat by the shader, so its winding says nothing
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    });
    const pools = new THREE.Mesh(this.poolGeo, this.poolMat);
    pools.frustumCulled = false;
    pools.renderOrder = 2;
    pools.name = 'lamp-pools';
    // The same cards again, added: dark asphalt multiplied by anything is still nearly black, so the pool also needs a little light of its own.
    this.poolAddMat = this.poolMat.clone();
    this.poolAddMat.blending = THREE.AdditiveBlending;
    this.poolAddMat.uniforms = { ...this.poolMat.uniforms, uStrength: { value: 0.13 } };
    const poolsAdd = new THREE.Mesh(this.poolGeo, this.poolAddMat);
    poolsAdd.frustumCulled = false;
    poolsAdd.renderOrder = 2;
    poolsAdd.name = 'lamp-pools-add';

    this.glowGeo = new THREE.InstancedBufferGeometry();
    this.glowGeo.index = quad.index;
    this.glowGeo.setAttribute('position', quad.getAttribute('position'));
    this.glowP = new THREE.InstancedBufferAttribute(new Float32Array(maxGlow * 4), 4);
    this.glowP.setUsage(THREE.DynamicDrawUsage);
    this.glowGeo.setAttribute('aP', this.glowP);
    this.glowGeo.instanceCount = 0;
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { uSodium: U.uSodium, uOn: { value: 0 }, uSize: { value: 2.3 }, uFogFar: { value: 900 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glows = new THREE.Mesh(this.glowGeo, this.glowMat);
    glows.frustumCulled = false;
    glows.renderOrder = 3;
    glows.name = 'lamp-glows';

    this.group.name = 'street-lamps';
    this.group.add(this.cobras, this.posts, pools, poolsAdd, glows);
    this.group.visible = false;
    scene.add(this.group);
  }

  setLamps(lamps: LampSet): void {
    this.lamps = lamps;
    this.lastCam.set(1e9, 0, 1e9);
  }

  setLevel(level: 0 | 1 | 2): void {
    this.level = level;
    this.group.visible = level > 0 && !!this.lamps;
    this.lastCam.set(1e9, 0, 1e9);
  }

  /** `on` is how lit the lamps are (0 by day, 1 at night); the poles show regardless. */
  update(dt: number, camera: THREE.Camera, on: number, lodScale: number, fogFar: number): void {
    if (this.level === 0 || !this.lamps) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.poolMat.uniforms.uOn.value = on;
    this.glowMat.uniforms.uOn.value = on;
    this.poolMat.uniforms.uFogFar.value = fogFar;
    this.glowMat.uniforms.uFogFar.value = fogFar;
    this.cool -= dt;
    const cam = camera.position;
    const moved = (cam.x - this.lastCam.x) ** 2 + (cam.z - this.lastCam.z) ** 2 > 225;
    const lit = on > 0.01 ? 1 : 0;
    if (lit === this.lastOn && (!moved || this.cool > 0)) return;
    this.cool = 0.4;
    this.lastOn = lit;
    this.lastCam.copy(cam);
    this.rebuild(cam, lit === 1, lodScale);
  }

  private rebuild(cam: THREE.Vector3, lit: boolean, lodScale: number): void {
    const L = this.lamps!;
    const caps = LAMP_CAPS[this.level === 1 ? 1 : 2];
    const rGlow = lit ? 900 : 0;
    const rPool = lit ? 150 * lodScale : 0;
    const rPole = 120 * lodScale;
    const far = Math.max(rGlow, rPole);
    const far2 = far * far;
    const idx: number[] = [];
    const key: number[] = [];
    for (let i = 0; i < L.count; i++) {
      const d2 = (L.x[i] - cam.x) ** 2 + (L.z[i] - cam.z) ** 2;
      if (d2 < far2) {
        idx.push(i);
        key.push(d2);
      }
    }
    const order = idx.map((_, n) => n).sort((a, b) => key[a] - key[b]);

    let nCobra = 0;
    let nPost = 0;
    let nPool = 0;
    let nGlow = 0;
    const pa = this.poolA.array as Float32Array;
    const pb = this.poolB.array as Float32Array;
    const gp = this.glowP.array as Float32Array;
    for (const n of order) {
      const i = idx[n];
      const d = Math.sqrt(key[n]);
      const iy = L.inward[i];
      const fx = Math.sin(iy);
      const fz = Math.cos(iy);
      const kind = L.kind[i];
      const h = L.h[i];
      const post = kind === 1;
      const mast = kind === 2;
      if (d < rPole && nCobra + nPost < caps.pole) {
        this.q.setFromAxisAngle(this.up, iy);
        this.pos.set(L.x[i], L.y[i] - 0.1, L.z[i]);
        this.sc.set(1, post ? h / 4 : h / POLE_H, 1);
        this.m.compose(this.pos, this.q, this.sc);
        if (post) this.posts.setMatrixAt(nPost++, this.m);
        else this.cobras.setMatrixAt(nCobra++, this.m);
      }
      if (nPool < caps.pool && d < rPool * (post ? 0.6 : 1)) {
        const reach = post ? 0 : mast ? 4 : 3.2;
        pa[nPool * 4] = L.x[i] + fx * reach;
        pa[nPool * 4 + 1] = L.y[i];
        pa[nPool * 4 + 2] = L.z[i] + fz * reach;
        pa[nPool * 4 + 3] = iy + Math.PI / 2;
        pb[nPool * 3] = L.slope[i];
        pb[nPool * 3 + 1] = post ? 0.55 : mast ? 1.3 : 1;
        pb[nPool * 3 + 2] = post ? 0.55 : mast ? 1.2 : 1;
        nPool++;
      }
      if (nGlow < caps.glow && d < rGlow) {
        const reach = post ? 0 : ARM - 0.1;
        gp[nGlow * 4] = L.x[i] + fx * reach;
        gp[nGlow * 4 + 1] = L.y[i] + (post ? h + 0.25 : h - 0.2);
        gp[nGlow * 4 + 2] = L.z[i] + fz * reach;
        gp[nGlow * 4 + 3] = post ? 0.6 : mast ? 1.25 : 1;
        nGlow++;
      }
      if (nCobra + nPost >= caps.pole && nPool >= caps.pool && nGlow >= caps.glow) break;
    }
    this.cobras.count = nCobra;
    this.posts.count = nPost;
    this.cobras.instanceMatrix.needsUpdate = true;
    this.posts.instanceMatrix.needsUpdate = true;
    this.poolGeo.instanceCount = nPool;
    this.poolA.needsUpdate = true;
    this.poolB.needsUpdate = true;
    this.glowGeo.instanceCount = nGlow;
    this.glowP.needsUpdate = true;
  }

  /** Counts for tests and diagnostics. */
  stats() {
    return { lamps: this.lamps?.count ?? 0, poles: this.cobras.count + this.posts.count, pools: this.poolGeo.instanceCount, glows: this.glowGeo.instanceCount };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [this.cobras, this.posts]) {
      m.geometry.dispose();
      m.dispose();
    }
    this.poleMat.dispose();
    this.poolGeo.dispose();
    this.glowGeo.dispose();
    this.poolMat.dispose();
    this.poolAddMat.dispose();
    this.glowMat.dispose();
  }
}

/**
 * The lamps of a tile: the anchors of `props.json` when the tile names one (`propsFile`) and it has
 * lamps, else the stand-in placement from `roads.json` and `junctions.json`. Null when neither loads.
 */
export async function loadLamps(tileBase: string, propsFile: string | undefined, signal?: AbortSignal): Promise<LampSet | null> {
  try {
    if (propsFile) {
      const pr = await fetch(new URL(propsFile, tileBase), { signal });
      if (pr.ok) {
        const props = parseProps(await pr.json());
        if (props && props.lamps.length > 0) return lampsFromProps(props.lamps);
      }
    }
    const [rr, jr] = await Promise.all([fetch(new URL('roads.json', tileBase), { signal }), fetch(new URL('junctions.json', tileBase), { signal })]);
    if (!rr.ok) return null;
    const roads = ((await rr.json()) as { roads: RoadJson[] }).roads;
    const junctions = jr.ok ? ((await jr.json()) as { junctions: { x: number; z: number }[] }).junctions : [];
    return placeLamps(roads, junctions);
  } catch {
    return null;
  }
}
