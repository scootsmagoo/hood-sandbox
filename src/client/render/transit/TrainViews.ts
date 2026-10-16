/**
 * The trains: every car of every train drawn as instances, one instanced mesh per material per level of detail (about thirty
 * draws for the whole network). The sim sends each train's route and where its head is along it (`E.Aux0`, interpolated by the
 * client between snapshots); the cars are laid out on the route from `transit.json` exactly as the sim lays out their bodies
 * (`carPoseAt`), the odd car of each married pair turned round (its cab at the back). The doors on the platform side slide
 * open with `E.Aux1`; the destination signs take the line's colour.
 */
import * as THREE from 'three';
import { EntityKind } from '../../../shared/entities';
import { TrainFlag } from '../../../shared/snapshot';
import { carMidAt, carPoseAt, colourNum, type CarPose, type TransitData } from '../../../shared/transit';
import car from '../../../shared/data/railcar.json';
import type { Game } from '../../Game';
import type { EntityState } from '../../net/Interpolator';
import type { CarAsset } from './transitAssets';
import { partMaterial } from './transitMaterials';

const MAX_CARS = 96;
/** Trains farther than this from the camera are not drawn, m. */
const DRAW_RANGE = 900;

interface LodSet {
  meshes: THREE.InstancedMesh[];
  open: THREE.InstancedBufferAttribute;
  line: THREE.InstancedBufferAttribute;
  count: number;
}

/** Where a car is this frame (for the camera and the HUD). */
export interface CarView {
  trainId: number;
  route: number;
  k: number;
  pose: CarPose;
  /** the car's own frame: position (rail top under its middle) and rotation, as a matrix */
  matrix: THREE.Matrix4;
}

export class TrainViews {
  readonly group = new THREE.Group();
  private readonly lods: LodSet[] = [];
  private readonly from: number[];
  private readonly pose: CarPose = { x: 0, y: 0, z: 0, fx: 0, fz: 1, grade: 0 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly lineColours: THREE.Color[];
  /** the cars of the train the player rides, this frame */
  readonly ridden: CarView[] = [];
  private hidden: ((x: number, y: number, z: number) => boolean) | null = null;
  /** every train's head this frame (for audio): id, position, speed, flags */
  readonly heads: { id: number; x: number; y: number; z: number; speed: number; flags: number; route: number; s: number; doors: number }[] = [];

  constructor(
    private readonly game: Game,
    private readonly data: TransitData,
    asset: CarAsset,
  ) {
    this.group.name = 'trains';
    this.from = asset.from;
    this.lineColours = data.lines.map((l) => new THREE.Color(colourNum(l.colour)).convertSRGBToLinear().multiplyScalar(1.4));
    for (const lod of asset.lods) {
      const open = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 2), 2);
      const line = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);
      open.setUsage(THREE.DynamicDrawUsage);
      line.setUsage(THREE.DynamicDrawUsage);
      const meshes: THREE.InstancedMesh[] = [];
      for (const [name, geo] of lod) {
        const g = geo.clone();
        g.setAttribute('aOpen', open);
        g.setAttribute('aLine', line);
        const mat = partMaterial(name, { car: true, travel: asset.travel });
        const im = new THREE.InstancedMesh(g, mat, MAX_CARS);
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = name !== 'tr_glass' && name !== 'tr_light';
        im.receiveShadow = true;
        // the glass after the opaque parts
        if (name === 'tr_glass') im.renderOrder = 2;
        im.name = `train_${name}`;
        meshes.push(im);
        this.group.add(im);
      }
      this.lods.push({ meshes, open, line, count: 0 });
    }
    game.scene.add(this.group);
  }

  /** Lays out every car of every train in view; `hidden` (when given) says a car at (x, y, z) is out of sight under the ground. */
  update(hidden: ((x: number, y: number, z: number) => boolean) | null = null): void {
    this.hidden = hidden;
    const v = this.game.view;
    const cam = this.game.camera.position;
    const lodScale = this.game.tier.lodScale;
    for (const l of this.lods) l.count = 0;
    this.ridden.length = 0;
    this.heads.length = 0;
    const riding = v.sample ? v.sample.b.train : 0;
    for (const st of v.entities.values()) {
      if (st.kind !== EntityKind.Train) continue;
      this.placeTrain(st, cam, lodScale, riding);
    }
    for (const l of this.lods) {
      for (const m of l.meshes) {
        m.count = l.count;
        // (an empty level draws nothing, its shadows neither)
        m.visible = l.count > 0;
        m.instanceMatrix.needsUpdate = true;
      }
      l.open.needsUpdate = true;
      l.line.needsUpdate = true;
    }
  }

  private placeTrain(st: EntityState, cam: THREE.Vector3, lodScale: number, riding: number): void {
    const route = Math.round(st.aux2);
    const r = this.data.routes[route];
    if (!r) return;
    const s = st.aux0;
    const doors = st.aux1;
    const flags = st.flags;
    this.heads.push({ id: st.id, x: st.x, y: st.y, z: st.z, speed: st.speed, flags, route, s, doors });
    if (Math.hypot(st.x - cam.x, st.z - cam.z) > DRAW_RANGE + 150) return;
    const cars = (this.game.view.defs.get(st.id) as { cars?: number } | undefined)?.cars ?? 6;
    const colour = this.lineColours[r.line] ?? this.lineColours[0];
    const left = (flags & TrainFlag.DoorsLeft) !== 0, right = (flags & TrainFlag.DoorsRight) !== 0;
    for (let k = 0; k < cars; k++) {
      const p = carPoseAt(r, carMidAt(s, k, car.length, car.gap), car.bogieZ, this.pose);
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) / lodScale;
      if (d > DRAW_RANGE) continue;
      if (st.id !== riding && this.hidden?.(p.x, p.y, p.z)) continue;
      const flip = k % 2 === 1;
      this.e.set(-Math.atan(p.grade), Math.atan2(p.fx, p.fz), 0, 'YXZ');
      this.q.setFromEuler(this.e);
      if (flip) this.q.multiply(this.qFlip);
      this.pos.set(p.x, p.y, p.z);
      this.m4.compose(this.pos, this.q, this.one);
      if (st.id === riding) this.ridden.push({ trainId: st.id, route, k, pose: { ...p }, matrix: this.m4.clone() });
      let li = 0;
      while (li + 1 < this.lods.length && d >= this.from[li + 1]) li++;
      // the car the camera rides in is always the near one
      if (st.id === riding) li = 0;
      const set = this.lods[li];
      if (set.count >= MAX_CARS) continue;
      const i = set.count++;
      for (const m of set.meshes) m.setMatrixAt(i, this.m4);
      // the doors that open are on the platform side, in the route's terms; a turned car has them on its other side
      const openL = flip ? (right ? doors : 0) : left ? doors : 0;
      const openR = flip ? (left ? doors : 0) : right ? doors : 0;
      set.open.setXY(i, openL, openR);
      set.line.setXYZ(i, colour.r, colour.g, colour.b);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const l of this.lods) for (const m of l.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
