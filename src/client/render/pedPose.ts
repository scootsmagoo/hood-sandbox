/**
 * The pose of a stand-in pedestrian as joint angles: a pure function of speed, walk phase, what the
 * sim says the ped is doing and the time. Both the per-ped model (the player and officers) and the
 * instanced crowd (everyone else) read the same numbers, so they cannot drift apart.
 *
 * Model space: faces +Z, +X to its left, feet at y = 0, hips at y = 0.9, shoulders at y = 1.48.
 * `rot.x` of a limb swings it: negative swings it forward and up.
 */
import { PedPose } from '../../shared/snapshot';
import { SEATED_SCALE } from '../../shared/doors';

/** What a ped is doing, for the pose (from the sim's flags). */
export type PedMode = 'normal' | 'seated' | 'dragged' | 'fleeing' | 'fighting';

export interface PedJoints {
  /** Scale of the whole body (seated drivers are a little smaller), and its tilt and shift about the feet. */
  scale: number;
  tiltX: number;
  shiftY: number;
  shiftZ: number;
  legL: number;
  legR: number;
  armL: number;
  armR: number;
  /** Sideways swing of each arm (rot.z): positive swings the left arm out and the right arm in. */
  armLz: number;
  armRz: number;
  /** The torso: lean, twist, and height of the hips. */
  torsoX: number;
  torsoY: number;
  torsoLift: number;
}

export function newJoints(): PedJoints {
  return { scale: 1, tiltX: 0, shiftY: 0, shiftZ: 0, legL: 0, legR: 0, armL: 0, armR: 0, armLz: 0, armRz: 0, torsoX: 0, torsoY: 0, torsoLift: 0 };
}

const HIPS = 0.9;

/**
 * Fills `j`. `lie` is how far toppled (1 on the back, -1 face down); `time` is seconds, `seed` a
 * per-ped offset so a crowd does not move in step.
 */
export function solvePose(j: PedJoints, speed: number, grounded: boolean, phase: number, mode: PedMode, swing: number, pose: number, time: number, lie: number, seed = 0): PedJoints {
  j.scale = mode === 'seated' ? SEATED_SCALE : 1;
  j.tiltX = 0;
  j.shiftY = 0;
  j.shiftZ = 0;
  j.armLz = 0;
  j.armRz = 0;
  j.torsoY = 0;
  j.torsoLift = 0;
  if (Math.abs(lie) > 0.02 && mode !== 'seated' && mode !== 'dragged') {
    // On the ground: the whole figure tips over about its feet, limbs a little flung.
    const flop = Math.abs(lie);
    j.tiltX = -lie * (Math.PI / 2);
    j.shiftY = 0.17 * flop;
    j.shiftZ = 0.85 * lie;
    j.legL = 0.1 * flop;
    j.legR = -0.2 * flop;
    j.armL = -0.4 * flop;
    j.armR = 0.3 * flop;
    j.torsoX = 0;
    j.torsoY = 0.2 * flop;
    return j;
  }
  if (mode === 'seated') {
    // Thighs forward under the wheel, hands up on it.
    j.legL = j.legR = -1.45;
    j.armL = j.armR = -1.15;
    j.torsoX = 0.05;
    return j;
  }
  if (mode === 'dragged') {
    // Hauled backwards out of the seat: heels trailing, arms flung up.
    j.legL = -0.9 + Math.sin(phase * 3) * 0.35;
    j.legR = -0.5 - Math.sin(phase * 3) * 0.35;
    j.armL = -2.6 + Math.sin(phase * 4) * 0.3;
    j.armR = -2.9 - Math.sin(phase * 4) * 0.3;
    j.torsoX = -0.35;
    return j;
  }
  if (!grounded) {
    j.legL = -0.5;
    j.legR = 0.35;
    j.armL = -2.2;
    j.armR = -2.0;
    j.torsoX = 0.05;
    return j;
  }
  const t = time + seed;
  if (pose !== PedPose.None && speed < 0.5) return idlePose(j, pose, t);
  const amp = Math.min(1, speed / 4.6) * (mode === 'fleeing' ? 1.2 : 0.95);
  const s = Math.sin(phase) * amp;
  j.legL = s;
  j.legR = -s;
  j.armL = -s * 0.9;
  j.armR = s * 0.9;
  j.torsoX = Math.min(0.25, speed * 0.03) + (mode === 'fleeing' ? 0.18 : 0);
  j.torsoLift = Math.abs(Math.sin(phase)) * 0.04 * amp;
  if (mode === 'fighting') {
    // Guard up, then the right hand winds back and whips forward.
    j.armL = -1.2;
    j.armR = swing > 0 ? 0.9 - swing * 2.7 : -1.3;
    j.torsoX = 0.12 + swing * 0.15;
    j.torsoY = -swing * 0.5;
  } else if (speed < 0.3) {
    // Standing: a slow sway and breathing, so a crowd is not a wax museum.
    j.armL = Math.sin(t * 1.3) * 0.05;
    j.armR = -Math.sin(t * 1.3) * 0.05;
    j.torsoY = Math.sin(t * 0.4) * 0.06;
    j.torsoLift = Math.sin(t * 1.9) * 0.004;
  }
  return j;
}

/** Standing, sitting, crouching: what people do when they are not going anywhere. */
function idlePose(j: PedJoints, pose: number, t: number): PedJoints {
  switch (pose) {
    case PedPose.Sit:
      // Hips down to a bench's height, thighs forward, hands in the lap.
      j.shiftY = -0.43;
      j.legL = -1.5;
      j.legR = -1.5;
      j.armL = -0.5;
      j.armR = -0.5;
      j.torsoX = 0.04 + Math.sin(t * 0.5) * 0.02;
      j.torsoY = Math.sin(t * 0.3) * 0.08;
      break;
    case PedPose.Phone:
      // The right hand to the ear, weight on one foot.
      j.armR = -2.75 + Math.sin(t * 0.9) * 0.04;
      j.armRz = 0.55;
      j.armL = 0.05;
      j.legL = 0.05;
      j.legR = -0.04;
      j.torsoY = Math.sin(t * 0.35) * 0.1;
      j.torsoX = 0.05;
      break;
    case PedPose.Film:
      // Both arms up in front, holding a phone out.
      j.armL = -1.6 + Math.sin(t * 1.1) * 0.03;
      j.armR = -1.55;
      j.armLz = -0.15;
      j.armRz = 0.15;
      j.torsoX = -0.04;
      break;
    case PedPose.Cower:
      // Down on their heels, hunched, arms over the head.
      j.shiftY = -0.4;
      j.legL = -1.3;
      j.legR = -1.2;
      j.torsoX = 0.75;
      j.armL = -2.9;
      j.armR = -2.8;
      j.armLz = -0.3;
      j.armRz = 0.3;
      j.tiltX = 0.12;
      break;
    case PedPose.Chat:
      // Talking with their hands.
      j.armR = -0.9 + Math.sin(t * 5.2) * 0.5;
      j.armL = -0.5 + Math.sin(t * 4.1 + 1) * 0.35;
      j.armRz = 0.2;
      j.torsoY = Math.sin(t * 0.9) * 0.18;
      j.torsoX = 0.04;
      break;
    case PedPose.Atm:
      // Leaning in, one hand out to the keys.
      j.torsoX = 0.14;
      j.armR = -1.15 + Math.sin(t * 1.7) * 0.08;
      j.armL = -0.25;
      break;
    case PedPose.Browse:
      // Leaning toward a window, hands behind.
      j.torsoX = 0.16;
      j.armL = 0.35;
      j.armR = 0.35;
      j.torsoY = Math.sin(t * 0.5) * 0.12;
      break;
    default:
      break;
  }
  return j;
}
