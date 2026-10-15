/**
 * The furniture of scenario points: benches and bus stop signs, so the people who sit and wait have
 * something to sit and wait at. Each is one instanced mesh for the whole tile (two draw calls).
 * `scenarios.json` is the sim's own file; the client reads it again here for the positions only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseScenarios, type ScenarioPoint } from '../../shared/walk';
import type { System } from '../Game';

const part = (w: number, h: number, d: number, x: number, y: number, z: number, rgb: number): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
  const c = new THREE.Color(rgb);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
};

/** A park bench facing +Z: slatted seat and back on two iron ends. Seat height 0.45 m. */
export function benchGeometry(): THREE.BufferGeometry {
  const wood = 0x7a5a3a, iron = 0x2a2c30;
  return mergeGeometries([
    part(1.7, 0.06, 0.46, 0, 0.45, 0, wood),
    part(1.7, 0.36, 0.05, 0, 0.74, -0.2, wood),
    part(0.06, 0.45, 0.46, -0.78, 0.22, 0, iron),
    part(0.06, 0.45, 0.46, 0.78, 0.22, 0, iron),
  ])!;
}

/** A bus stop: a pole with a blue sign, and a bench under a small roof beside it. Local +Z is toward the road. */
export function busStopGeometry(): THREE.BufferGeometry {
  const iron = 0x30343a;
  return mergeGeometries([
    part(0.07, 2.5, 0.07, 0, 1.25, 1.4, iron),
    part(0.55, 0.4, 0.04, 0, 2.2, 1.4, 0x1f4f9a),
    part(0.5, 0.12, 0.05, 0, 2.2, 1.425, 0xf0f0f0),
    part(2.0, 0.06, 0.8, 0, 2.3, -0.4, 0x3b4048),
    part(0.06, 2.3, 0.06, -0.95, 1.15, -0.7, iron),
    part(0.06, 2.3, 0.06, 0.95, 1.15, -0.7, iron),
    part(1.9, 1.5, 0.03, 0, 1.3, -0.74, 0x9fb3c2),
    part(1.5, 0.05, 0.4, 0, 0.45, -0.4, 0x6b6f76),
  ])!;
}

export class ScenarioProps implements System {
  readonly name = 'scenarioProps';
  readonly priority = 90;
  private readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ roughness: 0.75, vertexColors: true });

  constructor(scene: THREE.Scene, points: readonly ScenarioPoint[]) {
    this.group.name = 'scenario-props';
    const make = (geo: THREE.BufferGeometry, pts: ScenarioPoint[], offset: (p: ScenarioPoint) => [number, number]) => {
      if (!pts.length) return;
      this.geos.push(geo);
      const m = new THREE.InstancedMesh(geo, this.mat, pts.length);
      const mat = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      pts.forEach((p, i) => {
        const [dx, dz] = offset(p);
        mat.compose(new THREE.Vector3(p.x + dx, p.y - 0.05, p.z + dz), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(1, 1, 1));
        m.setMatrixAt(i, mat);
      });
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    };
    // A bench stands where its sitters sit; a stop's shelter stands behind where people queue.
    make(benchGeometry(), points.filter((p) => p.type === 'bench'), (p) => [-Math.sin(p.yaw) * 0.12, -Math.cos(p.yaw) * 0.12]);
    make(busStopGeometry(), points.filter((p) => p.type === 'busstop'), (p) => [-Math.sin(p.yaw) * 0.3, -Math.cos(p.yaw) * 0.3]);
    scene.add(this.group);
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.group.children as THREE.InstancedMesh[]) m.dispose();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}

/** Reads `scenarios.json` beside the tile and builds the props, or nothing when there is none. */
export async function loadScenarioProps(scene: THREE.Scene, tileBase: string | null): Promise<ScenarioProps | null> {
  if (!tileBase) return null;
  try {
    const res = await fetch(new URL('scenarios.json', tileBase).href);
    if (!res.ok) return null;
    const data = parseScenarios(await res.json());
    return data ? new ScenarioProps(scene, data.points) : null;
  } catch {
    return null;
  }
}
