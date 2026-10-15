/**
 * Parts that came off cars (bumpers): physics-free props that drop, tumble a little, skid to a stop
 * on the road and lie there for a while before they go. The sim knows nothing of them (they block
 * nothing), so they cost no physics. At most `MAX` at once: the oldest goes when a new one comes.
 * Each piece owns its geometry and material copies and frees them when it goes.
 */
import * as THREE from 'three';
import type { DetachedPart } from './carModel';

interface Piece {
  root: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  ground: number;
  age: number;
  resting: boolean;
  geos: THREE.BufferGeometry[];
  mats: THREE.Material[];
}

const MAX = 10;
/** Seconds a piece lies on the road before it is removed. */
const LIFE = 45;
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

export class CarDebris {
  readonly group = new THREE.Group();
  private readonly pieces: Piece[] = [];

  constructor() {
    this.group.name = 'car-debris';
  }

  /** Lets a part fall from where it was, with the car's velocity and a kick; `ground` is the road's height there. */
  add(part: DetachedPart, vx: number, vy: number, vz: number, ground: number, seed: number) {
    if (this.pieces.length >= MAX) this.remove(this.pieces[0]);
    const root = new THREE.Group();
    part.matrixWorld.decompose(root.position, root.quaternion, root.scale);
    for (let i = 0; i < part.geos.length; i++) {
      const m = new THREE.Mesh(part.geos[i], part.mats[i]);
      m.castShadow = true;
      root.add(m);
    }
    // the geometry is in the car's frame: centre the group on the piece so it tumbles about itself
    const box = new THREE.Box3();
    for (const g of part.geos) {
      g.computeBoundingBox();
      box.union(g.boundingBox!);
    }
    const c = box.getCenter(new THREE.Vector3());
    for (const ch of root.children) ch.position.sub(c);
    root.position.add(c.applyQuaternion(root.quaternion));
    const r = Math.sin(seed * 12.9898) * 43758.5453;
    const k = r - Math.floor(r);
    this.group.add(root);
    this.pieces.push({
      root,
      vel: new THREE.Vector3(vx * 0.8 + (k - 0.5) * 1.5, vy + 1.2, vz * 0.8 + (0.5 - k) * 1.5),
      spin: new THREE.Vector3((k - 0.5) * 4, (k - 0.3) * 3, (0.6 - k) * 5),
      ground: ground + Math.max(0.03, (box.max.y - box.min.y) * 0.25),
      age: 0,
      resting: false,
      geos: part.geos,
      mats: part.mats,
    });
  }

  update(dt: number) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      if (p.age > LIFE) {
        this.remove(p);
        continue;
      }
      if (p.resting) continue;
      p.vel.y -= 9.81 * dt;
      p.root.position.addScaledVector(p.vel, dt);
      tmpQ.setFromEuler(tmpE.set(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt));
      p.root.quaternion.premultiply(tmpQ);
      if (p.root.position.y < p.ground) {
        p.root.position.y = p.ground;
        p.vel.y = Math.abs(p.vel.y) * 0.25;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.5);
        // settle: lie flat-ish on the road
        tmpE.setFromQuaternion(p.root.quaternion, 'YXZ');
        tmpE.x *= 0.6;
        tmpE.z *= 0.6;
        p.root.quaternion.setFromEuler(tmpE);
        if (p.vel.lengthSq() < 0.05) p.resting = true;
      }
    }
  }

  private remove(p: Piece) {
    this.group.remove(p.root);
    for (const g of p.geos) g.dispose();
    for (const m of p.mats) m.dispose();
    this.pieces.splice(this.pieces.indexOf(p), 1);
  }

  get count() {
    return this.pieces.length;
  }

  dispose() {
    while (this.pieces.length) this.remove(this.pieces[0]);
    this.group.removeFromParent();
  }
}
