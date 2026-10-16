/**
 * The static physics of a streamed city (docs/contracts/city-tiles.md sections 4 and 5): each loaded tile's heightfield, building
 * and deck trimeshes and street furniture, made solid a piece at a time by jobs the streamer runs a few per tick, and removed when
 * the tile drops; the car-ground window (one heightfield with the internal edges fixed, cut from the loaded tiles round the player,
 * that cars' hulls meet instead of the tiles' own); and the ground height and footprints by tile.
 *
 * Every trimesh is built from vertices relative to its tile's centre and placed with a translation, so a mesh far from the origin
 * keeps tile-local precision (section 7).
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { collectProps, worldSolids, type PropInstance, type WorldBox } from '../../shared/props';
import { heightAt, type TileData } from '../../shared/tile';
import { GROUPS } from '../physics/rapier';
import type { PhysicsWorld } from '../World';
import { FootprintSet } from './FootprintSet';

/** A piece of work the streamer runs in a tick. `cost` is in work units (about a microsecond each on the dev box), counted, not timed. */
export interface StreamJob {
  name: string;
  cost: number;
  /** Runs the job; returns false when it is not finished (it is run again next time with the rest of its budget). */
  run(budget: number): boolean;
}

/** Most triangles in one trimesh piece (a building slice with its footprints: about 4 ms on the dev box). */
export const PIECE_TRIANGLES = 1024;
/** Prop cells (40 m) made solid per job. */
const PROP_CELLS_PER_JOB = 24;
const MERGED = new Set<string>(['lamp', 'tree', 'hydrant', 'bin', 'bollard']);
const MERGE_CELL = 40;
/**
 * Work units (calibrated to about a microsecond each on the dev box with tests/stream/cost.test.ts): per triangle of a trimesh (plain,
 * with the internal edges fixed), per heightfield sample, per prop box, per footprint triangle, per car-ground sample.
 */
export const COST = { tri: 1.2, triFixed: 1.4, sample: 0.012, box: 7, footprintTri: 3, carGroundSample: 0.08 } as const;

/** The car-ground window: its side (m), and how far the player may get from its centre before it is cut again. */
export const CAR_GROUND = { size: 1024, recentre: 192, snap: 64 } as const;

interface PTile {
  key: string;
  tile: TileData;
  /** cell bounds */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  terrain: RAPIER.Collider | null;
  colliders: RAPIER.Collider[];
  boxes: Set<WorldBox>;
  propKeys: number[];
  props: PropInstance[];
  minHeight: number;
}

export class StreamPhysics {
  readonly tiles = new Map<string, PTile>();
  readonly footprints: FootprintSet;
  private readonly terrainHandles = new Set<number>();
  private carGround: RAPIER.Collider | null = null;
  /** Where the car-ground window is centred (NaN: none yet), and whether a tile under it changed. */
  carGroundAt = { x: NaN, z: NaN };
  carGroundDirty = false;
  /** Bumped whenever a tile's ground comes or goes (a window built across a change is cut again). */
  private groundGen = 0;
  /** Counters for tests and the report. */
  readonly stats = { colliders: 0, pieces: 0, carGroundBuilds: 0 };

  constructor(
    readonly pw: PhysicsWorld,
    readonly tileSize: number,
  ) {
    if (!(pw.footprints instanceof FootprintSet)) throw new Error('StreamPhysics: build the PhysicsWorld with { stream: true, footprints: new FootprintSet() }');
    this.footprints = pw.footprints;
    pw.heightSource = (x, z) => this.groundHeight(x, z);
    pw.notTerrain = (c) => !this.terrainHandles.has(c.handle);
  }

  private get R() {
    return this.pw.R;
  }

  private get world() {
    return this.pw.world;
  }

  /** The tile whose cell holds (x, z) (a point on a seam: either), or null. */
  tileAt(x: number, z: number): PTile | null {
    for (const t of this.tiles.values()) if (x >= t.minX && x <= t.maxX && z >= t.minZ && z <= t.maxZ && t.terrain) return t;
    return null;
  }

  /** Ground height under (x, z): the tile there, else the nearest loaded tile's edge (clamped), else 0. */
  groundHeight(x: number, z: number): number {
    const t = this.tileAt(x, z);
    if (t) return heightAt(t.tile, x, z);
    let best: PTile | null = null;
    let bd = Infinity;
    for (const u of this.tiles.values()) {
      if (!u.terrain) continue;
      const d = Math.hypot(Math.max(u.minX - x, 0, x - u.maxX), Math.max(u.minZ - z, 0, z - u.maxZ));
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best ? heightAt(best.tile, x, z) : 0;
  }

  /** Whether a loaded (solid) tile covers (x, z). */
  solidAt(x: number, z: number): boolean {
    return this.tileAt(x, z) !== null;
  }

  private add(t: PTile, c: RAPIER.Collider) {
    t.colliders.push(c);
    this.stats.colliders++;
  }

  /** The jobs that make a tile solid, in order. Nothing of it is solid until its jobs have run. */
  plan(key: string, tile: TileData): StreamJob[] {
    if (this.tiles.has(key)) throw new Error(`stream physics: tile ${key} is already loaded`);
    const b = tile.manifest.bounds;
    const t: PTile = { key, tile, minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, terrain: null, colliders: [], boxes: new Set(), propKeys: [], props: [], minHeight: Infinity };
    this.tiles.set(key, t);
    const jobs: StreamJob[] = [];
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const hm = tile.manifest.heightmap;
    // 1. the ground (people, rays, wheels: the plain copy; hulls meet the car-ground window)
    jobs.push({
      name: `${key}:ground`,
      cost: hm.cols * hm.rows * COST.sample,
      run: () => {
        const { cols, rows, cellSize, minX, minZ } = hm;
        const src = tile.heights;
        const cm = new Float32Array(rows * cols);
        let lo = Infinity;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const v = src[r * cols + c];
          cm[c * rows + r] = v;
          if (v < lo) lo = v;
        }
        const width = (cols - 1) * cellSize, depth = (rows - 1) * cellSize;
        const col = this.world.createCollider(
          this.R.ColliderDesc.heightfield(rows - 1, cols - 1, cm, { x: width, y: 1, z: depth }).setTranslation(minX + width / 2, 0, minZ + depth / 2).setFriction(0.9).setCollisionGroups(GROUPS.worldNoCars),
        );
        t.terrain = col;
        t.minHeight = lo;
        this.terrainHandles.add(col.handle);
        this.add(t, col);
        this.updateMinHeight();
        this.carGroundDirty = true;
        this.groundGen++;
        return true;
      },
    });
    // 2. buildings: slices at building boundaries (a building is its walls, then its flat roof), with their footprints
    const P = tile.collisionPositions, I = tile.collisionIndices;
    const nTri = I.length / 3;
    const bt = Math.min(tile.manifest.collision.buildingTriangles ?? nTri, nTri);
    const flat = (tri: number) => {
      const a = I[tri * 3] * 3 + 1, b2 = I[tri * 3 + 1] * 3 + 1, c = I[tri * 3 + 2] * 3 + 1;
      return Math.abs(P[a] - P[b2]) < 1e-3 && Math.abs(P[b2] - P[c]) < 1e-3;
    };
    const slices: [number, number][] = [];
    let s0 = 0;
    for (let tri = 1; tri <= bt; tri++) {
      // a boundary: after a roof triangle comes a wall
      const boundary = tri === bt || (flat(tri - 1) && !flat(tri));
      if (boundary && (tri - s0 >= PIECE_TRIANGLES || tri === bt)) {
        slices.push([s0, tri]);
        s0 = tri;
      }
    }
    for (const [from, to] of slices) {
      jobs.push({
        name: `${key}:buildings:${from}`,
        cost: (to - from) * (COST.tri + COST.footprintTri),
        run: () => {
          const idx = I.subarray(from * 3, to * 3);
          this.add(t, this.trimesh(P, idx, cx, cz, undefined, GROUPS.world));
          if (tile.manifest.collision.buildingTriangles !== undefined) this.footprints.add(key, P, idx, to - from);
          this.stats.pieces++;
          return true;
        },
      });
    }
    // 3. decks and piers: whole connected structures packed into pieces (no internal edge is cut), twice (plain, and for hulls)
    if (nTri > bt) {
      for (const piece of deckPieces(I, bt, nTri)) {
        jobs.push({
          name: `${key}:decks:${piece[0]}`,
          cost: piece.length * (COST.tri + COST.triFixed),
          run: () => {
            const idx = new Uint32Array(piece.length * 3);
            piece.forEach((tri, k) => idx.set(I.subarray(tri * 3, tri * 3 + 3), k * 3));
            this.add(t, this.trimesh(P, idx, cx, cz, undefined, GROUPS.worldNoCars));
            this.add(t, this.trimesh(P, idx, cx, cz, this.R.TriMeshFlags.FIX_INTERNAL_EDGES, GROUPS.carGround));
            this.stats.pieces++;
            return true;
          },
        });
      }
    }
    // 4. street furniture, lamp poles and trunks: compound colliders per 40 m cell of the tile's own
    const props = collectProps(tile.lanes?.junctions, tile.scenarios?.points, tile.anchors);
    t.props = props;
    const cells = new Map<number, { shapes: RAPIER.Shape[]; at: RAPIER.Vector[]; rot: RAPIER.Rotation[] }>();
    const singles: WorldBox[] = [];
    const R = this.R;
    let boxes = 0;
    for (const prop of props) {
      for (const bx of worldSolids(prop)) {
        boxes++;
        t.boxes.add(bx);
        if (!MERGED.has(prop.kind)) {
          singles.push(bx);
          continue;
        }
        const k = Math.floor(bx.cx / MERGE_CELL) * 65536 + Math.floor(bx.cz / MERGE_CELL);
        let c = cells.get(k);
        if (!c) cells.set(k, (c = { shapes: [], at: [], rot: [] }));
        const half = bx.yaw / 2;
        c.shapes.push(new R.Cuboid(bx.hx, bx.hy, bx.hz));
        c.at.push({ x: bx.cx, y: bx.cy, z: bx.cz });
        c.rot.push({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
      }
    }
    const cellList = [...cells.values()];
    const perBox = boxes > 0 ? boxes / Math.max(1, cellList.length + singles.length) : 0;
    for (let i = 0; i < cellList.length; i += PROP_CELLS_PER_JOB) {
      const part = cellList.slice(i, i + PROP_CELLS_PER_JOB);
      jobs.push({
        name: `${key}:props:${i}`,
        cost: part.reduce((a, c) => a + c.shapes.length, 0) * COST.box,
        run: () => {
          for (const c of part) this.add(t, this.world.createCollider(R.ColliderDesc.compound(c.shapes, c.at, c.rot).setFriction(0.5).setCollisionGroups(GROUPS.prop)));
          return true;
        },
      });
    }
    jobs.push({
      name: `${key}:props:singles`,
      cost: singles.length * COST.box + boxes * 0.2 + perBox,
      run: () => {
        for (const bx of singles) {
          const half = bx.yaw / 2;
          this.add(t, this.world.createCollider(R.ColliderDesc.cuboid(bx.hx, bx.hy, bx.hz).setTranslation(bx.cx, bx.cy, bx.cz).setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }).setFriction(0.5).setCollisionGroups(GROUPS.prop)));
        }
        // the people's cheap clearance check, and the world's list
        for (const bx of t.boxes) {
          const reach = Math.hypot(bx.hx, bx.hz);
          for (let gx = Math.floor((bx.cx - reach) / 8); gx <= Math.floor((bx.cx + reach) / 8); gx++) {
            for (let gz = Math.floor((bx.cz - reach) / 8); gz <= Math.floor((bx.cz + reach) / 8); gz++) {
              const k = gx * 65536 + gz;
              const list = this.pw.propCells.get(k);
              if (list) list.push(bx);
              else this.pw.propCells.set(k, [bx]);
              t.propKeys.push(k);
            }
          }
        }
        for (const p of props) this.pw.props.push(p);
        return true;
      },
    });
    return jobs;
  }

  /** A trimesh from a set of triangles of the collision mesh, with its own compact vertices relative to (cx, cz). */
  private trimesh(P: Float32Array, idx: Uint32Array, cx: number, cz: number, flags: RAPIER.TriMeshFlags | undefined, groups: number): RAPIER.Collider {
    const remap = new Map<number, number>();
    const local = new Uint32Array(idx.length);
    const verts: number[] = [];
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      let k = remap.get(v);
      if (k === undefined) {
        k = verts.length / 3;
        remap.set(v, k);
        verts.push(P[v * 3] - cx, P[v * 3 + 1], P[v * 3 + 2] - cz);
      }
      local[i] = k;
    }
    const desc = this.R.ColliderDesc.trimesh(new Float32Array(verts), local, flags).setTranslation(cx, 0, cz).setFriction(0.5).setCollisionGroups(groups);
    const c = this.world.createCollider(desc);
    this.pw.staticMeshes.push({ collider: c, firstTriangle: -1, forCars: groups === GROUPS.carGround || groups === GROUPS.world });
    return c;
  }

  /** Takes a tile's colliders out of the world (all at once: removing is cheap). */
  remove(key: string): number {
    const t = this.tiles.get(key);
    if (!t) return 0;
    this.tiles.delete(key);
    const gone = new Set(t.colliders.map((c) => c.handle));
    for (const c of t.colliders) this.world.removeCollider(c, false);
    this.stats.colliders -= t.colliders.length;
    if (t.terrain) this.terrainHandles.delete(t.terrain.handle);
    for (let i = this.pw.staticMeshes.length - 1; i >= 0; i--) if (gone.has(this.pw.staticMeshes[i].collider.handle)) this.pw.staticMeshes.splice(i, 1);
    this.footprints.remove(key);
    for (const k of new Set(t.propKeys)) {
      const list = this.pw.propCells.get(k);
      if (!list) continue;
      const kept = list.filter((b) => !t.boxes.has(b));
      if (kept.length) this.pw.propCells.set(k, kept);
      else this.pw.propCells.delete(k);
    }
    const props = new Set(t.props);
    for (let i = this.pw.props.length - 1; i >= 0; i--) if (props.has(this.pw.props[i])) this.pw.props.splice(i, 1);
    this.updateMinHeight();
    this.carGroundDirty = true;
    this.groundGen++;
    return t.colliders.length;
  }

  private updateMinHeight() {
    let lo = Infinity;
    for (const t of this.tiles.values()) if (t.minHeight < lo) lo = t.minHeight;
    this.pw.minHeight = Number.isFinite(lo) ? lo : 0;
  }

  /** The finest heightmap cell of the loaded tiles (4 m in M1, 2 m when the bake moves to it), which the window samples at. */
  cellSize(): number {
    let c = Infinity;
    for (const t of this.tiles.values()) c = Math.min(c, t.tile.manifest.heightmap.cellSize);
    return Number.isFinite(c) ? c : 4;
  }

  /** Whether the car-ground window should be cut again for a player at (x, z). */
  carGroundStale(x: number, z: number): boolean {
    if (this.carGroundDirty) return true;
    if (Number.isNaN(this.carGroundAt.x)) return this.tiles.size > 0;
    return Math.max(Math.abs(x - this.carGroundAt.x), Math.abs(z - this.carGroundAt.z)) > CAR_GROUND.recentre;
  }

  /**
   * The job that cuts the car-ground window round (x, z) from the loaded tiles' samples and swaps it in: the samples a few columns
   * a run (resumable: at 2 m the window is 513 x 513 samples), then the collider swap at once. The old window stays until then.
   */
  carGroundJob(x: number, z: number): StreamJob {
    const b = this.carGroundBuild(x, z);
    return {
      name: 'car-ground',
      cost: b.n * b.n * COST.carGroundSample,
      run: (budget) => b.step(Number.isFinite(budget) ? Math.max(1, Math.floor(budget / (b.n * COST.carGroundSample))) : Infinity),
    };
  }

  /** Builds the window at once (the first one, and tests). */
  buildCarGround(x: number, z: number) {
    this.carGroundBuild(x, z).step(Infinity);
  }

  /** The window round (x, z) as a build that samples `cols` columns a step and swaps the collider in on the last. */
  private carGroundBuild(x: number, z: number): { n: number; step(cols: number): boolean } {
    const cell = this.cellSize();
    const snap = CAR_GROUND.snap;
    const cx = Math.round(x / snap) * snap, cz = Math.round(z / snap) * snap;
    const size = CAR_GROUND.size;
    const n = size / cell + 1;
    const minX = cx - size / 2, minZ = cz - size / 2;
    // column-major for Rapier (rows along z): cm[c * n + r]
    const cm = new Float32Array(n * n);
    let c = 0;
    let any = false;
    const gen = this.groundGen;
    return {
      n,
      step: (cols: number) => {
        const low = this.pw.minHeight - 80;
        for (let k = 0; k < cols && c < n; k++, c++) {
          const sx = minX + c * cell;
          for (let r = 0; r < n; r++) {
            const sz = minZ + r * cell;
            const t = this.tileAt(sx, sz);
            if (t) any = true;
            cm[c * n + r] = t ? sampleAt(t.tile, sx, sz) : low;
          }
        }
        if (c < n) return false;
        if (this.carGround) {
          this.world.removeCollider(this.carGround, false);
          this.carGround = null;
        }
        this.carGroundAt = { x: cx, z: cz };
        this.carGroundDirty = gen !== this.groundGen;
        if (!any) return true;
        this.carGround = this.world.createCollider(
          this.R.ColliderDesc.heightfield(n - 1, n - 1, cm, { x: size, y: 1, z: size }, this.R.HeightFieldFlags.FIX_INTERNAL_EDGES).setTranslation(cx, 0, cz).setFriction(0.9).setCollisionGroups(GROUPS.carGround),
        );
        this.stats.carGroundBuilds++;
        return true;
      },
    };
  }

  /** The car-ground window's collider (tests). */
  get carGroundCollider(): RAPIER.Collider | null {
    return this.carGround;
  }
}

/** The heightmap sample of a tile at a vertex position (exact: a seam vertex has the same value in both tiles). */
function sampleAt(tile: TileData, x: number, z: number): number {
  const { cols, rows, cellSize, minX, minZ } = tile.manifest.heightmap;
  const c = Math.round((x - minX) / cellSize), r = Math.round((z - minZ) / cellSize);
  if (c < 0 || r < 0 || c >= cols || r >= rows || Math.abs(minX + c * cellSize - x) > 1e-3 || Math.abs(minZ + r * cellSize - z) > 1e-3) return heightAt(tile, x, z);
  return tile.heights[r * cols + c];
}

/**
 * The deck and pier triangles (`bt .. nTri - 1`) grouped into connected structures (triangles that share a vertex), packed whole
 * into pieces of at most `PIECE_TRIANGLES` (a bigger structure is a piece of its own), in a deterministic order.
 */
export function deckPieces(I: Uint32Array, bt: number, nTri: number): number[][] {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let p = parent.get(v) ?? v;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    let q = v;
    while (q !== p) {
      const next = parent.get(q) ?? q;
      parent.set(q, p);
      q = next;
    }
    return p;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (let t = bt; t < nTri; t++) {
    union(I[t * 3], I[t * 3 + 1]);
    union(I[t * 3], I[t * 3 + 2]);
  }
  const comps = new Map<number, number[]>();
  for (let t = bt; t < nTri; t++) {
    const r = find(I[t * 3]);
    const l = comps.get(r);
    if (l) l.push(t);
    else comps.set(r, [t]);
  }
  const pieces: number[][] = [];
  let cur: number[] = [];
  for (const tris of comps.values()) {
    if (cur.length + tris.length > PIECE_TRIANGLES && cur.length) {
      pieces.push(cur);
      cur = [];
    }
    for (const t of tris) cur.push(t);
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}
