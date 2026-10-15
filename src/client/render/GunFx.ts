/**
 * Gunfire you can see: tracers, muzzle flashes, impact puffs, sparks, blood and bullet-hole decals.
 * Everything is built once, here, and reused: the tracers, the flashes and the decals are one
 * InstancedMesh each (a ring of fixed size, so a long fight never grows anything), and the dust,
 * sparks and blood are three small `SmokeSystem` point pools. Nothing is created or disposed when
 * shots are fired, so the leak counts stay flat. Idle, none of it is drawn.
 *
 * The sim says what happened (`weapon:fire` carries the muzzle and one impact per bullet); this file
 * only decorates it.
 */
import * as THREE from 'three';
import type { SimEvent } from '../../shared/protocol';
import { WEAPONS } from '../../shared/weapons';
import type { Game, System } from '../Game';
import { glowTex } from './models';
import { SmokeSystem } from './Smoke';

const MAX_TRACERS = 96;
const MAX_FLASHES = 16;
const MAX_DECALS = 64;
/** Bullets are drawn at this speed, m/s (the sim's are instant). */
const TRACER_SPEED = 430;
/** Shots from further than this are neither drawn nor flashed, m. */
const VISIBLE_M = 260;

interface Tracer {
  ax: number; ay: number; az: number;
  dx: number; dy: number; dz: number;
  dist: number;
  len: number;
  width: number;
  age: number;
  life: number;
}
interface Flash {
  x: number; y: number; z: number;
  size: number;
  age: number;
  life: number;
}

function streakTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 16;
  const g = c.getContext('2d')!;
  // Bright head on the right (the front of the bullet), fading to nothing behind it; soft across.
  const along = g.createLinearGradient(0, 0, 128, 0);
  along.addColorStop(0, 'rgba(255,200,120,0)');
  along.addColorStop(0.7, 'rgba(255,214,150,0.55)');
  along.addColorStop(1, 'rgba(255,250,235,1)');
  g.fillStyle = along;
  g.fillRect(0, 0, 128, 16);
  g.globalCompositeOperation = 'destination-in';
  const across = g.createLinearGradient(0, 0, 0, 16);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.5, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = across;
  g.fillRect(0, 0, 128, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function holeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(8,8,10,0.95)');
  grad.addColorStop(0.35, 'rgba(14,14,16,0.85)');
  grad.addColorStop(0.7, 'rgba(40,38,36,0.35)');
  grad.addColorStop(1, 'rgba(40,38,36,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

declare module '../Game' {
  interface Game {
    gunFx: GunFx;
  }
}

export class GunFx implements System {
  readonly name = 'gunFx';
  readonly priority = 60;
  private readonly group = new THREE.Group();
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly flashMesh: THREE.InstancedMesh;
  private readonly decalMesh: THREE.InstancedMesh;
  private readonly tracers: Tracer[] = [];
  private nextTracer = 0;
  private readonly flashes: Flash[] = [];
  private nextFlash = 0;
  private decalCount = 0;
  private nextDecal = 0;
  private readonly dust: SmokeSystem;
  private readonly sparks: SmokeSystem;
  private readonly blood: SmokeSystem;
  private readonly textures: THREE.Texture[] = [];
  private readonly size = new THREE.Vector2();
  private readonly m4 = new THREE.Matrix4();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly col = new THREE.Color();
  /** Shots drawn so far, for the tests and the leak harness. */
  shots = 0;
  /** Slows the effects down (screenshots: a muzzle flash lasts 55 ms). 1 in play. */
  timeScale = 1;

  constructor(private readonly game: Game) {
    game.gunFx = this;
    this.group.name = 'gunFx';
    game.scene.add(this.group);

    const streak = streakTexture();
    const hole = holeTexture();
    this.textures.push(streak, hole);
    const quad = new THREE.PlaneGeometry(1, 1);

    this.tracerMesh = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ map: streak, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: 0xffe6b8, side: THREE.DoubleSide }), MAX_TRACERS);
    this.flashMesh = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ map: glowTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: 0xffc27a, side: THREE.DoubleSide }), MAX_FLASHES);
    this.decalMesh = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ map: hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }), MAX_DECALS);
    for (const m of [this.tracerMesh, this.flashMesh, this.decalMesh]) {
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.renderOrder = 6;
      this.group.add(m);
    }
    // Make the flash colour attribute now, so nothing is created on the first shot.
    this.flashMesh.setColorAt(0, this.col.setScalar(1));
    for (let i = 0; i < MAX_TRACERS; i++) this.tracers.push({ ax: 0, ay: 0, az: 0, dx: 0, dy: 0, dz: 0, dist: 0, len: 0, width: 0, age: 0, life: 0 });
    for (let i = 0; i < MAX_FLASHES; i++) this.flashes.push({ x: 0, y: 0, z: 0, size: 0, age: 0, life: 0 });
    for (const t of this.tracers) t.age = t.life = 1;
    for (const f of this.flashes) f.age = f.life = 1;

    this.dust = new SmokeSystem(game.scene, { max: 160, color: [0.62, 0.58, 0.52], size: [0.12, 0.75], life: [0.3, 0.6], rise: 0.7, alpha: 0.5 });
    this.sparks = new SmokeSystem(game.scene, { max: 96, color: [1, 0.66, 0.25], additive: true, size: [0.07, 0.02], life: [0.1, 0.28], rise: 0.3, alpha: 1 });
    this.blood = new SmokeSystem(game.scene, { max: 96, color: [0.5, 0.04, 0.04], size: [0.09, 0.18], life: [0.3, 0.7], rise: 0.2, alpha: 0.8 });
    game.onSimEvent((e) => this.onEvent(e));
  }

  private onEvent(e: SimEvent) {
    switch (e.type) {
      case 'weapon:fire':
        this.fire(e);
        break;
      case 'vehicle:tyre': {
        const car = this.game.view.entities.get(e.vehicleId);
        if (car) this.sparks.burst(car.x, car.y + 0.2, car.z, 10, 4);
        break;
      }
      default:
        break;
    }
  }

  private fire(e: Extract<SimEvent, { type: 'weapon:fire' }>) {
    const cam = this.game.camera.position;
    if (Math.hypot(e.x - cam.x, e.z - cam.z) > VISIBLE_M) return;
    this.shots++;
    const def = WEAPONS[e.weapon];
    const pellet = def.pellets > 1;
    // The flash sits just in front of the muzzle.
    const f = this.flashes[this.nextFlash];
    this.nextFlash = (this.nextFlash + 1) % MAX_FLASHES;
    f.x = e.x + e.dx * 0.18;
    f.y = e.y + e.dy * 0.18;
    f.z = e.z + e.dz * 0.18;
    f.size = def.kind === 'shotgun' ? 0.95 : def.kind === 'rifle' ? 0.7 : def.kind === 'smg' ? 0.5 : 0.42;
    f.age = 0;
    f.life = 0.055;
    for (const im of e.impacts) {
      const dx = im.x - e.x;
      const dy = im.y - e.y;
      const dz = im.z - e.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.5) continue;
      const t = this.tracers[this.nextTracer];
      this.nextTracer = (this.nextTracer + 1) % MAX_TRACERS;
      t.ax = e.x;
      t.ay = e.y;
      t.az = e.z;
      t.dx = dx / dist;
      t.dy = dy / dist;
      t.dz = dz / dist;
      t.dist = dist;
      t.len = pellet ? 3 : 6.5;
      t.width = pellet ? 0.028 : 0.05;
      t.age = 0;
      t.life = (dist + t.len) / TRACER_SPEED;
      if (im.kind === 'none') continue;
      this.impact(im.kind, im.x, im.y, im.z, im.nx, im.ny, im.nz, pellet);
    }
  }

  private impact(kind: string, x: number, y: number, z: number, nx: number, ny: number, nz: number, pellet: boolean) {
    if (kind === 'ped') {
      this.blood.burst(x, y, z, pellet ? 2 : 5, 2.2);
      return;
    }
    if (kind === 'vehicle') {
      this.sparks.burst(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, pellet ? 2 : 6, 4.5);
      return;
    }
    this.dust.burst(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, pellet ? 1 : 3, 1.4);
    this.sparks.burst(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, pellet ? 1 : 3, 3.5);
    // A hole, lying on the surface.
    const i = this.nextDecal;
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;
    this.decalCount = Math.min(MAX_DECALS, this.decalCount + 1);
    this.v1.set(nx, ny, nz);
    if (this.v1.lengthSq() < 0.5) return;
    this.v1.normalize();
    this.q.setFromUnitVectors(this.v3.set(0, 0, 1), this.v1);
    // A turn about the normal so the holes do not all look alike.
    const spin = ((x * 12.9898 + z * 78.233 + y * 37.719) % 1) * Math.PI * 2;
    this.v2.copy(this.v1).multiplyScalar(0.012).add(this.s.set(x, y, z));
    const size = pellet ? 0.1 : 0.17;
    this.m4.compose(this.v2, this.q.multiply(this.q2.setFromAxisAngle(this.v3.set(0, 0, 1), spin)), this.s.set(size, size, 1));
    this.decalMesh.setMatrixAt(i, this.m4);
    this.decalMesh.count = this.decalCount;
    this.decalMesh.visible = true;
    this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    dt *= this.timeScale;
    const cam = this.game.camera;
    // Tracers.
    let n = 0;
    for (const t of this.tracers) {
      if (t.age >= t.life) continue;
      t.age += dt;
      const head = Math.min(t.dist, t.age * TRACER_SPEED);
      const tail = Math.min(t.dist, Math.max(0, t.age * TRACER_SPEED - t.len));
      const l = head - tail;
      if (l <= 0.05) continue;
      const mx = t.ax + t.dx * (head + tail) * 0.5;
      const my = t.ay + t.dy * (head + tail) * 0.5;
      const mz = t.az + t.dz * (head + tail) * 0.5;
      // The streak is a flat quad turned to face the camera about its own length.
      this.v1.set(t.dx, t.dy, t.dz);
      this.v2.set(cam.position.x - mx, cam.position.y - my, cam.position.z - mz);
      this.v3.crossVectors(this.v1, this.v2);
      const sl = this.v3.length();
      if (sl < 1e-4) continue;
      this.v3.multiplyScalar(t.width / sl);
      this.v2.crossVectors(this.v1, this.v3).normalize();
      this.m4.makeBasis(this.v1.multiplyScalar(l), this.v3, this.v2);
      this.m4.setPosition(mx, my, mz);
      this.tracerMesh.setMatrixAt(n++, this.m4);
    }
    this.tracerMesh.count = n;
    this.tracerMesh.visible = n > 0;
    if (n) this.tracerMesh.instanceMatrix.needsUpdate = true;

    // Flashes.
    n = 0;
    for (const f of this.flashes) {
      if (f.age >= f.life) continue;
      f.age += dt;
      const k = 1 - f.age / f.life;
      if (k <= 0) continue;
      const sc = f.size * (1.2 - 0.4 * k);
      this.s.set(sc, sc, 1);
      this.m4.compose(this.v1.set(f.x, f.y, f.z), cam.quaternion, this.s);
      this.flashMesh.setMatrixAt(n, this.m4);
      this.flashMesh.setColorAt(n, this.col.setScalar(k * 1.6));
      n++;
    }
    this.flashMesh.count = n;
    this.flashMesh.visible = n > 0;
    if (n) {
      this.flashMesh.instanceMatrix.needsUpdate = true;
      if (this.flashMesh.instanceColor) this.flashMesh.instanceColor.needsUpdate = true;
    }

    this.game.renderer.getDrawingBufferSize(this.size);
    const scale = this.size.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const sys of [this.dust, this.sparks, this.blood]) {
      sys.setScale(scale);
      sys.update(dt);
    }
  }

  /** What is drawn right now: live tracers and flashes, and the holes in walls. */
  get active() {
    return { tracers: this.tracerMesh.count, flashes: this.flashMesh.count, decals: this.decalMesh.count };
  }

  dispose() {
    this.game.scene.remove(this.group);
    for (const m of [this.tracerMesh, this.flashMesh, this.decalMesh]) {
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.tracerMesh.geometry.dispose();
    for (const t of this.textures) t.dispose();
    this.dust.dispose();
    this.sparks.dispose();
    this.blood.dispose();
  }
}
