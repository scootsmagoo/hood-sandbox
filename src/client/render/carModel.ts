/**
 * A car drawn from its Blender asset (carAssets.ts): the player's car, police cars and any traffic
 * car that is damaged, burning or has a door open. It keeps the `VehicleModel` interface of the
 * stand-in (models.ts), and adds levels of detail and damage.
 *
 * Draws: the body is one mesh per material (paint, trim, chrome, glass, interior); the lamps are one
 * mesh (head, tail and reverse by vertex, brightness per car); the four wheels are one
 * InstancedMesh per wheel material (2 or 3 draws for all four); the door, bonnet and bumpers hang
 * under groups at their pivots so they can open, pop, sag and fall. Only the level of detail in
 * use is drawn. Paint, lamps, the light bar and (once a window breaks) glass are the car's own
 * materials; the rest are shared, so no car compiles a new shader.
 */
import * as THREE from 'three';
import type { HandlingData } from '../../shared/handling';
import { WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import type { CarAsset, CarMat, CarPartName } from './carAssets';
import { BUMPER_OFF, BUMPER_SAG, type CarDamageState, type DamageShape, type Dent } from './carDamage';
import { ownDepth } from './depthMaterials';
import { BURNT, CAR_HEAD, newCarUniforms, newGlass, newLamp, newPaint, patchCar, sharedCarMaterials, type CarUniforms } from './carMaterials';
import { glowTex, type ModelLivery, type VehicleModel } from './models';

/** A part that came off (a bumper): its geometry and material, owned by whoever takes it, and where it was. */
export interface DetachedPart {
  geos: THREE.BufferGeometry[];
  mats: THREE.Material[];
  matrixWorld: THREE.Matrix4;
}

interface LodView {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  door: THREE.Group | null;
  hood: THREE.Group | null;
  bumpers: Partial<Record<'F' | 'R', THREE.Group>>;
  wheels: THREE.InstancedMesh[];
  bars: THREE.Mesh[];
  /** Dents applied to this level's geometry so far (counting the dropped ones). */
  dentsDone: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const HALF_TURN = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI);

/** A position hash in [-1, 1]: the crumple of a dent, the same for every vertex at one point. */
function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

/** Pushes a geometry's vertices in a dent's sphere along its direction. Returns whether any moved. */
export function displace(g: THREE.BufferGeometry, d: Dent): boolean {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  const r2 = d.r * d.r;
  let moved = false;
  for (let i = 0; i < pos.count; i++) {
    const ox = a[i * 3];
    const oy = a[i * 3 + 1];
    const oz = a[i * 3 + 2];
    const x = ox - d.x;
    const y = oy - d.y;
    const z = oz - d.z;
    const q = x * x + y * y + z * z;
    if (q >= r2) continue;
    const f = 1 - q / r2;
    const h = hash3(ox, oy, oz);
    const k = d.d * f * f * (1 + 0.5 * h);
    // a little sideways scatter, so a dent crumples rather than presses in like a thumb
    const s = d.d * f * 0.22;
    a[i * 3] = ox + d.dx * k + s * hash3(oy, oz, ox);
    a[i * 3 + 1] = oy + d.dy * k + s * hash3(oz, ox, oy) * 0.5;
    a[i * 3 + 2] = oz + d.dz * k + s * hash3(oz, oy, ox);
    moved = true;
  }
  if (moved) {
    pos.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }
  return moved;
}

/** What the damage rules need to know of an asset: its size and its window panels (the windscreen is the one furthest forward on the centre line, the rear window the one furthest back). */
export function shapeOf(asset: CarAsset): DamageShape {
  const b = asset.bounds;
  const ws = asset.windows.reduce<{ z: number; i: number }>((best, w) => (w.centre.z > best.z && Math.abs(w.centre.x) < 0.2 ? { z: w.centre.z, i: w.index } : best), { z: -Infinity, i: -1 });
  const rw = asset.windows.reduce<{ z: number; i: number }>((best, w) => (w.centre.z < best.z && Math.abs(w.centre.x) < 0.2 ? { z: w.centre.z, i: w.index } : best), { z: Infinity, i: -1 });
  return {
    rearWindow: rw.i,
    halfLength: Math.max(b.max.z, -b.min.z),
    halfWidth: Math.max(b.max.x, -b.min.x),
    windows: asset.windows.map((w) => ({ index: w.index, x: w.centre.x, y: w.centre.y, z: w.centre.z })),
    windscreen: ws.i,
  };
}

export class CarModel implements VehicleModel {
  readonly root = new THREE.Group();
  /** The level of detail drawn, 0 to 2. */
  lod = -1;
  readonly shape: DamageShape;
  private readonly lods: LodView[] = [];
  private readonly u: CarUniforms = newCarUniforms();
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly livery: THREE.MeshStandardMaterial | null;
  private readonly lamp: THREE.MeshStandardMaterial;
  private glass: THREE.MeshStandardMaterial | null = null;
  private readonly barMats: THREE.MeshStandardMaterial[] = [];
  private readonly glows: THREE.Sprite[] = [];
  private readonly owned = new Set<THREE.BufferGeometry>();
  private readonly paintBase: THREE.Color;
  private readonly liveryBase: THREE.Color | null;
  private flats = 0;
  private burnt = false;
  private damageVersion = -1;
  private dropped = 0;
  private hood = 0;
  private bumperState = { F: 0, R: 0 };
  private readonly wheelPos: THREE.Vector3[] = [];
  private readonly wb: HandlingData['wheels'];

  constructor(
    private readonly asset: CarAsset,
    h: HandlingData,
    color: number,
    livery?: ModelLivery,
  ) {
    this.root.name = `car-${asset.name}`;
    // (the levels not drawn are out of the scene graph: the leak harness counts them through this)
    this.root.userData.lodGroups = this.lods;
    this.wb = h.wheels;
    this.paint = newPaint(livery ? livery.body : color, this.u);
    this.paintBase = this.paint.color.clone();
    this.livery = livery && !livery.unmarked ? newPaint(livery.stripe, this.u) : null;
    if (this.livery) this.livery.roughness = 0.4;
    this.liveryBase = this.livery ? this.livery.color.clone() : null;
    this.lamp = newLamp(this.u);
    if (livery) {
      for (const c of livery.lightbar) {
        this.barMats.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.35), emissive: c, emissiveIntensity: 0, roughness: 0.3, transparent: true, opacity: 0.92 }));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(livery.unmarked ? 1.5 : 2.6);
        this.glows.push(glow);
        this.root.add(glow);
      }
    }
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      this.wheelPos.push(new THREE.Vector3((left ? 1 : -1) * (front ? h.wheels.trackFront : h.wheels.trackRear) * 0.5, h.wheels.mountY, front ? h.wheels.frontZ : h.wheels.rearZ));
    }
    for (let level = 0; level < 3; level++) this.lods.push(this.buildLod(level, livery));
    // the glows sit on the light bar's halves (or, unmarked, behind the windscreen)
    const bars = this.lods[0].bars;
    if (bars.length === 2) {
      for (let i = 0; i < 2; i++) {
        bars[i].geometry.computeBoundingBox();
        this.glows[i]?.position.copy(bars[i].geometry.boundingBox!.getCenter(tmpP)).add(new THREE.Vector3(0, 0.1, 0));
      }
    }
    this.shape = shapeOf(asset);
    // what never moves within the car keeps the matrix it was built with (a car is some 50 objects; only the pivots move)
    this.root.traverse((o) => {
      if (o === this.root || o.userData.pivot || o instanceof THREE.Sprite) return;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    this.setLod(0);
  }

  private matFor(m: CarMat): THREE.Material {
    const s = sharedCarMaterials();
    switch (m) {
      case 'paint':
        return this.paint;
      case 'livery':
        return this.livery ?? this.paint;
      case 'glass':
        return this.glass ?? s.glass;
      case 'chrome':
        return s.chrome;
      case 'interior':
        return s.interior;
      case 'tyre':
        return s.tyre;
      case 'light_head':
      case 'light_tail':
      case 'light_reverse':
        return this.lamp;
      default:
        return s.trim;
    }
  }

  private buildLod(level: number, livery?: ModelLivery): LodView {
    const lod = this.asset.lods[level];
    const group = new THREE.Group();
    group.name = `lod${level}`;
    group.visible = false;
    this.root.add(group);
    const view: LodView = { group, meshes: [], door: null, hood: null, bumpers: {}, wheels: [], bars: [], dentsDone: 0 };
    const addPart = (name: CarPartName, parent: THREE.Object3D, offset: THREE.Vector3 | null) => {
      const part = lod.parts.get(name);
      if (!part) return;
      for (const [m, g] of part.geos) {
        const mesh = new THREE.Mesh(g, this.matFor(m));
        mesh.userData.mat = m;
        // the body's paint (and the wheels) cast the car's shadow; the details do not need their own
        mesh.castShadow = m === 'paint' && level < 2;
        mesh.receiveShadow = m === 'paint';
        if (m === 'glass') mesh.renderOrder = 2;
        if (offset) mesh.position.copy(offset);
        parent.add(mesh);
        view.meshes.push(mesh);
      }
    };
    const pivoted = (name: CarPartName): THREE.Group | null => {
      const part = lod.parts.get(name);
      if (!part) return null;
      const g = new THREE.Group();
      g.name = name;
      g.position.copy(part.pivot);
      g.userData.pivot = part.pivot.clone();
      group.add(g);
      addPart(name, g, part.pivot.clone().negate());
      return g;
    };
    addPart('body', group, null);
    if (!livery || !livery.unmarked) addPart('police', group, null);
    view.door = pivoted('door');
    view.hood = pivoted('hood');
    const bf = pivoted('bumper_F');
    const br = pivoted('bumper_R');
    if (bf) view.bumpers.F = bf;
    if (br) view.bumpers.R = br;
    if (lod.lamps) {
      const m = new THREE.Mesh(lod.lamps, this.lamp);
      group.add(m);
      view.meshes.push(m);
    }
    if (livery && !livery.unmarked) {
      for (const [i, g] of [lod.barA, lod.barB].entries()) {
        if (!g || !this.barMats[i]) continue;
        const m = new THREE.Mesh(g, this.barMats[i]);
        group.add(m);
        view.bars.push(m);
      }
    } else if (livery?.unmarked && level === 0) {
      // strobes behind the windscreen and in the grille: dark until the lights are on
      const b = this.asset.bounds;
      const ws = this.asset.windows.reduce((best, w) => (w.centre.z > best.z ? w.centre : best), new THREE.Vector3(0, b.max.y * 0.6, b.max.z * 0.4));
      const geo = new THREE.BoxGeometry(0.2, 0.05, 0.06);
      this.owned.add(geo);
      const spots: [number, number, number, number][] = [
        [0, -0.25, ws.y - 0.12, ws.z - 0.12],
        [1, 0.25, ws.y - 0.12, ws.z - 0.12],
        [1, -0.45 * b.max.x, b.min.y + (b.max.y - b.min.y) * 0.25, b.max.z - 0.02],
        [0, 0.45 * b.max.x, b.min.y + (b.max.y - b.min.y) * 0.25, b.max.z - 0.02],
      ];
      for (const [i, x, y, z] of spots) {
        const m = new THREE.Mesh(geo, this.barMats[i]);
        m.position.set(x, y, z);
        group.add(m);
        view.bars.push(m);
      }
      if (this.glows.length === 2) {
        this.glows[0].position.set(-0.25, ws.y - 0.05, ws.z - 0.1);
        this.glows[1].position.set(0.25, ws.y - 0.05, ws.z - 0.1);
      }
    }
    const wheel = lod.parts.get('wheel');
    if (wheel) {
      for (const [m, g] of wheel.geos) {
        const sm = sharedCarMaterials();
        const im = new THREE.InstancedMesh(g, m === 'tyre' ? sm.wheelTyre : m === 'chrome' ? sm.wheelChrome : sm.wheelTrim, WHEEL_COUNT);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = m === 'tyre' && level < 2;
        im.frustumCulled = false;
        ownDepth(im);
        group.add(im);
        view.wheels.push(im);
      }
    }
    return view;
  }

  /**
   * Shows one level of detail (0 nearest). The other levels are taken out of the car's scene graph, not just hidden:
   * a hidden node still costs a world-matrix update every frame (the car moves, so its whole subtree is recomputed),
   * and a car is some 50 nodes, two thirds of them in levels nobody can see.
   */
  setLod(level: number) {
    if (level === this.lod) return;
    this.lod = level;
    for (let i = 0; i < this.lods.length; i++) {
      const g = this.lods[i].group;
      g.visible = i === level;
      if (i === level) {
        if (g.parent !== this.root) this.root.add(g);
      } else if (g.parent) this.root.remove(g);
    }
  }

  apply(wheels: Float32Array, braking: boolean, reversing: boolean, door = 0) {
    const v = this.lods[this.lod];
    if (v.door) v.door.rotation.y = -door * 1.15;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const o = i * WHEEL_FLOATS;
      const left = i % 2 === 0;
      const p = this.wheelPos[i];
      const flat = (this.flats >> i) & 1;
      tmpP.set(p.x, p.y - wheels[o + 2] - (flat ? this.wb.radius * 0.12 : 0), p.z);
      tmpQ.setFromAxisAngle(AXIS_Y, wheels[o]);
      if (!left) tmpQ.multiply(HALF_TURN);
      tmpQ.multiply(tmpQ2.setFromAxisAngle(AXIS_X, left ? wheels[o + 1] : -wheels[o + 1]));
      tmpS.set(1, flat ? 0.76 : 1, flat ? 0.76 : 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      for (const im of v.wheels) im.setMatrixAt(i, tmpM);
    }
    for (const im of v.wheels) im.instanceMatrix.needsUpdate = true;
    const night = Math.max(0, (CAR_HEAD.value - 0.8) / 1.6);
    this.u.uLampB.value.y = braking ? 2.4 : 0.3 + 0.7 * night;
    this.u.uLampB.value.z = reversing ? 1.5 : 0;
    if (v.hood && this.hood === 2) {
      // a popped bonnet rattles while the car moves
      v.hood.rotation.x = -0.62 + Math.sin(performance.now() * 0.02) * 0.03 * Math.min(1, Math.abs(wheels[1] - (this.lastRoll ?? wheels[1])) * 4);
    }
    this.lastRoll = wheels[1];
  }
  private lastRoll: number | null = null;

  flash(time: number, on: boolean) {
    const phase = Math.floor(time * 10) % 10;
    for (const [i, m] of this.barMats.entries()) {
      const lit = on && (i === 0 ? phase === 0 || phase === 2 : phase === 5 || phase === 7);
      m.emissiveIntensity = lit ? 3.2 : 0;
      if (this.glows[i]) this.glows[i].material.opacity = lit ? 0.95 : 0;
    }
  }

  setCondition(wear: number, burnt: boolean) {
    const k = burnt ? 1 : Math.min(0.55, wear * 0.55);
    this.paint.color.copy(this.paintBase).lerp(BURNT, k);
    if (this.livery && this.liveryBase) this.livery.color.copy(this.liveryBase).lerp(BURNT, k);
    this.paint.roughness = burnt ? 0.95 : 0.32 + wear * 0.35;
    this.paint.metalness = burnt ? 0.05 : 0.35;
    if (burnt && !this.burnt) {
      this.burnt = true;
      const s = sharedCarMaterials();
      for (const v of this.lods) {
        for (const m of v.meshes) m.material = m.userData.mat === 'glass' ? s.burntGlass : s.burnt;
        for (const im of v.wheels) im.material = s.wheelBurnt;
      }
      this.u.uDirt.value = 0;
    }
  }

  setFlats(mask: number) {
    this.flats = mask;
  }

  /** Grime, 0 clean to 1 filthy. */
  setDirt(k: number) {
    this.u.uDirt.value = k;
  }

  /**
   * Draws the damage state: new dents into the geometry (the near levels; cloned the first time),
   * the bumpers, bonnet and windows. Returns the parts that came off this time (for the debris).
   */
  syncDamage(s: CarDamageState): DetachedPart[] {
    const out: DetachedPart[] = [];
    if (s.version === this.damageVersion) return out;
    this.damageVersion = s.version;
    // dents: each near level applies the ones it has not seen
    for (let level = 0; level < 2; level++) {
      const v = this.lods[level];
      const start = Math.max(0, v.dentsDone - s.dropped);
      if (start >= s.dents.length) continue;
      for (const mesh of v.meshes) {
        if (mesh.userData.mat === 'tyre') continue;
        let g = mesh.geometry;
        let changed = false;
        for (let i = start; i < s.dents.length; i++) {
          if (!this.owned.has(g)) {
            // the shared asset geometry stays clean: this car gets its own copy
            const d = s.dents[i];
            g.computeBoundingSphere();
            const bs = g.boundingSphere!;
            if (bs.center.distanceTo(tmpP.set(d.x, d.y, d.z)) > bs.radius + d.r) continue;
            g = g.clone();
            this.owned.add(g);
            mesh.geometry = g;
          }
          changed = displace(g, s.dents[i]) || changed;
        }
        void changed;
      }
      v.dentsDone = s.dropped + s.dents.length;
    }
    this.dropped = s.dropped;
    // bumpers
    for (const end of ['F', 'R'] as const) {
      const state = end === 'F' ? s.bumperF : s.bumperR;
      const sag = end === 'F' ? s.sagF : s.sagR;
      if (state === this.bumperState[end]) continue;
      this.bumperState[end] = state;
      for (const [level, v] of this.lods.entries()) {
        const b = v.bumpers[end];
        if (!b) continue;
        if (state === BUMPER_SAG) {
          b.rotation.z = sag * 0.16;
          b.rotation.x = end === 'F' ? 0.08 : -0.08;
          b.position.y = (b.userData.pivot as THREE.Vector3).y - 0.05;
        } else if (state === BUMPER_OFF && b.visible) {
          if (level === Math.max(0, Math.min(1, this.lod))) {
            b.updateWorldMatrix(true, true);
            const geos: THREE.BufferGeometry[] = [];
            const mats: THREE.Material[] = [];
            for (const c of b.children) {
              const m = c as THREE.Mesh;
              if (!m.isMesh) continue;
              // the debris owns copies: it may outlive this car
              const g = m.geometry.clone();
              g.applyMatrix4(m.matrix);
              geos.push(g);
              mats.push((m.material as THREE.Material).clone());
            }
            out.push({ geos, mats, matrixWorld: b.matrixWorld.clone() });
          }
          b.visible = false;
        }
      }
    }
    // bonnet
    if (s.hood !== this.hood) {
      this.hood = s.hood;
      for (const v of this.lods) if (v.hood) v.hood.rotation.x = s.hood === 2 ? -0.62 : s.hood === 1 ? -0.07 : 0;
    }
    // windows
    if (s.windows && !this.burnt) {
      if (!this.glass) {
        this.glass = patchCar(newGlass(), { kind: 'glass' }, this.u);
        for (const v of this.lods) for (const m of v.meshes) if (m.userData.mat === 'glass') m.material = this.glass;
      }
      this.u.uBroken.value = s.windows;
    }
    return out;
  }

  dispose() {
    for (const v of this.lods) for (const im of v.wheels) im.dispose();
    for (const g of this.owned) g.dispose();
    this.owned.clear();
    this.paint.dispose();
    this.livery?.dispose();
    this.lamp.dispose();
    this.glass?.dispose();
    for (const m of this.barMats) m.dispose();
    for (const s of this.glows) s.material.dispose();
  }
}
