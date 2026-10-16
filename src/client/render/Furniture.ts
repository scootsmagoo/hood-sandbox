/**
 * Hydrants, waste bins and bollards: the small furniture of `props.json` (OSM nodes only: 8, 11 and
 * 100 in the tile), built by tools/blender/props/furniture.py and drawn as three instanced meshes,
 * refilled with the ones near the camera when it has moved (nothing is drawn beyond 110 m x
 * `lodScale`: they are too small to see). The sim makes them solid from the same sizes
 * (`HYDRANT`, `BIN`, `BOLLARD` in shared/props.ts).
 *
 * Street lamps are not here: lamps.ts draws them (it also owns their glow and light pools).
 */
import * as THREE from 'three';
import type { PropsData } from '../../shared/tile';
import type { Game, System } from '../Game';
import { addSodium } from './look/sodium';
import type { PropAssets } from './propAssets';

const RANGE = 110;
const CAP = 64;

interface Kind {
  geo: THREE.BufferGeometry;
  at: [number, number, number][];
  mesh: THREE.InstancedMesh;
}

export class Furniture implements System {
  readonly name = 'furniture';
  readonly priority = 171;
  readonly group = new THREE.Group();
  private readonly kinds: Kind[] = [];
  private readonly mat: THREE.MeshLambertMaterial;
  private readonly lastCam = new THREE.Vector3(1e9, 0, 1e9);
  private cool = 0;
  private level: 0 | 1 | 2 = 2;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly game: Game,
    anchors: PropsData,
    assets: PropAssets,
  ) {
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mat.customProgramCacheKey = () => 'furniture';
    this.mat.onBeforeCompile = (shader) => addSodium(shader);
    const defs: [THREE.BufferGeometry, [number, number, number][]][] = [
      [assets.furniture.hydrant, anchors.hydrants],
      [assets.furniture.bin, anchors.bins],
      [assets.furniture.bollard, anchors.bollards],
    ];
    this.group.name = 'furniture';
    for (const [g, at] of defs) {
      if (!at.length) continue;
      const geo = g.clone();
      const mesh = new THREE.InstancedMesh(geo, this.mat, Math.min(CAP, at.length));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.kinds.push({ geo, at, mesh });
    }
    game.scene.add(this.group);
  }

  setLevel(level: 0 | 1 | 2): void {
    this.level = level;
    this.group.visible = level > 0;
    this.lastCam.set(1e9, 0, 1e9);
  }

  update(dt: number): void {
    if (this.level === 0) return;
    this.cool -= dt;
    const cam = this.game.camera.position;
    if ((cam.x - this.lastCam.x) ** 2 + (cam.z - this.lastCam.z) ** 2 < 25 || this.cool > 0) return;
    this.cool = 0.5;
    this.lastCam.copy(cam);
    const r2 = (RANGE * this.game.tier.lodScale) ** 2;
    for (const k of this.kinds) {
      let n = 0;
      for (const [x, y, z] of k.at) {
        if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > r2 || n >= k.mesh.instanceMatrix.count) continue;
        this.q.setFromAxisAngle(this.up, ((x * 7.31 + z * 3.17) % 6.283) as number);
        this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1));
        k.mesh.setMatrixAt(n++, this.m);
      }
      k.mesh.count = n;
      k.mesh.visible = n > 0;
      k.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const k of this.kinds) {
      k.mesh.dispose();
      k.geo.dispose();
    }
    this.mat.dispose();
  }
}
