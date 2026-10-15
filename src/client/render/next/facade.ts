/**
 * Procedural building facades (`?gfx=next`). The baked walls carry vertex colours only, so there is
 * nothing to hang a window texture on. Instead, when a wall mesh is first seen, this reads its
 * triangles once and writes two vertex attributes the shader needs (no re-bake, the files stay as
 * they are):
 *
 *   aWall = (base y, top y, u0, length)   the wall quad's own span, and where it starts along its tangent
 *   aBld  = (building hash, tangent x, tangent z, 0)
 *
 * A wall is one quad per footprint edge (tools/pipeline/src/mesh/extrude.ts), so a quad is the
 * connected set of its triangles' vertices. Quads that share a corner and the same base and top are
 * one building for the hash. The fragment shader then lays out floors (about 3.5 m, whole numbers
 * per wall), columns (whole numbers per wall, so a window never meets a corner half cut), a
 * podium storefront on tall buildings, and lights the windows at night from `uNight`.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';
import { U } from './uniforms';

/** Adds `aWall` and `aBld` to a wall mesh's geometry. Idempotent. */
export function prepareWallGeometry(mesh: THREE.Mesh): void {
  const g = mesh.geometry;
  if (g.getAttribute('aWall')) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const index = g.getIndex();
  const n = pos.count;
  const wall = new Float32Array(n * 4);
  const bld = new Float32Array(n * 4);
  g.setAttribute('aWall', new THREE.BufferAttribute(wall, 4));
  g.setAttribute('aBld', new THREE.BufferAttribute(bld, 4));
  if (!index || n === 0) return;

  // World positions (the node carries the quantisation scale and the chunk's offset).
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const wp = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    wp[i * 3] = v.x;
    wp[i * 3 + 1] = v.y;
    wp[i * 3 + 2] = v.z;
  }

  // Union-find over vertices joined by a triangle: a wall quad is one set.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const ix = index.array;
  for (let t = 0; t < ix.length; t += 3) {
    union(ix[t], ix[t + 1]);
    union(ix[t], ix[t + 2]);
  }

  interface Quad {
    minY: number;
    maxY: number;
    tx: number;
    tz: number;
    u0: number;
    len: number;
    verts: number[];
    hash: number;
  }
  const quads = new Map<number, Quad>();
  const get = (r: number): Quad => {
    let q = quads.get(r);
    if (!q) quads.set(r, (q = { minY: Infinity, maxY: -Infinity, tx: 1, tz: 0, u0: 0, len: 0, verts: [], hash: 0 }));
    return q;
  };
  for (let i = 0; i < n; i++) {
    const q = get(find(i));
    q.verts.push(i);
    const y = wp[i * 3 + 1];
    if (y < q.minY) q.minY = y;
    if (y > q.maxY) q.maxY = y;
  }
  for (const q of quads.values()) {
    // The tangent runs between the two vertices furthest apart in plan.
    let best = 0;
    let bi = q.verts[0];
    let bj = q.verts[0];
    for (let a = 0; a < q.verts.length; a++) {
      for (let b = a + 1; b < q.verts.length; b++) {
        const i = q.verts[a];
        const j = q.verts[b];
        const d = Math.hypot(wp[j * 3] - wp[i * 3], wp[j * 3 + 2] - wp[i * 3 + 2]);
        if (d > best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < 0.5 || q.maxY - q.minY < 0.5) {
      q.len = 0; // not a wall (a flat quad, or a sliver)
      continue;
    }
    q.tx = (wp[bj * 3] - wp[bi * 3]) / best;
    q.tz = (wp[bj * 3 + 2] - wp[bi * 3 + 2]) / best;
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of q.verts) {
      const u = wp[i * 3] * q.tx + wp[i * 3 + 2] * q.tz;
      if (u < lo) lo = u;
      if (u > hi) hi = u;
    }
    q.u0 = lo;
    q.len = hi - lo;
  }

  // One building = quads with the same span that share a corner. Hash it from its first corner.
  const bp = new Map<number, number>();
  const bfind = (a: number): number => {
    let r = a;
    while ((bp.get(r) ?? r) !== r) r = bp.get(r)!;
    return r;
  };
  const cornerOwner = new Map<string, number>();
  for (const [r, q] of quads) {
    bp.set(r, r);
    if (q.len === 0) continue;
    for (const i of q.verts) {
      const key = `${Math.round(wp[i * 3] * 10)},${Math.round(wp[i * 3 + 2] * 10)},${Math.round(q.minY)},${Math.round(q.maxY)}`;
      const other = cornerOwner.get(key);
      if (other === undefined) cornerOwner.set(key, r);
      else {
        const a = bfind(r);
        const b = bfind(other);
        if (a !== b) bp.set(a, b);
      }
    }
  }
  for (const [r, q] of quads) {
    const root = bfind(r);
    // A stable hash of the root quad's lowest corner.
    const rq = quads.get(root)!;
    const i0 = rq.verts[0];
    const hx = Math.round(wp[i0 * 3] * 10);
    const hz = Math.round(wp[i0 * 3 + 2] * 10);
    let h = Math.imul(hx, 73856093) ^ Math.imul(hz, 19349663) ^ Math.imul(Math.round(rq.maxY), 83492791);
    h = (h ^ (h >>> 13)) >>> 0;
    q.hash = (h % 100000) / 100000;
    for (const i of q.verts) {
      wall[i * 4] = q.minY;
      wall[i * 4 + 1] = q.maxY;
      wall[i * 4 + 2] = q.u0;
      wall[i * 4 + 3] = q.len;
      bld[i * 4] = q.hash;
      bld[i * 4 + 1] = q.tx;
      bld[i * 4 + 2] = q.tz;
    }
  }
}

const VERT_DECL = /* glsl */ `
attribute vec4 aWall;
attribute vec4 aBld;
varying vec3 vFW;
varying vec4 vWall;
varying vec4 vBld;
`;

const FRAG_DECL = /* glsl */ `
uniform float uNight;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
varying vec3 vFW;
varying vec4 vWall;
varying vec4 vBld;
${GLSL_NOISE}
`;

/** Runs after the vertex colour is applied: lays the facade over diffuseColor, and sets the window light and roughness. */
const FRAG_FACADE = /* glsl */ `
float gfxWin = 0.0;
vec3 gfxEmit = vec3(0.0);
float gfxRough = -1.0;
{
  float len = vWall.w;
  float H = vWall.y - vWall.x;
  float camD = distance(vFW, cameraPosition);
  if (len > 0.9 && H > 3.5) {
    float hb = vBld.x;
    vec2 t = vBld.yz;
    float u = dot(vFW.xz, t) - vWall.z;
    float v = vFW.y - vWall.x;
    #ifdef GFX_GLASS
      bool glassy = true;
    #else
      bool glassy = false;
    #endif
    bool tall = H > 40.0;
    bool podium = H > 16.0;
    float gH = podium ? 4.6 : 0.0;
    float fh0 = 3.3 + 0.8 * gfxH21(vec2(hb * 91.7, 3.1));
    float nF = max(1.0, floor((H - gH) / fh0 + 0.5));
    float fh = (H - gH) / nF;
    float colW = glassy ? 1.5 : (tall ? 2.5 : 2.5 + 1.0 * gfxH21(vec2(hb * 13.1, 7.7)));
    float cellX;
    float cellY;
    float colId;
    float rowId;
    vec4 rect; // x0, x1, y0, y1 of the window inside its cell
    bool store = podium && v < gH;
    if (store) {
      float nC = max(1.0, floor(len / 4.6 + 0.5));
      cellX = u / (len / nC);
      cellY = v / gH;
      rect = vec4(0.07, 0.93, 0.10, 0.80);
      rowId = -1.0;
    } else {
      float nC = max(1.0, floor(len / colW + 0.5));
      cellX = u / (len / nC);
      cellY = (v - gH) / fh;
      if (glassy) rect = vec4(0.05, 0.95, 0.06, 0.80);
      else if (tall) rect = vec4(0.07, 0.93, 0.22, 0.80);
      else rect = vec4(0.27, 0.73, 0.28, 0.80);
      rowId = floor(cellY);
    }
    colId = floor(cellX);
    float fx = fract(cellX);
    float fy = fract(cellY);
    float fwx = max(fwidth(cellX), 1e-3);
    float fwy = max(fwidth(cellY), 1e-3);
    float wx = clamp(min(fx - rect.x, rect.y - fx) / fwx + 0.5, 0.0, 1.0);
    float wy = clamp(min(fy - rect.z, rect.w - fy) / fwy + 0.5, 0.0, 1.0);
    float cov = wx * wy;
    float avg = (rect.y - rect.x) * (rect.w - rect.z);
    float far = smoothstep(0.35, 0.9, max(fwx, fwy));
    cov = mix(cov, avg, far);

    // A wall with no window in the top 1 m or the bottom 0.3 m reads as a parapet and a plinth.
    float edge = smoothstep(0.0, 0.5, v) * (1.0 - smoothstep(H - 0.9, H - 0.3, v));
    if (len < 2.0) cov = 0.0;
    cov *= edge;

    float r = gfxH21(vec2(colId + hb * 100.0, rowId * 1.7 + hb * 31.0));
    float r2 = gfxH21(vec2(colId * 0.37 + hb * 17.0, rowId * 2.9 + 5.0));

    // Wall surface: staining, a darker slab line at each floor, a grimy base.
    float fade = 1.0 - smoothstep(60.0, 220.0, camD);
    float stain = gfxVn(vec2(u * 0.45, v * 0.07 + hb * 40.0));
    float slab = store ? 1.0 : mix(0.86, 1.0, smoothstep(0.0, 0.10, fy));
    float grime = mix(0.72, 1.0, smoothstep(0.0, 3.0, v));
    diffuseColor.rgb *= (1.0 + (stain - 0.5) * 0.3 * fade) * mix(1.0, slab, fade) * grime;
    if (glassy) diffuseColor.rgb *= 0.55; // mullions and spandrels: darker than the flat grey of the bake

    // The window: sky and street reflection, a little by day, plus the lit rooms at night.
    vec3 V = normalize(cameraPosition - vFW);
    vec3 nW = vec3(t.y, 0.0, -t.x);
    if (dot(nW, V) < 0.0) nW = -nW;
    vec3 R = reflect(-V, nW);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, R.y));
    vec3 ground = mix(uHorizon * 0.5, uGround, smoothstep(0.0, -0.4, R.y));
    vec3 refl = R.y > 0.0 ? sky : ground;
    float F = 0.04 + 0.96 * pow(1.0 - max(dot(nW, V), 0.0), 5.0);
    float refl0 = glassy ? 0.42 : 0.22;
    vec3 glass = refl * (refl0 + 0.9 * F) * mix(0.8, 1.2, r);
    // Blinds and curtains: some windows are pale.
    float blind = step(0.93, r2) * (1.0 - uNight * 0.6);
    glass = mix(glass, vec3(0.45, 0.40, 0.33) * 0.6, blind * 0.7);

    // Rooms lit after dark. A floor tends to be lit as a whole (an office), so the odds depend on the row.
    float rowP = gfxH21(vec2(rowId * 3.1 + hb * 29.0, 9.0));
    float lit0 = store ? 0.75 : mix(0.05, 0.60, rowP * rowP * (0.4 + 0.6 * gfxH21(vec2(hb * 5.3, 1.0))));
    float lit = step(gfxH21(vec2(colId * 1.31 + hb * 57.0, rowId * 2.17 + hb * 13.0)), lit0) * uNight;
    vec3 warm = vec3(1.0, 0.68, 0.36);
    vec3 cool = vec3(0.62, 0.78, 1.0);
    vec3 lc = mix(warm, cool, step(0.72, r2) * 0.9 + (glassy ? 0.35 : 0.0));
    vec3 room = lc * (0.55 + 0.75 * r) * (store ? 0.8 : 1.0) * (0.6 + 0.4 * smoothstep(rect.z, rect.w, fy));
    vec3 winEmit = glass * (1.0 - lit) + room * lit;

    gfxEmit = winEmit * cov;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.024, 0.032), cov);
    gfxRough = mix(glassy ? 0.55 : 0.85, 0.09, cov);
  }
}
`;

const FACADE_CACHE = 'gfxnext-facade-v1';

/** Patches a baked `bld_wall` or `bld_glass` material. */
export function patchFacadeMaterial(mat: THREE.Material, glass: boolean): void {
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uHorizon = U.uHorizon;
    shader.uniforms.uZenith = U.uZenith;
    shader.uniforms.uGround = U.uGround;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vFW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWall = aWall;\n  vBld = aBld;`);
    let f = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_FACADE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (gfxRough >= 0.0) roughnessFactor = gfxRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = 0.0;')
      // The baked material's flat night glow (Atmosphere.applyGlow) is replaced by lit windows.
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vec3(0.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gfxEmit;');
    if (glass) f = `#define GFX_GLASS\n${f}`;
    shader.fragmentShader = f;
  };
  m.customProgramCacheKey = () => `${FACADE_CACHE}${glass ? '-glass' : ''}`;
  m.needsUpdate = true;
}
