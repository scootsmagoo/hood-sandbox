/**
 * The look: GTA IV's Atlanta, the default way the game is drawn (`?gfx=classic` is the old flat
 * renderer). What it is made of, each part switchable per tier through `Tier.fx` (graphics.ts) and
 * for A/B tests with `&gfxoff=post,facade,surface,haze,lamps,bloom`:
 *
 *   facade   procedural windows, grime and lit rooms on bld_wall and bld_glass     (facade.ts)
 *   surfaces worn asphalt, stained slabs, olive lawns, dull roofs                  (surfaces.ts)
 *   post     half-float target, bloom, ACES, the time-of-day grade                 (post.ts, grade in timeOfDay.ts)
 *   haze     exponential humid-air fog                                             (fog.ts)
 *   lamps    sodium street lamps: glow heads, light pools on the road, poles       (lamps.ts)
 *   sky      the hazy dome with clouds, stars and moon                             (sky.ts, owned by Atmosphere)
 *
 * The palette, sun, fog range and shadow softness for each moment come from timeOfDay.ts through
 * Atmosphere; this system adds the parts that need the world's materials. No tile is re-baked: the
 * wall attributes are derived from the loaded geometry unless the pipeline has baked them.
 */
import * as THREE from 'three';
import { resolveFx, type TierFx } from '../../graphics';
import type { Game, System } from '../../Game';
import { gradeLook, newSkyLook, nightFactor, skyLook } from '../timeOfDay';
import { hasBakedWalls, patchFacadeMaterial, prepareWallGeometry } from './facade';
import { patchFogChunk } from './fog';
import { loadLamps, StreetLamps } from './lamps';
import { PostFx } from './post';
import { lookState } from './state';
import { patchSurfaceMaterial, prepareSurfaceGeometry } from './surfaces';
import { U } from './uniforms';

const SCAN_EVERY = 0.5;

class Look implements System {
  readonly name = 'look';
  /** After the atmosphere (150), so its fog and exposure are the ones to build on. */
  readonly priority = 160;
  private fx: TierFx;
  private readonly patched = new WeakSet<THREE.Material>();
  private readonly patchedList: THREE.Material[] = [];
  private post: PostFx | null = null;
  private readonly lamps: StreetLamps;
  private readonly look = newSkyLook();
  private lastMinutes = -1;
  private scan = 0;
  private lampsLoaded = false;
  private disposed = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly game: Game,
    tileBase: string | null,
  ) {
    this.fx = resolveFx(game.tier, game.params);
    patchFogChunk();
    this.lamps = new StreetLamps(game.scene);
    this.applyFx(true);
    game.onTierChange(() => this.applyFx(false));
    if (tileBase && this.fx.lamps > 0) {
      void loadLamps(tileBase, game.ready?.tile?.props, this.abort.signal).then((set) => {
        if (!set || this.disposed) return;
        this.lamps.setLamps(set);
        this.lampsLoaded = true;
        this.lamps.setLevel(this.fx.lamps);
      });
    }
  }

  /** Reads the tier's fx: builds or drops the post chain, and sets every part to its level. Materials recompile when their level changes. */
  private applyFx(first: boolean) {
    const g = this.game;
    const before = this.fx;
    this.fx = resolveFx(g.tier, g.params);
    const fx = this.fx;
    const ext = g.renderer.extensions;
    const hdr = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    if (fx.post > 0 && hdr) {
      if (!this.post) {
        this.post = new PostFx(g.renderer, g);
        this.post.install();
      }
    } else if (this.post) {
      this.post.dispose();
      this.post = null;
    }
    lookState.facade = fx.facade > 0;
    this.lamps.setLevel(this.lampsLoaded ? fx.lamps : 0);
    if (!first && (before.facade !== fx.facade || before.surfaces !== fx.surfaces)) for (const m of this.patchedList) m.needsUpdate = true;
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
    U.uSpill.value = this.lampsLoaded && this.fx.lamps > 0 ? 1 : 0;
    if (Math.abs(cv.minutes - this.lastMinutes) > 0.005) {
      this.lastMinutes = cv.minutes;
      skyLook(cv.minutes, this.look);
      U.uHorizon.value.copy(this.look.horizon);
      U.uZenith.value.copy(this.look.zenith);
      U.uGround.value.copy(this.look.hemiGround).multiplyScalar(0.35);
      if (this.post) gradeLook(cv.minutes, this.post.grade);
    }
    const p = this.post;
    if (p) {
      p.levels = this.fx.post === 2 ? this.fx.bloom : 0;
      p.grade.exposure = g.renderer.toneMappingExposure;
    }
    const fog = g.scene.fog as THREE.Fog | null;
    this.lamps.update(dt, g.camera, THREE.MathUtils.smoothstep(night, 0.2, 0.8), g.tier.lodScale, fog ? Math.max(fog.far, 50) : 900);
  }

  /** Patches the baked materials and wall geometry that have not been seen yet (a rebuilt world has new ones). */
  private patchWorld() {
    const world = this.game.scene.getObjectByName('world');
    if (!world) return;
    const facadeLevel = () => this.fx.facade;
    const surfaceLevel = () => this.fx.surfaces;
    // Mesh format 2 puts the ambient occlusion in the vertex alpha, so the hand-made canyon darkening is dropped.
    const baked = (this.game.ready?.tile?.meshFormat ?? 0) >= 2;
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const wall = m.name === 'bld_wall' || m.name === 'bld_glass';
        if (wall && this.fx.facade > 0) {
          prepareWallGeometry(mesh);
          if (!this.patched.has(m)) {
            patchFacadeMaterial(m, m.name === 'bld_glass', { level: facadeLevel, baked: baked && hasBakedWalls(mesh.geometry) });
            this.patched.add(m);
            this.patchedList.push(m);
          }
        } else if (this.fx.surfaces > 0 && !wall) {
          // roads, ground and roofs: name the baked attributes for the shader, then patch the material once
          const features = prepareSurfaceGeometry(mesh);
          if (!this.patched.has(m) && patchSurfaceMaterial(m, { level: surfaceLevel, features })) {
            this.patched.add(m);
            this.patchedList.push(m);
          }
        }
      }
    });
    // Drop materials of a world that was thrown away.
    if (this.patchedList.length > 400) this.patchedList.length = 0;
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.post?.dispose();
    this.post = null;
    this.lamps.dispose();
  }
}

/** Adds the look to the game. Called once, from main.ts, unless the URL says `gfx=classic`. */
export function installLook(game: Game, tileBase: string | null): void {
  game.addSystem(new Look(game, tileBase));
}
