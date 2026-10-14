/**
 * Sky, fog and light: a gradient dome that follows the camera, a hemisphere light, and a sun whose
 * shadow box follows the player (snapped to the shadow map's texels so edges do not shimmer).
 * The time of day is fixed for now, a bright late afternoon.
 */
import * as THREE from 'three';
import type { Game, System } from '../Game';
import type { Tier } from '../graphics';

const HORIZON = new THREE.Color(0xc9d8e2);
const ZENITH = new THREE.Color(0x4a82c4);
const SUN_DIR = new THREE.Vector3(-0.45, 0.62, 0.55).normalize();

export class Atmosphere implements System {
  readonly name = 'atmosphere';
  readonly priority = 150;
  private dome: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private right = new THREE.Vector3();
  private upv = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(private readonly game: Game) {
    const scene = game.scene;
    scene.fog = new THREE.Fog(HORIZON.getHex(), 200, 1300);
    scene.add(new THREE.HemisphereLight(0xd6e4ff, 0x8a8574, 2.3));

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);

    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uHorizon: { value: HORIZON }, uZenith: { value: ZENITH } },
      vertexShader: 'varying float vH; void main(){ vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uHorizon; uniform vec3 uZenith; varying float vH; void main(){ float t = pow(clamp(vH,0.0,1.0), 0.55); gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0); }',
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    game.onTierChange((t) => this.applyTier(t));
    this.applyTier(game.tier);
  }

  private applyTier(t: Tier) {
    this.dome.scale.setScalar(t.far * 0.9);
    const fog = this.game.scene.fog as THREE.Fog;
    fog.far = Math.min(1300, t.far * 0.8);
    fog.near = fog.far * 0.15;
    const on = t.shadowMap > 0;
    this.sun.castShadow = on;
    if (on) {
      const r = t.shadowRadius;
      const cam = this.sun.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 1;
      cam.far = r * 6;
      cam.updateProjectionMatrix();
      this.sun.shadow.mapSize.set(t.shadowMap, t.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  lateUpdate() {
    const g = this.game;
    this.dome.position.copy(g.camera.position);
    const t = g.tier;
    if (t.shadowMap === 0) return;
    // Snap the shadow box's centre to whole texels across the light's own axes.
    const texel = (2 * t.shadowRadius) / t.shadowMap;
    this.right.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
    this.upv.crossVectors(SUN_DIR, this.right).normalize();
    const f = g.focus;
    const a = Math.round(f.dot(this.right) / texel) * texel;
    const b = Math.round(f.dot(this.upv) / texel) * texel;
    const c = f.dot(SUN_DIR);
    this.tmp.set(0, 0, 0).addScaledVector(this.right, a).addScaledVector(this.upv, b).addScaledVector(SUN_DIR, c);
    this.sun.target.position.copy(this.tmp);
    this.sun.position.copy(this.tmp).addScaledVector(SUN_DIR, t.shadowRadius * 3);
    this.sun.target.updateMatrixWorld();
  }
}
