/**
 * The ragdoll rig, shared by the sim (which builds Rapier bodies and joints from it) and the client
 * (which draws the block figure's parts from the transforms the sim sends). Eleven parts: pelvis,
 * torso, head, upper and lower arms, thighs and shins, matching the stand-in figure (1.74 m, hips at
 * 0.9, shoulders at 1.48, feet at 0) split at the elbows and knees.
 *
 * Figure space is the ped model's: +Z forward, +Y up, +X to its left, feet at y = 0. In the rest pose
 * every part's frame is the figure's, so a part's rotation is its whole orientation in the world.
 *
 * On the wire a ragdoll is its pelvis centre and eleven rotations (`RAG_WORDS` words, see
 * shared/snapshot.ts); the part positions follow from the joints (`forwardKinematics`).
 */
import { rotateVec, type Quat, type Vec3 } from './math';

export const RagPart = {
  Pelvis: 0,
  Torso: 1,
  Head: 2,
  UpperArmL: 3,
  LowerArmL: 4,
  UpperArmR: 5,
  LowerArmR: 6,
  ThighL: 7,
  ShinL: 8,
  ThighR: 9,
  ShinR: 10,
} as const;
export const RAG_PARTS = 11;

export interface RagPartDef {
  name: string;
  /** Index of the part it hangs from, -1 for the pelvis (the root). Parents come before children. */
  parent: number;
  /** Centre in the rest pose, figure space. */
  centre: readonly [number, number, number];
  /** Collision shape around the centre: a box (half extents), a capsule along Y (radius, half height) or a ball (radius). */
  shape: { kind: 'box'; half: readonly [number, number, number]; round?: number } | { kind: 'capsule'; radius: number; halfHeight: number };
  mass: number;
  /** The joint to the parent: where it is in the rest pose (figure space), and a ball or a hinge about +X with limits (radians). */
  joint: { at: readonly [number, number, number]; kind: 'ball' } | { at: readonly [number, number, number]; kind: 'hinge'; min: number; max: number } | null;
  /** The block drawn for the part, around its centre: size and offset (figure space, rest pose). */
  draw: { size: readonly [number, number, number]; offset: readonly [number, number, number] };
}

const arm = (side: 1 | -1, upper: boolean): RagPartDef => ({
  name: `${upper ? 'upperArm' : 'lowerArm'}${side > 0 ? 'L' : 'R'}`,
  parent: upper ? RagPart.Torso : side > 0 ? RagPart.UpperArmL : RagPart.UpperArmR,
  centre: [0.27 * side, upper ? 1.33 : 1.03, 0],
  shape: { kind: 'capsule', radius: upper ? 0.055 : 0.05, halfHeight: 0.1 },
  mass: upper ? 2.5 : 2,
  // the elbow bends forward: the forearm swings toward -X rotation (forward and up)
  joint: upper ? { at: [0.27 * side, 1.47, 0], kind: 'ball' } : { at: [0.27 * side, 1.18, 0], kind: 'hinge', min: -2.4, max: 0 },
  draw: { size: [0.12, 0.3, 0.14], offset: [0, 0, 0] },
});

const leg = (side: 1 | -1, upper: boolean): RagPartDef => ({
  name: `${upper ? 'thigh' : 'shin'}${side > 0 ? 'L' : 'R'}`,
  parent: upper ? RagPart.Pelvis : side > 0 ? RagPart.ThighL : RagPart.ThighR,
  centre: [0.1 * side, upper ? 0.69 : 0.25, upper ? 0 : 0.03],
  shape: upper ? { kind: 'capsule', radius: 0.08, halfHeight: 0.13 } : { kind: 'box', half: [0.075, 0.23, 0.1] },
  mass: upper ? 9 : 5,
  // the knee bends backward
  joint: upper ? { at: [0.1 * side, 0.9, 0], kind: 'ball' } : { at: [0.1 * side, 0.48, 0], kind: 'hinge', min: 0, max: 2.4 },
  draw: upper ? { size: [0.17, 0.43, 0.2], offset: [0, 0, 0] } : { size: [0.17, 0.44, 0.2], offset: [0, 0.01, -0.03] },
});

export const RAG_RIG: readonly RagPartDef[] = [
  { name: 'pelvis', parent: -1, centre: [0, 1.0, 0], shape: { kind: 'box', half: [0.19, 0.11, 0.12] }, mass: 11, joint: null, draw: { size: [0.44, 0.22, 0.26], offset: [0, 0, 0] } },
  { name: 'torso', parent: RagPart.Pelvis, centre: [0, 1.3, 0], shape: { kind: 'box', half: [0.21, 0.19, 0.12] }, mass: 22, joint: { at: [0, 1.11, 0], kind: 'ball' }, draw: { size: [0.44, 0.4, 0.26], offset: [0, 0, 0] } },
  // (a rounded box, not a ball: a ball rolls about on the ground for ever)
  { name: 'head', parent: RagPart.Torso, centre: [0, 1.62, 0.01], shape: { kind: 'box', half: [0.075, 0.085, 0.085], round: 0.035 }, mass: 5.5, joint: { at: [0, 1.5, 0], kind: 'ball' }, draw: { size: [0.23, 0.23, 0.23], offset: [0, 0, 0] } },
  arm(1, true),
  arm(1, false),
  arm(-1, true),
  arm(-1, false),
  leg(1, true),
  leg(1, false),
  leg(-1, true),
  leg(-1, false),
];

export const RAG_MASS = RAG_RIG.reduce((s, p) => s + p.mass, 0);

/** Where the pelvis centre sits above the feet when standing, m. */
export const RAG_PELVIS_HEIGHT = RAG_RIG[0].centre[1];

/**
 * Fills `pos` (11 x 3) from the pelvis centre and the eleven rotations (`rot`, 11 x 4: x, y, z, w),
 * walking the joints from the pelvis out. Rotations are world orientations of each part's frame.
 */
export function forwardKinematics(pelvis: Vec3, rot: ArrayLike<number>, pos: Float32Array | number[]) {
  pos[0] = pelvis.x;
  pos[1] = pelvis.y;
  pos[2] = pelvis.z;
  const q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const v: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 1; i < RAG_PARTS; i++) {
    const d = RAG_RIG[i];
    const p = d.parent;
    const at = d.joint!.at;
    const pc = RAG_RIG[p].centre;
    // the joint in the world, from the parent
    q.x = rot[p * 4]; q.y = rot[p * 4 + 1]; q.z = rot[p * 4 + 2]; q.w = rot[p * 4 + 3];
    rotateVec(q, at[0] - pc[0], at[1] - pc[1], at[2] - pc[2], v);
    const jx = pos[p * 3] + v.x;
    const jy = pos[p * 3 + 1] + v.y;
    const jz = pos[p * 3 + 2] + v.z;
    // and the part's centre from the joint
    q.x = rot[i * 4]; q.y = rot[i * 4 + 1]; q.z = rot[i * 4 + 2]; q.w = rot[i * 4 + 3];
    rotateVec(q, d.centre[0] - at[0], d.centre[1] - at[1], d.centre[2] - at[2], v);
    pos[i * 3] = jx + v.x;
    pos[i * 3 + 1] = jy + v.y;
    pos[i * 3 + 2] = jz + v.z;
  }
}

/** The standing rest pose at feet (x, y, z) facing `yaw`: positions (11 x 3) and rotations (11 x 4). */
export function restPose(x: number, y: number, z: number, yaw: number, pos: Float32Array | number[], rot: Float32Array | number[]) {
  const s = Math.sin(yaw / 2);
  const c = Math.cos(yaw / 2);
  const q: Quat = { x: 0, y: s, z: 0, w: c };
  const v: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < RAG_PARTS; i++) {
    const ctr = RAG_RIG[i].centre;
    rotateVec(q, ctr[0], ctr[1], ctr[2], v);
    pos[i * 3] = x + v.x;
    pos[i * 3 + 1] = y + v.y;
    pos[i * 3 + 2] = z + v.z;
    rot[i * 4] = 0;
    rot[i * 4 + 1] = s;
    rot[i * 4 + 2] = 0;
    rot[i * 4 + 3] = c;
  }
}

/** Packs a unit quaternion into two words (four signed 16-bit numbers), for the snapshot. */
export function packQuat(x: number, y: number, z: number, w: number, out: Uint32Array, at: number) {
  // keep w >= 0 (q and -q are the same rotation), so the receiver's blend takes the short way
  const s = w < 0 ? -32767 : 32767;
  out[at] = ((Math.round(x * s) & 0xffff) | ((Math.round(y * s) & 0xffff) << 16)) >>> 0;
  out[at + 1] = ((Math.round(z * s) & 0xffff) | ((Math.round(w * s) & 0xffff) << 16)) >>> 0;
}

const s16 = (v: number) => ((v & 0xffff) << 16) >> 16;

/** Unpacks `packQuat`'s two words into `out` at `o` (x, y, z, w), normalised. */
export function unpackQuat(src: Uint32Array, at: number, out: Float32Array | number[], o: number) {
  const a = src[at];
  const b = src[at + 1];
  const x = s16(a);
  const y = s16(a >>> 16);
  const z = s16(b);
  const w = s16(b >>> 16);
  const l = Math.hypot(x, y, z, w) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  out[o + 3] = w / l;
}
