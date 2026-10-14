/**
 * Stand-in models, built from primitives: a car and the protagonist. Real assets (Blender scripts
 * under tools/blender, exported as glTF) replace them later behind the same interfaces.
 *
 * Models face +Z with +X to their left, matching the sim.
 */
import * as THREE from 'three';
import type { HandlingData } from '../../shared/handling';
import { WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';

const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

export interface VehicleModel {
  root: THREE.Group;
  /** Sets wheels, lights and body from interpolated sim state. */
  apply(wheels: Float32Array, braking: boolean, reversing: boolean): void;
  dispose(): void;
}

const shared = {
  glass: new THREE.MeshStandardMaterial({ color: 0x1b242b, roughness: 0.15, metalness: 0.6 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.35, metalness: 0.8 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.7 }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xfff1c9, emissiveIntensity: 0.8 }),
};

export function buildVehicleModel(h: HandlingData, color = 0xb23a2e): VehicleModel {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.45 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0d0d, emissive: 0xff1a1a, emissiveIntensity: 0.25 });
  const c = h.chassis;
  const [hx, hy, hz] = c.halfExtents;
  root.add(box(hx * 2, hy * 2, hz * 2, paint, c.offset[0], c.offset[1], c.offset[2]));
  // Bumpers and lower trim.
  root.add(box(hx * 2 + 0.02, 0.16, 0.14, shared.trim, 0, c.offset[1] - hy + 0.1, hz));
  root.add(box(hx * 2 + 0.02, 0.16, 0.14, shared.trim, 0, c.offset[1] - hy + 0.1, -hz));
  // Greenhouse: glass with a body-coloured roof slab.
  const cab = c.cabin;
  root.add(box(cab.halfExtents[0] * 2, cab.halfExtents[1] * 2, cab.halfExtents[2] * 2, shared.glass, cab.offset[0], cab.offset[1], cab.offset[2]));
  root.add(box(cab.halfExtents[0] * 2 + 0.04, 0.06, cab.halfExtents[2] * 2 - 0.1, paint, cab.offset[0], cab.offset[1] + cab.halfExtents[1] + 0.03, cab.offset[2]));
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

  return {
    root,
    apply(wheels, braking, reversing) {
      for (let i = 0; i < WHEEL_COUNT; i++) {
        const o = i * WHEEL_FLOATS;
        pivots[i].rotation.y = wheels[o];
        rollers[i].rotation.x = wheels[o + 1];
        pivots[i].position.y = wb.mountY - wheels[o + 2];
      }
      for (const t of tails) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = braking ? 2.2 : reversing ? 0.9 : 0.25;
    },
    dispose() {
      tyreGeo.dispose();
      rimGeo.dispose();
      spokeGeo.dispose();
      paint.dispose();
      tail.dispose();
    },
  };
}

export interface PedModel {
  root: THREE.Group;
  /** `speed` in m/s; `phase` is advanced by the caller. */
  pose(speed: number, grounded: boolean, phase: number): void;
}

/**
 * The protagonist stand-in: jeans, an olive work jacket, a cap. About 1.74 m tall, feet at y = 0.
 * Swings its limbs with speed.
 */
export function buildPedModel(): PedModel {
  const root = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0x5b6b3a, roughness: 0.8 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2f4059, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x6b4430, roughness: 0.7 });
  const cap = new THREE.MeshStandardMaterial({ color: 0x8a2f1e, roughness: 0.8 });
  const boots = new THREE.MeshStandardMaterial({ color: 0x1d1a17, roughness: 0.9 });

  const limb = (w: number, len: number, d: number, mat: THREE.Material, px: number, py: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat);
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
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), skin);
  head.position.set(0, 0.72, 0.01);
  head.castShadow = true;
  torso.add(head);
  torso.add(box(0.25, 0.06, 0.28, cap, 0, 0.81, 0.04));
  root.add(legL, legR, torso, armL, armR);

  return {
    root,
    pose(speed, grounded, phase) {
      const amp = Math.min(1, speed / 4.6) * 0.95;
      const s = Math.sin(phase) * amp;
      if (grounded) {
        legL.rotation.x = s;
        legR.rotation.x = -s;
        armL.rotation.x = -s * 0.9;
        armR.rotation.x = s * 0.9;
        torso.rotation.x = Math.min(0.25, speed * 0.03);
      } else {
        legL.rotation.x = -0.5;
        legR.rotation.x = 0.35;
        armL.rotation.x = -2.2;
        armR.rotation.x = -2.0;
        torso.rotation.x = 0.05;
      }
      torso.position.y = 0.9 + (grounded ? Math.abs(Math.sin(phase)) * 0.04 * amp : 0);
    },
  };
}
