/**
 * Draws the sim's entities. A view is made the first time an entity shows up in the interpolated
 * state and dropped when it is gone.
 */
import * as THREE from 'three';
import { EntityKind, type EntityId } from '../../shared/entities';
import type { EntityDef } from '../../shared/entityDefs';
import { doorGeometry } from '../../shared/doors';
import { HANDLING } from '../../shared/handling';
import { rotateVec } from '../../shared/math';
import { HeliFlag, VehicleFlag } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import type { EntityState } from '../net/Interpolator';
import { glowTex, makeVehicleModel, setHeadlights, type VehicleModel } from './models';
import { carAsset, carAssetHolder, carAssetsReady } from './carAssets';
import { CAR_ASSETS } from './carLod';
import { applyBullet, applyExplosion, applyHealth, applyImpact, boxShape, isDamaged, newDamage, type CarDamageState, type DamageShape } from './carDamage';
import { CarDebris } from './carDebris';
import { assetFor, pickLod } from './carLod';
import { CAR_SKY } from './carMaterials';
import { shapeOf } from './carModel';
import { newSkyLook, skyLook } from './timeOfDay';
import { PedViews } from './chars/PedViews';
import { TrafficInstances } from './TrafficInstances';
import { SmokeSystem } from './Smoke';
import { buildHelicopter, buildSpikeStrip, type HeliModel, type StripModel } from './PoliceProps';

declare module '../Game' {
  interface Game {
    views: EntityViews;
  }
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
  /** Drawn as the stand-in box car (the assets were not loaded when it was made). */
  standIn: boolean;
}

/** A damaged traffic car is drawn as its full model within this distance (m, scaled by the tier's lodScale). */
const DAMAGED_NEAR = 45;
/** A parked car is drawn as an instance beyond PARKED_FAR m (and as a full model again within PARKED_NEAR), both divided by the tier's lodScale. `?parkedinst=0` keeps full models. */
const PARKED_FAR = 26;
const PARKED_NEAR = 20;

/** Grime per car, 0.1 (clean) to 0.75 (filthy): a hash of its id, so a car keeps its dirt. */
export function dirtOf(id: number): number {
  const h = Math.sin(id * 78.233 + 1.7) * 43758.5453;
  return 0.1 + 0.65 * (h - Math.floor(h)) ** 1.5;
}

/** The body origin's height above flat ground at rest (RaycastCar.restHeight). */
function rideHeight(h: (typeof HANDLING)[string]): number {
  const omega = 2 * Math.PI * h.suspension.frequencyHz;
  return h.wheels.radius + Math.max(0.04, h.suspension.travel * h.suspension.restRatio - 9.81 / (omega * omega)) - h.wheels.mountY;
}
type View = VehicleView;

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
  /** Every pedestrian: skinned actors near the camera, the instanced crowd beyond, box figures as a fallback (chars/PedViews.ts). */
  readonly peds: PedViews;
  /** Ambient traffic cars away from the camera, drawn as instances. */
  readonly traffic = new TrafficInstances();
  /** Each car's damage (dents, bumpers, bonnet, windows), kept while the car exists, whether it is drawn as a model or an instance. */
  readonly damage = new Map<EntityId, CarDamageState>();
  /** Bumpers that fell off. */
  readonly debris = new CarDebris();
  private readonly sky = newSkyLook();
  private skyMinutes = -1;
  private readonly shapes = new Map<string, DamageShape>();
  /** Parked cars that are drawn as instances now (they get a full model when the camera comes close). */
  private readonly parkedInstanced = new Set<EntityId>();
  private readonly parkedFar: boolean;

  constructor(private readonly game: Game) {
    game.views = this;
    this.parkedFar = game.params.get('parkedinst') !== '0';
    this.group.name = 'entities';
    this.group.matrixAutoUpdate = false; // (identity: only the models inside it move)
    game.scene.add(this.group);
    this.peds = new PedViews(game, this.group);
    this.group.add(this.traffic.group);
    this.traffic.setShadows(game.tier.shadowMap > 0);
    game.onTierChange((t) => this.traffic.setShadows(t.shadowMap > 0));
    this.smoke = new SmokeSystem(game.scene);
    this.engineSmoke = new SmokeSystem(game.scene, { max: 360, color: [0.16, 0.16, 0.18], size: [1.0, 4.2], life: [1.4, 2.8], rise: 2.6, alpha: 0.85 });
    this.fire = new SmokeSystem(game.scene, { max: 320, color: [1.0, 0.42, 0.08], additive: true, size: [1.6, 0.4], life: [0.4, 0.9], rise: 2.2, alpha: 1 });
    this.group.add(this.debris.group);
    if (carAssetsReady()) this.group.add(carAssetHolder());
    game.onSimEvent((e) => {
      if (e.type === 'vehicle:explode') {
        this.explode(e.x, e.y, e.z);
        const s = this.damageOf(e.vehicleId);
        if (s) applyExplosion(s.state, s.shape, e.vehicleId);
      } else if (e.type === 'vehicle:damage' && e.at) {
        const s = this.damageOf(e.vehicleId);
        if (s) {
          const [x, y, z, dx, dy, dz] = e.at;
          applyImpact(s.state, s.shape, x, y, z, dx, dy, dz, e.amount, s.deform);
        }
      } else if (e.type === 'weapon:fire') {
        for (const hit of e.impacts) if (hit.kind === 'vehicle' && hit.targetId) this.bulletHit(hit.targetId, hit.x, hit.y, hit.z);
      }
    });
  }

  /** The damage state of a car (made on its first hit) and the shape and deform factor its rules need; null if it is not a known car. */
  private damageOf(id: EntityId): { state: CarDamageState; shape: DamageShape; deform: number } | null {
    const def = this.game.view.defs.get(id);
    if (!def || def.kind !== EntityKind.Vehicle) return null;
    const h = HANDLING[def.typeId] ?? HANDLING.sedan;
    let state = this.damage.get(id);
    if (!state) this.damage.set(id, (state = newDamage()));
    return { state, shape: this.shapeFor(def.typeId, !!def.police && !def.police.unmarked), deform: h.damage.deformMult };
  }

  private shapeFor(typeId: string, police: boolean): DamageShape {
    const name = assetFor(typeId, police);
    let s = this.shapes.get(name);
    if (!s) {
      const asset = carAsset(name);
      const h = HANDLING[typeId] ?? HANDLING.sedan;
      s = asset ? shapeOf(asset) : boxShape(h.chassis.halfExtents[2], h.chassis.halfExtents[0]);
      this.shapes.set(name, s);
    }
    return s;
  }

  /** A bullet hit a car at a world point: it may break the window it hit. */
  private bulletHit(id: EntityId, x: number, y: number, z: number) {
    const st = this.game.view.entities.get(id);
    const s = this.damageOf(id);
    if (!st || !s) return;
    this.q.set(st.q.x, st.q.y, st.q.z, st.q.w).invert();
    this.tmp.set(x - st.x, y - st.y, z - st.z).applyQuaternion(this.q);
    applyBullet(s.state, s.shape, this.tmp.x, this.tmp.y, this.tmp.z);
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

  private warmed = false;

  /**
   * Draws every car asset once, at every level of detail, into a 1-pixel target: the geometries are on the GPU and the shaders
   * compiled before the first car needs them (no hitch when a police car first rolls up, and nothing new uploaded mid-game).
   */
  private prewarm() {
    this.warmed = true;
    if (!carAssetsReady()) return;
    const g = this.game;
    const temp = new THREE.Group();
    const models: VehicleModel[] = [];
    const ahead = new THREE.Vector3(0, 0, -6).applyQuaternion(g.camera.quaternion).add(g.camera.position);
    const types = new Set<string>();
    for (const [name, e] of Object.entries(CAR_ASSETS)) {
      const h = HANDLING[e.type] ?? HANDLING.sedan;
      types.add(h.id);
      const livery = e.police ? { body: 0x223344, stripe: 0xdddddd, lightbar: [0x3366ff, 0xff3333] as [number, number] } : undefined;
      for (let level = 0; level < 3; level++) {
        const m = makeVehicleModel(h, 0x808080, livery);
        if (!m.setLod) continue;
        m.setLod(level);
        m.root.position.copy(ahead);
        temp.add(m.root);
        models.push(m);
      }
      void name;
    }
    this.traffic.begin(g.camera.position, 1);
    this.traffic.prewarm([...types].map((t) => HANDLING[t]), ahead);
    g.scene.add(temp);
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const prev = g.renderer.getRenderTarget();
    g.renderer.setRenderTarget(rt);
    g.renderer.render(g.scene, g.camera);
    g.renderer.setRenderTarget(prev);
    rt.dispose();
    g.scene.remove(temp);
    for (const m of models) m.dispose();
    this.traffic.begin(g.camera.position, 1);
    this.traffic.end();
  }

  update(dt: number) {
    if (!this.warmed) this.prewarm();
    const { entities } = this.game.view;
    const { defs } = this.game.view;
    // Headlamps brighten at night, on every car.
    const night = this.game.clockView?.night ?? 0;
    setHeadlights(0.8 + 1.6 * night);
    // the cars' cheap reflections take the sky's colours
    const minutes = Math.round((this.game.clockView?.minutes ?? 14 * 60) * 4) / 4;
    if (minutes !== this.skyMinutes) {
      this.skyMinutes = minutes;
      skyLook(minutes, this.sky);
      CAR_SKY.uSkyTop.value.copy(this.sky.zenith);
      CAR_SKY.uSkyHorizon.value.copy(this.sky.horizon);
      CAR_SKY.uSkyGround.value.copy(this.sky.hemiGround).multiplyScalar(0.6);
    }
    const cam = this.game.camera.position;
    const lodScale = this.game.tier.lodScale;
    this.traffic.begin(cam, lodScale);
    this.peds.begin(dt, entities, defs);
    for (const [id, st] of entities) {
      if (st.kind === EntityKind.Helicopter || st.kind === EntityKind.SpikeStrip) {
        this.updateProp(id, st, dt, night);
        continue;
      }
      if (st.kind === EntityKind.Ped) {
        this.peds.frame(id, st, defs.get(id), dt);
        continue;
      }
      // (trains are drawn by the transit layer: render/transit/TrainViews.ts)
      if (st.kind === EntityKind.Train) continue;
      let v = this.views.get(id);
      let instanced = st.kind === EntityKind.Vehicle && (st.flags & VehicleFlag.Traffic) !== 0;
      if (!instanced && this.parkedFar && st.kind === EntityKind.Vehicle && !(st.flags & (VehicleFlag.Occupied | VehicleFlag.Police | VehicleFlag.Roadblock)) && id !== this.game.view.controlled?.id) {
        // A parked car away from the camera is drawn as an instance too (the same asset at the same level of detail: only
        // the shading of its trim differs): a full model is 5 to 17 draws and three materials of its own.
        const d = Math.hypot(st.x - cam.x, st.z - cam.z) / lodScale;
        instanced = this.parkedInstanced.has(id) ? d > PARKED_NEAR : d > PARKED_FAR;
        if (instanced) this.parkedInstanced.add(id);
        else this.parkedInstanced.delete(id);
      }
      if (instanced) {
        // Ambient traffic is drawn as instances, unless it smokes, burns or has a door open.
        const def = defs.get(id);
        if (def && def.kind === EntityKind.Vehicle) {
          // a damaged car gets its full model (dents, loose parts) while it is near; farther off the instance shows its wear
          const special =
            (st.flags & (VehicleFlag.Smoking | VehicleFlag.OnFire | VehicleFlag.Burnt | VehicleFlag.DoorOpen)) !== 0 ||
            (isDamaged(this.damage.get(id)) && Math.hypot(st.x - cam.x, st.z - cam.z) < DAMAGED_NEAR * lodScale);
          if (!special) {
            if (v) this.dropView(id, v);
            const h = HANDLING[def.typeId] ?? HANDLING.sedan;
            const wear = Math.max(0, Math.min(1, 1 - st.health / h.damage.bodyHealth));
            this.traffic.add(h, def.color, st.x, st.y, st.z, st.q, st.wheels, wear, (st.flags & VehicleFlag.Braking) !== 0, (st.flags & VehicleFlag.Reversing) !== 0, 0.5 + 1.7 * night, dirtOf(id));
            continue;
          }
        }
      }
      if (v && v.kind === 'vehicle' && v.standIn && carAssetsReady()) {
        // the assets arrived after this car was made: swap the box for the real model
        this.dropView(id, v);
        v = undefined;
      }
      if (!v) {
        // Draw only what the sim has defined; the definition can trail the first snapshot by a frame or two.
        const def = defs.get(id);
        if (!def) continue;
        v = this.make(def);
        this.views.set(id, v);
        this.group.add(v.model.root);
      }
      v.model.root.position.set(st.x, st.y, st.z);
      v.model.root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
      {
        let want = (st.flags & VehicleFlag.DoorOpen) !== 0 ? 1 : 0;
        if (st.kind === EntityKind.Vehicle && !(st.flags & VehicleFlag.Traffic)) {
          // someone getting in or out at this car's driver's door holds it open
          const def = defs.get(id);
          if (def && def.kind === EntityKind.Vehicle) {
            const g = doorGeometry(HANDLING[def.typeId] ?? HANDLING.sedan);
            const w = rotateVec(st.q, g.stand.x, 0, g.stand.z);
            want = Math.max(want, this.peds.doorOpenAt(st.x + w.x, st.z + w.z));
          }
        }
        v.door += (want - v.door) * Math.min(1, dt * 9);
        const m = v.model;
        if (m.setLod) m.setLod(pickLod(Math.hypot(st.x - cam.x, st.y - cam.y, st.z - cam.z), lodScale, m.lod));
        m.apply(st.wheels, (st.flags & VehicleFlag.Braking) !== 0, (st.flags & VehicleFlag.Reversing) !== 0, v.door);
        this.syncDamage(id, v, st);
        this.emitSmoke(v, st, dt);
        this.condition(v, st, dt);
      }
    }
    this.time += dt;
    this.traffic.end();
    this.peds.end(dt, entities, defs);
    for (const [id, v] of this.views) {
      if (!entities.has(id) || !defs.has(id)) this.dropView(id, v);
    }
    for (const [id, p] of this.props) {
      if (!entities.has(id) || !defs.has(id)) this.dropProp(id, p);
    }
    for (const id of this.damage.keys()) if (!entities.has(id)) this.damage.delete(id);
    for (const id of this.parkedInstanced) if (!entities.has(id)) this.parkedInstanced.delete(id);
    this.debris.update(dt);
    this.game.renderer.getDrawingBufferSize(this.size);
    const scale = this.size.y / (2 * Math.tan((this.game.camera.fov * Math.PI) / 360));
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

  /** Helicopters and spike strips, drawn by `PoliceProps`. */
  private readonly props = new Map<EntityId, { heli: HeliModel | null; strip: StripModel | null }>();
  private readonly beamTarget = new THREE.Vector3();

  private updateProp(id: EntityId, st: EntityState, dt: number, night: number) {
    let p = this.props.get(id);
    if (!p) {
      const def = this.game.view.defs.get(id);
      if (!def) return;
      if (def.kind === EntityKind.Helicopter) {
        const heli = buildHelicopter(def.color);
        this.group.add(heli.root, heli.fx);
        p = { heli, strip: null };
      } else if (def.kind === EntityKind.SpikeStrip) {
        const strip = buildSpikeStrip(def.length, def.depth);
        this.group.add(strip.root);
        p = { heli: null, strip };
      } else return;
      this.props.set(id, p);
    }
    const root = p.heli ? p.heli.root : p.strip!.root;
    root.position.set(st.x, st.y + (p.strip ? 0.06 : 0), st.z);
    root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
    if (p.heli) {
      // The beam goes where the helicopter is looking: at the player when it has them, else a sweep of the ground ahead of it.
      const ground = st.y - st.aux1;
      const ped = this.game.view.controlled ?? this.game.view.ped;
      if (st.flags & HeliFlag.Sees && ped) this.beamTarget.set(ped.x, ped.y + 0.2, ped.z);
      else {
        const yaw = Math.atan2(2 * (st.q.x * st.q.z + st.q.w * st.q.y), 1 - 2 * (st.q.x * st.q.x + st.q.y * st.q.y));
        const ahead = Math.max(10, st.aux1 * 0.7);
        const side = Math.sin(this.time * 0.6) * st.aux1 * 0.45;
        this.beamTarget.set(st.x + Math.sin(yaw) * ahead + Math.cos(yaw) * side, ground + 0.2, st.z + Math.cos(yaw) * ahead - Math.sin(yaw) * side);
      }
      const light = st.flags & HeliFlag.Searchlight ? Math.min(1, 0.4 + night) : 0;
      p.heli.update(dt, this.time, st.aux0, light, this.beamTarget);
    }
  }

  private dropProp(id: EntityId, p: { heli: HeliModel | null; strip: StripModel | null }) {
    if (p.heli) {
      this.group.remove(p.heli.root, p.heli.fx);
      p.heli.dispose();
    }
    if (p.strip) {
      this.group.remove(p.strip.root);
      p.strip.dispose();
    }
    this.props.delete(id);
  }

  /** Removes an entity's own model (its meshes and GPU buffers go with it). */
  private dropView(id: EntityId, v: View) {
    this.group.remove(v.model.root);
    v.model.dispose();
    this.views.delete(id);
  }

  private make(def: EntityDef): VehicleView {
    // (helicopters and spike strips are drawn by `updateProp`)
    if (def.kind !== EntityKind.Vehicle) throw new Error(`no view for entity kind ${def.kind}`);
    const h = HANDLING[def.typeId] ?? HANDLING.sedan;
    const model = makeVehicleModel(h, def.color, def.police ? { body: def.police.body, stripe: def.police.stripe, lightbar: def.police.lightbar, unmarked: def.police.unmarked } : undefined);
    model.setDirt?.(def.police ? 0.15 : dirtOf(def.id));
    return {
      kind: 'vehicle',
      model,
      handlingId: h.id,
      door: 0,
      wear: 0,
      burnt: false,
      police: !!def.police,
      standIn: !model.setLod,
    };
  }

  /** Draws a car's damage state on its model; parts that came off become debris. */
  private syncDamage(id: EntityId, v: VehicleView, st: EntityState) {
    const s = this.damage.get(id);
    const m = v.model;
    if (!m.syncDamage) return;
    const h = HANDLING[v.handlingId] ?? HANDLING.sedan;
    if (s) applyHealth(s, m.shape!, st.health / h.damage.bodyHealth);
    if (st.flags & VehicleFlag.Burnt) {
      const d = this.damageOf(id);
      if (d && !d.state.burnt) applyExplosion(d.state, d.shape, id);
    }
    const state = this.damage.get(id);
    if (!state) return;
    const parts = m.syncDamage(state);
    if (parts.length) {
      const ground = st.y - rideHeight(h);
      parts.forEach((p, i) => this.debris.add(p, st.vx, st.vy, st.vz, ground, id * 7 + i + state.version));
    }
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
    v.model.setFlats((st.flags & VehicleFlag.FlatMask) >> VehicleFlag.FlatShift);
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
    for (const [id, p] of [...this.props]) this.dropProp(id, p);
    this.traffic.dispose();
    this.debris.dispose();
    this.peds.dispose();
    this.smoke.dispose();
    this.engineSmoke.dispose();
    this.fire.dispose();
  }
}
