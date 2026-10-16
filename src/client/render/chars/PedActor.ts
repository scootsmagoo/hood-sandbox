/**
 * A person near the camera (the player, officers, anyone within a dozen metres, a ragdolled body):
 * a SkinnedMesh at one of three levels of detail on its own skeleton, played by an AnimationMixer.
 * `planFor` (animSelect.ts) says which clips and how heavily; weights ease, so a stop or a start is
 * a blend, not a pop. Locomotion clips share a phase advanced by speed so the feet keep to the ground.
 * On top of the clips: the aim pitch (spine and chest), a recoil kick, and the ragdoll, which drives
 * the bones directly (`RagBones`). A gun, when held, hangs on the right hand.
 */
import * as THREE from 'three';
import { SEATED_SCALE } from '../../../shared/doors';
import type { WeaponKind } from '../../../shared/weapons';
import { gunMesh } from '../models';
import { PlanBuffer, planInto, type AnimInput, type Plan } from './animSelect';
import { doorOpenAmount, entryStep, type EntryStep } from './carEntry';
import { makeSkeleton, type CharacterAssets } from './characterAssets';
import { actorMaterial } from './pedMaterial';
import type { Appearance } from './outfits';
import { RagBones } from './ragBones';

/** Actor level of detail by distance (m, at lodScale 1). */
export const ACTOR_LOD = { near: 12, far: 36, hysteresis: 2 } as const;

export function actorLod(dist: number, lodScale: number, current = -1): 0 | 1 | 2 {
  const d = dist / Math.max(0.1, lodScale);
  const h = ACTOR_LOD.hysteresis;
  const near = ACTOR_LOD.near + (current === 0 ? h : current > 0 ? -h : 0);
  const far = ACTOR_LOD.far + (current >= 0 && current <= 1 ? h : current === 2 ? -h : 0);
  return d < near ? 0 : d < far ? 1 : 2;
}

const X = new THREE.Vector3(1, 0, 0);

/** The aim bend: the pitch it follows (a camera can look further), the torso's share and limit, the head's share, the neck's limit. */
export const AIM_PITCH_MAX = THREE.MathUtils.degToRad(75);
export const TORSO_SHARE = 0.5;
export const TORSO_MAX = THREE.MathUtils.degToRad(35);
export const TORSO_MAX_SEATED = THREE.MathUtils.degToRad(20);
const HEAD_SHARE = 0.75;
const NECK_MAX = THREE.MathUtils.degToRad(25);

const ragBonesCache = new WeakMap<object, RagBones>();

export class PedActor {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[];
  private readonly skeleton: THREE.Skeleton;
  private readonly meshes: (THREE.SkinnedMesh | null)[] = [];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly weights = new Map<string, number>();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly rag: RagBones;
  private readonly palette: Float32Array;
  private seed: number;
  private phase = 0;
  private clock = 0;
  private lod = 0;
  private gun: THREE.Mesh | null = null;
  private gunKind: WeaponKind | null = null;
  private ragdolled = false;
  private lastMode = '';
  /** A one-shot clip over the plan: getting in or out of a car. `from` is where the body was when it began (the door, or the seat): the sim moves it to the other in one step, the view walks it across. */
  private shot: { clip: string; t: number; enter: boolean; from: THREE.Vector3; fromQ: THREE.Quaternion; moves: boolean; door: THREE.Vector3 } | null = null;
  /** Where the door is being worked and how far it should stand open (0 to 1), while this person gets in or out. */
  doorAmount = 0;
  doorX = 0;
  doorZ = 0;
  private readonly lastPos = new THREE.Vector3();
  private readonly lastQuat = new THREE.Quaternion();
  private haveLast = false;
  private readonly toQ = new THREE.Quaternion();
  private readonly step: EntryStep = { move: 0, turn: 0, hop: 0 };
  private seatScale = 1;
  /** Animation level of detail: a far figure is posed every second or fourth frame. */
  private frame = 0;
  private readonly planBuf = new PlanBuffer();
  private owed = 0;
  private readonly overlay = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly figure = new THREE.Quaternion();
  /** Bones this actor has bent on top of the clips: the pose the mixer gave (`pre`) and what was left after the bend (`post`). */
  private readonly bent = new Map<number, { pre: THREE.Quaternion; post: THREE.Quaternion }>();
  private readonly mount = new THREE.Quaternion();
  /** Where the gun's origin (the middle of its grip) sits in the hand bone's frame: in the palm's fist, thumb side up. */
  private readonly grip = new THREE.Vector3();
  private readonly gripUp = new THREE.Vector3();
  private readonly idx: { spine: number; chest: number; neck: number; head: number; armL: number; armR: number; hand: number };
  /** Set by the owner: the scale the person is drawn at (height, width). */
  height = 1;
  width = 1;

  constructor(readonly assets: CharacterAssets, public appearance: Appearance, seed = 0) {
    this.seed = Math.floor(seed);
    const rig = assets.rig;
    const sk = makeSkeleton(rig);
    this.bones = sk.bones;
    this.skeleton = sk.skeleton;
    this.height = appearance.height;
    this.width = appearance.width;
    this.palette = new Float32Array(appearance.palette);
    this.material = actorMaterial(this.palette, this.seed);
    this.root.add(sk.root);
    this.root.name = `ped-${appearance.arch}`;
    for (let lod = 0; lod < 3; lod++) {
      const g = assets.geos.get(`${appearance.arch}_lod${lod}`) ?? assets.geos.get(`kudzu_lod${lod}`);
      if (!g) {
        this.meshes.push(null);
        continue;
      }
      const m = new THREE.SkinnedMesh(g, this.material);
      m.frustumCulled = false;
      m.castShadow = true;
      m.visible = lod === 0;
      this.root.add(m);
      m.bind(this.skeleton, new THREE.Matrix4());
      this.meshes.push(m);
    }
    this.mixer = new THREE.AnimationMixer(this.root);
    let rb = ragBonesCache.get(rig);
    if (!rb) ragBonesCache.set(rig, (rb = new RagBones(rig)));
    this.rag = rb;
    this.idx = { spine: rig.index.get('spine')!, chest: rig.index.get('chest')!, neck: rig.index.get('neck')!, head: rig.index.get('head')!, armL: rig.index.get('upperarm_L')!, armR: rig.index.get('upperarm_R')!, hand: rig.index.get('hand_R')! };
    // the gun's grip frame on the right hand: barrel along the hand, thumb side up
    const rh = new THREE.Quaternion().fromArray(rig.restWorldQuat, this.idx.hand * 4);
    const z = new THREE.Vector3(0, 1, 0).applyQuaternion(rh).normalize();
    const y = new THREE.Vector3(0, 0, 1);
    y.addScaledVector(z, -y.dot(z)).normalize();
    const xx = new THREE.Vector3().crossVectors(y, z);
    this.mount.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, y, z));
    this.mount.premultiply(rh.clone().invert());
    // along the hand 8 cm, 5 cm toward the thumb (the slide rides above the web of the hand), 3.4 cm into the curl of the fingers
    this.grip.set(0, 0, 0).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(this.mount), 0.082).addScaledVector(this.gripUp.set(0, 1, 0).applyQuaternion(this.mount), 0.028).addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(this.mount), 0.034);
  }

  /** Makes a parked actor of the same body someone else (their colours, size and clock). */
  reuse(a: Appearance, seed: number) {
    this.appearance = a;
    this.palette.set(a.palette);
    this.height = a.height;
    this.width = a.width;
    this.seed = Math.floor(seed);
    (this.material.userData.pedSeed as { value: number }).value = this.seed * 0.6180339 + 0.31;
    this.phase = 0;
    this.clock = 0;
    this.frame = 0;
    this.owed = 0;
    this.shot = null;
    this.haveLast = false;
    this.lastMode = '';
    this.seatScale = 1;
    this.setGun(null);
    this.root.visible = true;
  }

  /** Puts an actor away: hidden, at rest, no clip playing. */
  park() {
    this.root.visible = false;
    this.setGun(null);
    for (const a of this.actions.values()) {
      a.weight = 0;
      a.enabled = false;
    }
    this.weights.clear();
    this.rag.reset(this.bones);
    this.bent.clear();
    this.ragdolled = false;
    // out of the scene, and the bone texture is given back (it is made again on first use)
    this.root.removeFromParent();
    this.skeleton.dispose();
  }

  get visible() {
    return this.root.visible;
  }

  setLod(l: 0 | 1 | 2) {
    if (l === this.lod) return;
    this.lod = l;
    this.meshes.forEach((m, i) => {
      if (m) m.visible = i === l;
    });
  }

  currentLod() {
    return this.lod;
  }

  setShadows(on: boolean) {
    for (const m of this.meshes) if (m) m.castShadow = on;
  }

  setGun(kind: WeaponKind | null) {
    if (kind === this.gunKind) return;
    this.gunKind = kind;
    if (this.gun) {
      this.gun.parent?.remove(this.gun);
      this.gun = null;
    }
    if (!kind) return;
    const g = gunMesh(kind);
    g.quaternion.copy(this.mount);
    g.position.copy(this.grip);
    // a long gun's receiver is taller: the hand sits under it, not on the web beside a slide
    if (kind !== 'pistol') g.position.addScaledVector(this.gripUp, 0.028);
    g.scale.setScalar(1.12);
    this.bones[this.idx.hand].add(g);
    this.gun = g;
  }

  private action(name: string): THREE.AnimationAction | null {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.assets.clips.get(name);
    if (!clip || clip.tracks.length === 0) return null;
    a = this.mixer.clipAction(clip);
    a.timeScale = 0;
    a.weight = 0;
    a.enabled = false;
    a.play();
    this.actions.set(name, a);
    return a;
  }

  /** Plays the plan: eases the weights and sets each clip's time. */
  private play(dt: number, plan: Plan) {
    this.phase = (this.phase + dt * plan.cadence) % 1;
    this.clock += dt;
    const want = new Map<string, number>();
    for (const l of plan.layers) want.set(l.clip, (want.get(l.clip) ?? 0) + l.weight);
    const k = 1 - Math.exp(-dt * 14);
    for (const [name, w] of this.weights) if (!want.has(name)) want.set(name, 0);
    for (const l of plan.layers) {
      const a = this.action(l.clip);
      if (!a) continue;
      const dur = a.getClip().duration;
      const u = l.time === 'loco' ? this.phase : l.time === 'fixed' ? l.u ?? 0 : ((this.clock + this.seed) / dur) % 1;
      a.time = Math.min(dur - 1e-4, Math.max(0, u * dur));
    }
    for (const [name, target] of want) {
      const a = this.action(name);
      if (!a) continue;
      let w = this.weights.get(name) ?? 0;
      w += (Math.min(1, target) - w) * k;
      if (target === 0 && w < 0.004) w = 0;
      this.weights.set(name, w);
      a.weight = w;
      a.enabled = w > 0;
      if (w === 0 && target === 0) this.weights.delete(name);
    }
  }

  /**
   * Rotates a bone about a figure-frame axis on top of its animated pose. The axis is taken into the parent's frame as the
   * parent stands now (the clip and any bend above it included), so the bend is about the same line in space whatever the clip does.
   */
  private twist(bone: number, axis: THREE.Vector3, angle: number) {
    let b = this.bent.get(bone);
    if (!b) this.bent.set(bone, (b = { pre: new THREE.Quaternion(), post: new THREE.Quaternion() }));
    const q = this.bones[bone].quaternion;
    b.pre.copy(q);
    this.figure.identity();
    for (let p = this.assets.rig.parent[bone]; p >= 0; p = this.assets.rig.parent[p]) this.figure.premultiply(this.bones[p].quaternion);
    this.axis.copy(axis).applyQuaternion(this.figure.invert());
    this.overlay.setFromAxisAngle(this.axis, angle);
    q.premultiply(this.overlay);
    b.post.copy(q);
  }

  /**
   * Takes last frame's bends off. The mixer writes a track's value only when it changes, and a held aim clip does not change:
   * the bend would be laid on again every frame and grow until the person is folded in two.
   */
  private unbend() {
    for (const [bone, b] of this.bent) {
      const q = this.bones[bone].quaternion;
      if (q.equals(b.post)) q.copy(b.pre);
    }
    this.bent.clear();
  }

  /**
   * The aim pitch (radians, up positive) as a pose: a share in the torso (spine, then chest, limited to about 35 degrees), the neck
   * turning the head toward the same line, and the arms taking the rest, so the gun points where the camera does and the body stays upright.
   */
  private aim(pitch: number, kick: number, seated: boolean) {
    const p = Math.max(-AIM_PITCH_MAX, Math.min(AIM_PITCH_MAX, pitch));
    // in a seat the back is already reclined and there is no room to lean: the arms take more
    const limit = seated ? TORSO_MAX_SEATED : TORSO_MAX;
    const torso = Math.max(-limit, Math.min(limit, p * TORSO_SHARE));
    // a positive angle about +X leans the figure forward: up is the other way
    this.twist(this.idx.spine, X, -torso * 0.45);
    this.twist(this.idx.chest, X, -torso * 0.55 - 0.06 * kick);
    const neck = Math.max(-NECK_MAX, Math.min(NECK_MAX, p * HEAD_SHARE - torso));
    this.twist(this.idx.neck, X, -neck);
    // the clips hold the arms level: they take what the torso does not, from the shoulder
    const arms = p - torso;
    this.twist(this.idx.armL, X, -arms);
    this.twist(this.idx.armR, X, -arms);
  }

  /**
   * One frame of a standing, walking, aiming person. `aimPitch` (radians, up positive) tilts the
   * torso when the plan has a gun up; `kick` (0 to 1) is the recoil.
   */
  update(dt: number, input: AnimInput, aimPitch = 0, kick = 0) {
    this.frame++;
    this.owed += dt;
    // far figures are posed less often (their clips are smooth, the skeleton keeps its last pose in between)
    const every = this.lod === 0 || this.shot || input.extra?.aim !== undefined ? 1 : this.lod === 1 ? 2 : 4;
    if (every > 1 && (this.frame + this.seed) % every !== 0 && !this.ragdolled) {
      this.root.scale.set(this.width * this.seatScale, this.height * this.seatScale, this.width * this.seatScale);
      return;
    }
    dt = this.owed;
    this.owed = 0;
    if (this.ragdolled) {
      this.ragdolled = false;
      this.rag.reset(this.bones);
      this.bent.clear();
      this.root.position.set(0, 0, 0);
    }
    if (this.lastMode && this.lastMode !== input.mode && (this.lastMode === 'seated' || input.mode === 'seated')) {
      // getting in or out: the sim puts the body at the seat (or beside the door) at once, so the view walks it there from where it was
      const enter = input.mode === 'seated';
      const near = this.haveLast && this.lastPos.distanceToSquared(this.root.position) < 3.5 * 3.5;
      this.shot = { clip: enter ? 'enter_car' : 'exit_car', t: 0, enter, from: this.lastPos.clone(), fromQ: this.lastQuat.clone(), moves: near, door: (enter ? this.lastPos : this.root.position).clone() };
    }
    this.lastMode = input.mode;
    let plan: Plan = planInto(this.planBuf, input);
    if (this.shot) {
      const dur = this.assets.clips.get(this.shot.clip)?.duration ?? 0.8;
      this.shot.t += dt;
      if (this.shot.t >= dur) {
        this.shot = null;
        this.doorAmount = 0;
      } else {
        const k = this.shot.t / dur;
        plan = { layers: [{ clip: this.shot.clip, weight: 1, time: 'fixed', u: k }], cadence: 0 };
        if (this.shot.moves) this.walkThroughDoor(this.shot, k);
        this.doorAmount = doorOpenAmount(k, this.shot.enter);
        this.doorX = this.shot.door.x;
        this.doorZ = this.shot.door.z;
      }
    }
    this.play(dt, plan);
    this.mixer.update(0);
    this.unbend();
    if (input.extra?.aim !== undefined) {
      this.aim(aimPitch, kick, input.mode === 'seated');
    }
    // the seat takes a little off the figure (shared/doors.ts); easing it keeps the exit from jumping
    this.seatScale += ((input.mode === 'seated' ? SEATED_SCALE : 1) - this.seatScale) * Math.min(1, dt * 12);
    const s = this.seatScale;
    this.root.scale.set(this.width * s, this.height * s, this.width * s);
    this.lastPos.copy(this.root.position);
    this.lastQuat.copy(this.root.quaternion);
    this.haveLast = true;
  }

  /**
   * Moves the body from where it was (`shot.from`) to where the sim put it, over the clip: in through the door, over the sill,
   * onto the seat (or the reverse, the body stays in the seat while it leans out and leaves it late), turning from facing the door to
   * facing the road. `root` already holds the sim's place for this frame; this pulls it back toward the start.
   */
  private walkThroughDoor(shot: { enter: boolean; from: THREE.Vector3; fromQ: THREE.Quaternion }, k: number) {
    const st = entryStep(k, shot.enter, this.step);
    const p = this.root.position;
    p.x += (shot.from.x - p.x) * (1 - st.move);
    p.z += (shot.from.z - p.z) * (1 - st.move);
    // up and over the sill: the vertical goes straight (the seat is lower than the street), with a hop in the middle
    p.y += (shot.from.y - p.y) * (1 - st.move) + st.hop;
    this.toQ.copy(this.root.quaternion);
    this.root.quaternion.copy(shot.fromQ).slerp(this.toQ, st.turn);
  }

  /** Draws a ragdoll: the bones follow the eleven bodies of the sim. `pos` 11 x 3, `rot` 11 x 4, world frame. */
  drive(pos: ArrayLike<number>, rot: ArrayLike<number>) {
    this.ragdolled = true;
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.set(1, 1, 1);
    this.rag.apply(this.bones, pos, rot);
  }

  get isRagdoll() {
    return this.ragdolled;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.skeleton.dispose();
    this.material.dispose();
    this.root.removeFromParent();
  }
}

