/**
 * Draws the airport's aircraft: the moving ones from the snapshot's aircraft block (interpolated between snapshots by id), the
 * parked ones from the stand words (on the stands of `aeroway.json`, a wheelbase behind the stop mark), the pushback tugs, and the
 * airside vehicles round the parked aircraft near the camera.
 *
 * Everything is instanced: per class and level of detail one InstancedMesh per material (the livery paint, the plain parts, the
 * windows, the lamps) and one for the gear, so a hundred and fifty aircraft are a few dozen draws. The livery is per instance
 * (six colours, `aLiv*`): the paint's vertex colour says which region a vertex is (crown, belly, fin, engines, stripe, accent;
 * tools/blender/airport/aircraft.py). Levels of detail by distance (aircraft.json `lod_from`, times the tier's lod scale).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { standPose, type AerowayData } from '../../../shared/aeroway';
import { AC, AircraftFlag, AircraftInfo, AircraftPhase, StandWord, type SnapshotView } from '../../../shared/snapshot';
import raw from '../../../shared/data/aircraft.json';
import type { Game, System } from '../../Game';
import { nightFactor } from '../timeOfDay';
import { aircraftAsset, groundAsset, loadAircraftAssets, type AcMat } from './aircraftAssets';

export const CLASS_NAMES = ['narrowbody', 'widebody', 'regional'] as const;
const TYPES = raw.types as unknown as Record<string, { wheelbase: number; length: number; span: number; height: number; fuselage: { radius: number; centreY: number }; lights: Record<string, number[]> }>;
const LIVERIES = raw.liveries as unknown as { crown: string; belly: string; fin: string; engine: string; stripe: string; accent: string }[];
const LIV_KEYS = ['crown', 'belly', 'fin', 'engine', 'stripe', 'accent'] as const;
/** Linear livery colours, flat: 18 numbers per livery. */
const LIV = new Float32Array(LIVERIES.length * 18);
LIVERIES.forEach((l, i) => LIV_KEYS.forEach((k, j) => {
  const c = new THREE.Color(l[k]);
  LIV[i * 18 + j * 3] = c.r;
  LIV[i * 18 + j * 3 + 1] = c.g;
  LIV[i * 18 + j * 3 + 2] = c.b;
}));

/** The shared uniforms: night (0..1) for the cabin windows and the lamps. */
const UNI = { uAcNight: { value: 0 } };
const CAP = 220;
const GROUND_CAP = 160;

type Kind = 'paint' | 'plain' | 'window' | 'light' | 'gear';

function makeMaterial(kind: Kind): THREE.Material {
  if (kind === 'light') {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, name: 'ac_light' });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uAcNight = UNI.uAcNight;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAcNight;').replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 0.7 + 2.3 * uAcNight;');
    };
    m.customProgramCacheKey = () => 'ac-light';
    return m;
  }
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'window' ? 0.15 : kind === 'paint' ? 0.38 : 0.6, metalness: kind === 'window' ? 0.3 : kind === 'paint' ? 0.15 : 0.25, name: `ac_${kind}` });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAcNight = UNI.uAcNight;
    if (kind === 'paint') {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aLivA;\nattribute vec3 aLivB;\nattribute vec3 aLivC;\nattribute vec3 aLivD;\nattribute vec3 aLivE;\nattribute vec3 aLivF;\nvarying vec3 vLiv;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
  {
    float rg = floor(color.r * 7.0 + 0.5);
    vLiv = rg < 0.5 ? aLivA : rg < 1.5 ? aLivB : rg < 2.5 ? aLivC : rg < 3.5 ? aLivD : rg < 4.5 ? aLivE : aLivF;
  }`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLiv;')
        .replace('#include <color_fragment>', '#if defined( USE_COLOR_ALPHA )\n  diffuseColor.rgb = vLiv * (0.4 + 0.6 * vColor.a);\n#else\n  diffuseColor.rgb = vLiv;\n#endif');
    } else {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#if defined( USE_COLOR_ALPHA )\n  diffuseColor.rgb *= vColor.rgb * (0.4 + 0.6 * vColor.a);\n#elif defined( USE_COLOR )\n  diffuseColor.rgb *= vColor;\n#endif');
    }
    if (kind === 'window') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCabin;\nvarying float vCabin;').replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCabin = aCabin;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uAcNight;\nvarying float vCabin;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.86, 0.62) * (0.05 + 1.4 * uAcNight) * vCabin;');
    }
  };
  m.customProgramCacheKey = () => `ac-${kind}`;
  return m;
}

const MAT_KIND: Record<AcMat, Kind> = { ac_paint: 'paint', ac_grey: 'plain', ac_metal: 'plain', ac_dark: 'plain', ac_window: 'window', ac_light: 'light' };

/** A model's geometries merged by the kind of material they are drawn with (copies: the asset's own stay as they are). */
function byKind(m: Map<AcMat, THREE.BufferGeometry>): { kind: Kind; geo: THREE.BufferGeometry }[] {
  const lists = new Map<Kind, THREE.BufferGeometry[]>();
  for (const [mat, g] of m) {
    const k = MAT_KIND[mat];
    const l = lists.get(k);
    if (l) l.push(g);
    else lists.set(k, [g]);
  }
  const out: { kind: Kind; geo: THREE.BufferGeometry }[] = [];
  for (const [kind, gs] of lists) {
    const geo = gs.length === 1 ? gs[0].clone() : mergeGeometries(gs, false);
    if (geo) out.push({ kind, geo });
  }
  return out;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  kind: Kind;
  liv?: THREE.InstancedBufferAttribute[];
  cabin?: THREE.InstancedBufferAttribute;
  n: number;
  /** the instances of the parked aircraft (written when they change, at the front): the moving ones follow */
  n0: number;
}

/** One aircraft to draw this frame. */
interface Draw {
  cls: number;
  livery: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  gear: number;
  flags: number;
  phase: number;
  /** 0..1, for the strobes' phase */
  seed: number;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler(0, 0, 0, 'YXZ');
const P = new THREE.Vector3();
const S1 = new THREE.Vector3(1, 1, 1);
const SK = new THREE.Vector3(1, 1, 1);
const M2 = new THREE.Matrix4();
const M3 = new THREE.Matrix4();
/** Aircraft further than this share of the camera's far plane are drawn nearer and smaller (see `update`). */
export const FAR_SHARE = 0.9;

export class AircraftViews implements System {
  readonly name = 'aircraft';
  readonly priority = 166;
  readonly group = new THREE.Group();
  private readonly materials = new Map<Kind, THREE.Material>();
  /** [class][lod] -> batches */
  private batches: Batch[][][] = [];
  private ground: Batch[][] = [];
  private fallback: THREE.InstancedMesh | null = null;
  private ready = false;
  private disposed = false;
  /** what is drawn this frame (reused) */
  readonly draws: Draw[] = [];
  private nDraw = 0;
  private readonly prev = new Map<number, number>();
  /** where the parked aircraft start in `draws`, the stand words they were laid out from, and the camera then */
  private firstParked = 0;
  private words = new Uint32Array(0);
  private standsChanged = true;
  private readonly laidAt = new THREE.Vector3(Infinity, 0, 0);
  private laidScale = 0;
  private readonly parkedStats = { byLod: [0, 0, 0], tris: 0, service: 0 };
  /** stats for the tests and the perf report */
  readonly stats = { moving: 0, parked: 0, byLod: [0, 0, 0], tugs: 0, service: 0, tris: 0 };

  constructor(
    private readonly game: Game,
    readonly data: AerowayData,
  ) {
    this.group.name = 'aircraft';
    game.scene.add(this.group);
    for (let i = 0; i < CAP; i++) this.draws.push({ cls: 0, livery: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, gear: 1, flags: 0, phase: 0, seed: 0 });
    void loadAircraftAssets().then(() => this.build());
  }

  private mat(kind: Kind): THREE.Material {
    let m = this.materials.get(kind);
    if (!m) this.materials.set(kind, (m = makeMaterial(kind)));
    return m;
  }

  private batch(geo: THREE.BufferGeometry, kind: Kind, cap: number, shadows: boolean): Batch {
    const mesh = new THREE.InstancedMesh(geo, this.mat(kind), cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows && kind !== 'light' && kind !== 'window';
    mesh.receiveShadow = kind !== 'light';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const b: Batch = { mesh, kind, n: 0, n0: 0 };
    if (kind === 'paint') {
      b.liv = ['aLivA', 'aLivB', 'aLivC', 'aLivD', 'aLivE', 'aLivF'].map((name) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(name, a);
        return a;
      });
    }
    if (kind === 'window') {
      b.cabin = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      b.cabin.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCabin', b.cabin);
    }
    this.group.add(mesh);
    return b;
  }

  private build() {
    if (this.disposed) return;
    CLASS_NAMES.forEach((cls, ci) => {
      const a = aircraftAsset(cls);
      this.batches[ci] = [];
      if (!a) return;
      a.lods.forEach((lod, li) => {
        const list: Batch[] = [];
        // one batch per kind of material (the grey, metal and dark parts are one plain batch): few draws, few instance writes
        for (const b of byKind(lod.body)) list.push(this.batch(b.geo, b.kind, CAP, li < 2));
        // the gear, marked so only gear-down aircraft get it
        for (const g of byKind(lod.gear)) {
          const b = this.batch(g.geo, g.kind, CAP, li < 2);
          (b as Batch & { gear?: boolean }).gear = true;
          list.push(b);
        }
        this.batches[ci][li] = list;
      });
    });
    // a stand-in for a class whose model is missing
    if (CLASS_NAMES.some((c) => !aircraftAsset(c))) {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0);
      this.fallback = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.5 }), CAP);
      this.fallback.count = 0;
      this.fallback.frustumCulled = false;
      this.group.add(this.fallback);
    }
    const gr = groundAsset();
    if (gr) {
      for (const name of ['tug', 'baggageTractor', 'baggageCart', 'beltLoader']) {
        const levels = gr.parts.get(name);
        const geo = levels?.[levels.length > 1 ? 1 : 0];
        const list: Batch[] = [];
        if (geo) for (const g of byKind(geo)) list.push(this.batch(g.geo, g.kind, GROUND_CAP, false));
        this.ground.push(list);
      }
    }
    this.ready = true;
  }

  /** The aircraft of this frame: the moving ones between the two snapshots, and the parked ones of the newer. */
  private gather(a: SnapshotView, b: SnapshotView, alpha: number) {
    this.nDraw = 0;
    const al = Math.max(0, Math.min(1.2, alpha));
    // the older snapshot's records by id
    this.prev.clear();
    for (let i = 0, n = a.aircraftCount; i < n; i++) this.prev.set(a.u32[a.aircraftAt(i) + AC.Id], i);
    const fa = a.f32, fb = b.f32, ub = b.u32;
    let moving = 0;
    for (let i = 0, n = b.aircraftCount; i < n && this.nDraw < CAP; i++) {
      const ob = b.aircraftAt(i);
      const id = ub[ob + AC.Id];
      const ia = this.prev.get(id);
      const oa = ia != null ? a.aircraftAt(ia) : ob;
      const fA = ia != null ? fa : fb;
      const info = ub[ob + AC.Info];
      const d = this.draws[this.nDraw++];
      const lerp = (k: number) => fA[oa + k] + (fb[ob + k] - fA[oa + k]) * al;
      const ang = (k: number) => {
        let dd = fb[ob + k] - fA[oa + k];
        while (dd > Math.PI) dd -= 2 * Math.PI;
        while (dd < -Math.PI) dd += 2 * Math.PI;
        return fA[oa + k] + dd * al;
      };
      d.cls = AircraftInfo.cls(info);
      d.livery = AircraftInfo.livery(info);
      d.phase = AircraftInfo.phase(info);
      d.flags = info;
      d.x = lerp(AC.Px);
      d.y = lerp(AC.Py);
      d.z = lerp(AC.Pz);
      d.yaw = ang(AC.Yaw);
      d.pitch = lerp(AC.Pitch);
      d.roll = lerp(AC.Roll);
      d.gear = fb[ob + AC.Gear];
      d.seed = ((id * 0.618034) % 1 + 1) % 1;
      moving++;
    }
    let parked = 0;
    this.firstParked = this.nDraw;
    const ns = Math.min(b.standCount, this.data.stands.length);
    if (this.words.length !== ns) {
      this.words = new Uint32Array(ns);
      this.standsChanged = true;
    }
    for (let i = 0; i < ns && this.nDraw < CAP; i++) {
      const w = b.standWord(i);
      if (this.words[i] !== w) {
        this.words[i] = w;
        this.standsChanged = true;
      }
      if (!StandWord.occupied(w)) continue;
      const st = this.data.stands[i];
      const cls = StandWord.cls(w);
      const q = standPose(this.data, st, TYPES[CLASS_NAMES[cls]].wheelbase);
      const d = this.draws[this.nDraw++];
      d.cls = cls;
      d.livery = StandWord.livery(w);
      d.phase = AircraftPhase.Parked;
      d.flags = w | AircraftFlag.Nav | AircraftFlag.Cabin;
      d.x = q.x;
      d.y = q.y;
      d.z = q.z;
      d.yaw = q.yaw;
      d.pitch = 0;
      d.roll = 0;
      d.gear = 1;
      d.seed = ((i * 0.618034) % 1 + 1) % 1;
      parked++;
    }
    this.stats.moving = moving;
    this.stats.parked = parked;
  }

  update() {
    const s = this.game.view.sample;
    const cv = this.game.clockView;
    if (cv) UNI.uAcNight.value = THREE.MathUtils.smoothstep(nightFactor(cv.minutes), 0.15, 0.7);
    if (!this.ready || !s) return;
    this.gather(s.a, s.b, s.alpha);
    const cam = this.game.camera.position;
    const scale = this.game.tier.lodScale;
    // the parked aircraft (and the vehicles round them) are laid out again only when a stand changes or the camera has moved
    // far enough to change a level of detail; in between only the moving ones are written (and uploaded)
    const redo = this.standsChanged || this.laidAt.distanceTo(cam) > 12 || scale !== this.laidScale;
    this.fb = 0;
    if (redo) {
      for (const byLod of this.batches) for (const list of byLod ?? []) for (const b of list ?? []) b.n = 0;
      for (const list of this.ground) for (const b of list) b.n = 0;
      const ps = this.parkedStats;
      ps.byLod[0] = ps.byLod[1] = ps.byLod[2] = 0;
      ps.tris = ps.service = 0;
      for (let k = this.firstParked; k < this.nDraw; k++) this.place(this.draws[k], cam, scale, ps);
      for (const byLod of this.batches) for (const list of byLod ?? []) for (const b of list ?? []) b.n0 = b.n;
      for (const list of this.ground) for (const b of list) b.n0 = b.n;
      this.laidAt.copy(cam);
      this.laidScale = scale;
      this.standsChanged = false;
    } else {
      for (const byLod of this.batches) for (const list of byLod ?? []) for (const b of list ?? []) b.n = b.n0;
      for (const list of this.ground) for (const b of list) b.n = b.n0;
    }
    const ms = { byLod: [0, 0, 0], tris: 0, service: 0, tugs: 0 };
    for (let k = 0; k < this.firstParked; k++) this.place(this.draws[k], cam, scale, ms);
    const upload = (b: Batch) => {
      b.mesh.count = b.n;
      b.mesh.visible = b.n > 0;
      const from = redo ? 0 : b.n0;
      if (b.n <= from) return;
      const attrs: THREE.BufferAttribute[] = [b.mesh.instanceMatrix, ...(b.liv ?? []), ...(b.cabin ? [b.cabin] : [])];
      for (const a of attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(from * a.itemSize, (b.n - from) * a.itemSize);
        a.needsUpdate = true;
      }
    };
    for (const byLod of this.batches) for (const list of byLod ?? []) for (const b of list ?? []) upload(b);
    for (const list of this.ground) for (const b of list) upload(b);
    if (this.fallback) {
      this.fallback.count = this.fb;
      this.fallback.visible = this.fb > 0;
      this.fallback.instanceMatrix.needsUpdate = true;
    }
    const ps = this.parkedStats;
    for (let i = 0; i < 3; i++) this.stats.byLod[i] = ps.byLod[i] + ms.byLod[i];
    this.stats.tugs = ms.tugs;
    this.stats.service = ps.service;
    this.stats.tris = ps.tris + ms.tris;
  }

  private fb = 0;

  /** Writes one aircraft's instances (and its tug, or the vehicles round it when parked) after the batches' current ones. */
  private place(d: Draw, cam: THREE.Vector3, scale: number, st: { byLod: number[]; tris: number; service: number; tugs?: number }) {
    const cls = CLASS_NAMES[d.cls] ?? 'narrowbody';
    const asset = aircraftAsset(cls);
    const dist = Math.hypot(cam.x - d.x, cam.y - d.y, cam.z - d.z);
    E.set(-d.pitch, d.yaw, d.roll, 'YXZ');
    Q.setFromEuler(E);
    P.set(d.x, d.y, d.z);
    // past the far plane (an arrival 14 km out, a departure climbing away): drawn nearer along the same line of sight and
    // scaled by as much, so it looks the same size where it is, and is not clipped
    const reach = this.game.camera.far * FAR_SHARE;
    if (dist > reach) {
      const k = reach / dist;
      P.set(cam.x + (d.x - cam.x) * k, cam.y + (d.y - cam.y) * k, cam.z + (d.z - cam.z) * k);
      SK.setScalar(k);
      M.compose(P, Q, SK);
    } else M.compose(P, Q, S1);
    if (!asset || !this.batches[d.cls]?.length) {
      if (this.fallback && this.fb < CAP) {
        const t = TYPES[cls];
        M2.makeScale(t.span * 0.25, t.height * 0.5, t.length);
        this.fallback.setMatrixAt(this.fb++, M3.copy(M).multiply(M2));
      }
      return;
    }
    let li = 0;
    for (let i = asset.from.length - 1; i > 0; i--) if (dist >= asset.from[i] / scale) { li = i; break; }
    li = Math.min(li, this.batches[d.cls].length - 1);
    st.byLod[li]++;
    st.tris += asset.lods[li].tris;
    const cabin = (d.flags & AircraftFlag.Cabin) !== 0 ? 1 : 0;
    for (const b of this.batches[d.cls][li]) {
      if ((b as Batch & { gear?: boolean }).gear && d.gear < 0.5) continue;
      if (b.n >= CAP) continue;
      b.mesh.setMatrixAt(b.n, M);
      if (b.liv) for (let j = 0; j < 6; j++) b.liv[j].setXYZ(b.n, LIV[d.livery * 18 + j * 3], LIV[d.livery * 18 + j * 3 + 1], LIV[d.livery * 18 + j * 3 + 2]);
      if (b.cabin) b.cabin.setX(b.n, cabin);
      b.n++;
    }
    // the pushback tug, at the nose gear, facing the aircraft
    if ((d.flags & AircraftFlag.Tug) !== 0 && this.ground[0]?.length && dist < 1500) {
      const wb = TYPES[cls].wheelbase + 3.4;
      P.set(d.x + Math.sin(d.yaw) * wb, d.y, d.z + Math.cos(d.yaw) * wb);
      E.set(0, d.yaw + Math.PI, 0, 'YXZ');
      Q.setFromEuler(E);
      M.compose(P, Q, S1);
      for (const b of this.ground[0]) if (b.n < GROUND_CAP) b.mesh.setMatrixAt(b.n++, M);
      st.tugs = (st.tugs ?? 0) + 1;
    }
    // a parked aircraft near the camera: a belt loader at its forward hold, a baggage train beside it
    if (d.phase === AircraftPhase.Parked && dist < 420 && this.ground.length >= 4) {
      const t = TYPES[cls];
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), rx = -Math.cos(d.yaw), rz = Math.sin(d.yaw);
      const r = t.fuselage.radius;
      this.service(3, d, fx, fz, rx, rz, t.wheelbase * 0.55, r + 4.5, -Math.PI / 2);
      this.service(1, d, fx, fz, rx, rz, t.wheelbase * 0.2, r + 9.5, Math.PI);
      this.service(2, d, fx, fz, rx, rz, t.wheelbase * 0.2 - 4.2, r + 9.5, Math.PI);
      if (d.cls === 1) this.service(2, d, fx, fz, rx, rz, t.wheelbase * 0.2 - 8.4, r + 9.5, Math.PI);
      st.service++;
    }
  }

  private service(gi: number, d: Draw, fx: number, fz: number, rx: number, rz: number, along: number, side: number, yawOff: number) {
    const list = this.ground[gi];
    if (!list?.length) return;
    P.set(d.x + fx * along + rx * side, d.y, d.z + fz * along + rz * side);
    E.set(0, d.yaw + yawOff, 0, 'YXZ');
    Q.setFromEuler(E);
    M.compose(P, Q, S1);
    for (const b of list) if (b.n < GROUND_CAP) b.mesh.setMatrixAt(b.n++, M);
  }

  /** The aircraft drawn this frame (for the lights and the audio). */
  get drawn(): readonly Draw[] {
    return this.draws.slice(0, this.nDraw);
  }

  /** How many are drawn this frame, and the n-th (no allocation). */
  get count(): number {
    return this.nDraw;
  }
  at(i: number): Draw {
    return this.draws[i];
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isMesh) {
        m.geometry.dispose();
        m.dispose?.();
      }
    });
    for (const m of this.materials.values()) m.dispose();
    this.fallback?.geometry.dispose();
    (this.fallback?.material as THREE.Material | undefined)?.dispose();
  }
}
