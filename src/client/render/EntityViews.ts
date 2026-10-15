/**
 * Draws the sim's entities. A view is made the first time an entity shows up in the interpolated
 * state and dropped when it is gone.
 */
import * as THREE from 'three';
import { EntityKind, type EntityId } from '../../shared/entities';
import type { EntityDef } from '../../shared/entityDefs';
import { HANDLING } from '../../shared/handling';
import { PedFlag, VehicleFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import type { EntityState } from '../net/Interpolator';
import { OUTFIT_COUNT } from '../../shared/entityDefs';
import { buildPedModel, buildVehicleModel, glowTex, OUTFITS, setHeadlights, type PedMode, type PedModel, type VehicleModel } from './models';
import { TrafficInstances } from './TrafficInstances';
import { newJoints, solvePose } from './pedPose';
import { PedCrowd, varyLook } from './PedCrowd';
import { SmokeSystem } from './Smoke';

/** A colour scaled toward black. */
function shade(color: number, k: number): number {
  const r = Math.round(((color >> 16) & 255) * k);
  const g = Math.round(((color >> 8) & 255) * k);
  const b = Math.round((color & 255) * k);
  return (r << 16) | (g << 8) | b;
}

declare module '../Game' {
  interface Game {
    views: EntityViews;
  }
}

interface PedView {
  kind: 'ped';
  /** The person's own model (the player, officers, and anyone past the crowd's capacity); null for a person drawn in the crowd. */
  model: PedModel | null;
  /** Differs per person, so a crowd does not sway in step. */
  seed: number;
  phase: number;
  /** How far toppled, eased toward the sim's state: 1 on its back, -1 face down. */
  lie: number;
}
interface VehicleView {
  kind: 'vehicle';
  model: VehicleModel;
  /** Which handling entry it is (wheel positions for the smoke emitter). */
  handlingId: string;
  /** How open the driver's door is drawn, 0 to 1 (eased toward the sim's flag). */
  door: number;
  /** Last wear and burnt state pushed into the model. */
  wear: number;
  burnt: boolean;
  /** A police car, with a lightbar to flash. */
  police: boolean;
}
type View = PedView | VehicleView;

export class EntityViews implements System {
  readonly name = 'entityViews';
  readonly priority = 50;
  private views = new Map<EntityId, View>();
  private group = new THREE.Group();
  readonly smoke: SmokeSystem;
  /** Engine smoke (dark), flames (additive orange) and the explosion's flash. */
  private readonly engineSmoke: SmokeSystem;
  private readonly fire: SmokeSystem;
  private readonly flashes: { sprite: THREE.Sprite; t: number }[] = [];
  private time = 0;
  /** Everyone who is not the player or an officer, drawn as instances. */
  readonly crowd = new PedCrowd(192);
  private readonly joints = newJoints();
  /** Ambient traffic cars away from the camera, drawn as instances. */
  readonly traffic = new TrafficInstances();

  constructor(private readonly game: Game) {
    game.views = this;
    this.group.name = 'entities';
    game.scene.add(this.group);
    this.group.add(this.crowd.group);
    this.crowd.setShadows(game.tier.shadowMap > 0);
    game.onTierChange((t) => this.crowd.setShadows(t.shadowMap > 0));
    this.group.add(this.traffic.group);
    this.traffic.setShadows(game.tier.shadowMap > 0);
    game.onTierChange((t) => this.traffic.setShadows(t.shadowMap > 0));
    this.smoke = new SmokeSystem(game.scene);
    this.engineSmoke = new SmokeSystem(game.scene, { max: 360, color: [0.16, 0.16, 0.18], size: [1.0, 4.2], life: [1.4, 2.8], rise: 2.6, alpha: 0.85 });
    this.fire = new SmokeSystem(game.scene, { max: 320, color: [1.0, 0.42, 0.08], additive: true, size: [1.6, 0.4], life: [0.4, 0.9], rise: 2.2, alpha: 1 });
    game.onSimEvent((e) => {
      if (e.type === 'vehicle:explode') this.explode(e.x, e.y, e.z);
    });
  }

  /** The stand-in explosion: a bright flash that swells and fades, a fireball and a burst of black smoke. */
  private explode(x: number, y: number, z: number) {
    const mat = new THREE.SpriteMaterial({ map: glowTex(), color: 0xffb060, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x, y + 1, z);
    sprite.scale.setScalar(2);
    this.game.scene.add(sprite);
    this.flashes.push({ sprite, t: 0 });
    this.fire.burst(x, y + 0.8, z, 90, 9);
    this.engineSmoke.burst(x, y + 1, z, 60, 6);
  }

  update(dt: number) {
    const { entities } = this.game.view;
    const { defs } = this.game.view;
    // Headlamps brighten at night, on every car.
    const night = this.game.clockView?.night ?? 0;
    setHeadlights(0.8 + 1.6 * night);
    this.traffic.begin();
    for (const [id, st] of entities) {
      let v = this.views.get(id);
      if (st.kind === EntityKind.Vehicle && st.flags & VehicleFlag.Traffic) {
        // Ambient traffic is drawn as instances, unless it smokes, burns or has a door open.
        const def = defs.get(id);
        if (def && def.kind === EntityKind.Vehicle) {
          const special = (st.flags & (VehicleFlag.Smoking | VehicleFlag.OnFire | VehicleFlag.Burnt | VehicleFlag.DoorOpen)) !== 0;
          if (!special) {
            if (v) this.dropView(id, v);
            const h = HANDLING[def.typeId] ?? HANDLING.sedan;
            const wear = Math.max(0, Math.min(1, 1 - st.health / h.damage.bodyHealth));
            this.traffic.add(h, def.color, st.x, st.y, st.z, st.q, st.wheels, wear, (st.flags & VehicleFlag.Braking) !== 0, (st.flags & VehicleFlag.Reversing) !== 0, 0.5 + 1.7 * night);
            continue;
          }
        }
      }
      if (!v) {
        // Draw only what the sim has defined; the definition can trail the first snapshot by a frame or two.
        const def = defs.get(id);
        if (!def) continue;
        v = this.make(def);
        this.views.set(id, v);
        if (v.kind === 'ped' && v.model) this.group.add(v.model.root);
        else if (v.kind === 'vehicle') this.group.add(v.model.root);
      }
      if (v.kind === 'vehicle' || v.model) {
        v.model!.root.position.set(st.x, st.y, st.z);
        v.model!.root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
      }
      if (v.kind === 'ped') {
        const f = st.flags;
        v.phase += dt * (3.5 + st.speed * 1.5);
        const mode: PedMode =
          f & PedFlag.Dragged ? 'dragged' : f & PedFlag.InVehicle ? 'seated' : f & PedFlag.Fighting ? 'fighting' : f & PedFlag.Fleeing ? 'fleeing' : 'normal';
        const lieTo = f & PedFlag.Dead ? -1 : f & PedFlag.Downed ? 1 : 0;
        v.lie += (lieTo - v.lie) * Math.min(1, dt * 14);
        const pedPose = (f & PedFlag.PoseMask) >> PedFlag.PoseShift;
        if (v.model) {
          v.model.lie(v.lie);
          v.model.pose(st.speed, (f & PedFlag.Grounded) !== 0, v.phase, mode, st.aux1, pedPose, this.time + v.seed);
        } else {
          solvePose(this.joints, st.speed, (f & PedFlag.Grounded) !== 0, v.phase, mode, st.aux1, pedPose, this.time, v.lie, v.seed);
          this.crowd.place(id, st.x, st.y, st.z, st.q, this.joints);
        }
      } else {
        const want = (st.flags & VehicleFlag.DoorOpen) !== 0 ? 1 : 0;
        v.door += (want - v.door) * Math.min(1, dt * 9);
        v.model.apply(st.wheels, (st.flags & VehicleFlag.Braking) !== 0, (st.flags & VehicleFlag.Reversing) !== 0, v.door);
        this.emitSmoke(v, st, dt);
        this.condition(v, st, dt);
      }
    }
    this.time += dt;
    this.traffic.end();
    for (const [id, v] of this.views) {
      if (!entities.has(id) || !defs.has(id)) this.dropView(id, v);
    }
    this.crowd.commit();
    const cam = this.game.camera;
    this.game.renderer.getDrawingBufferSize(this.size);
    const scale = this.size.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const sys of [this.smoke, this.engineSmoke, this.fire]) {
      sys.setScale(scale);
      sys.update(dt);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / 0.9;
      f.sprite.scale.setScalar(3 + Math.min(1, f.t / 0.2) * 22);
      (f.sprite.material as THREE.SpriteMaterial).opacity = 0.85 * Math.max(0, 1 - k) ** 1.5;
      if (k >= 1) {
        this.game.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
  }

  /** Removes an entity's own model (its meshes and GPU buffers go with it). */
  private dropView(id: EntityId, v: View) {
    if (v.kind === 'ped' && !v.model) this.crowd.remove(id);
    else {
      this.group.remove(v.model!.root);
      if (v.kind === 'vehicle') v.model.dispose();
    }
    this.views.delete(id);
  }

  private make(def: EntityDef): View {
    if (def.kind === EntityKind.Ped) {
      const base = OUTFITS[def.outfit % OUTFIT_COUNT];
      // An officer wears the agency's colour, with darker trousers and cap.
      const look = def.police
        ? { jacket: def.police.uniform, jeans: shade(def.police.uniform, 0.55), skin: base.skin, cap: shade(def.police.uniform, 0.7) }
        : base;
      // Officers and the player keep their own models; everyone else is drawn in the crowd.
      if (!def.police && !def.player && this.crowd.add(def.id, varyLook(look, def.id))) return { kind: 'ped', model: null, seed: def.id * 1.7, phase: def.id * 0.9, lie: 0 };
      return { kind: 'ped', model: buildPedModel(look), seed: def.id * 1.7, phase: 0, lie: 0 };
    }
    const h = HANDLING[def.typeId] ?? HANDLING.sedan;
    return {
      kind: 'vehicle',
      model: buildVehicleModel(h, def.color, def.police ? { body: def.police.body, stripe: def.police.stripe, lightbar: def.police.lightbar } : undefined),
      handlingId: h.id,
      door: 0,
      wear: 0,
      burnt: false,
      police: !!def.police,
    };
  }

  /** Wear on the paint, the lightbar, and the smoke and flames of a wreck. */
  private condition(v: VehicleView, st: EntityState, dt: number) {
    const h = HANDLING[v.handlingId] ?? HANDLING.sedan;
    const burnt = (st.flags & VehicleFlag.Burnt) !== 0;
    const wear = Math.round(Math.max(0, Math.min(1, 1 - st.health / h.damage.bodyHealth)) * 20) / 20;
    if (wear !== v.wear || burnt !== v.burnt) {
      v.wear = wear;
      v.burnt = burnt;
      v.model.setCondition(wear, burnt);
    }
    if (v.police) v.model.flash(this.time, (st.flags & VehicleFlag.Lightbar) !== 0);
    this.q.set(st.q.x, st.q.y, st.q.z, st.q.w);
    // The engine is at the front of the car, under the bonnet.
    this.tmp.set(0, h.chassis.offset[1] + h.chassis.halfExtents[1] + 0.1, h.chassis.halfExtents[2] * 0.62).applyQuaternion(this.q);
    const x = st.x + this.tmp.x;
    const y = st.y + this.tmp.y;
    const z = st.z + this.tmp.z;
    const f = st.flags;
    if (f & VehicleFlag.OnFire) {
      this.fire.emit(x, y, z, 0, 0, dt, 1.6);
      this.engineSmoke.emit(x, y + 0.4, z, 0, 0, dt, 1);
    } else if (f & VehicleFlag.Smoking && !burnt) {
      // Thin and pale when the engine first starts to give, thick and dark as it dies.
      const strength = Math.max(0.15, Math.min(1, 1 - st.health2 / (h.damage.engineHealth * 0.42)));
      this.engineSmoke.emit(x, y, z, st.vx * 0.2, st.vz * 0.2, dt, strength);
    } else if (burnt) {
      this.engineSmoke.emit(x, y + 0.3, z, 0, 0, dt, 0.35);
    }
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
    this.traffic.dispose();
    this.crowd.dispose();
    this.smoke.dispose();
    this.engineSmoke.dispose();
    this.fire.dispose();
  }
}
