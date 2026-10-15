/**
 * Traffic signal heads on poles at the signalised junctions. `lanes.json` says where each pole stands
 * and which way its face looks; the lamp colours are `legState` from `shared/signals.ts` at the
 * sim's time, so they agree with the cars and with the pedestrians' walk lights without any
 * snapshot bandwidth. Three instanced meshes for the whole tile (poles with their arms, lamp
 * housings, lamps), a handful of draw calls whatever the number of junctions.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseLanes, type LaneJunctionData } from '../../shared/lanes';
import { SIM_DT } from '../../shared/protocol';
import { SIGNAL_ARM, SIGNAL_BOXES, SIGNAL_POLE_H, signalHeads } from '../../shared/props';
import { legState, type SignalState } from '../../shared/signals';
import type { Game, System } from '../Game';

const POLE_H = SIGNAL_POLE_H;
const ARM = SIGNAL_ARM;

const part = (w: number, h: number, d: number, x: number, y: number, z: number, rgb: number): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  g.deleteAttribute('uv');
  const c = new THREE.Color(rgb);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
};

/** Local frame: +Z looks at the approaching cars, the pole stands at the origin, the lane is toward -X. */
function bodyGeometry(): THREE.BufferGeometry {
  // the pole, its arm, and the lamp housing hanging from the end of the arm (36 triangles a head): the boxes the sim makes solid
  return mergeGeometries(SIGNAL_BOXES.map((b) => part(b.w, b.h, b.d, b.x, b.y, b.z, b.rgb)))!;
}

/** One lamp: a flat 8-sided disc facing +Z. */
function lampGeometry(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(0.14, 8);
  g.deleteAttribute('uv');
  return g;
}

const LAMP_Y = [0.38, 0, -0.38];
const COLORS: Record<SignalState, [number, number, number]> = {
  red: [1, 0.05, 0.03],
  amber: [1, 0.55, 0.02],
  green: [0.05, 1, 0.35],
};
const LIT = 3.2;
const DIM_RGB: [number, number, number][] = [
  [0.1, 0.008, 0.008],
  [0.1, 0.06, 0.008],
  [0.008, 0.08, 0.03],
];

interface Head {
  junction: number;
  leg: number;
  chunk: number;
  /** index of this head in its chunk */
  idx: number;
  /** last state drawn (index into the lamps), -1 none */
  lit: number;
}

/** Heads are drawn in chunks of this many metres, so the ones behind the camera are culled. */
const CHUNK = 400;

export class SignalHeads implements System {
  readonly name = 'signalHeads';
  readonly priority = 60;
  private readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly lamps: THREE.InstancedMesh[] = [];
  private readonly heads: Head[] = [];
  private readonly junctions: LaneJunctionData[] = [];
  private lastTick = -1;

  constructor(
    private readonly game: Game,
    junctions: LaneJunctionData[],
  ) {
    this.group.name = 'signal-heads';
    const list: { j: number; leg: number; x: number; y: number; z: number; yaw: number }[] = [];
    const index = new Map<LaneJunctionData, number>();
    for (const h of signalHeads(junctions)) {
      let ji = index.get(h.junction);
      if (ji === undefined) index.set(h.junction, (ji = this.junctions.push(h.junction) - 1));
      list.push({ j: ji, leg: h.leg, x: h.placement.x, y: h.placement.y, z: h.placement.z, yaw: h.placement.yaw });
    }
    const bodyG = bodyGeometry();
    const lampG = lampGeometry();
    this.geos.push(bodyG, lampG);
    const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
    const lampM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mats.push(body, lampM);
    const byChunk = new Map<string, typeof list>();
    for (const h of list) {
      const key = `${Math.floor(h.x / CHUNK)},${Math.floor(h.z / CHUNK)}`;
      const a = byChunk.get(key);
      if (a) a.push(h);
      else byChunk.set(key, [h]);
    }
    const m = new THREE.Matrix4();
    const lm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const members of byChunk.values()) {
      const n = members.length;
      const poles = new THREE.InstancedMesh(bodyG, body, n);
      const lamps = new THREE.InstancedMesh(lampG, lampM, n * 3);
      lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3 * 3), 3);
      lamps.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const chunk = this.lamps.push(lamps) - 1;
      members.forEach((h, i) => {
        q.setFromAxisAngle(up, h.yaw);
        m.compose(new THREE.Vector3(h.x, h.y, h.z), q, one);
        poles.setMatrixAt(i, m);
        for (let k = 0; k < 3; k++) {
          lm.makeTranslation(-ARM, POLE_H - 0.3 + LAMP_Y[k], 0.225).premultiply(m);
          lamps.setMatrixAt(i * 3 + k, lm);
        }
        this.heads.push({ junction: h.j, leg: h.leg, chunk, idx: i, lit: -1 });
      });
      // frustum culling works per chunk: the bounds are those of its heads, with the pole's height
      for (const mesh of [poles, lamps]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
      }
    }
    game.scene.add(this.group);
  }

  update() {
    const tick = this.game.view.tick;
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const t = tick * SIM_DT;
    const dirty = new Set<number>();
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      const st = legState(this.junctions[h.junction] as never, h.leg, t);
      const lit = st === 'red' ? 0 : st === 'amber' ? 1 : 2;
      if (lit === h.lit) continue;
      h.lit = lit;
      dirty.add(h.chunk);
      const arr = this.lamps[h.chunk].instanceColor!.array as Float32Array;
      for (let k = 0; k < 3; k++) {
        const rgb = k === lit ? COLORS[st].map((c) => c * LIT) : DIM_RGB[k];
        const o = (h.idx * 3 + k) * 3;
        arr[o] = rgb[0];
        arr[o + 1] = rgb[1];
        arr[o + 2] = rgb[2];
      }
    }
    for (const c of dirty) this.lamps[c].instanceColor!.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.group.children as THREE.InstancedMesh[]) m.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

/** Reads `lanes.json` beside the tile and builds the heads, or nothing when there is none. */
export async function loadSignalHeads(game: Game, tileBase: string | null, file: string | undefined): Promise<SignalHeads | null> {
  if (!tileBase || !file) return null;
  try {
    const res = await fetch(new URL(file, tileBase).href);
    if (!res.ok) return null;
    const data = parseLanes(await res.json());
    return data ? new SignalHeads(game, data.junctions) : null;
  } catch {
    return null;
  }
}
