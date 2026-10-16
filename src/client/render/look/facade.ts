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
 *   gLook  (material, style, band material and crown, provenance)   what the building is made of and in what style (meshFormat 3; all zero on an older tile)
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

/** True when the geometry carries the pipeline's appearance attribute (mesh format 3: material, style, band, crown). */
export function hasBakedLook(g: THREE.BufferGeometry): boolean {
  const l = g.getAttribute('_look');
  return !!l && l.itemSize === 4;
}

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
    // an older tile has no appearance: material and style 0 (unknown) keep the kind's own layout
    g.setAttribute('gLook', hasBakedLook(g) ? g.getAttribute('_look')! : new THREE.BufferAttribute(new Uint8Array(g.getAttribute('position').count * 4), 4));
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
  g.setAttribute('gLook', new THREE.BufferAttribute(new Uint8Array(n * 4), 4));
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
attribute vec4 gLook;
varying vec4 vLook;
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
varying vec4 vLook;
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
    // what the building is made of and in what style (meshFormat 3; zero on an older tile, which keeps the kind's own layout)
    float matId = vLook.x;
    float styleId = vLook.y;
    float bandMat = mod(vLook.z, 8.0);
    float crownM = floor(vLook.z / 8.0) * 2.0;
    bool baked = floors > 0.5;
    bool mBrick = abs(matId - 1.0) < 0.5;
    bool mGlass = abs(matId - 2.0) < 0.5;
    bool mConc = abs(matId - 3.0) < 0.5;
    bool mStone = abs(matId - 4.0) < 0.5;
    bool mMetal = abs(matId - 5.0) < 0.5;
    bool mStucco = abs(matId - 6.0) < 0.5;
    bool mWood = abs(matId - 7.0) < 0.5;
    bool sClassic = abs(styleId - 1.0) < 0.5;
    bool sVictor = abs(styleId - 2.0) < 0.5;
    bool sDeco = abs(styleId - 3.0) < 0.5;
    bool sModern = abs(styleId - 4.0) < 0.5;
    bool sBrutal = abs(styleId - 5.0) < 0.5;
    bool sPostmod = abs(styleId - 6.0) < 0.5;
    bool sContemp = abs(styleId - 7.0) < 0.5;
    #ifdef GFX_GLASS
      bool glassy = true;
    #else
      bool glassy = baked && (abs(kind - 2.0) < 0.5 || (mGlass && kind > 0.5 && kind < 9.5));
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
    bool generic = baked && kind < 0.5;
    bool trad = sClassic || sVictor || sDeco; // masonry with a cornice, a base and punched or piered windows

    // Floors and the ground band: from the data when the tile has it, from the height alone when it has not.
    float Hc = H - crownM; // the windows end here; above it is the crown
    float gH;
    float nF;
    float fh;
    float colW;
    vec4 rect; // x0, x1, y0, y1 of the window inside its cell
    vec2 surr = vec2(0.0); // how far the stone or painted surround reaches past the window, in cell fractions
    float surrTone = 1.0;
    float ribbon = 0.0;
    if (baked) {
      gH = bandM;
      nF = floors;
      fh = max((Hc - gH) / nF, 1.5);
      if (glassy) {
        if (era > 2.5 && era < 3.5) { colW = 1.8; rect = vec4(0.03, 0.97, 0.16, 0.80); ribbon = 1.0; } // a 1970s mirror tower: strip windows between spandrels
        else { colW = 1.5; rect = vec4(0.05, 0.95, 0.06, 0.80); }
      }
      else if (office) { colW = 2.3; rect = vec4(0.03, 0.97, 0.26, 0.80); }
      else if (brick) { colW = 2.7; rect = vec4(0.27, 0.73, 0.22, 0.80); }
      else if (parking) { colW = 3.0; rect = vec4(0.02, 0.98, 0.06, 0.62); }
      else if (civic) { colW = 3.4; rect = vec4(0.30, 0.70, 0.14, 0.88); }
      else if (industrial) { colW = 5.0; rect = vec4(0.30, 0.70, 0.58, 0.88); }
      else if (resid) { colW = 3.0; rect = vec4(0.22, 0.78, 0.20, 0.82); }
      else if (house) { colW = 3.2; rect = vec4(0.28, 0.72, 0.28, 0.78); }
      else if (venue) { colW = 6.0; rect = vec4(0.1, 0.9, 0.3, 0.7); }
      else { colW = 2.6 + 0.8 * gfxH21(vec2(hb * 13.1, 7.7)); rect = vec4(0.27, 0.73, 0.28, 0.80); }
      // the era's windows, for the kinds that are dressed by it
      bool dressed = !(glassy || parking || industrial || house || shed || venue);
      if (dressed) {
        if (sVictor) { colW = 2.3; rect = vec4(0.31, 0.69, 0.12, 0.90); surr = vec2(0.07, 0.04); surrTone = 1.2; } // tall narrow windows, stone lintel and sill
        else if (sClassic) { colW = 3.3; rect = vec4(0.28, 0.72, 0.15, 0.86); surr = vec2(0.09, 0.05); surrTone = 1.24; }
        else if (sDeco) { colW = 2.8; rect = vec4(0.25, 0.75, 0.04, 0.94); surr = vec2(0.0, 0.0); } // tall strips between piers, a thin spandrel under each
        else if (sBrutal) { colW = 3.8; rect = vec4(0.27, 0.73, 0.30, 0.70); surr = vec2(0.05, 0.06); surrTone = 0.78; } // small deep-set windows
        else if (sModern) {
          if (resid || brick || mStone || mBrick) { colW = 3.0; rect = vec4(0.2, 0.8, 0.22, 0.78); surr = vec2(0.03, 0.02); surrTone = 0.8; } // punched square windows in deep reveals
          else { colW = 3.0; rect = vec4(0.02, 0.98, 0.30, 0.70); ribbon = 1.0; } // ribbon windows between concrete spandrels
        }
        else if (sPostmod) { colW = 2.4; rect = vec4(0.30, 0.70, 0.10, 0.90); surr = vec2(0.05, 0.03); surrTone = 1.1; } // a stone tower: narrow tall windows between strong piers
        else if (sContemp) { colW = resid ? 3.1 : 3.4; rect = vec4(0.06, 0.94, 0.08, 0.88); }
        else if (era > 0.5 && era < 1.5) colW *= 0.85; // older buildings: narrower bays
      }
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
    float cellWm;
    float cellX;
    float cellY;
    float colId;
    float rowId;
    bool store = gH > 0.5 && v < gH;
    bool lobby = false;
    if (store) {
      bool towerLobby = (glassy || office || civic) && H > 40.0 && gH > 5.9;
      float bayW = retail ? 3.6 : towerLobby ? (civic ? 5.2 : 6.4) : 4.6;
      float nC = max(1.0, floor(len / bayW + 0.5));
      cellWm = len / nC;
      cellX = u / cellWm;
      cellY = v / gH;
      rect = towerLobby ? (civic ? vec4(0.22, 0.78, 0.05, 0.9) : vec4(0.10, 0.90, 0.04, 0.92)) : vec4(0.07, 0.93, 0.10, 0.80);
      surr = vec2(0.0);
      ribbon = 0.0;
      lobby = towerLobby;
      rowId = -1.0;
    } else {
      float nC = max(1.0, floor(len / colW + 0.5));
      cellWm = len / nC;
      cellX = u / cellWm;
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

    // A wall with no window in the top 1 m or the bottom 0.3 m reads as a parapet and a plinth; a traditional building has a cornice (about 1.4 m).
    float topClear = trad ? 1.5 : 0.9;
    float edge = smoothstep(0.0, 0.5, v) * (1.0 - smoothstep(Hc - topClear, Hc - topClear + 0.6, v));
    float inCrown = crownM > 0.5 ? smoothstep(Hc - 0.2, Hc + 0.2, v) : 0.0;
    if (len < 2.0 || shed) cov = 0.0;
    cov *= edge * (1.0 - inCrown);

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

    vec3 wallHue = diffuseColor.rgb / max(lumW, 0.01); // the colour of the wall as a hue, for the tint of its glass
    // The material of the wall: brick courses, ashlar blocks, precast panels, standing-seam metal, clapboards, stipple. Only close up (it would shimmer far away).
    float wallRough = glassy ? 0.55 : 0.88;
    #ifndef GFX_LITE
    if (camD < 140.0) {
      float matFade = 1.0 - smoothstep(35.0, 120.0, camD);
      vec3 base = diffuseColor.rgb;
      vec2 wp = vec2(u, v);
      if (mBrick && !glassy) {
        float row = v / 0.0762;
        float rI = floor(row);
        float bx = u / 0.2286 + 0.5 * mod(rI, 2.0);
        float bI = floor(bx);
        float fwr = max(fwidth(row), 1e-3);
        float bf = 1.0 - smoothstep(0.22, 0.55, fwr);
        float mH = 1.0 - smoothstep(0.11, 0.11 + max(fwr, 0.02), fract(row));
        float mV = (1.0 - smoothstep(0.035, 0.035 + max(fwidth(bx), 0.02), fract(bx))) * step(0.12, fract(row));
        float joint = max(mH, mV) * bf;
        float tone = mix(1.0, 0.86 + 0.28 * gfxH21(vec2(bI, rI) + hb * 40.0), bf);
        vec3 mortar = vec3(0.30, 0.28, 0.25);
        diffuseColor.rgb = mix(base * tone, mortar, joint * 0.62);
        wallRough = 0.93;
      } else if (mStone && !glassy) {
        // ashlar: courses about 0.45 m, blocks of 0.8 to 1.4 m, a hairline joint; polished granite is smoother
        float rowS = v / 0.45;
        float rS = floor(rowS);
        float bl = 0.85 + 0.55 * gfxH21(vec2(rS, hb * 9.0));
        float bxS = u / bl + gfxH21(vec2(rS * 1.7, hb * 5.0));
        float bIS = floor(bxS);
        float fwS = max(fwidth(rowS), 1e-3);
        float sf = 1.0 - smoothstep(0.18, 0.5, fwS);
        float jH = 1.0 - smoothstep(0.012, 0.012 + max(fwS, 0.012), fract(rowS));
        float jV = (1.0 - smoothstep(0.012, 0.012 + max(fwidth(bxS), 0.01), fract(bxS)));
        float jn = max(jH, jV) * sf;
        float tone = mix(1.0, 0.9 + 0.2 * gfxH21(vec2(bIS, rS) + hb * 30.0), sf);
        diffuseColor.rgb = mix(base * tone, base * 0.55, jn * 0.7);
        wallRough = 0.72;
      } else if (mConc && !glassy) {
        // precast panels: a joint at every column line and a gasket line mid-spandrel, a different tone for each panel, board marks
        float distM = min(fx, 1.0 - fx) * cellWm;
        float pj = 1.0 - smoothstep(0.01, 0.01 + max(fwx * cellWm, 0.01), distM);
        float gj = (1.0 - smoothstep(0.0, 0.03 + fwy * 1.3, abs(fy - 0.5))) * 0.5;
        float tone = 0.93 + 0.14 * gfxH21(vec2(colId, rowId * 0.5) + hb * 21.0);
        float board = 0.97 + 0.03 * step(0.5, fract(v / 0.12));
        diffuseColor.rgb = base * tone * board * (1.0 - 0.28 * pj * matFade - 0.12 * gj * matFade);
        wallRough = 0.92;
      } else if (mMetal && !glassy) {
        // standing seams every 0.4 m, bright and dark ribs
        float sx = u / 0.4;
        float sfm = 1.0 - smoothstep(0.25, 0.6, max(fwidth(sx), 1e-3));
        float rib = smoothstep(0.0, 0.12, fract(sx)) * (1.0 - smoothstep(0.88, 1.0, fract(sx)));
        diffuseColor.rgb = base * mix(1.0, 0.82 + 0.26 * rib, sfm) * (0.95 + 0.1 * gfxH21(vec2(floor(sx), hb * 7.0)));
        wallRough = 0.5;
      } else if (mWood && !glassy) {
        float cr = v / 0.14;
        float cf = 1.0 - smoothstep(0.2, 0.5, max(fwidth(cr), 1e-3));
        float shadow = smoothstep(0.0, 0.2, fract(cr)) ;
        diffuseColor.rgb = base * mix(1.0, 0.72 + 0.28 * shadow, cf) * (0.94 + 0.12 * gfxH21(vec2(floor(cr), hb * 3.0)));
        wallRough = 0.85;
      } else if (mStucco && !glassy) {
        diffuseColor.rgb = base * (0.93 + 0.14 * gfxVn(vec2(u * 3.1, v * 3.1)) * matFade + 0.0);
        wallRough = 0.96;
      }
    }
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
      float streak = store ? 0.0 : inX * smoothstep(0.0, rect.z, fy) * (1.0 - step(rect.z, fy)) * step(0.45, r) * (1.0 - ribbon);
      // a brutalist or deco spandrel is a deeper recess: the slab line is stronger
      float slabK = sBrutal ? 0.7 : 1.0;
      diffuseColor.rgb *= (1.0 + (stain - 0.5) * 0.34 * fade) * mix(1.0, mix(slabK, 1.0, slab), fade) * grime * canyon * (1.0 - 0.22 * streak * fade);
    #endif
    if (glassy) diffuseColor.rgb *= 0.55; // mullions and spandrels: darker than the flat grey of the bake

    // The surround of a window (stone lintel and sill, a painted frame) and a dark metal frame on the modern kinds.
    if (far < 0.95) {
      vec4 rs = vec4(rect.x - surr.x, rect.y + surr.x, rect.z - surr.y, rect.w + surr.y);
      float wxs = clamp(min(fx - rs.x, rs.y - fx) / fwx + 0.5, 0.0, 1.0);
      float wys = clamp(min(fy - rs.z, rs.w - fy) / fwy + 0.5, 0.0, 1.0);
      float covS = max(wxs * wys - wx * wy, 0.0) * step(0.001, surr.x + surr.y) * (1.0 - far) * edge;
      diffuseColor.rgb *= mix(1.0, surrTone, covS);
      if (!glassy && !store && ribbon < 0.5 && !(sVictor || sClassic)) {
        vec4 rf = vec4(rect.x - 0.035, rect.y + 0.035, rect.z - 0.03, rect.w + 0.03);
        float wxf = clamp(min(fx - rf.x, rf.y - fx) / fwx + 0.5, 0.0, 1.0);
        float wyf = clamp(min(fy - rf.z, rf.w - fy) / fwy + 0.5, 0.0, 1.0);
        float covF = max(wxf * wyf - wx * wy, 0.0) * (1.0 - far) * edge;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, covF * 0.8);
      }
    }
    // The ground band: its own material under a tower (dark granite, polished stone, concrete or a metal frame), a belt course above it.
    if (gH > 0.5) {
      float inBand = 1.0 - smoothstep(gH - 0.12, gH + 0.04, v);
      vec3 bt = bandMat > 3.5 && bandMat < 4.5 ? (sClassic || sDeco ? vec3(0.50, 0.46, 0.40) : vec3(0.16, 0.15, 0.15))
              : (bandMat > 2.5 && bandMat < 3.5 ? vec3(0.2, 0.2, 0.19) : (bandMat > 4.5 && bandMat < 5.5 ? vec3(0.07, 0.075, 0.085) : vec3(-1.0)));
      float btW = bt.x > 0.0 && abs(bandMat - matId) > 0.5 ? 0.72 : 0.0;
      diffuseColor.rgb = mix(diffuseColor.rgb, bt * (0.85 + 0.3 * gfxH21(vec2(colId, 3.0 + hb * 20.0))), btW * inBand);
      float belt = (1.0 - smoothstep(0.0, 0.12, abs(v - gH - 0.1))) * (trad || lobby ? 1.0 : 0.0);
      diffuseColor.rgb *= 1.0 + 0.3 * belt;
      if (lobby && store) wallRough = 0.5;
    }
    // The cornice of a traditional building: a light band at the top, the shade under it.
    if (trad && H > 8.0) {
      float corn = smoothstep(H - 0.95, H - 0.7, v);
      float under = smoothstep(H - 2.0, H - 1.0, v) * (1.0 - smoothstep(H - 1.0, H - 0.9, v));
      diffuseColor.rgb *= (1.0 + 0.2 * corn) * (1.0 - 0.14 * under);
    }
    // The crown of a tall building: no windows, a lighter panel with ribs, lit after dark.
    if (crownM > 0.5) {
      float rib = 0.9 + 0.1 * step(0.5, fract(u / 1.5));
      diffuseColor.rgb *= mix(1.0, 1.14 * rib, inCrown);
      float crownLight = inCrown * (0.6 + 0.4 * gfxVn(vec2(u * 0.3, v * 0.2))) * uNight;
      gfxEmit += vec3(1.0, 0.78, 0.5) * (0.28 * crownLight);
    }

    // The window: sky and street reflection, a little by day, plus the lit rooms at night.
    vec3 V = normalize(cameraPosition - vFW);
    vec3 nW = normalize(vWN);
    if (dot(nW, V) < 0.0) nW = -nW;
    vec3 R = reflect(-V, nW);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, R.y));
    vec3 ground = mix(uHorizon * 0.5, uGround, smoothstep(0.0, -0.4, R.y));
    vec3 refl = (R.y > 0.0 ? sky : ground) * vec3(0.9, 0.97, 0.92); // a greenish tint on the glass
    float F = 0.04 + 0.35 * pow(1.0 - max(dot(nW, V), 0.0), 5.0);
    // reflective 1970s glass mirrors the sky more; a 1990s tint less
    float refl0 = glassy ? (era > 2.5 && era < 3.5 ? 0.55 : 0.42) : 0.22;
    vec3 glass = refl * (refl0 + 0.9 * F) * mix(0.8, 1.2, r);
    // the tint of the glass is the building's own colour
    glass *= mix(vec3(1.0), clamp(wallHue, 0.45, 1.7), glassy ? 0.75 : 0.15);
    #ifndef GFX_LITE
      // Blinds and curtains: some windows are pale.
      float blind = step(0.93, r2) * (1.0 - uNight * 0.6);
      glass = mix(glass, vec3(0.45, 0.40, 0.33) * 0.6, blind * 0.7);
    #endif
    // An open garage has no glass: dark bays.
    if (parking) glass = vec3(0.012, 0.012, 0.014);

    // Rooms lit after dark. A floor tends to be lit as a whole (an office), so the odds depend on the row; a ribbon is lit in runs.
    float litMax = parking ? 0.12 : industrial ? 0.12 : (office || glassy) ? 0.6 : (resid || house) ? 0.45 : 0.5;
    float rowP = gfxH21(vec2(rowId * 3.1 + hb * 29.0, 9.0));
    float lit0 = store ? (retail ? 0.85 : lobby ? 0.9 : 0.7) : mix(0.04, litMax, rowP * rowP * (0.4 + 0.6 * gfxH21(vec2(hb * 5.3, 1.0))));
    float colLit = ribbon > 0.5 ? floor(colId / 2.0) : colId;
    float lit = step(gfxH21(vec2(colLit * 1.31 + hb * 57.0, rowId * 2.17 + hb * 13.1)), lit0) * uNight;
    vec3 warm = vec3(1.0, 0.70, 0.38); // tungsten
    vec3 cool = vec3(0.70, 0.90, 0.84); // fluorescent office tubes
    float coolMix = (glassy || office) ? 0.55 : civic ? 0.3 : (resid || house || brick) ? 0.0 : 0.15;
    vec3 lc = mix(warm, cool, step(0.72, r2) * 0.9 * (coolMix > 0.0 ? 1.0 : 0.0) + coolMix * 0.4);
    if (parking) lc = vec3(1.0, 0.55, 0.22) * 0.6;
    vec3 room = lc * (0.45 + 0.6 * r) * (store ? 0.42 : 1.0) * (lobby ? 1.8 : 1.0) * (0.6 + 0.4 * smoothstep(rect.z, rect.w, fy));
    vec3 winEmit = glass * (1.0 - lit) + room * lit;

    gfxEmit += winEmit * cov;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.024, 0.032), cov);
    // street-lamp light on the lower floors: sodium, strongest at the foot of the wall and gone by about 20 m
    float spill = exp(-v / 5.5) * (0.45 + 0.55 * gfxVn(vec2(u * 0.22, hb * 20.0)));
    gfxEmit += uSodium * diffuseColor.rgb * (uSpill * uNight * spill * 0.6);
    gfxRough = mix(wallRough, 0.24, cov);
  }
}
`;

const FACADE_CACHE = 'look-facade-v4';

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
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vFW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);\n  vUvW = uv;\n  vWall = gWall;\n  vBld = gBld;\n  vBid = gBid;\n  vLook = gLook;`);
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
