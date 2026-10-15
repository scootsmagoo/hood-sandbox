/**
 * Stand-in models for the police escalation: the helicopter (fuselage, tail boom, a spinning rotor and a
 * searchlight whose beam is an additive cone with a pool of light where it lands) and the spike strip.
 * Built from primitives like the other stand-ins; the beam is a cheap mesh, not a light, so it costs no
 * shader recompiles and nothing per fragment on the street.
 *
 * Helicopters face +Z with +X to their left, like the sim's.
 */
import * as THREE from 'three';
import { glowTex } from './models';

const mat = (color: number, rough = 0.5, metal = 0.2) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

export interface HeliModel {
  root: THREE.Group;
  /** The beam and its pool, in world coordinates: add it to the scene next to `root`, not under it. */
  fx: THREE.Group;
  /**
   * Spins the rotor and aims the searchlight. `light` is the share of the beam shown (0 by day), `target` the
   * point it lights (world), `rotor` the rotor speed 0 to 1. The beam ends at `target`.
   */
  update(dt: number, time: number, rotor: number, light: number, target: THREE.Vector3): void;
  dispose(): void;
}

export function buildHelicopter(color: number): HeliModel {
  const root = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };
  const paint = own(mat(color, 0.4, 0.35));
  // a little glow of its own so it still reads against a night sky
  paint.emissive = new THREE.Color(color).multiplyScalar(0.18);
  const dark = own(mat(0x15171a, 0.6, 0.2));
  const metal = own(mat(0x9aa0a8, 0.4, 0.8));
  const glass = own(new THREE.MeshStandardMaterial({ color: 0x1b242b, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.6 }));
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = root) => {
    own(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  };

  // The cabin and its glass nose. (Only the fuselage casts a shadow: the rest would double the draws for a shadow nobody can tell.)
  add(new THREE.CapsuleGeometry(1.2, 3.0, 6, 14).rotateX(Math.PI / 2), paint).castShadow = true;
  add(new THREE.SphereGeometry(1.1, 14, 10).scale(0.98, 0.95, 1.25), glass, 0, 0.1, 2.15);
  // Tail boom, fin, stabiliser.
  add(new THREE.CylinderGeometry(0.22, 0.5, 5.6, 8).rotateX(-Math.PI / 2), paint, 0, 0.35, -4.6);
  add(new THREE.BoxGeometry(0.12, 1.6, 1.1), paint, 0, 0.9, -7.2);
  add(new THREE.BoxGeometry(2.2, 0.1, 0.6), paint, 0, 0.35, -6.9);
  // The mast, the main rotor (four blades) and a faint disc for the blur.
  add(new THREE.CylinderGeometry(0.16, 0.2, 0.9, 8), metal, 0, 1.55, 0);
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.05, 0);
  root.add(rotor);
  const blade = new THREE.BoxGeometry(7.4, 0.05, 0.34);
  own(blade);
  const b1 = new THREE.Mesh(blade, dark);
  const b2 = new THREE.Mesh(blade, dark);
  b2.rotation.y = Math.PI / 2;
  rotor.add(b1, b2);
  const discMat = own(new THREE.MeshBasicMaterial({ color: 0x1a1c20, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const disc = add(new THREE.CircleGeometry(3.8, 28).rotateX(-Math.PI / 2), discMat, 0, 2.05, 0);
  disc.castShadow = false;
  // The tail rotor.
  const tail = new THREE.Group();
  tail.position.set(0.32, 0.95, -7.3);
  root.add(tail);
  const tb = new THREE.BoxGeometry(0.05, 1.7, 0.16);
  own(tb);
  const t1 = new THREE.Mesh(tb, dark);
  const t2 = new THREE.Mesh(tb, dark);
  t2.rotation.x = Math.PI / 2;
  tail.add(t1, t2);
  // Skids and struts.
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.06, 0.06, 4.4, 6).rotateX(Math.PI / 2), metal, sx * 1.15, -1.6, 0.2);
    for (const z of [-0.9, 1.2]) add(new THREE.BoxGeometry(0.07, 0.65, 0.07), metal, sx * 1.1, -1.3, z);
  }
  // The searchlight under the nose.
  const lamp = add(new THREE.SphereGeometry(0.24, 10, 8), metal, 0, -1.2, 1.9);
  lamp.castShadow = false;
  // Strobes: a white one under the tail and a red one on the mast, blinking.
  const strobeMat = own(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const strobe = new THREE.Sprite(strobeMat);
  strobe.scale.setScalar(2.2);
  strobe.position.set(0, 0.3, -7.6);
  root.add(strobe);
  const beaconMat = own(new THREE.SpriteMaterial({ map: glowTex(), color: 0xff2020, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const beacon = new THREE.Sprite(beaconMat);
  beacon.scale.setScalar(1.6);
  beacon.position.set(0, 2.15, 0);
  root.add(beacon);

  // The beam: an open cone from the lamp (apex at the origin, axis +Z, length 1) that is brightest at the lamp, and a pool where it lands.
  const cone = new THREE.ConeGeometry(1, 1, 24, 1, true);
  cone.translate(0, -0.5, 0).rotateX(-Math.PI / 2);
  own(cone);
  const pos = cone.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getZ(i); // 0 at the lamp, 1 at the ground
    const k = 0.1 + 0.9 * Math.pow(1 - t, 0.7);
    colors[i * 3] = k;
    colors[i * 3 + 1] = k;
    colors[i * 3 + 2] = k * 0.9;
  }
  cone.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Three nested cones, wide and faint to narrow and brighter, read as a soft-edged beam.
  const beams: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; k: number; a: number }[] = [];
  for (const [k, a] of [[1, 0.05], [0.68, 0.07], [0.38, 0.1]] as const) {
    const bm = own(new THREE.MeshBasicMaterial({ color: 0xfff2cc, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(cone, bm);
    mesh.visible = false;
    mesh.frustumCulled = false;
    beams.push({ mesh, mat: bm, k, a });
  }
  // A glow where the lamp is, so the source shows.
  const lampGlowMat = own(new THREE.SpriteMaterial({ map: glowTex(), color: 0xfff2cc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const lampGlow = new THREE.Sprite(lampGlowMat);
  lampGlow.scale.setScalar(5);
  const poolGeo = own(new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2));
  const poolMat = own(new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xfff2cc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const pool = new THREE.Mesh(poolGeo, poolMat);
  pool.visible = false;
  pool.frustumCulled = false;
  pool.renderOrder = 3;
  // The beam and its pool live in the world, not on the airframe, so they point at the ground whatever the helicopter's lean.
  const fx = new THREE.Group();
  fx.add(...beams.map((b) => b.mesh), pool, lampGlow);

  const lampWorld = new THREE.Vector3();
  const half = Math.tan((7 * Math.PI) / 180);

  return {
    root,
    fx,
    update(dt, time, rotorSpeed, light, target) {
      rotor.rotation.y += dt * 34 * rotorSpeed;
      tail.rotation.x += dt * 60 * rotorSpeed;
      discMat.opacity = 0.16 * rotorSpeed;
      strobeMat.opacity = Math.floor(time * 2.2) % 2 === 0 && (time * 2.2) % 1 < 0.12 ? 1 : 0;
      beaconMat.opacity = (time * 1.1) % 1 < 0.5 ? 0.9 : 0.1;
      if (light <= 0.01) {
        for (const b of beams) b.mesh.visible = false;
        pool.visible = false;
        lampGlow.visible = false;
        return;
      }
      root.updateWorldMatrix(true, false);
      lampWorld.set(0, -1.2, 1.9).applyMatrix4(root.matrixWorld);
      const len = Math.max(1, lampWorld.distanceTo(target));
      pool.visible = true;
      lampGlow.visible = true;
      lampGlow.position.copy(lampWorld);
      lampGlowMat.opacity = 0.9 * light;
      for (const b of beams) {
        b.mesh.visible = true;
        b.mesh.position.copy(lampWorld);
        b.mesh.scale.set(len * half * b.k, len * half * b.k, len);
        b.mesh.lookAt(target);
        b.mat.opacity = b.a * light;
      }
      pool.position.set(target.x, target.y + 0.25, target.z);
      const r = len * half * 1.15;
      pool.scale.setScalar(r);
      poolMat.opacity = 0.75 * light;
    },
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

export interface StripModel {
  root: THREE.Group;
  dispose(): void;
}

/** A spike strip: a dark plate with rows of small spikes. `length` runs along the model's Z. */
export function buildSpikeStrip(length: number, depth: number): StripModel {
  const root = new THREE.Group();
  const plate = new THREE.BoxGeometry(depth, 0.05, length);
  const plateMat = mat(0x8a6d1f, 0.55, 0.3);
  const base = new THREE.Mesh(plate, plateMat);
  base.position.y = 0.03;
  root.add(base);
  const rows = 3;
  const cols = Math.max(4, Math.floor(length / 0.2));
  const spike = new THREE.ConeGeometry(0.04, 0.2, 4);
  const spikeMat = mat(0xc9ced4, 0.3, 0.9);
  const inst = new THREE.InstancedMesh(spike, spikeMat, rows * cols);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      m.makeTranslation(((r + 0.5) / rows - 0.5) * depth * 0.8, 0.15, ((c + 0.5) / cols - 0.5) * length * 0.98);
      inst.setMatrixAt(n++, m);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  root.add(inst);
  base.receiveShadow = true;
  return {
    root,
    dispose() {
      plate.dispose();
      plateMat.dispose();
      spike.dispose();
      spikeMat.dispose();
      inst.dispose();
    },
  };
}
