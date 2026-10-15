/**
 * The Rapier world and its static geometry: the heightfield and the collision trimesh of a tile, the
 * street furniture (signal poles, benches, bus stops: `shared/props.ts`), and the questions about
 * where a person can stand.
 */
import { FootprintIndex } from '../shared/footprints';
import { SIM_DT } from '../shared/protocol';
import { collectProps, worldSolids, type PropInstance, type WorldBox } from '../shared/props';
import { heightAt, type TileData } from '../shared/tile';
import { PED } from './character/locomotion';
import { GROUPS, type Rapier } from './physics/rapier';
import type RAPIER from '@dimforge/rapier3d-simd-compat';

/** What a spot must be clear of for a person to be put there. */
export interface SpotOptions {
  /** Count the street furniture as solid (default true). Someone sitting on a bench stands inside one. */
  props?: boolean;
  /** Count cars as solid too (default false: the static world only). */
  vehicles?: boolean;
  /** Leave this body out (the car someone is getting out of). */
  ignoreBody?: RAPIER.RigidBody;
  /** Radius of the capsule tested, m (default a little under a person's). */
  radius?: number;
}

/**
 * The capsule tested for overlap is a little slimmer and shorter than a person and starts above the ground, so standing on a
 * kerb or a deck, or under a low bridge a person just fits beneath, is not an overlap.
 */
const TEST = { radius: PED.radius - 0.05, halfHeight: 0.38, lift: 0.15 } as const;
/** The capsule swept along a path to see whether people can walk it: a little over a person's height, so only a way they fit is open. */
const SWEEP = { radius: PED.radius - 0.02, halfHeight: 0.5, lift: 0.12 } as const;

export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** Lowest terrain sample. */
  readonly minHeight: number;
  /** The heightfield: left out of the tests that ask about walls and furniture. */
  readonly terrain: RAPIER.Collider;
  /** The footprints of the buildings (empty when the tile does not say which triangles are buildings). */
  readonly footprints: FootprintIndex;
  /** The street furniture made solid. */
  readonly props: readonly PropInstance[];
  private readonly testShapes = new Map<number, RAPIER.Capsule>();
  /** The solid boxes of the props by 8 m grid cell, for the cheap move's clearance. */
  private readonly propCells = new Map<number, WorldBox[]>();

  constructor(
    readonly R: Rapier,
    readonly tile: TileData,
  ) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SIM_DT;
    let lo = Infinity;
    for (const h of tile.heights) if (h < lo) lo = h;
    this.minHeight = lo;
    this.terrain = this.addHeightfield();
    this.addCollisionMesh();
    const bt = tile.manifest.collision.buildingTriangles;
    this.footprints = new FootprintIndex(tile.collisionPositions, tile.collisionIndices, bt ?? 0);
    this.props = collectProps(tile.lanes?.junctions, tile.scenarios?.points);
    this.addProps();
    // Build the query structures before anything casts a ray.
    this.world.step();
  }

  /**
   * Rapier stores a heightfield column-major with rows along Z and columns along X, centred on its
   * origin, so the tile's row-major samples are transposed and the collider is moved to the tile's centre.
   */
  private addHeightfield(): RAPIER.Collider {
    const { cols, rows, cellSize, minX, minZ } = this.tile.manifest.heightmap;
    const src = this.tile.heights;
    const cm = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cm[c * rows + r] = src[r * cols + c];
    const width = (cols - 1) * cellSize;
    const depth = (rows - 1) * cellSize;
    const desc = this.R.ColliderDesc.heightfield(rows - 1, cols - 1, cm, { x: width, y: 1, z: depth })
      .setTranslation(minX + width / 2, 0, minZ + depth / 2)
      .setFriction(0.9)
      .setCollisionGroups(GROUPS.world);
    return this.world.createCollider(desc);
  }

  /** Street furniture: one fixed box collider for each solid box of each prop, exactly the boxes the client draws. */
  private addProps() {
    const R = this.R;
    for (const prop of this.props) {
      for (const b of worldSolids(prop)) {
        // by the cells its bounding circle touches
        const reach = Math.hypot(b.hx, b.hz);
        for (let cx = Math.floor((b.cx - reach) / 8); cx <= Math.floor((b.cx + reach) / 8); cx++) {
          for (let cz = Math.floor((b.cz - reach) / 8); cz <= Math.floor((b.cz + reach) / 8); cz++) {
            const k = cx * 65536 + cz;
            const list = this.propCells.get(k);
            if (list) list.push(b);
            else this.propCells.set(k, [b]);
          }
        }
        const half = b.yaw / 2;
        this.world.createCollider(
          R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
            .setTranslation(b.cx, b.cy, b.cz)
            .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
            .setFriction(0.5)
            .setCollisionGroups(GROUPS.prop),
        );
      }
    }
  }

  private addCollisionMesh() {
    const { collisionPositions, collisionIndices } = this.tile;
    if (collisionIndices.length === 0) return;
    const desc = this.R.ColliderDesc.trimesh(collisionPositions, collisionIndices)
      .setFriction(0.5)
      .setCollisionGroups(GROUPS.world);
    this.world.createCollider(desc);
  }

  /** Terrain height under (x, z) from the heightmap; buildings are not considered. */
  groundHeight(x: number, z: number): number {
    return heightAt(this.tile, x, z);
  }

  /** Distance to the nearest wall within a metre (Infinity if none), negative inside a building: what a gliding person checks. */
  readonly wallClearance = (x: number, z: number, y: number): number => {
    const roof = this.footprints.roofAbove(x, z, y);
    if (!Number.isNaN(roof)) return -1;
    let d = this.footprints.nearestWall(x, z, 1, undefined, y);
    const boxes = this.propCells.get(Math.floor(x / 8) * 65536 + Math.floor(z / 8));
    if (boxes) {
      for (const b of boxes) {
        // only what a person's body meets: not an arm over the road
        if (b.cy - b.hy > y + 1.7 || b.cy + b.hy < y + 0.15) continue;
        const dx = x - b.cx, dz = z - b.cz;
        const s = Math.sin(b.yaw), c = Math.cos(b.yaw);
        // into the box's frame (its local x is (cos, -sin) in (x, z), its local z is (sin, cos))
        const lx = Math.abs(dx * c - dz * s) - b.hx, lz = Math.abs(dx * s + dz * c) - b.hz;
        const out = Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
        if (out < d) d = out;
      }
    }
    return d;
  };

  private shape(radius: number, halfHeight: number = TEST.halfHeight): RAPIER.Capsule {
    const key = Math.round(radius * 1000) * 1000 + Math.round(halfHeight * 1000);
    let c = this.testShapes.get(key);
    if (!c) this.testShapes.set(key, (c = new this.R.Capsule(halfHeight, radius)));
    return c;
  }

  /**
   * Whether a person standing with their feet at (x, y, z) would overlap a wall, a deck, a prop (or a car, if asked),
   * not counting the ground itself.
   */
  overlapsStatic(x: number, y: number, z: number, o: SpotOptions = {}): boolean {
    return this.overlapping(x, y, z, o) !== null;
  }

  /** The solid a person standing at (x, y, z) would overlap, or null (see `overlapsStatic`). */
  overlapping(x: number, y: number, z: number, o: SpotOptions = {}): RAPIER.Collider | null {
    const groups = o.vehicles ? GROUPS.actorQuery : o.props === false ? GROUPS.wallQuery : GROUPS.staticQuery;
    const r = o.radius ?? TEST.radius;
    const hit = this.world.intersectionWithShape(
      { x, y: y + TEST.lift + r + TEST.halfHeight, z },
      { x: 0, y: 0, z: 0, w: 1 },
      this.shape(r),
      undefined,
      groups,
      this.terrain,
      o.ignoreBody,
    );
    return hit;
  }

  /** Whether a person cannot be at (x, y, z): inside a building, or overlapping something solid. */
  blockedAt(x: number, y: number, z: number, o: SpotOptions = {}): boolean {
    return this.footprints.inside(x, y, z) || this.overlapsStatic(x, y, z, o);
  }

  /**
   * Whether a person can walk the straight line from a to b (feet heights `ay`, `by`) without touching a wall, a deck or a
   * prop: a capsule swept along it, with the ground left out.
   */
  sweepClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number = SWEEP.radius): boolean {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    // a slope is swept in pieces, each at its own height, so the capsule follows the path up or down
    const n = Math.max(1, Math.ceil(Math.abs(by - ay) / 0.25), Math.ceil(len / 6));
    const shape = this.shape(radius, SWEEP.halfHeight);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const y0 = ay + (by - ay) * t0, y1 = ay + (by - ay) * t1;
      const hit = this.world.castShape(
        { x: ax + dx * t0, y: (y0 + y1) / 2 + SWEEP.lift + radius + SWEEP.halfHeight, z: az + dz * t0 },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: dx / len, y: 0, z: dz / len },
        shape,
        0,
        len / n,
        true,
        undefined,
        GROUPS.staticQuery,
        this.terrain,
      );
      if (hit) return false;
    }
    return true;
  }

  /** The height of the first floor (ground, deck) below `fromY` within `maxDrop`, or NaN. */
  floorBelow(x: number, fromY: number, z: number, maxDrop = 3): number {
    const hit = this.world.castRay(new this.R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), maxDrop, true, undefined, GROUPS.cameraQuery);
    return hit ? fromY - hit.timeOfImpact : NaN;
  }

  /**
   * The nearest place to (x, y, z) where a person can stand: not in a building, clear of solids, with a floor within a metre
   * of `y`, found on rings of growing radius. Null when there is none within `maxR`. (`y` is the feet.)
   */
  clearSpot(x: number, y: number, z: number, maxR = 4, o: SpotOptions = {}): { x: number; y: number; z: number } | null {
    const tryAt = (cx: number, cz: number) => {
      const fy = this.floorBelow(cx, y + 1.0, cz, 2.2);
      if (Number.isNaN(fy) || Math.abs(fy - y) > 1.2) return null;
      return this.blockedAt(cx, fy, cz, o) ? null : { x: cx, y: fy + 0.02, z: cz };
    };
    const first = tryAt(x, z);
    if (first) return first;
    for (let r = 0.4; r <= maxR + 1e-6; r += 0.4) {
      const n = Math.max(8, Math.round((r * 2 * Math.PI) / 0.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r;
        const hit = tryAt(x + Math.sin(a) * r, z + Math.cos(a) * r);
        if (hit) return hit;
      }
    }
    return null;
  }
}
