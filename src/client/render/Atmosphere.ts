/**
 * Sky, fog and light, driven by the game clock. In the GTA IV look (the default; `?gfx=classic` is
 * the old one) the dome is the hazy cloudy sky of look/sky.ts, the fog is exponential, and the
 * sun leaves pale soft shadows by day, all from the GTA4 palette of timeOfDay.ts. A dome follows the camera; a hemisphere
 * light and an ambient light fill the scene; a directional light is the sun by day and the moon
 * by night, and its shadow box follows the player (snapped to the shadow map's texels so edges do
 * not shimmer). The look for each moment comes from timeOfDay.ts.
 *
 * The clock is read from the snapshot header and interpolated between the two snapshots around the
 * renderer's time, so the light moves smoothly rather than in 60 Hz steps.
 */
import * as THREE from 'three';
import { H } from '../../shared/snapshot';
import type { Game, System } from '../Game';
import { lookMode, resolveFx, type LookMode, type Tier } from '../graphics';
import { createSkyMaterial } from './look/sky';
import { lookState } from './look/state';
import { CLASSIC, GTA4, isNight, moonDirection, nightFactor, newSkyLook, skyLook, sunDirection, type SkyLook, type SkyPalette } from './timeOfDay';

/** The clock as the client shows it: game minutes since midnight, the day (0 = Monday), and the night factor. */
export interface ClockView {
  minutes: number;
  day: number;
  night: number;
  isNight: boolean;
}

declare module '../Game' {
  interface Game {
    /** The game clock, as last drawn (set by the atmosphere). */
    clockView: ClockView;
  }
}

const MINUTES_PER_DAY = 1440;
/** Night glow on the building walls and glass, as emissive intensity at full night. Cheap: no window texture, so it lights the whole facade a little. */
const WALL_GLOW = 0.04;
const GLASS_GLOW = 0.2;
const GLOW_COLOR = new THREE.Color(0xffb860);
const UP = new THREE.Vector3(0, 1, 0);
/** Seconds between passes over the world's materials (rebuilt chunks get the glow on the next pass). */
const GLOW_EVERY = 2;

export class Atmosphere implements System {
  readonly name = 'atmosphere';
  readonly priority = 150;
  private dome: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private ambient: THREE.AmbientLight;
  private look: SkyLook = newSkyLook();
  private lightDir = new THREE.Vector3(-0.45, 0.62, 0.55).normalize();
  private sunDir = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private upv = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private lastMinutes = -1;
  private glowTimer = GLOW_EVERY;
  private glowOn = false;
  readonly style: LookMode;
  private readonly pal: SkyPalette;
  private skyOctaves: 2 | 4 | 0 = 0;
  private time = 0;
  private haze = true;

  constructor(private readonly game: Game) {
    const scene = game.scene;
    this.style = lookMode(game.params);
    this.pal = this.style === 'gta4' ? GTA4 : CLASSIC;
    scene.fog = new THREE.Fog(0xc9d8e2, 200, 1300);
    this.hemi = new THREE.HemisphereLight(0xd6e4ff, 0x8a8574, 2.3);
    this.ambient = new THREE.AmbientLight(0xffffff, 0);
    scene.add(this.hemi, this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);

    const classicMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() } },
      vertexShader: 'varying float vH; void main(){ vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uHorizon; uniform vec3 uZenith; varying float vH; void main(){ float t = pow(clamp(vH,0.0,1.0), 0.55); gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0); }',
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), classicMat);
    // The classic dome is drawn first; the look's sky is drawn after the opaque scene, only where nothing else is.
    this.dome.renderOrder = this.style === 'gta4' ? 1000 : -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    game.clockView = { minutes: 14 * 60, day: 2, night: 0, isNight: false };
    game.onTierChange((t) => this.applyTier(t));
    this.applyTier(game.tier);
    this.applyLook(14 * 60);
  }

  private applyTier(t: Tier) {
    this.dome.scale.setScalar(t.far * 0.9);
    if (this.style === 'gta4') {
      const octaves = t.name === 'low' ? 2 : 4;
      if (octaves !== this.skyOctaves) {
        this.skyOctaves = octaves;
        (this.dome.material as THREE.Material).dispose();
        this.dome.material = createSkyMaterial(octaves);
        this.lastMinutes = -1; // the new material takes the sky's uniforms on the next update
      }
    }
    this.haze = resolveFx(t, this.game.params).haze;
    this.applyFog(t);
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

  /** Fog range: three's linear ramp in the classic look; in the GTA IV look the exponential haze (near < 0, look/fog.ts) out to the day's visibility. */
  private applyFog(t: Tier) {
    const fog = this.game.scene.fog as THREE.Fog;
    if (this.style === 'gta4' && this.haze) {
      fog.far = Math.min(this.look.visibility, t.far * 0.75);
      fog.near = -1;
    } else {
      fog.far = Math.min(1300, t.far * 0.8);
      fog.near = fog.far * 0.15;
    }
  }

  /** The clock from the snapshots, interpolated between the two that surround the renderer's time. */
  private readClock(): { minutes: number; day: number } | null {
    const s = this.game.view.sample;
    if (!s) return null;
    const a = s.a.f32[H.ClockMinutes];
    const b = s.b.f32[H.ClockMinutes];
    let d = b - a;
    // The two snapshots may straddle midnight.
    if (d > MINUTES_PER_DAY / 2) d -= MINUTES_PER_DAY;
    else if (d < -MINUTES_PER_DAY / 2) d += MINUTES_PER_DAY;
    const alpha = Math.max(0, Math.min(1, s.alpha));
    const minutes = (((a + d * alpha) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return { minutes, day: s.b.u32[H.Day] };
  }

  update(dt: number) {
    const c = this.readClock();
    if (!c) return;
    const cv = this.game.clockView;
    cv.minutes = c.minutes;
    cv.day = c.day;
    cv.night = nightFactor(c.minutes);
    cv.isNight = isNight(c.minutes);
    if (Math.abs(c.minutes - this.lastMinutes) > 0.005) {
      this.lastMinutes = c.minutes;
      this.applyLook(c.minutes);
    }
    this.time += dt;
    if (this.style === 'gta4') (this.dome.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    this.glowTimer -= dt;
    if (this.glowTimer <= 0) {
      this.glowTimer = GLOW_EVERY;
      // The look's facade has its own lit windows; the flat orange glow is for the classic look (and for the facade switched off).
      if (!lookState.facade) this.applyGlow(cv.night);
    }
  }

  private applyLook(minutes: number) {
    const look = skyLook(minutes, this.look, this.pal);
    const g = this.game;
    this.setDome(look);
    (g.scene.fog as THREE.Fog).color.copy(look.fog);
    if (this.style === 'gta4') {
      this.applyFog(g.tier);
      this.sun.shadow.intensity = look.shadowIntensity;
      this.sun.shadow.radius = look.shadowSoftness * (g.tier.shadowMap >= 2048 ? 1 : 0.8);
    }
    this.sun.color.copy(look.sun);
    this.sun.intensity = look.sunIntensity;
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.ambient.color.copy(look.hemiSky);
    this.ambient.intensity = look.ambient;
    g.renderer.toneMappingExposure = look.exposure;

    // The shadow light is the sun above the horizon and the moon below it, blended through twilight
    // so the shadows swing round rather than jump.
    const night = nightFactor(minutes);
    sunDirection(minutes, this.sunDir);
    moonDirection(minutes, this.moonDir);
    this.lightDir.copy(this.sunDir).lerp(this.moonDir, night).normalize();
    if (this.style === 'gta4') {
      const u = (this.dome.material as THREE.ShaderMaterial).uniforms;
      (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
      (u.uMoonDir.value as THREE.Vector3).copy(this.moonDir);
      (u.uSunColor.value as THREE.Color).copy(look.sun);
      u.uNight.value = night;
    }
  }

  private setDome(look: SkyLook) {
    const u = (this.dome.material as THREE.ShaderMaterial).uniforms;
    (u.uHorizon.value as THREE.Color).copy(look.horizon);
    (u.uZenith.value as THREE.Color).copy(look.zenith);
  }

  /** Warm emissive on the building walls and glass at night, applied to every baked building material. */
  private applyGlow(night: number) {
    const world = this.game.scene.getObjectByName('world');
    if (!world) return;
    const wall = WALL_GLOW * night;
    const glass = GLASS_GLOW * night;
    if (wall === 0 && !this.glowOn) return;
    this.glowOn = wall > 0;
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m.name.startsWith('bld_') || !('emissive' in m)) continue;
        const s = m as THREE.MeshStandardMaterial;
        s.emissive.copy(GLOW_COLOR);
        s.emissiveIntensity = m.name === 'bld_glass' ? glass : wall;
      }
    });
  }

  lateUpdate() {
    const g = this.game;
    this.dome.position.copy(g.camera.position);
    const t = g.tier;
    if (t.shadowMap === 0) return;
    // Snap the shadow box's centre to whole texels across the light's own axes.
    const L = this.lightDir;
    const texel = (2 * t.shadowRadius) / t.shadowMap;
    this.right.crossVectors(UP, L).normalize();
    this.upv.crossVectors(L, this.right).normalize();
    const f = g.focus;
    const a = Math.round(f.dot(this.right) / texel) * texel;
    const b = Math.round(f.dot(this.upv) / texel) * texel;
    const c = f.dot(L);
    this.tmp.set(0, 0, 0).addScaledVector(this.right, a).addScaledVector(this.upv, b).addScaledVector(L, c);
    this.sun.target.position.copy(this.tmp);
    this.sun.position.copy(this.tmp).addScaledVector(L, t.shadowRadius * 3);
    this.sun.target.updateMatrixWorld();
  }
}
