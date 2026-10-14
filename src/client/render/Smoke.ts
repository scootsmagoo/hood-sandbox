/**
 * Tyre smoke: a pool of soft puffs drawn as one Points object. Cheap, and enough to show a
 * burnout or a drift.
 */
import * as THREE from 'three';

const MAX = 400;

export class SmokeSystem {
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly alpha = new Float32Array(MAX);
  private next = 0;
  private carry = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.age.fill(1e9);
    this.life.fill(1);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 400 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; varying float vAlpha; uniform float uScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          vAlpha = aAlpha;
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.2, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.82), a);
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
      this.next = (this.next + 1) % MAX;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      this.vel[i * 3] = vx + (Math.random() - 0.5) * 0.8;
      this.vel[i * 3 + 1] = 0.6 + Math.random() * 0.8;
      this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.8;
      this.age[i] = 0;
      this.life[i] = 0.9 + Math.random() * 0.8;
      this.size[i] = 0.4;
    }
  }

  update(dt: number) {
    let any = false;
    for (let i = 0; i < MAX; i++) {
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
      this.size[i] = 0.4 + t * 1.5;
      this.alpha[i] = (1 - t) * 0.4;
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
