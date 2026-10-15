/**
 * The furniture of scenario points: benches and bus stop signs, so the people who sit and wait have
 * something to sit and wait at. Each is one instanced mesh for the whole tile (two draw calls).
 * `scenarios.json` is the sim's own file; the client reads it again here for the positions only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BENCH_BOXES, BUSSTOP_BOXES, benchPlacement, busStopPlacement, type PropBox, type PropPlacement } from '../../shared/props';
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

const boxes = (list: readonly PropBox[]) => mergeGeometries(list.map((b) => part(b.w, b.h, b.d, b.x, b.y, b.z, b.rgb)))!;

/** A park bench facing +Z (the boxes are in `shared/props.ts`, where the sim makes them solid). */
export const benchGeometry = (): THREE.BufferGeometry => boxes(BENCH_BOXES);

/** A bus stop: a pole with a blue sign, and a bench under a small roof beside it. Local +Z is toward the road. */
export const busStopGeometry = (): THREE.BufferGeometry => boxes(BUSSTOP_BOXES);

export class ScenarioProps implements System {
  readonly name = 'scenarioProps';
  readonly priority = 90;
  private readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ roughness: 0.75, vertexColors: true });

  constructor(scene: THREE.Scene, points: readonly ScenarioPoint[]) {
    this.group.name = 'scenario-props';
    const make = (geo: THREE.BufferGeometry, pts: ScenarioPoint[], place: (p: ScenarioPoint) => PropPlacement) => {
      if (!pts.length) return;
      this.geos.push(geo);
      const m = new THREE.InstancedMesh(geo, this.mat, pts.length);
      const mat = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      pts.forEach((p, i) => {
        const at = place(p);
        mat.compose(new THREE.Vector3(at.x, at.y, at.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), at.yaw), new THREE.Vector3(1, 1, 1));
        m.setMatrixAt(i, mat);
      });
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    };
    // A bench stands where its sitters sit; a stop's shelter stands behind where people queue.
    make(benchGeometry(), points.filter((p) => p.type === 'bench'), benchPlacement);
    make(busStopGeometry(), points.filter((p) => p.type === 'busstop'), busStopPlacement);
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
