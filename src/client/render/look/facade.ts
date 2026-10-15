/**
 * Procedural building facades: floors, windows, grime and lit rooms laid over the baked walls by the
 * fragment shader, so the walls need no texture.
 *
 * The shader reads four per-vertex attributes of the wall quad it is on:
 *
 *   uv     (u, v)           metres along the footprint ring, and metres above the base (an exact box projection)
 *   gWall  (u0, len, v0, v1) where the quad starts along the ring, its length, its bottom and top in `v`
 *   gBld   (kind, era, floors, band)  the building kind id, its era, the number of upper floors, the ground band in decimetres
 *   gBid   (hash, flags)    a stable 16-bit hash of the building, for per-building variation
 *
 * **Baked first.** A tile of mesh format 2 (docs/contracts/m1-tile-format.md, "Mesh attributes")
 * carries all of them as `TEXCOORD_0`, `_WALL`, `_BLD` and `_BID`; `prepareWallGeometry` only gives
 * them the names the shader uses (the same buffers, no copy). **Fallback.** An older tile has none,
 * so `deriveWallAttributes` reads the triangles once on load and writes the same four attributes
 * (kind 0, floors 0, so the shader lays the building out by its height alone, as the first version
 * of the look did): a wall is one quad per footprint edge, so a quad is the connected set of its
 * triangles' vertices, and quads that share a corner, a bottom and a top are one building for the hash.
 *
 * The GTA IV treatment: the baked colours are muted and browned, the foot of every wall is dirty,
 * there are rain streaks under the sills, windows reflect the hazy sky, rooms are lit tungsten or
 * fluorescent after dark, the lower floors pick up the sodium of the street lamps, and the
 * kinds differ (glass curtain wall, ribbon office, punched brick, open garage, shopfront, civic piers).
 */
import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';
import { U } from './uniforms';

/** True when the geometry carries the pipeline's wall attributes (mesh format 2). */
export function hasBakedWalls(g: THREE.BufferGeometry): boolean {
  const w = g.getAttribute('_wall');
  const b = g.getAttribute('_bld');
  return !!w && !!b && w.itemSize === 4 && b.itemSize === 4 && !!g.getAttribute('_bid') && !!g.getAttribute('uv');
}

/** Gives a wall geometry the attributes the shader reads: the baked ones renamed, or derived from the triangles. Idempotent. */
export function prepareWallGeometry(mesh: THREE.Mesh): void {
  const g = mesh.geometry;
  if (g.getAttribute('gWall')) return;
  if (hasBakedWalls(g)) {
    g.setAttribute('gWall', g.getAttribute('_wall'));
    g.setAttribute('gBld', g.getAttribute('_bld'));
    g.setAttribute('gBid', g.getAttribute('_bid'));
    return;
  }
  mesh.updateWorldMatrix(true, false);
  deriveWallAttributes(g, mesh.matrixWorld);
}

/** The fallback for a tile without baked wall attributes: finds the quads and the buildings from the triangles. */
export function deriveWallAttributes(g: THREE.BufferGeometry, world: THREE.Matrix4): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const index = g.getIndex();
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const wall = new Float32Array(n * 4);
  const bld = new Float32Array(n * 4);
  const bid = new Float32Array(n * 2);
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('gWall', new THREE.BufferAttribute(wall, 4));
  g.setAttribute('gBld', new THREE.BufferAttribute(bld, 4));
  g.setAttribute('gBid', new THREE.BufferAttribute(bid, 2));
  if (!index || n === 0) return;

  // World positions (the node carries the quantisation scale and the chunk's offset).
  const wp = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(world);
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
    const rq = quads.get(bfind(r))!;
    // A stable hash of the root quad's first corner.
    const i0 = rq.verts[0];
    let h = Math.imul(Math.round(wp[i0 * 3] * 10), 73856093) ^ Math.imul(Math.round(wp[i0 * 3 + 2] * 10), 19349663) ^ Math.imul(Math.round(rq.maxY), 83492791);
    h = (h ^ (h >>> 13)) >>> 0;
    q.hash = h % 65536;
    for (const i of q.verts) {
      // u along the quad's own tangent (absolute, so u - u0 starts at 0), v as world height (so v - v0 starts at 0)
      uv[i * 2] = wp[i * 3] * q.tx + wp[i * 3 + 2] * q.tz;
      uv[i * 2 + 1] = wp[i * 3 + 1];
      wall[i * 4] = q.u0;
      wall[i * 4 + 1] = q.len;
      wall[i * 4 + 2] = q.minY;
      wall[i * 4 + 3] = q.maxY;
      bid[i * 2] = q.hash;
      // gBld stays 0: kind generic, floors 0 (laid out by height alone)
    }
  }
}

const VERT_DECL = /* glsl */ `
attribute vec4 gWall;
attribute vec4 gBld;
attribute vec2 gBid;
varying vec3 vFW;
varying vec2 vUvW;
varying vec3 vWN;
varying vec4 vWall;
varying vec4 vBld;
varying vec2 vBid;
`;

const FRAG_DECL = /* glsl */ `
uniform float uNight;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform vec3 uSodium;
uniform float uSpill;
uniform float uWallSat;
uniform float uAo;
varying vec3 vFW;
varying vec2 vUvW;
varying vec3 vWN;
varying vec4 vWall;
varying vec4 vBld;
varying vec2 vBid;
${GLSL_NOISE}
`;

/** Runs after the vertex colour is applied: lays the facade over diffuseColor, and sets the window light and roughness. */
const FRAG_FACADE = /* glsl */ `
vec3 gfxEmit = vec3(0.0);
float gfxRough = -1.0;
{
  float len = vWall.y;
  float v0 = vWall.z;
  float H = vWall.w - v0;
  float camD = distance(vFW, cameraPosition);
  if (len > 0.9 && H > 3.0) {
    float hb = vBid.x / 65535.0;
    float u = vUvW.x - vWall.x;
    float v = vUvW.y - v0;
    float kind = vBld.x;
    float era = vBld.y;
    float floors = vBld.z;
    float bandM = vBld.w * 0.1;
    bool baked = floors > 0.5;
    #ifdef GFX_GLASS
      bool glassy = true;
    #else
      bool glassy = baked && abs(kind - 2.0) < 0.5;
    #endif
    bool office = baked && abs(kind - 1.0) < 0.5;
    bool brick = baked && abs(kind - 3.0) < 0.5;
    bool parking = baked && abs(kind - 4.0) < 0.5;
    bool retail = baked && abs(kind - 5.0) < 0.5;
    bool civic = baked && (abs(kind - 6.0) < 0.5 || abs(kind - 7.0) < 0.5);
    bool industrial = baked && abs(kind - 8.0) < 0.5;
    bool resid = baked && abs(kind - 9.0) < 0.5;
    bool house = baked && abs(kind - 10.0) < 0.5;
    bool shed = baked && abs(kind - 11.0) < 0.5;
    bool venue = baked && abs(kind - 12.0) < 0.5;

    // Floors and the ground band: from the data when the tile has it, from the height alone when it has not.
    float gH;
    float nF;
    float fh;
    float colW;
    vec4 rect; // x0, x1, y0, y1 of the window inside its cell
    if (baked) {
      gH = bandM;
      nF = floors;
      fh = max((H - gH) / nF, 1.5);
      if (glassy) { colW = 1.5; rect = vec4(0.05, 0.95, 0.06, 0.80); }
      else if (office) { colW = 2.3; rect = vec4(0.03, 0.97, 0.26, 0.80); }
      else if (brick) { colW = 2.7; rect = vec4(0.27, 0.73, 0.22, 0.80); }
      else if (parking) { colW = 3.0; rect = vec4(0.02, 0.98, 0.06, 0.62); }
      else if (civic) { colW = 3.4; rect = vec4(0.30, 0.70, 0.14, 0.88); }
      else if (industrial) { colW = 5.0; rect = vec4(0.30, 0.70, 0.58, 0.88); }
      else if (resid) { colW = 3.0; rect = vec4(0.22, 0.78, 0.20, 0.82); }
      else if (house) { colW = 3.2; rect = vec4(0.28, 0.72, 0.28, 0.78); }
      else if (venue) { colW = 6.0; rect = vec4(0.1, 0.9, 0.3, 0.7); }
      else { colW = 2.6 + 0.8 * gfxH21(vec2(hb * 13.1, 7.7)); rect = vec4(0.27, 0.73, 0.28, 0.80); }
      // older buildings: narrower bays
      if (era > 0.5 && era < 1.5) colW *= 0.85;
    } else {
      bool tall = H > 40.0;
      bool podium = H > 16.0;
      gH = podium ? 4.6 : 0.0;
      float fh0 = 3.3 + 0.8 * gfxH21(vec2(hb * 91.7, 3.1));
      nF = max(1.0, floor((H - gH) / fh0 + 0.5));
      fh = (H - gH) / nF;
      colW = glassy ? 1.5 : (tall ? 2.5 : 2.5 + 1.0 * gfxH21(vec2(hb * 13.1, 7.7)));
      if (glassy) rect = vec4(0.05, 0.95, 0.06, 0.80);
      else if (tall) rect = vec4(0.07, 0.93, 0.22, 0.80);
      else rect = vec4(0.27, 0.73, 0.28, 0.80);
    }
    float cellX;
    float cellY;
    float colId;
    float rowId;
    bool store = gH > 0.5 && v < gH;
    if (store) {
      float nC = max(1.0, floor(len / (retail ? 3.6 : 4.6) + 0.5));
      cellX = u / (len / nC);
      cellY = v / gH;
      rect = vec4(0.07, 0.93, 0.10, 0.80);
      rowId = -1.0;
    } else {
      float nC = max(1.0, floor(len / colW + 0.5));
      cellX = u / (len / nC);
      cellY = (v - gH) / fh;
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
    if (len < 2.0 || shed) cov = 0.0;
    cov *= edge;

    float r = gfxH21(vec2(colId + hb * 100.0, rowId * 1.7 + hb * 31.0));
    float r2 = gfxH21(vec2(colId * 0.37 + hb * 17.0, rowId * 2.9 + 5.0));

    // Wall surface: the baked colour muted and browned, a darker slab line at each floor, a grimy base.
    float fade = 1.0 - smoothstep(60.0, 220.0, camD);
    float lumW = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(vec3(lumW), diffuseColor.rgb, uWallSat) * vec3(1.0, 0.975, 0.92);
    // the foot of a wall is dirty (the baked ambient occlusion darkens the light there; this is the dirt itself)
    float grime = mix(0.5, 1.0, smoothstep(0.0, 3.5, v));
    #ifdef GFX_BAKED_AO
      float canyon = 1.0;
    #else
      float canyon = mix(0.84, 1.0, smoothstep(0.0, 35.0, v));
    #endif
    #ifdef GFX_LITE
      diffuseColor.rgb *= grime * canyon;
    #else
      float stain = gfxVn(vec2(u * 0.45, v * 0.07 + hb * 40.0));
      float slab = store ? 1.0 : mix(0.86, 1.0, smoothstep(0.0, 0.10, fy));
      float splash = mix(0.78, 1.0, gfxVn(vec2(u * 2.1, v * 3.0 + hb * 9.0)));
      grime *= mix(1.0, splash, 1.0 - smoothstep(0.0, 2.6, v));
      grime *= mix(0.9, 1.0, smoothstep(H, H - 2.5, v)); // soot under the roofline
      // rain streaks: dirt run down from the foot of each window
      float inX = smoothstep(rect.x - 0.04, rect.x + 0.04, fx) * (1.0 - smoothstep(rect.y - 0.04, rect.y + 0.04, fx));
      float streak = store ? 0.0 : inX * smoothstep(0.0, rect.z, fy) * (1.0 - step(rect.z, fy)) * step(0.45, r);
      diffuseColor.rgb *= (1.0 + (stain - 0.5) * 0.34 * fade) * mix(1.0, slab, fade) * grime * canyon * (1.0 - 0.22 * streak * fade);
    #endif
    if (glassy) diffuseColor.rgb *= 0.55; // mullions and spandrels: darker than the flat grey of the bake

    // The window: sky and street reflection, a little by day, plus the lit rooms at night.
    vec3 V = normalize(cameraPosition - vFW);
    vec3 nW = normalize(vWN);
    if (dot(nW, V) < 0.0) nW = -nW;
    vec3 R = reflect(-V, nW);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, R.y));
    vec3 ground = mix(uHorizon * 0.5, uGround, smoothstep(0.0, -0.4, R.y));
    vec3 refl = (R.y > 0.0 ? sky : ground) * vec3(0.9, 0.97, 0.92); // a greenish tint on the glass
    float F = 0.04 + 0.35 * pow(1.0 - max(dot(nW, V), 0.0), 5.0);
    float refl0 = glassy ? 0.42 : 0.22;
    vec3 glass = refl * (refl0 + 0.9 * F) * mix(0.8, 1.2, r);
    #ifndef GFX_LITE
      // Blinds and curtains: some windows are pale.
      float blind = step(0.93, r2) * (1.0 - uNight * 0.6);
      glass = mix(glass, vec3(0.45, 0.40, 0.33) * 0.6, blind * 0.7);
    #endif
    // An open garage has no glass: dark bays.
    if (parking) glass = vec3(0.012, 0.012, 0.014);

    // Rooms lit after dark. A floor tends to be lit as a whole (an office), so the odds depend on the row.
    float litMax = parking ? 0.12 : industrial ? 0.12 : (office || glassy) ? 0.6 : (resid || house) ? 0.45 : 0.5;
    float rowP = gfxH21(vec2(rowId * 3.1 + hb * 29.0, 9.0));
    float lit0 = store ? (retail ? 0.85 : 0.7) : mix(0.04, litMax, rowP * rowP * (0.4 + 0.6 * gfxH21(vec2(hb * 5.3, 1.0))));
    float lit = step(gfxH21(vec2(colId * 1.31 + hb * 57.0, rowId * 2.17 + hb * 13.1)), lit0) * uNight;
    vec3 warm = vec3(1.0, 0.70, 0.38); // tungsten
    vec3 cool = vec3(0.70, 0.90, 0.84); // fluorescent office tubes
    float coolMix = (glassy || office) ? 0.55 : civic ? 0.3 : (resid || house || brick) ? 0.0 : 0.15;
    vec3 lc = mix(warm, cool, step(0.72, r2) * 0.9 * (coolMix > 0.0 ? 1.0 : 0.0) + coolMix * 0.4);
    if (parking) lc = vec3(1.0, 0.55, 0.22) * 0.6;
    vec3 room = lc * (0.45 + 0.6 * r) * (store ? 0.42 : 1.0) * (0.6 + 0.4 * smoothstep(rect.z, rect.w, fy));
    vec3 winEmit = glass * (1.0 - lit) + room * lit;

    gfxEmit = winEmit * cov;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.024, 0.032), cov);
    // street-lamp light on the lower floors: sodium, strongest at the foot of the wall and gone by about 20 m
    float spill = exp(-v / 5.5) * (0.45 + 0.55 * gfxVn(vec2(u * 0.22, hb * 20.0)));
    gfxEmit += uSodium * diffuseColor.rgb * (uSpill * uNight * spill * 0.6);
    gfxRough = mix(glassy ? 0.55 : 0.85, 0.24, cov);
  }
}
`;

const FACADE_CACHE = 'look-facade-v3';

/** What a facade program is built with: the level (`fx.facade`, 1 is the cheap variant) and whether the tile's ambient occlusion is in the vertex alpha. */
export interface FacadeOptions {
  level: () => number;
  baked: boolean;
}

/** Patches a baked `bld_wall` or `bld_glass` material. Change the level with `needsUpdate`. */
export function patchFacadeMaterial(mat: THREE.Material, glass: boolean, opt: FacadeOptions): void {
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uHorizon = U.uHorizon;
    shader.uniforms.uZenith = U.uZenith;
    shader.uniforms.uGround = U.uGround;
    shader.uniforms.uSodium = U.uSodium;
    shader.uniforms.uSpill = U.uSpill;
    shader.uniforms.uWallSat = U.uWallSat;
    shader.uniforms.uAo = U.uAo;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vFW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);\n  vUvW = uv;\n  vWall = gWall;\n  vBld = gBld;\n  vBid = gBid;`);
    let f = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_FACADE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (gfxRough >= 0.0) roughnessFactor = gfxRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = 0.0;')
      // The baked material's flat night glow (Atmosphere.applyGlow) is replaced by lit windows.
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vec3(0.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gfxEmit;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_FRAGMENT}`);
    const defs = [glass ? '#define GFX_GLASS' : '', opt.level() < 2 ? '#define GFX_LITE' : '', opt.baked ? '#define GFX_BAKED_AO' : ''].filter(Boolean).join('\n');
    shader.fragmentShader = defs ? `${defs}\n${f}` : f;
  };
  m.customProgramCacheKey = () => `${FACADE_CACHE}${glass ? '-glass' : ''}-${opt.level() < 2 ? 'lite' : 'full'}${opt.baked ? '-ao' : ''}`;
  m.needsUpdate = true;
}

/** The pipeline bakes ambient occlusion into the alpha of the vertex colour (meant for the indirect light): this applies it. Neutral (alpha 1) on an older tile. */
export const AO_FRAGMENT = /* glsl */ `
#ifdef USE_COLOR_ALPHA
  reflectedLight.indirectDiffuse *= mix(1.0, vColor.a, uAo);
#endif
`;
