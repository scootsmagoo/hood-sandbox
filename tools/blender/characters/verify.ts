/**
 * Checks the built character file (public/assets/characters/characters.glb) against the numbers the
 * game relies on. Used by tests/characterAssets.test.ts, which `npm run assets` runs after building.
 *
 *   - every archetype in tools/blender/characters/outfits.py (and src/client/render/chars/outfits.ts)
 *     at three levels of detail, one primitive each, with position, normal, colour (occlusion and
 *     face cover), joints, weights and a region byte
 *   - triangles per level of detail within budget
 *   - bounds: a person 1.7 to 1.8 m tall standing on y = 0, arms within half a metre of the middle
 *   - the skeleton: 34 bones (22 of the body, 12 of the fingers) named as skeleton.py names them, at the places it puts them, with the
 *     parents it gives them (and the ragdoll's eleven bodies mapped onto bones that exist)
 *   - weights: at most four joints a vertex, summing to one, all joints in range
 *   - the clips: every clip the game plays is there, with tracks that move, unit quaternions, no NaN
 *   - file size
 */
import { readFileSync } from 'node:fs';
import { NodeIO, type Document, type Primitive } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

/** Triangles per level of detail: [min, max]. */
export const TRI_BUDGET: [number, number][] = [
  [3000, 5700],
  [800, 1600],
  [250, 650],
];
export const MAX_BYTES = 2_600_000;
export const BONES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicle_L', 'upperarm_L', 'forearm_L', 'hand_L', 'clavicle_R', 'upperarm_R', 'forearm_R', 'hand_R',
  'thigh_L', 'shin_L', 'foot_L', 'toe_L', 'thigh_R', 'shin_R', 'foot_R', 'toe_R',
  'thumb_a_L', 'thumb_b_L', 'index_a_L', 'index_b_L', 'fingers_a_L', 'fingers_b_L',
  'thumb_a_R', 'thumb_b_R', 'index_a_R', 'index_b_R', 'fingers_a_R', 'fingers_b_R',
];
/** The bones the ragdoll's eleven bodies drive (src/client/render/chars/ragBones.ts). */
export const RAG_BONES = ['pelvis', 'spine', 'head', 'upperarm_L', 'forearm_L', 'upperarm_R', 'forearm_R', 'thigh_L', 'shin_L', 'thigh_R', 'shin_R'];
/** Every clip the game asks for (animSelect.ts) and whether it loops. */
export const CLIPS: Record<string, boolean> = {
  idle: true, walk: true, jog: true, sprint: true, flee: true, turn_l: true, turn_r: true, sit: true, phone: true, film: true, cower: true, chat: true, atm: true,
  browse: true, fight: true, punch: false, aim_pistol: true, aim_rifle: true, aim_crouch: true, cover: true, cover_low: true, reload: true, drive: true, enter_car: false,
  exit_car: false, dragged: true, stumble: true, flinch: false, fall: true, getup_back: false, getup_front: false,
};

export interface CharManifest {
  file: string;
  bytes: number;
  regions: string[];
  bones: Record<string, { parent: string | null; head: number[] }>;
  tris: Record<string, number>;
  clips: Record<string, { duration: number; loop: boolean }>;
}

export async function readCharacters(path: string): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io.readBinary(new Uint8Array(readFileSync(path)));
}

export interface CharStats {
  bytes: number;
  tris: Record<string, number>;
  bounds: Record<string, { min: number[]; max: number[] }>;
  clips: string[];
}

export async function checkCharacters(path: string, archetypes: readonly string[], manifest?: CharManifest): Promise<{ problems: string[]; stats: CharStats }> {
  const problems: string[] = [];
  const bytes = readFileSync(path).length;
  const doc = await readCharacters(path);
  const root = doc.getRoot();
  const stats: CharStats = { bytes, tris: {}, bounds: {}, clips: [] };
  if (bytes > MAX_BYTES) problems.push(`file is ${bytes} bytes (max ${MAX_BYTES})`);

  // ---- the skeleton
  const skin = root.listSkins()[0];
  if (!skin) problems.push('no skin');
  else {
    const names = skin.listJoints().map((j) => j.getName());
    if (names.length !== BONES.length || BONES.some((b) => !names.includes(b))) problems.push(`joints are [${names.join(', ')}], expected [${BONES.join(', ')}]`);
    if (manifest) {
      for (const j of skin.listJoints()) {
        const want = manifest.bones[j.getName()];
        if (!want) continue;
        const p = j.getWorldTranslation();
        if (Math.hypot(p[0] - want.head[0], p[1] - want.head[1], p[2] - want.head[2]) > 2e-3) problems.push(`bone ${j.getName()} is at (${p.map((x) => x.toFixed(3))}), expected (${want.head})`);
        const parent = j.getParentNode()?.getName() ?? null;
        if (want.parent && parent !== want.parent) problems.push(`bone ${j.getName()} hangs from ${parent}, expected ${want.parent}`);
      }
    }
    for (const b of RAG_BONES) if (!skin.listJoints().some((j) => j.getName() === b)) problems.push(`ragdoll bone ${b} missing`);
    const pelvis = skin.listJoints().find((j) => j.getName() === 'pelvis');
    // the ragdoll's pelvis centre is 1.0 m above the feet (shared/ragdoll.ts)
    if (pelvis && Math.abs(pelvis.getWorldTranslation()[1] - 1.0) > 0.01) problems.push(`pelvis at ${pelvis.getWorldTranslation()[1]}, the ragdoll's is at 1.0`);
  }

  // ---- the meshes
  const byName = new Map(root.listMeshes().map((m) => [m.getName(), m]));
  for (const a of archetypes) {
    for (let lod = 0; lod < 3; lod++) {
      const name = `${a}_lod${lod}`;
      const mesh = byName.get(name);
      if (!mesh) {
        problems.push(`${name} is missing`);
        continue;
      }
      const prims = mesh.listPrimitives();
      if (prims.length !== 1) {
        problems.push(`${name} has ${prims.length} primitives, expected one`);
        continue;
      }
      const p = prims[0];
      for (const sem of ['POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0', '_REGION']) if (!p.getAttribute(sem)) problems.push(`${name} has no ${sem}`);
      const tris = (p.getIndices()?.getCount() ?? 0) / 3;
      stats.tris[name] = tris;
      const [lo, hi] = TRI_BUDGET[lod];
      if (tris < lo || tris > hi) problems.push(`${name}: ${tris} triangles, expected ${lo} to ${hi}`);
      if (manifest && manifest.tris[name] !== tris) problems.push(`${name}: manifest says ${manifest.tris[name]} triangles, the file has ${tris}`);
      checkPrimitive(name, p, problems, stats, lod);
    }
  }

  // ---- the clips
  const anims = new Map(root.listAnimations().map((a) => [a.getName(), a]));
  stats.clips = [...anims.keys()];
  const boneNames = new Set(BONES);
  for (const name of Object.keys(CLIPS)) {
    const a = anims.get(name);
    if (!a) {
      problems.push(`clip ${name} is missing`);
      continue;
    }
    if (a.listChannels().length === 0) problems.push(`clip ${name} has no tracks`);
    let moves = false;
    let end = 0;
    for (const ch of a.listChannels()) {
      const node = ch.getTargetNode();
      if (!node || !boneNames.has(node.getName())) problems.push(`clip ${name} animates ${node?.getName()}, which is not a bone`);
      const s = ch.getSampler()!;
      const t = s.getInput()!.getArray()!;
      const v = s.getOutput()!.getArray()!;
      end = Math.max(end, t[t.length - 1]);
      const k = ch.getTargetPath() === 'rotation' ? 4 : 3;
      for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) {
        problems.push(`clip ${name} has a non-finite value`);
        break;
      }
      if (k === 4) {
        for (let i = 0; i < v.length; i += 4) {
          const l = Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3]);
          if (Math.abs(l - 1) > 0.02) {
            problems.push(`clip ${name}: a quaternion of length ${l.toFixed(3)} on ${node?.getName()}`);
            break;
          }
        }
      }
      if (v.length > k) for (let c = 0; c < k && !moves; c++) for (let i = k + c; i < v.length; i += k) if (Math.abs(v[i] - v[c]) > 1e-3) { moves = true; break; }
    }
    if (!moves) problems.push(`clip ${name} never moves`);
    if (manifest && Math.abs(end - manifest.clips[name].duration) > 0.05) problems.push(`clip ${name} runs ${end.toFixed(2)} s, the manifest says ${manifest.clips[name].duration}`);
    if (end < 0.3 || end > 8) problems.push(`clip ${name} runs ${end.toFixed(2)} s`);
  }
  return { problems, stats };
}

function checkPrimitive(name: string, p: Primitive, problems: string[], stats: CharStats, lod: number) {
  const pos = p.getAttribute('POSITION')!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[k]);
      max[k] = Math.max(max[k], v[k]);
    }
  }
  stats.bounds[name] = { min, max };
  if (min[1] < -0.02 || min[1] > 0.03) problems.push(`${name}: lowest point at y = ${min[1].toFixed(3)}, feet should stand on 0`);
  if (max[1] < 1.7 || max[1] > 1.82) problems.push(`${name}: tallest point at y = ${max[1].toFixed(3)}, expected 1.7 to 1.82`);
  if (Math.max(Math.abs(min[0]), max[0]) > 0.5) problems.push(`${name}: ${Math.max(Math.abs(min[0]), max[0]).toFixed(2)} m wide on one side`);
  if (min[2] < -0.45 || max[2] > 0.45) problems.push(`${name}: z from ${min[2].toFixed(2)} to ${max[2].toFixed(2)}`);
  const j = p.getAttribute('JOINTS_0')!;
  const w = p.getAttribute('WEIGHTS_0')!;
  const jv = [0, 0, 0, 0];
  const wv = [0, 0, 0, 0];
  let bad = 0;
  for (let i = 0; i < j.getCount(); i++) {
    j.getElement(i, jv);
    w.getElement(i, wv);
    const sum = wv[0] + wv[1] + wv[2] + wv[3];
    if (Math.abs(sum - 1) > 0.06 || jv.some((x, k) => wv[k] > 0 && x >= BONES.length)) bad++;
  }
  if (bad) problems.push(`${name}: ${bad} vertices with weights not summing to one or joints out of range`);
  const reg = p.getAttribute('_REGION')!;
  const r = [0];
  for (let i = 0; i < reg.getCount(); i++) {
    reg.getElement(i, r);
    if (r[0] < 0 || r[0] > 15) {
      problems.push(`${name}: region ${r[0]}`);
      break;
    }
  }
  if (lod === 0 && !reg.getCount()) problems.push(`${name} is empty`);
}
