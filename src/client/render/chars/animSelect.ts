/**
 * Which clips a person plays: a pure function from what the sim says (speed, flags, pose, aim) to a
 * list of weighted layers. The near figures (`PedActor`) play the layers through an AnimationMixer;
 * the crowd bakes the same clips into a texture and plays the two heaviest. Clip names are the ones
 * tools/blender/characters/clips.py makes; `@upper` and `@lower` are the same clip with only the
 * upper-body or lower-body tracks (so a rifle is held up while the legs run).
 *
 * Locomotion clips share one phase (they all start on the left heel strike), so blending walk into
 * a jog does not make the feet fight; the phase advances at `speed / stride` cycles a second, which
 * keeps the feet from sliding on the ground at the clip's own pace.
 */
import { PedPose } from '../../../shared/snapshot';
import type { PedMode, PoseExtra } from '../pedPose';

export type ClipName =
  | 'idle' | 'walk' | 'jog' | 'sprint' | 'flee' | 'turn_l' | 'turn_r' | 'sit' | 'phone' | 'film' | 'cower' | 'chat' | 'atm' | 'browse'
  | 'fight' | 'punch' | 'aim_pistol' | 'aim_rifle' | 'aim_crouch' | 'cover' | 'cover_low' | 'reload' | 'drive' | 'enter_car' | 'exit_car'
  | 'dragged' | 'stumble' | 'flinch' | 'fall' | 'getup_back' | 'getup_front';

/** The speed each locomotion clip was authored at (m/s) and the distance a cycle covers there (m). */
export const GAIT = {
  walk: { speed: 1.5, stride: 1.65 },
  jog: { speed: 3.3, stride: 2.5 },
  sprint: { speed: 5.5, stride: 3.2 },
  flee: { speed: 4.6, stride: 2.8 },
} as const;

export interface AnimInput {
  /** m/s along the ground. */
  speed: number;
  grounded: boolean;
  mode: PedMode;
  /** The sim's `PedPose`. */
  pose: number;
  /** A punch's progress, 0 to 1 (0: not punching). */
  swing: number;
  /** Turning rate in place, rad/s, positive to the left. */
  yawRate: number;
  extra?: PoseExtra;
}

export type TimeMode = 'loco' | 'loop' | 'fixed';

export interface Layer {
  /** A clip name, optionally with `@upper` or `@lower`. */
  clip: string;
  weight: number;
  time: TimeMode;
  /** For `fixed`: the position in the clip, 0 to 1. */
  u?: number;
}

export interface Plan {
  layers: Layer[];
  /** Locomotion phase speed, cycles a second (0 when no layer is `loco`). */
  cadence: number;
}

/** A plan that is written again every frame without making anything new: its layers are reused. */
export class PlanBuffer implements Plan {
  layers: Layer[] = [];
  cadence = 0;
  private readonly pool: Layer[] = [];
  private n = 0;
  reset() {
    this.n = 0;
    this.layers.length = 0;
    this.cadence = 0;
    return this;
  }
  add(clip: string, weight: number, time: TimeMode, u?: number): Layer {
    let l = this.pool[this.n];
    if (!l) this.pool[this.n] = l = { clip, weight, time, u };
    else {
      l.clip = clip;
      l.weight = weight;
      l.time = time;
      l.u = u;
    }
    this.n++;
    this.layers.push(l);
    return l;
  }
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const POSE_CLIP: Record<number, ClipName> = {
  [PedPose.Sit]: 'sit',
  [PedPose.Phone]: 'phone',
  [PedPose.Film]: 'film',
  [PedPose.Cower]: 'cower',
  [PedPose.Chat]: 'chat',
  [PedPose.Atm]: 'atm',
  [PedPose.Browse]: 'browse',
};

/** The weights of the locomotion clips at a speed: idle, walk, jog and sprint (or flee). */
export function locoWeights(speed: number, fleeing: boolean) {
  const moving = sstep(0.1, 0.6, speed);
  const run = fleeing ? sstep(1.9, 2.6, speed) : sstep(2.1, 2.9, speed);
  const fast = fleeing ? 0 : sstep(4.2, 5.0, speed);
  return { idle: 1 - moving, walk: moving * (1 - run), jog: fleeing ? 0 : moving * run * (1 - fast), sprint: fleeing ? 0 : moving * run * fast, flee: fleeing ? moving * run : 0 };
}

function pushLoco(out: PlanBuffer, speed: number, fleeing: boolean, suffix: string, withIdle: boolean): number {
  const w = locoWeights(speed, fleeing);
  let stride = 0;
  let sum = 0;
  for (const k of ['walk', 'jog', 'sprint', 'flee'] as const) {
    if (w[k] < 0.01) continue;
    out.add(`${k}${suffix}`, w[k], 'loco');
    stride += w[k] * GAIT[k].stride;
    sum += w[k];
  }
  if (withIdle && w.idle >= 0.01) out.add(`idle${suffix}`, w.idle, 'loop');
  return sum > 0 ? speed / (stride / sum) : 0;
}

export function planFor(i: AnimInput): Plan {
  return planInto(new PlanBuffer(), i);
}

/** `planFor` into a buffer, making nothing new (the per-person plans of every frame). */
export function planInto(out: PlanBuffer, i: AnimInput): Plan {
  out.reset();
  const x = i.extra;
  const done = (cadence = 0): Plan => {
    if (x?.flinch) out.add('flinch@upper', 0.9 * x.flinch, 'fixed', 0.45);
    out.cadence = cadence;
    return out;
  };
  if (i.mode === 'seated') {
    if (x?.aim !== undefined) {
      out.add('drive@lower', 1, 'loop');
      out.add(x.long ? 'aim_rifle@upper' : 'aim_pistol@upper', 1, 'loop');
    }
    else out.add('drive', 1, 'loop');
    return done();
  }
  if (i.mode === 'dragged') {
    out.add('dragged', 1, 'loop');
    return done();
  }
  if (!i.grounded) {
    out.add('fall', 1, 'loop');
    return done();
  }
  if (x?.stumble) {
    out.add('stumble', 1, 'loop');
    return done();
  }
  const moving = i.speed > 0.35;
  const fleeing = i.mode === 'fleeing';
  if (x?.aim !== undefined) {
    const gun = x.crouch ? 'aim_crouch' : x.long ? 'aim_rifle' : 'aim_pistol';
    if (moving && !x.crouch) {
      out.add(`${gun}@upper`, 1, 'loop');
      return done(pushLoco(out, i.speed, false, '@lower', true));
    }
    out.add(gun, 1, 'loop');
    return done();
  }
  if (x?.reload) {
    out.add('reload@upper', 1, 'loop');
    if (moving) return done(pushLoco(out, i.speed, false, '@lower', true));
    out.add('idle@lower', 1, 'loop');
    return done();
  }
  if (x?.crouch) {
    out.add('cover_low', 1, 'loop');
    return done();
  }
  if (x?.cover) {
    out.add('cover', 1, 'loop');
    return done();
  }
  if (i.mode === 'fighting') {
    if (i.swing > 0.001) {
      out.add('punch', 1, 'fixed', Math.min(1, i.swing));
      return done();
    }
    if (!moving) {
      out.add('fight', 1, 'loop');
      return done();
    }
  }
  if (!moving && i.pose !== PedPose.None && POSE_CLIP[i.pose]) {
    out.add(POSE_CLIP[i.pose], 1, 'loop');
    return done();
  }
  if (!moving && Math.abs(i.yawRate) > 0.9) {
    const k = sstep(0.9, 1.7, Math.abs(i.yawRate));
    out.add(i.yawRate > 0 ? 'turn_l' : 'turn_r', k, 'loop');
    out.add('idle', 1 - k, 'loop');
    return done();
  }
  return done(pushLoco(out, i.speed, fleeing, '', true));
}

/** The two heaviest layers, renormalised: what the crowd's baked animation can play. Masked layers are dropped to their full clip. */
export function topTwo(layers: readonly Layer[]): [Layer, Layer | null] {
  // the full clips and the lower halves (a person who is aiming is never in the crowd, but the choice is the same); nothing is made here
  let a: Layer | null = null;
  let b: Layer | null = null;
  for (const l of layers) {
    if (l.clip.endsWith('@upper')) continue;
    if (!a || l.weight > a.weight) {
      b = a;
      a = l;
    } else if (!b || l.weight > b.weight) b = l;
  }
  return [a ?? layers[0], a ? b : null];
}

/** The clips the crowd needs baked (it never aims, drives or fights). */
export const CROWD_CLIPS: readonly ClipName[] = ['idle', 'walk', 'jog', 'sprint', 'flee', 'turn_l', 'turn_r', 'sit', 'phone', 'film', 'cower', 'chat', 'atm', 'browse', 'stumble', 'fall', 'fight', 'dragged', 'drive'];
