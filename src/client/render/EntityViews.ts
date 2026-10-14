/**
 * Draws the sim's entities. A view is made the first time an entity shows up in the interpolated
 * state and dropped when it is gone.
 */
import * as THREE from 'three';
import type { EntityId } from '../../shared/entities';
import { HANDLING } from '../../shared/handling';
import { PedFlag, VehicleFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import type { EntityState } from '../net/Interpolator';
import { buildPedModel, buildVehicleModel, type PedModel, type VehicleModel } from './models';
import { SmokeSystem } from './Smoke';

declare module '../Game' {
  interface Game {
    views: EntityViews;
  }
}

interface PedView {
  kind: 'ped';
  model: PedModel;
  phase: number;
}
interface VehicleView {
  kind: 'vehicle';
  model: VehicleModel;
  /** Per wheel suspension lengths, for the smoke emitter. */
  handlingId: string;
}
type View = PedView | VehicleView;

export class EntityViews implements System {
  readonly name = 'entityViews';
  readonly priority = 50;
  private views = new Map<EntityId, View>();
  private group = new THREE.Group();
  readonly smoke: SmokeSystem;

  constructor(private readonly game: Game) {
    game.views = this;
    this.group.name = 'entities';
    game.scene.add(this.group);
    this.smoke = new SmokeSystem(game.scene);
  }

  update(dt: number) {
    const { entities } = this.game.view;
    for (const [id, st] of entities) {
      let v = this.views.get(id);
      if (!v) {
        v = this.make(st);
        this.views.set(id, v);
        this.group.add(v.model.root);
      }
      v.model.root.position.set(st.x, st.y, st.z);
      v.model.root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
      if (v.kind === 'ped') {
        v.model.root.visible = (st.flags & PedFlag.InVehicle) === 0;
        v.phase += dt * (3.5 + st.speed * 1.5);
        v.model.pose(st.speed, (st.flags & PedFlag.Grounded) !== 0, v.phase);
      } else {
        v.model.apply(st.wheels, (st.flags & VehicleFlag.Braking) !== 0, (st.flags & VehicleFlag.Reversing) !== 0);
        this.emitSmoke(v, st, dt);
      }
    }
    for (const [id, v] of this.views) {
      if (!entities.has(id)) {
        this.group.remove(v.model.root);
        if (v.kind === 'vehicle') v.model.dispose();
        this.views.delete(id);
      }
    }
    const cam = this.game.camera;
    this.game.renderer.getDrawingBufferSize(this.size);
    this.smoke.setScale(this.size.y / (2 * Math.tan((cam.fov * Math.PI) / 360)));
    this.smoke.update(dt);
  }

  private make(st: EntityState): View {
    if (st.kind === 1) {
      const model = buildPedModel();
      return { kind: 'ped', model, phase: 0 };
    }
    const type = this.game.ready.vehicleType;
    return { kind: 'vehicle', model: buildVehicleModel(HANDLING[type] ?? HANDLING.sedan), handlingId: type };
  }

  private readonly size = new THREE.Vector2();
  private readonly tmp = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  private emitSmoke(v: VehicleView, st: EntityState, dt: number) {
    const h = HANDLING[v.handlingId] ?? HANDLING.sedan;
    this.q.set(st.q.x, st.q.y, st.q.z, st.q.w);
    for (let i = 0; i < 4; i++) {
      const slip = st.wheels[i * 4 + 3];
      if (slip < 0.6 || Math.hypot(st.vx, st.vz) < 0.2 && slip < 0.99) continue;
      const left = i % 2 === 0;
      const front = i < 2;
      this.tmp
        .set((left ? 1 : -1) * (front ? h.wheels.trackFront : h.wheels.trackRear) * 0.5, h.wheels.mountY - st.wheels[i * 4 + 2] - h.wheels.radius, front ? h.wheels.frontZ : h.wheels.rearZ)
        .applyQuaternion(this.q)
        .add({ x: st.x, y: st.y, z: st.z } as THREE.Vector3);
      this.smoke.emit(this.tmp.x, this.tmp.y + 0.05, this.tmp.z, st.vx * 0.3, st.vz * 0.3, dt, slip);
    }
  }

  dispose() {
    this.smoke.dispose();
  }
}
