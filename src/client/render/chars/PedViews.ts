/**
 * Every pedestrian on screen: the view of each person from the interpolated entity state.
 *
 * People are drawn one of three ways, chosen per person per frame:
 *   - a `PedActor` (a skinned mesh with its own skeleton and a mixer): the player, officers, anyone in
 *     the nearest handful, and every ragdoll. At most `actorBudget` ordinary people at a time, chosen
 *     by distance with some stickiness;
 *   - the `SkinnedCrowd`: everyone else, as instances with baked animation;
 *   - the old box figures (`PedModel` / `PedCrowd` / `RagdollFigures`) when the character assets are
 *     missing or `?peds=box`.
 * The sim's flags map to clips in animSelect.ts; ragdolls drive the bones (ragBones.ts).
 */
import * as THREE from 'three';
import type { EntityId } from '../../../shared/entities';
import { EntityKind } from '../../../shared/entities';
import type { EntityDef } from '../../../shared/entityDefs';
import { PedFlag, gunWeapon } from '../../../shared/snapshot';
import { weaponByIndex } from '../../../shared/weapons';
import type { Game } from '../../Game';
import type { EntityState } from '../../net/Interpolator';
import { buildPedModel, type PedLook, type PedMode, type PedModel } from '../models';
import { PedCrowd, varyLook } from '../PedCrowd';
import { newJoints, solvePose, type PoseExtra } from '../pedPose';
import { RagdollFigures } from '../RagdollFigures';
import type { AnimInput } from './animSelect';
import { characterAssets } from './characterAssets';
import { CHAR_OUTFITS, CHAR_OUTFIT_COUNT, appearanceOf, officerOutfit, type Appearance } from './outfits';
import { actorLod, PedActor } from './PedActor';
import { SkinnedCrowd } from './SkinnedCrowd';

interface View {
  id: EntityId;
  /** Made while the character assets were missing: a box figure. */
  box: boolean;
  police: boolean;
  player: boolean;
  seed: number;
  /** Box figures only. */
  phase: number;
  lie: number;
  model: PedModel | null;
  look: PedLook;
  app: Appearance;
  actor: PedActor | null;
  inCrowd: boolean;
  yaw: number;
  yawRate: number;
  kick: number;
}

/** How many ordinary people may be drawn as actors, by tier, and how near they must be. */
export const ACTOR_BUDGET = { low: 5, medium: 9, high: 14 } as const;
export const ACTOR_RANGE = 17;

const shade = (color: number, k: number) => (Math.round(((color >> 16) & 255) * k) << 16) | (Math.round(((color >> 8) & 255) * k) << 8) | Math.round((color & 255) * k);

/** The near set: the `budget` nearest candidates inside `range`; those already near count as 25% closer. Pure, for tests. */
export function pickNear(cands: readonly { id: number; d: number; was: boolean }[], budget: number, range: number): Set<number> {
  const scored = cands.map((c) => ({ id: c.id, s: c.was ? c.d * 0.75 : c.d, d: c.d })).filter((c) => c.d < range * (cands.find((x) => x.id === c.id)?.was ? 1.2 : 1));
  scored.sort((a, b) => a.s - b.s || a.id - b.id);
  return new Set(scored.slice(0, budget).map((c) => c.id));
}

export class PedViews {
  private readonly views = new Map<EntityId, View>();
  private boxCrowd: PedCrowd | null = null;
  private boxRagdolls: RagdollFigures | null = null;
  private crowd: SkinnedCrowd | null = null;
  private ragdollPoses: RagdollFigures | null = null;
  private near = new Set<EntityId>();
  private time = 0;
  private readonly lastCam = new THREE.Vector3();
  private fast = false;
  /** Hold who is an actor as it is (the leak harness freezes the street with this: whoever walks near or away must not look like growth). */
  pinned = false;
  /** Every mesh drawn once, off to one side, in the first frames: no geometry is first uploaded (a hitch, and a count that grows) when someone first walks into range. */
  private warm: THREE.Group | null = null;
  private warmFrames = 3;
  private warmActor: PedActor | null = null;
  private shadows: boolean;
  private readonly joints = newJoints();
  private readonly extra: PoseExtra = {};
  private readonly input: AnimInput = { speed: 0, grounded: true, mode: 'normal', pose: 0, swing: 0, yawRate: 0 };
  private readonly cands: { id: number; d: number; was: boolean }[] = [];

  constructor(private readonly game: Game, private readonly parent: THREE.Group) {
    this.shadows = game.tier.shadowMap > 0;
    game.onTierChange((t) => {
      this.shadows = t.shadowMap > 0;
      this.boxCrowd?.setShadows(this.shadows);
      this.boxRagdolls?.setShadows(this.shadows);
      this.crowd?.setShadows(this.shadows);
      for (const v of this.views.values()) v.actor?.setShadows(this.shadows);
    });
  }

  get skinned() {
    return this.crowd !== null;
  }

  /** The crowd, whichever kind (tests and harnesses read its size). */
  get crowdSize() {
    return (this.crowd ?? this.boxCrowd)?.size ?? 0;
  }

  private ensureBackends() {
    const assets = characterAssets();
    if (assets && !this.crowd) {
      this.crowd = new SkinnedCrowd(assets, 192);
      this.crowd.setShadows(this.shadows);
      this.parent.add(this.crowd.group);
      this.ragdollPoses = new RagdollFigures(24, false);
      this.warm = new THREE.Group();
      const basic = new THREE.MeshBasicMaterial({ color: 0x000000 });
      for (const g of assets.geos.values()) {
        const m = new THREE.Mesh(g, basic);
        m.frustumCulled = false;
        m.position.set(0, -2000, 0);
        this.warm.add(m);
      }
      this.parent.add(this.warm);
      // and one actor, so the skinned programs (and the shadow pass's) compile now, not when someone first steps up to the camera
      this.warmActor = new PedActor(assets, appearanceOf(CHAR_OUTFITS[0], 0), 0);
      this.warmActor.root.position.set(0, -2000, 0);
      this.warmActor.setShadows(this.shadows);
      this.parent.add(this.warmActor.root);
      // box views made before the assets arrived are rebuilt as skinned
      for (const [id, v] of [...this.views]) if (v.box) this.drop(id, v);
      if (this.boxCrowd) this.boxCrowd.group.visible = false;
    }
    if (!assets && !this.boxCrowd) {
      this.boxCrowd = new PedCrowd(192);
      this.boxCrowd.setShadows(this.shadows);
      this.parent.add(this.boxCrowd.group);
      this.boxRagdolls = new RagdollFigures(24);
      this.boxRagdolls.setShadows(this.shadows);
      this.parent.add(this.boxRagdolls.group);
    }
  }

  /** Before the frame's people: picks who is near enough to be an actor. */
  begin(dt: number, entities: ReadonlyMap<EntityId, EntityState>, defs: ReadonlyMap<EntityId, EntityDef>) {
    this.ensureBackends();
    this.made = 0;
    // a fast camera (driving) sees people for a second: nobody new becomes an actor until it slows
    const cp = this.game.camera.position;
    const camSpeed = dt > 0 ? Math.hypot(cp.x - this.lastCam.x, cp.z - this.lastCam.z) / dt : 0;
    this.lastCam.copy(cp);
    this.fast = camSpeed > 9 && camSpeed < 400;
    this.boxRagdolls?.begin();
    this.crowd?.begin(this.game.camera.position, this.game.tier.lodScale);
    if (!this.crowd || this.pinned) return;
    const cam = this.game.camera.position;
    this.cands.length = 0;
    for (const [id, st] of entities) {
      if (st.kind !== EntityKind.Ped) continue;
      const v = this.views.get(id);
      if (v && (v.police || v.player)) continue;
      const def = defs.get(id);
      if (!def || (def.kind === EntityKind.Ped && (def.police || def.player))) continue;
      if (this.fast && !v?.actor) continue;
      this.cands.push({ id, d: Math.hypot(st.x - cam.x, st.z - cam.z), was: !!v?.actor });
    }
    this.near = pickNear(this.cands, ACTOR_BUDGET[this.game.tier.name], ACTOR_RANGE * this.game.tier.lodScale);
  }

  private make(id: EntityId, def: EntityDef & { kind: typeof EntityKind.Ped }): View {
    const assets = characterAssets();
    const outfit = def.police ? officerOutfit(def.police.uniform, id) : CHAR_OUTFITS[def.player ? 0 : def.outfit % CHAR_OUTFIT_COUNT];
    const app = appearanceOf(outfit, id, !!def.police);
    const base: View = { id, box: !assets, police: !!def.police, player: def.player, seed: id * 1.7, phase: id * 0.9, lie: 0, model: null, look: app.look, app, actor: null, inCrowd: false, yaw: 0, yawRate: 0, kick: 0 };
    if (!assets) {
      // the box figures
      const look = def.police ? { jacket: def.police.uniform, jeans: shade(def.police.uniform, 0.55), skin: app.look.skin, cap: shade(def.police.uniform, 0.7) } : app.look;
      const varied = varyLook(look, id);
      if (!def.police && !def.player && this.boxCrowd!.add(id, varied)) return { ...base, look: varied };
      base.look = look;
      base.model = buildPedModel(look);
      base.phase = 0;
      this.parent.add(base.model.root);
      return base;
    }
    if (!def.police && !def.player) base.inCrowd = this.crowd!.add(id, app);
    return base;
  }

  private drop(id: EntityId, v: View) {
    if (v.box) {
      if (v.model) this.parent.remove(v.model.root);
      else this.boxCrowd?.remove(id);
      this.boxRagdolls?.forget(id);
    } else {
      this.removeActor(v);
      if (v.inCrowd) this.crowd?.remove(id);
      this.ragdollPoses?.forget(id);
    }
    this.views.delete(id);
  }

  /** Actors put away, by body: making one (a skeleton, a bone texture, three meshes, a mixer) is the dearest thing a person does, so they are reused. */
  private readonly pool = new Map<string, PedActor[]>();
  private pooled = 0;
  private made = 0;
  private readonly MAX_POOL = 10;

  private removeActor(v: View) {
    const a = v.actor;
    if (!a) return;
    v.actor = null;
    const list = this.pool.get(a.appearance.arch) ?? [];
    if (this.pooled < this.MAX_POOL) {
      a.park();
      list.push(a);
      this.pool.set(a.appearance.arch, list);
      this.pooled++;
    } else a.dispose();
  }

  /** An actor for a person: a parked one of their body if there is one. False when too many were made this frame (the person stays in the crowd a moment). */
  private makeActor(v: View, force = false): boolean {
    const list = this.pool.get(v.app.arch);
    let a = list?.pop();
    if (a) {
      this.pooled--;
      a.reuse(v.app, v.seed);
      this.parent.add(a.root);
    } else {
      if (!force && this.made >= 2) return false;
      this.made++;
      a = new PedActor(characterAssets()!, v.app, v.seed);
      a.setShadows(this.shadows);
      this.parent.add(a.root);
    }
    v.actor = a;
    return true;
  }

  /** One person for one frame. */
  frame(id: EntityId, st: EntityState, def: EntityDef | undefined, dt: number) {
    if (!def || def.kind !== EntityKind.Ped) return;
    let v = this.views.get(id);
    if (v && v.box && characterAssets()) {
      this.drop(id, v);
      v = undefined;
    }
    if (!v) {
      v = this.make(id, def);
      this.views.set(id, v);
    }
    const f = st.flags;
    const cam = this.game.camera.position;
    const dist = Math.hypot(st.x - cam.x, st.y - cam.y, st.z - cam.z);
    // heading and turning rate (for the turn-on-the-spot clips)
    const yaw = Math.atan2(2 * (st.q.x * st.q.z + st.q.w * st.q.y), 1 - 2 * (st.q.x * st.q.x + st.q.y * st.q.y));
    let dyaw = yaw - v.yaw;
    dyaw -= Math.round(dyaw / (2 * Math.PI)) * 2 * Math.PI;
    v.yawRate += ((dt > 0 ? dyaw / dt : 0) - v.yawRate) * Math.min(1, dt * 8);
    v.yaw = yaw;
    if (v.box) return this.frameBox(v, st, f, dt, dist);
    const ragdoll = (f & PedFlag.Ragdoll) !== 0;
    if (ragdoll && this.ragdollPoses!.update(this.game.view.sample, id)) {
      if (!v.actor) this.makeActor(v, true);
      const p = this.ragdollPoses!.pose(id)!;
      const a = v.actor!;
      a.root.visible = true;
      a.drive(p.pos, p.rot);
      a.setLod(actorLod(dist, this.game.tier.lodScale, a.currentLod()));
      return;
    }
    if (!ragdoll && this.ragdollPoses!.has(id)) this.ragdollPoses!.forget(id);
    // actor or crowd
    const wantActor = v.police || v.player || !v.inCrowd || this.near.has(id) || (v.actor?.isRagdoll ?? false);
    if (wantActor && !v.actor) this.makeActor(v, v.police || v.player || !v.inCrowd);
    else if (!wantActor && v.actor) this.removeActor(v);
    const mode: PedMode = f & PedFlag.Dragged ? 'dragged' : f & PedFlag.InVehicle ? 'seated' : f & PedFlag.Fighting ? 'fighting' : f & PedFlag.Fleeing ? 'fleeing' : 'normal';
    const x = this.extra;
    const gun = f & PedFlag.Armed ? weaponByIndex(gunWeapon(st.gun)) : undefined;
    x.aim = f & PedFlag.Aiming ? st.aimPitch : undefined;
    x.long = !!gun && (gun.kind === 'rifle' || gun.kind === 'shotgun');
    x.crouch = (f & PedFlag.Crouched) !== 0;
    x.cover = (f & PedFlag.InCover) !== 0;
    x.flinch = f & PedFlag.Flinch ? 1 : 0;
    x.firing = (f & PedFlag.Firing) !== 0;
    x.reload = f & PedFlag.Reloading ? 1 : 0;
    x.stumble = f & PedFlag.Stumble ? 1 : 0;
    const inp = this.input;
    inp.speed = st.speed;
    inp.grounded = (f & PedFlag.Grounded) !== 0;
    inp.mode = mode;
    inp.pose = (f & PedFlag.PoseMask) >> PedFlag.PoseShift;
    inp.swing = st.aux1;
    inp.yawRate = v.yawRate;
    inp.extra = x;
    const a = v.actor;
    if (a) {
      a.root.position.set(st.x, st.y, st.z);
      a.root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
      a.setGun(gun ? gun.kind : null);
      a.setLod(actorLod(dist, this.game.tier.lodScale, a.currentLod()));
      // an officer sitting in a far car is not worth a skeleton; the player's own body would fill the view when aiming from a car
      let show = true;
      if (v.police && f & PedFlag.InVehicle) show = dist < 40;
      if (this.game.aim?.active && this.game.view.inVehicle && id === this.game.view.ped?.id) show = false;
      a.root.visible = show;
      v.kick = x.firing ? 1 : Math.max(0, v.kick - dt * 8);
      if (show) a.update(dt, inp, x.aim ?? 0, v.kick);
    } else if (v.inCrowd) {
      this.crowd!.place(id, dt, st.x, st.y, st.z, st.q, inp);
    }
  }

  private frameBox(v: View, st: EntityState, f: number, dt: number, dist: number) {
    const id = v.id;
    if (v.model) {
      v.model.root.position.set(st.x, st.y, st.z);
      v.model.root.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
      if (v.police && f & PedFlag.InVehicle) v.model.root.visible = dist < 40;
    }
    if (f & PedFlag.Ragdoll && this.boxRagdolls!.update(this.game.view.sample, id)) {
      if (v.model) v.model.root.visible = false;
      else this.boxCrowd!.hide(id);
      this.boxRagdolls!.place(id, v.look);
      v.lie = f & PedFlag.Dead ? -1 : 1;
      return;
    }
    if (!(f & PedFlag.Ragdoll) && this.boxRagdolls!.has(id)) {
      this.boxRagdolls!.forget(id);
      v.lie = 0;
      if (v.model) v.model.root.visible = true;
    }
    v.phase += dt * (3.5 + st.speed * 1.5);
    const mode: PedMode = f & PedFlag.Dragged ? 'dragged' : f & PedFlag.InVehicle ? 'seated' : f & PedFlag.Fighting ? 'fighting' : f & PedFlag.Fleeing ? 'fleeing' : 'normal';
    const lieTo = f & PedFlag.Dead ? -1 : f & PedFlag.Downed ? 1 : 0;
    v.lie += (lieTo - v.lie) * Math.min(1, dt * 14);
    const pedPose = (f & PedFlag.PoseMask) >> PedFlag.PoseShift;
    if (v.model) {
      v.model.lie(v.lie);
      const gun = f & PedFlag.Armed ? weaponByIndex(gunWeapon(st.gun)) : undefined;
      v.model.setGun(gun ? gun.kind : null);
      v.model.root.visible = !(this.game.aim?.active && this.game.view.inVehicle && id === this.game.view.ped?.id);
      const x = this.extra;
      x.aim = f & PedFlag.Aiming ? st.aimPitch : undefined;
      x.long = !!gun && (gun.kind === 'rifle' || gun.kind === 'shotgun');
      x.crouch = (f & PedFlag.Crouched) !== 0;
      x.cover = (f & PedFlag.InCover) !== 0;
      x.flinch = f & PedFlag.Flinch ? 1 : 0;
      x.firing = (f & PedFlag.Firing) !== 0;
      x.reload = f & PedFlag.Reloading ? 1 : 0;
      x.stumble = f & PedFlag.Stumble ? 1 : 0;
      v.model.pose(st.speed, (f & PedFlag.Grounded) !== 0, v.phase, mode, st.aux1, pedPose, this.time + v.seed, f & (PedFlag.Aiming | PedFlag.Crouched | PedFlag.InCover | PedFlag.Flinch | PedFlag.Reloading | PedFlag.Stumble) ? x : undefined);
    } else {
      const x = this.extra;
      x.aim = undefined;
      x.crouch = x.cover = x.firing = false;
      x.flinch = f & PedFlag.Flinch ? 1 : 0;
      x.reload = 0;
      x.stumble = f & PedFlag.Stumble ? 1 : 0;
      solvePose(this.joints, st.speed, (f & PedFlag.Grounded) !== 0, v.phase, mode, st.aux1, pedPose, this.time, v.lie, v.seed, x.flinch || x.stumble ? x : undefined);
      this.boxCrowd!.place(id, st.x, st.y, st.z, st.q, this.joints);
    }
  }

  /** After the frame's people: drops the gone, commits the instances. */
  end(dt: number, entities: ReadonlyMap<EntityId, EntityState>, defs: ReadonlyMap<EntityId, EntityDef>) {
    this.time += dt;
    for (const [id, v] of this.views) if (!entities.has(id) || !defs.has(id)) this.drop(id, v);
    this.boxRagdolls?.end();
    this.boxCrowd?.commit();
    this.crowd?.commit(this.warmFrames > 0);
    if (this.warm && --this.warmFrames <= 0) {
      this.warm.removeFromParent();
      (this.warm.children[0] as THREE.Mesh | undefined)?.material && ((this.warm.children[0] as THREE.Mesh).material as THREE.Material).dispose();
      this.warm = null;
      if (this.warmActor) {
        const a = this.warmActor;
        this.warmActor = null;
        a.park();
        this.pool.set(a.appearance.arch, [...(this.pool.get(a.appearance.arch) ?? []), a]);
        this.pooled++;
      }
    }
  }

  dispose() {
    for (const [id, v] of [...this.views]) this.drop(id, v);
    for (const list of this.pool.values()) for (const a of list) a.dispose();
    this.pool.clear();
    this.boxCrowd?.dispose();
    this.boxRagdolls?.dispose();
    this.crowd?.dispose();
    this.ragdollPoses?.dispose();
  }
}

