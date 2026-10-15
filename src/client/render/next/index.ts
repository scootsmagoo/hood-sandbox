/**
 * `?gfx=next`: a spike of the graphics overhaul (docs/graphics-plan.md). Everything here is behind
 * the flag and loaded on demand, so the default path does not run, or even download, any of it.
 *
 *   facade   procedural windows on bld_wall and bld_glass, lit at night       (facade.ts)
 *   surface  asphalt, sidewalk, grass and roof detail from world position     (surfaces.ts)
 *   post     half-float target, bloom, ACES, a grade that follows the clock    (post.ts)
 *   haze     humid-air fog tint and range
 *
 * `?gfx=next&gfxoff=post,facade,surface,haze` turns parts off, to see what each one costs.
 * No tile is re-baked: the wall attributes are derived from the loaded geometry (facade.ts).
 */
import * as THREE from 'three';
import type { Game, System } from '../../Game';
import { newSkyLook, nightFactor, skyLook, warmth } from '../timeOfDay';
import { patchFacadeMaterial, prepareWallGeometry } from './facade';
import { PostFx } from './post';
import { patchSurfaceMaterial } from './surfaces';
import { U } from './uniforms';

const SCAN_EVERY = 0.5;
const HAZE_DAY = new THREE.Color(0xb9c4cc);

class GfxNext implements System {
  readonly name = 'gfxNext';
  /** After the atmosphere (150), so its fog and exposure are the ones to build on. */
  readonly priority = 160;
  private readonly patched = new WeakSet<THREE.Material>();
  private readonly off: Set<string>;
  private post: PostFx | null = null;
  private look = newSkyLook();
  private lastMinutes = -1;
  private scan = 0;

  constructor(private readonly game: Game) {
    this.off = new Set((game.params.get('gfxoff') ?? '').split(',').filter(Boolean));
    const ext = game.renderer.extensions;
    const hdr = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    if (!this.off.has('post') && hdr) {
      this.post = new PostFx(game.renderer, game);
      this.post.install();
    }
  }

  update(dt: number) {
    const g = this.game;
    const cv = g.clockView;
    if (!cv) return;
    this.scan -= dt;
    if (this.scan <= 0) {
      this.scan = SCAN_EVERY;
      this.patchWorld();
    }
    const night = nightFactor(cv.minutes);
    U.uNight.value = night;
    if (Math.abs(cv.minutes - this.lastMinutes) > 0.005) {
      this.lastMinutes = cv.minutes;
      skyLook(cv.minutes, this.look);
      U.uHorizon.value.copy(this.look.horizon);
      U.uZenith.value.copy(this.look.zenith);
      U.uGround.value.copy(this.look.hemiGround).multiplyScalar(0.35);
    }
    const day = 1 - night;
    const warm = warmth(cv.minutes);

    if (!this.off.has('haze')) {
      // Humid air: a shorter fog range with a pale, slightly warm tint by day.
      const fog = g.scene.fog as THREE.Fog | null;
      if (fog) {
        const far = Math.min(1300, g.tier.far * 0.8);
        fog.far = far;
        fog.near = 60;
        fog.color.copy(this.look.fog).lerp(HAZE_DAY, 0.22 * day * (1 - warm * 0.6));
      }
    }

    const p = this.post;
    if (p) {
      const t = g.tier.name;
      p.levels = t === 'low' ? 1 : 2;
      const gr = p.grade;
      gr.exposure = g.renderer.toneMappingExposure;
      gr.saturation = 0.9 + 0.2 * day + 0.06 * warm;
      gr.contrast = 0.28;
      gr.vignette = 0.22;
      gr.bloom = 0.32 + 0.35 * night;
      // Cool shadows and warm highlights; deeper blue shadows at night, orange highlights at dusk.
      gr.shadowTint.setRGB(1 - 0.05 * day + 0.02 * night - 0.04 * warm, 1.0 - 0.01 * day, 1 + 0.04 * day + 0.1 * night + 0.02 * warm);
      gr.highlightTint.setRGB(1 + 0.03 * day + 0.1 * warm, 1.0 + 0.0 * day, 1 - 0.03 * day - 0.12 * warm);
    }
  }

  /** Patches the baked materials and wall geometry that have not been seen yet (a rebuilt world has new ones). */
  private patchWorld() {
    const world = this.game.scene.getObjectByName('world');
    if (!world) return;
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const wall = m.name === 'bld_wall' || m.name === 'bld_glass';
        if (wall && !this.off.has('facade')) {
          prepareWallGeometry(mesh);
          if (!this.patched.has(m)) {
            patchFacadeMaterial(m, m.name === 'bld_glass');
            this.patched.add(m);
          }
        } else if (!this.patched.has(m) && !this.off.has('surface')) {
          if (patchSurfaceMaterial(m)) this.patched.add(m);
        }
      }
    });
  }

  dispose() {
    this.post?.dispose();
    this.post = null;
  }
}

/** Adds the spike's system to the game. Called once, from main.ts, when the URL says `gfx=next`. */
export function installGfxNext(game: Game): void {
  game.addSystem(new GfxNext(game));
}
