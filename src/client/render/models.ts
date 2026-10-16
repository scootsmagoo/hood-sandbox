/**
 * Stand-in models, built from primitives: a car and the protagonist. Cars now come from Blender
 * assets (tools/blender, loaded by carAssets.ts, drawn by carModel.ts) behind the same
 * `VehicleModel` interface; `makeVehicleModel` picks the asset and falls back to the box car here
 * when the asset is missing (not loaded, failed, or `?cars=box`).
 *
 * Models face +Z with +X to their left, matching the sim.
 */
import * as THREE from 'three';
import type { HandlingData } from '../../shared/handling';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { newJoints, solvePose, type PedMode, type PoseExtra } from './pedPose';
import type { WeaponKind } from '../../shared/weapons';
import { WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import { carAsset } from './carAssets';
import type { CarDamageState, DamageShape } from './carDamage';
import { CAR_HEAD } from './carMaterials';
import { assetFor } from './carLod';
import { CarModel, type DetachedPart } from './carModel';
import { CHAR_OUTFITS, lookOf } from './chars/outfits';

// Boxes of the same size share one geometry, so building and dropping models does not leak.
const boxGeos = new Map<string, THREE.BoxGeometry>();
const boxGeo = (w: number, h: number, d: number) => {
  const key = `${w.toFixed(3)}x${h.toFixed(3)}x${d.toFixed(3)}`;
  let g = boxGeos.get(key);
  if (!g) boxGeos.set(key, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
};

const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

export interface VehicleModel {
  root: THREE.Group;
  /** Sets wheels, lights, the driver's door (0 shut to 1 wide open) and body from interpolated sim state. */
  apply(wheels: Float32Array, braking: boolean, reversing: boolean, door?: number): void;
  /** Police cars: flashes the lightbar. `time` is seconds; `on` false darkens it. */
  flash(time: number, on: boolean): void;
  /** Wear: 0 (new) to 1 (wrecked) darkens the paint; `burnt` chars the whole car. */
  setCondition(wear: number, burnt: boolean): void;
  /** Flat tyres, one bit a wheel (snapshot order): those wheels are drawn squashed and sunk. */
  setFlats(mask: number): void;
  dispose(): void;
  /** Asset cars only: the level of detail drawn (0 nearest) and how to change it. */
  lod?: number;
  setLod?(level: number): void;
  /** Asset cars only: grime, 0 to 1. */
  setDirt?(k: number): void;
  /** Asset cars only: the car's shape for the damage rules, and drawing a damage state (returns parts that fell off). */
  shape?: DamageShape;
  syncDamage?(s: CarDamageState): DetachedPart[];
}

/** A car's model: its Blender asset (the police one for a police car) when loaded, else the stand-in box car. */
export function makeVehicleModel(h: HandlingData, color: number, livery?: ModelLivery): VehicleModel {
  const asset = carAsset(assetFor(h.id, !!livery && !livery.unmarked));
  return asset ? new CarModel(asset, h, color, livery) : buildVehicleModel(h, color, livery);
}

/** What the sim says about a police car's paint. */
export interface ModelLivery {
  body: number;
  stripe: number;
  lightbar: [number, number];
  /** A plain car: no stripe and no roof bar, only two strobes in the windscreen and grille that show when the lights are on. */
  unmarked?: boolean;
}

let glowTexture: THREE.CanvasTexture | null = null;
/** A soft round glow, shared by every lightbar. */
export function glowTex(): THREE.CanvasTexture {
  if (!glowTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowTexture = new THREE.CanvasTexture(c);
  }
  return glowTexture;
}

const shared = {
  // See-through enough to show the driver.
  glass: new THREE.MeshStandardMaterial({ color: 0x1b242b, roughness: 0.15, metalness: 0.5, transparent: true, opacity: 0.55 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.35, metalness: 0.8 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.7 }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xfff1c9, emissiveIntensity: 0.8 }),
};

/** How bright the headlamps are drawn, 0.8 by day; the time of day raises it at night. Shared by every car. */
export function setHeadlights(k: number) {
  shared.head.emissiveIntensity = k;
  CAR_HEAD.value = k;
}

/**
 * Which part of a car a material is, for merging a model into instanced meshes (`TrafficInstances`): its
 * `userData.part` is `paint` (takes the car's colour), `tail`, `head` (lamps) or unset (fixed colours).
 */
shared.head.userData.part = 'head';
shared.glass.userData.part = 'glass';
/** Wheel rims are not worth their triangles on an instance. */
shared.rim.userData.part = 'skip';

export function buildVehicleModel(h: HandlingData, color = 0xb23a2e, livery?: ModelLivery): VehicleModel {
  const root = new THREE.Group();
  const owned: THREE.Material[] = [];
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.45 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.25 });
  paint.userData.part = 'paint';
  tail.userData.part = 'tail';
  const c = h.chassis;
  const [hx, hy, hz] = c.halfExtents;
  const shadowCasters: THREE.Object3D[] = [];
  const bodyBox = box(hx * 2, hy * 2, hz * 2, paint, c.offset[0], c.offset[1], c.offset[2]);
  shadowCasters.push(bodyBox);
  root.add(bodyBox);
  // Bumpers and lower trim.
  root.add(box(hx * 2 + 0.02, 0.16, 0.14, shared.trim, 0, c.offset[1] - hy + 0.1, hz));
  root.add(box(hx * 2 + 0.02, 0.16, 0.14, shared.trim, 0, c.offset[1] - hy + 0.1, -hz));
  // Greenhouse: glass with a body-coloured roof slab.
  const cab = c.cabin;
  const cabBox = box(cab.halfExtents[0] * 2, cab.halfExtents[1] * 2, cab.halfExtents[2] * 2, shared.glass, cab.offset[0], cab.offset[1], cab.offset[2]);
  shadowCasters.push(cabBox);
  root.add(cabBox);
  root.add(box(cab.halfExtents[0] * 2 + 0.04, 0.06, cab.halfExtents[2] * 2 - 0.1, paint, cab.offset[0], cab.offset[1] + cab.halfExtents[1] + 0.03, cab.offset[2]));
  if (h.body === 'pickup') {
    // An open bed behind the cab: floor rails, side walls and a tailgate.
    const top = c.offset[1] + hy;
    const bedFront = cab.offset[2] - cab.halfExtents[2];
    const bedLen = bedFront - -hz;
    const bedMid = (bedFront + -hz) / 2;
    const rail = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.8), roughness: 0.5, metalness: 0.3 });
    rail.userData.part = 'paint';
    owned.push(rail);
    for (const sx of [-1, 1]) root.add(box(0.08, 0.34, bedLen, rail, sx * (hx - 0.04), top + 0.17, bedMid));
    root.add(box(hx * 2, 0.34, 0.08, rail, 0, top + 0.17, -hz + 0.04));
    root.add(box(hx * 2 - 0.16, 0.34, 0.08, rail, 0, top + 0.17, bedFront + 0.04));
    root.add(box(hx * 2 - 0.16, 0.04, bedLen, shared.trim, 0, top + 0.02, bedMid));
    // A tall grille and a bull bar.
    root.add(box(hx * 1.4, 0.34, 0.1, shared.trim, 0, c.offset[1] + 0.05, hz + 0.04));
  }

  // The driver's door: a panel on the left side, hinged at its front edge.
  const doorZ = cab.offset[2] + 0.2;
  const doorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.92), roughness: 0.38, metalness: 0.45 });
  doorMat.userData.part = 'paint';
  owned.push(doorMat);
  const doorLen = 1.0;
  const doorHinge = new THREE.Group();
  doorHinge.position.set(hx + 0.02, c.offset[1] - hy * 0.2, doorZ + doorLen / 2);
  doorHinge.add(box(0.05, hy * 1.6 + cab.halfExtents[1] * 1.3, doorLen, doorMat, 0, (cab.halfExtents[1] * 1.3) / 2 - 0.03, -doorLen / 2));
  root.add(doorHinge);

  // Lights.
  for (const sx of [-1, 1]) {
    root.add(box(0.34, 0.12, 0.05, shared.head, sx * (hx - 0.28), c.offset[1] + 0.1, hz + 0.02));
    const t = box(0.34, 0.1, 0.05, tail, sx * (hx - 0.28), c.offset[1] + 0.12, -hz - 0.02);
    t.castShadow = false;
    t.name = 'tail';
    root.add(t);
  }

  const wb = h.wheels;
  const pivots: THREE.Group[] = [];
  const rollers: THREE.Group[] = [];
  const tyreGeo = new THREE.CylinderGeometry(wb.radius, wb.radius, wb.width, 20).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(wb.radius * 0.62, wb.radius * 0.62, wb.width + 0.02, 12).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(wb.width + 0.03, wb.radius * 0.16, wb.radius * 1.2);
  for (let i = 0; i < WHEEL_COUNT; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const track = front ? wb.trackFront : wb.trackRear;
    const pivot = new THREE.Group();
    pivot.position.set((left ? 1 : -1) * track * 0.5, wb.mountY - h.suspension.travel, front ? wb.frontZ : wb.rearZ);
    const roller = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, shared.tyre);
    tyre.castShadow = true;
    roller.add(tyre, new THREE.Mesh(rimGeo, shared.rim), new THREE.Mesh(spokeGeo, shared.trim));
    pivot.add(roller);
    root.add(pivot);
    pivots.push(pivot);
    rollers.push(roller);
  }
  const tails = root.children.filter((o) => o.name === 'tail') as THREE.Mesh[];

  // Police: a stripe down the flank and a lightbar on the roof, two lamps that take turns.
  const lamps: { mat: THREE.MeshStandardMaterial; glow: THREE.Sprite; color: number }[] = [];
  if (livery) {
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 });
    owned.push(dark);
    const addLamp = (col: number, size: [number, number, number], x: number, y: number, z: number, glowSize: number) => {
      const lm = new THREE.MeshStandardMaterial({ color: new THREE.Color(col).multiplyScalar(0.25), emissive: col, emissiveIntensity: 0, roughness: 0.4 });
      owned.push(lm);
      const lamp = box(size[0], size[1], size[2], lm, x, y, z);
      lamp.castShadow = false;
      root.add(lamp);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(glowSize);
      glow.position.set(x, y + 0.1, z);
      root.add(glow);
      owned.push(glow.material);
      lamps.push({ mat: lm, glow, color: col });
    };
    if (livery.unmarked) {
      // Strobes behind the windscreen and in the grille: nothing to see until they are switched on.
      const dashY = cab.offset[1] + cab.halfExtents[1] * 0.55;
      const dashZ = cab.offset[2] + cab.halfExtents[2] - 0.12;
      addLamp(livery.lightbar[0], [0.22, 0.06, 0.08], -cab.halfExtents[0] * 0.5, dashY, dashZ, 1.5);
      addLamp(livery.lightbar[1], [0.22, 0.06, 0.08], cab.halfExtents[0] * 0.5, dashY, dashZ, 1.5);
      addLamp(livery.lightbar[1], [0.2, 0.05, 0.05], -hx * 0.55, c.offset[1] - hy * 0.2, hz + 0.04, 1.1);
      addLamp(livery.lightbar[0], [0.2, 0.05, 0.05], hx * 0.55, c.offset[1] - hy * 0.2, hz + 0.04, 1.1);
    } else {
      // A stripe down the flank and a lightbar on the roof, two lamps that take turns.
      const stripe = new THREE.MeshStandardMaterial({ color: livery.stripe, roughness: 0.5 });
      owned.push(stripe);
      for (const sx of [-1, 1]) root.add(box(0.03, 0.14, hz * 1.5, stripe, sx * (hx + 0.012), c.offset[1] + 0.02, -0.1));
      const roofY = cab.offset[1] + cab.halfExtents[1] + 0.12;
      root.add(box(cab.halfExtents[0] * 1.3, 0.07, 0.24, dark, cab.offset[0], roofY - 0.04, cab.offset[2]));
      for (const [i, sx] of [-1, 1].entries()) addLamp(livery.lightbar[i], [cab.halfExtents[0] * 0.62, 0.08, 0.2], cab.offset[0] + sx * cab.halfExtents[0] * 0.38, roofY + 0.02, cab.offset[2], 2.4);
    }
  }
  // A police car's detail (wheels' hubs, lamps, trim) does not cast a shadow of its own: the body does, and a response of five cars would
  // otherwise cost a hundred more draws in the shadow pass.
  if (livery) {
    const keep = new Set<THREE.Object3D>(shadowCasters);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !keep.has(o)) o.castShadow = false;
    });
  }
  const paintBase = new THREE.Color(color);
  const doorBase = new THREE.Color(color).multiplyScalar(0.92);
  const char = new THREE.Color(0x1b1a19);

  return {
    root,
    apply(wheels, braking, reversing, door = 0) {
      doorHinge.rotation.y = -door * 1.15;
      for (let i = 0; i < WHEEL_COUNT; i++) {
        const o = i * WHEEL_FLOATS;
        pivots[i].rotation.y = wheels[o];
        rollers[i].rotation.x = wheels[o + 1];
        pivots[i].position.y = wb.mountY - wheels[o + 2];
      }
      for (const t of tails) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = braking ? 2.2 : reversing ? 0.9 : 0.25;
    },
    flash(time, on) {
      // Red-and-blue style: one side then the other, five times a second, each with a double blink.
      const phase = Math.floor(time * 10) % 10;
      for (const [i, l] of lamps.entries()) {
        const lit = on && (i === 0 ? phase === 0 || phase === 2 : phase === 5 || phase === 7);
        l.mat.emissiveIntensity = lit ? 3 : 0;
        l.glow.material.opacity = lit ? 0.95 : 0;
      }
    },
    setFlats(mask) {
      for (let i = 0; i < WHEEL_COUNT; i++) {
        const flat = (mask >> i) & 1;
        rollers[i].scale.set(1, flat ? 0.74 : 1, flat ? 0.74 : 1);
      }
    },
    setCondition(wear, burnt) {
      const k = burnt ? 1 : Math.min(0.55, wear * 0.55);
      paint.color.copy(paintBase).lerp(char, k);
      doorMat.color.copy(doorBase).lerp(char, k);
      paint.roughness = burnt ? 0.95 : 0.38 + wear * 0.3;
      paint.metalness = burnt ? 0.1 : 0.45;
    },
    dispose() {
      tyreGeo.dispose();
      rimGeo.dispose();
      spokeGeo.dispose();
      paint.dispose();
      tail.dispose();
      for (const m of owned) m.dispose();
    },
  };
}


export type { PedMode };

export interface PedModel {
  root: THREE.Group;
  /** `speed` in m/s; `phase` is advanced by the caller; `swing` is a punch's wind-up, 0 to 1; `pedPose` is the sim's `PedPose` and `time` seconds. */
  pose(speed: number, grounded: boolean, phase: number, mode?: PedMode, swing?: number, pedPose?: number, time?: number, extra?: PoseExtra): void;
  /** Puts a gun of this kind in the hands (null: empty hands). Its mesh is made the first time and shares geometry with every other model. */
  setGun(kind: WeaponKind | null): void;
  /** Topples the figure: 1 lies on its back (knocked down), -1 face down (dead), 0 stands. A stand-in for a ragdoll. */
  lie(amount: number): void;
}

export interface PedLook {
  jacket: number;
  jeans: number;
  skin: number;
  cap: number | null;
}

/** Outfits by `PedDef.outfit` as the box figures' looks (0 is the protagonist). The real ones are in chars/outfits.ts. */
export const OUTFITS: readonly PedLook[] = CHAR_OUTFITS.map((_, i) => lookOf(i));

// ---- Guns: one merged mesh per kind, barrel along +Z, origin at the grip.
const gunGeos = new Map<WeaponKind, THREE.BufferGeometry>();
let gunMaterial: THREE.MeshStandardMaterial | null = null;
function gunGeometry(kind: WeaponKind): THREE.BufferGeometry {
  let g = gunGeos.get(kind);
  if (g) return g;
  const parts: [number, number, number, number, number, number][] =
    kind === 'pistol'
      ? [[0.027, 0.036, 0.19, 0, 0.034, 0.07], [0.022, 0.018, 0.15, 0, 0.007, 0.05], [0.007, 0.03, 0.045, 0, -0.012, 0.05], [0.012, 0.012, 0.03, 0, 0.034, 0.178]]
      : kind === 'smg'
        ? [[0.05, 0.075, 0.3, 0, 0.02, 0.12], [0.03, 0.15, 0.04, 0, -0.09, 0.08], [0.04, 0.05, 0.12, 0, 0.0, -0.1], [0.025, 0.025, 0.1, 0, 0.03, 0.3]]
        : kind === 'shotgun'
          ? [[0.04, 0.04, 0.72, 0, 0.03, 0.32], [0.045, 0.085, 0.3, 0, 0.0, -0.18], [0.06, 0.045, 0.2, 0, -0.035, 0.26]]
          : [[0.05, 0.09, 0.5, 0, 0.02, 0.2], [0.025, 0.025, 0.32, 0, 0.03, 0.62], [0.045, 0.1, 0.26, 0, -0.01, -0.2], [0.035, 0.15, 0.05, 0, -0.11, 0.15], [0.03, 0.03, 0.12, 0, 0.09, 0.2]];
  const geos = parts.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  // a pistol's grip leans back from the frame
  if (kind === 'pistol') geos.push(new THREE.BoxGeometry(0.03, 0.1, 0.048).rotateX(-0.2).translate(0, -0.045, -0.012));
  g = mergeGeometries(geos, false)!;
  for (const b of geos) b.dispose();
  gunGeos.set(kind, g);
  return g;
}

/** A gun's mesh (shared geometry and material), barrel along +Z, origin at the grip. */
export function gunMesh(kind: WeaponKind): THREE.Mesh {
  const m = new THREE.Mesh(gunGeometry(kind), (gunMaterial ??= new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.42, metalness: 0.25 })));
  m.castShadow = true;
  return m;
}

const pedMaterials = new Map<number, THREE.MeshStandardMaterial>();
const pedMat = (color: number, rough = 0.8) => {
  const key = color * 10 + Math.round(rough * 9);
  let m = pedMaterials.get(key);
  if (!m) pedMaterials.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: rough })));
  return m;
};
const headGeo = new THREE.SphereGeometry(0.115, 14, 10);

/**
 * A pedestrian stand-in in one of a handful of outfits (the protagonist's is the first): jeans, a
 * jacket, maybe a cap. About 1.74 m tall, feet at y = 0. Swings its limbs with speed, and can sit
 * at the wheel, flail while being dragged out, run in a panic, or throw a punch. Geometry and
 * materials are shared, so nothing needs disposing.
 */
export function buildPedModel(look: PedLook = OUTFITS[0]): PedModel {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  root.add(inner);
  const jacket = pedMat(look.jacket);
  const jeans = pedMat(look.jeans, 0.85);
  const skin = pedMat(look.skin, 0.7);
  const boots = pedMat(0x1d1a17, 0.9);

  const limb = (w: number, len: number, d: number, mat: THREE.Material, px: number, py: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0);
    const m = new THREE.Mesh(boxGeo(w, len, d), mat);
    m.position.y = -len / 2;
    m.castShadow = true;
    pivot.add(m);
    return pivot;
  };
  const legL = limb(0.17, 0.86, 0.2, jeans, 0.1, 0.9);
  const legR = limb(0.17, 0.86, 0.2, jeans, -0.1, 0.9);
  for (const l of [legL, legR]) {
    const b = box(0.19, 0.12, 0.3, boots, 0, -0.82, 0.05);
    l.add(b);
  }
  const armL = limb(0.12, 0.6, 0.14, jacket, 0.27, 1.48);
  const armR = limb(0.12, 0.6, 0.14, jacket, -0.27, 1.48);
  const torso = new THREE.Group();
  torso.position.y = 0.9;
  torso.add(box(0.44, 0.6, 0.26, jacket, 0, 0.3, 0));
  const head = new THREE.Mesh(headGeo, skin);
  head.position.set(0, 0.72, 0.01);
  head.castShadow = true;
  torso.add(head);
  if (look.cap !== null) torso.add(box(0.25, 0.06, 0.28, pedMat(look.cap), 0, 0.81, 0.04));
  inner.add(legL, legR, torso, armL, armR);

  // The gun sits in the right hand's pivot, its barrel along the arm; a lowered arm points it at the ground.
  let gunKind: WeaponKind | null = null;
  const guns = new Map<WeaponKind, THREE.Mesh>();
  let lying = 0;
  const j = newJoints();
  return {
    root,
    setGun(kind) {
      if (kind === gunKind) return;
      if (gunKind) guns.get(gunKind)!.visible = false;
      gunKind = kind;
      if (!kind) return;
      let m = guns.get(kind);
      if (!m) {
        m = new THREE.Mesh(gunGeometry(kind), (gunMaterial ??= new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.42, metalness: 0.25 })));
        m.castShadow = true;
        m.rotation.x = Math.PI / 2;
        // The grip is in the hand at the end of the arm and the barrel runs on past it; drawn a little oversize so it reads from behind.
        m.position.set(0, -0.58, 0.0);
        m.scale.setScalar(1.35);
        armR.add(m);
        guns.set(kind, m);
      }
      m.visible = true;
    },
    lie(amount) {
      lying = amount;
    },
    pose(speed, grounded, phase, mode = 'normal', swing = 0, pedPose = 0, time = 0, extra) {
      solvePose(j, speed, grounded, phase, mode, swing, pedPose, time, lying, 0, extra);
      inner.scale.setScalar(j.scale);
      inner.rotation.x = j.tiltX;
      inner.position.set(0, j.shiftY, j.shiftZ);
      legL.rotation.x = j.legL;
      legR.rotation.x = j.legR;
      armL.rotation.set(j.armL, 0, j.armLz);
      armR.rotation.set(j.armR, 0, j.armRz);
      torso.rotation.set(j.torsoX, j.torsoY, 0);
      torso.position.y = 0.9 + j.torsoLift;
    },
  };
}
