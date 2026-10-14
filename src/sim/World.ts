/**
 * The Rapier world and its static geometry: the heightfield and the collision trimesh of a tile.
 */
import { SIM_DT } from '../shared/protocol';
import { heightAt, type TileData } from '../shared/tile';
import { GROUPS, type Rapier } from './physics/rapier';
import type RAPIER from '@dimforge/rapier3d-simd-compat';

export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** Lowest terrain sample. */
  readonly minHeight: number;

  constructor(
    readonly R: Rapier,
    readonly tile: TileData,
  ) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SIM_DT;
    let lo = Infinity;
    for (const h of tile.heights) if (h < lo) lo = h;
    this.minHeight = lo;
    this.addHeightfield();
    this.addCollisionMesh();
    // Build the query structures before anything casts a ray.
    this.world.step();
  }

  /**
   * Rapier stores a heightfield column-major with rows along Z and columns along X, centred on its
   * origin, so the tile's row-major samples are transposed and the collider is moved to the tile's centre.
   */
  private addHeightfield() {
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
    this.world.createCollider(desc);
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
}
