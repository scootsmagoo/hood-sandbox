/**
 * Soft puffs drawn as one Points object: tyre smoke for a burnout or a drift, engine smoke from a
 * damaged car, and (additive and orange) fire.
 */
import * as THREE from 'three';

export interface SmokeOptions {
  /** Particle pool size. */
  max?: number;
  /** RGB, 0 to 1. */
  color?: [number, number, number];
  /** Glow instead of haze: additive blending. */
  additive?: boolean;
  /** Start and end size (m), life range (s), upward speed (m/s) and peak opacity. */
  size?: [number, number];
  life?: [number, number];
  rise?: number;
  alpha?: number;
}

export class SmokeSystem {
  private readonly MAX: number;
  private readonly opts: Required<SmokeOptions>;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private next = 0;
  private carry = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, options: SmokeOptions = {}) {
    this.opts = { max: 400, color: [0.82, 0.82, 0.82], additive: false, size: [0.4, 1.9], life: [0.9, 1.7], rise: 0.6, alpha: 0.4, ...options };
    const MAX = (this.MAX = this.opts.max);
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.age = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.age.fill(1e9);
    this.life.fill(1);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: this.opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 400 }, uColor: { value: new THREE.Vector3(...this.opts.color) } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; varying float vAlpha; uniform float uScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          vAlpha = aAlpha;
        }`,
      fragmentShader: `
        varying float vAlpha; uniform vec3 uColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.2, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  /** Pixels per metre at one metre's distance: drawing buffer height over twice the tangent of half the field of view. */
  setScale(pixelsPerMetre: number) {
    this.mat.uniforms.uScale.value = pixelsPerMetre;
  }

  /** Emits at a rate proportional to `strength` (0 to 1). */
  emit(x: number, y: number, z: number, vx: number, vz: number, dt: number, strength: number) {
    this.carry += dt * 60 * strength;
    while (this.carry >= 1) {
      this.carry -= 1;
      const i = this.next;
      this.next = (this.next + 1) % this.MAX;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      this.vel[i * 3] = vx + (Math.random() - 0.5) * 0.8;
      this.vel[i * 3 + 1] = this.opts.rise + Math.random() * this.opts.rise * 1.3;
      this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.8;
      this.age[i] = 0;
      this.life[i] = this.opts.life[0] + Math.random() * (this.opts.life[1] - this.opts.life[0]);
      this.size[i] = this.opts.size[0];
    }
  }

  /** An explosion: `count` puffs thrown out of one point at up to `speed` m/s. */
  burst(x: number, y: number, z: number, count: number, speed: number) {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.MAX;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9;
      const r = Math.sqrt(1 - up * up) * speed * (0.3 + Math.random() * 0.7);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * r;
      this.vel[i * 3 + 1] = up * speed * 0.8 + 1;
      this.vel[i * 3 + 2] = Math.sin(a) * r;
      this.age[i] = 0;
      this.life[i] = this.opts.life[0] + Math.random() * (this.opts.life[1] - this.opts.life[0]);
      this.size[i] = this.opts.size[0];
    }
  }

  update(dt: number) {
    let any = false;
    for (let i = 0; i < this.MAX; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      any = true;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 1.5;
      this.vel[i * 3 + 2] *= 1 - dt * 1.5;
      this.size[i] = this.opts.size[0] + t * (this.opts.size[1] - this.opts.size[0]);
      this.alpha[i] = (1 - t) * this.opts.alpha;
    }
    this.points.visible = any;
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
