/**
 * Hero landmarks: the hand-built models of the tile's `landmarks.json` (public/assets/landmarks/<id>.glb, built by
 * tools/blender/landmarks/). The pipeline took the generic buildings they replace out of buildings.glb and gave them a
 * collision hull, so drawn and solid agree; this puts the model where the file says and draws it.
 *
 * What a model is made of (the materials of tools/blender/landmarks/lm.py):
 *   bld_wall, bld_glass  facades: the look's window shader (look/facade.ts) on the same per-vertex data the baked tile has
 *   bld_roof             flat roofs: the look's roof patch
 *   lm_stone             stone, concrete and painted panels (street-lamp light on the lower parts)
 *   lm_flood             stone that is floodlit after dark (the Capitol)
 *   lm_lit               a pale surface lit from within after dark, cool (the stadium roof)
 *   lm_metal, lm_gold    cladding, steel, gilding (the dome is floodlit gold at night)
 *   lm_glass             glazing that is not a facade: sky reflection, a glint
 *   lm_glow              emissive at night (rings, halos, crowns), its colour the vertex colour; a dim sheen by day
 *   lm_dark              black glazing
 * Levels of detail are `lod0`, `lod1`... groups, one visible at a time by distance (times the tier's `lodScale`).
 *
 * A model that fails to load leaves a hole where its building was (the bake removed the generic one); the game goes on.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { parseLandmarks, type LandmarkEntry } from '../../shared/landmarks';
import { resolveFx } from '../graphics';
import type { Game, System } from '../Game';
import { patchFacadeMaterial, prepareWallGeometry } from './look/facade';
import { lookState } from './look/state';
import { patchSurfaceMaterial, prepareSurfaceGeometry } from './look/surfaces';
import { addSodium } from './look/sodium';
import { U } from './look/uniforms';
import { nightFactor } from './timeOfDay';
import { freezeStatic } from './freeze';
import assetManifest from './landmarkAssets.manifest.json';

/** Shared with every lm_glow / lm_flood / lm_gold material: 0 by day, 1 at night. */
const NIGHT = { value: 0 };
/** How strongly a floodlit surface glows after dark. */
const FLOOD = { value: 0 };
const LIFT = 'look-landmark-v1';

const GLASS_GLSL = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform float uNight;
`;

/** Builds the material of a model by its glTF material name. */
function makeMaterial(name: string, game: Game): THREE.Material {
  const base = { vertexColors: true, name } as const;
  switch (name) {
    case 'bld_wall':
    case 'bld_glass': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.9, metalness: 0 });
      if (name === 'bld_glass') {
        m.roughness = 0.25;
        m.metalness = 0.35;
      }
      return m;
    }
    case 'bld_roof':
      return new THREE.MeshStandardMaterial({ ...base, roughness: 0.95, metalness: 0 });
    case 'lm_metal': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.42, metalness: 0.55 });
      m.customProgramCacheKey = () => `${LIFT}-metal`;
      m.onBeforeCompile = (shader) => addSodium(shader, 0.5);
      return m;
    }
    case 'lm_gold': {
      // no environment map in the scene, so a metal would be black: a bright yellow with a sheen, floodlit at night
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.3, metalness: 0.25 });
      m.customProgramCacheKey = () => `${LIFT}-gold`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uFlood = FLOOD;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlood;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * (0.12 + 0.85 * uFlood) * vec3(1.0, 0.92, 0.7);');
        addSodium(shader, 0.4);
      };
      return m;
    }
    case 'lm_flood': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.88, metalness: 0 });
      m.customProgramCacheKey = () => `${LIFT}-flood`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uFlood = FLOOD;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlood;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uFlood * 0.32 * vec3(1.0, 0.86, 0.62);');
        addSodium(shader, 1);
      };
      return m;
    }
    case 'lm_lit': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.55, metalness: 0.1 });
      m.customProgramCacheKey = () => `${LIFT}-lit`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uFlood = FLOOD;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlood;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uFlood * 0.7 * vec3(0.82, 0.92, 1.0);');
      };
      return m;
    }
    case 'lm_glow': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.6, metalness: 0 });
      m.customProgramCacheKey = () => `${LIFT}-glow`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uLmNight = NIGHT;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uLmNight;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * (0.08 + 3.2 * uLmNight);');
      };
      return m;
    }
    case 'lm_glass': {
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.18, metalness: 0.2 });
      m.customProgramCacheKey = () => `${LIFT}-glass`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uHorizon = U.uHorizon;
        shader.uniforms.uZenith = U.uZenith;
        shader.uniforms.uGround = U.uGround;
        shader.uniforms.uNight = U.uNight;
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLmW;\nvarying vec3 vLmN;').replace('#include <project_vertex>', '#include <project_vertex>\n  vLmW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vLmN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${GLASS_GLSL}\nvarying vec3 vLmW;\nvarying vec3 vLmN;`)
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
  {
    vec3 V = normalize(cameraPosition - vLmW);
    vec3 nW = normalize(vLmN);
    if (dot(nW, V) < 0.0) nW = -nW;
    vec3 R = reflect(-V, nW);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, R.y));
    vec3 gr = mix(uHorizon * 0.5, uGround, smoothstep(0.0, -0.4, R.y));
    float F = 0.1 + 0.55 * pow(1.0 - max(dot(nW, V), 0.0), 4.0);
    totalEmissiveRadiance += (R.y > 0.0 ? sky : gr) * F * 0.8 * vec3(0.9, 0.97, 0.95) + diffuseColor.rgb * uNight * 0.6;
  }`,
          );
      };
      return m;
    }
    case 'lm_dark':
      return new THREE.MeshStandardMaterial({ ...base, roughness: 0.35, metalness: 0.1 });
    default: {
      // lm_stone and anything unknown
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.88, metalness: 0 });
      m.customProgramCacheKey = () => `${LIFT}-stone`;
      m.onBeforeCompile = (shader) => addSodium(shader, 1);
      return m;
    }
  }
}

interface Hero {
  entry: LandmarkEntry;
  root: THREE.Group;
  lods: { obj: THREE.Object3D; from: number }[];
  shown: number;
  radius: number;
}

export class Landmarks implements System {
  readonly name = 'landmarks';
  readonly priority = 165;
  readonly group = new THREE.Group();
  private readonly heroes: Hero[] = [];
  /** ids drawn or being loaded: a hero that spans two tiles is listed by both and drawn once */
  private readonly known = new Set<string>();
  private readonly patched: THREE.Material[] = [];
  private disposed = false;
  private readonly abort = new AbortController();

  constructor(private readonly game: Game) {
    this.group.name = 'landmarks';
    game.scene.add(this.group);
    game.onTierChange(() => {
      for (const m of this.patched) m.needsUpdate = true;
    });
  }

  /** Loads the models of the heroes in `entries`. Each failure is logged and skipped. */
  async load(entries: LandmarkEntry[], base: string) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const fx = () => resolveFx(this.game.tier, this.game.params);
    const facadeOn = () => lookState.facade;
    await Promise.all(
      entries
        .filter((e) => e.hero && !this.known.has(e.id))
        .map(async (e) => {
          this.known.add(e.id);
          const h = e.hero!;
          try {
            // the manifest's hash is the file's (the tile's may be older: a model is rebuilt without a re-bake)
            const built = (assetManifest.landmarks as Record<string, { hash: string }>)[e.id];
            const gltf = await loader.loadAsync(new URL(`${h.model}?v=${built?.hash ?? h.hash}`, base).href, undefined);
            if (this.disposed) return;
            const root = new THREE.Group();
            root.name = `landmark:${e.id}`;
            root.position.set(e.x, h.y, e.z);
            root.rotation.y = h.yaw;
            const lods: Hero['lods'] = [];
            const mats = new Map<string, THREE.Material>();
            gltf.scene.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh) return;
              const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
              const name = src.name || 'lm_stone';
              let m = mats.get(name);
              if (!m) {
                m = makeMaterial(name, this.game);
                mats.set(name, m);
                if (name === 'bld_wall' || name === 'bld_glass') {
                  if (facadeOn()) patchFacadeMaterial(m, name === 'bld_glass', { level: () => fx().facade, baked: true });
                } else if (name === 'bld_roof') {
                  patchSurfaceMaterial(m, { level: () => fx().surfaces, features: { roadUv: false, land: false, srf: false } });
                }
                this.patched.push(m);
              }
              mesh.material = m;
              if (name === 'bld_wall' || name === 'bld_glass') prepareWallGeometry(mesh);
              if (name === 'bld_roof') prepareSurfaceGeometry(mesh);
              mesh.castShadow = name !== 'lm_glow';
              mesh.receiveShadow = name !== 'lm_glow';
            });
            for (let i = 0; i < h.lods.length; i++) {
              const obj = gltf.scene.getObjectByName(`lod${i}`);
              if (!obj) continue;
              obj.visible = i === 0;
              lods.push({ obj, from: h.lods[i].from });
            }
            root.add(gltf.scene);
            const hero: Hero = { entry: e, root, lods, shown: 0, radius: Math.max(20, e.radius) };
            this.heroes.push(hero);
            this.group.add(root);
            root.updateMatrixWorld(true);
          } catch (err) {
            console.warn(`[landmarks] ${e.id}: ${(err as Error).message}`);
          }
        }),
    );
    if (this.disposed) return;
    freezeStatic(this.group);
    for (const h of this.heroes) this.select(h, true);
  }

  private select(h: Hero, force = false) {
    const cam = this.game.camera.position;
    const d = Math.max(0, Math.hypot(cam.x - h.entry.x, cam.z - h.entry.z) - h.radius * 0.5);
    const scale = this.game.tier.lodScale;
    let want = 0;
    for (let i = h.lods.length - 1; i > 0; i--) {
      const from = h.lods[i].from / scale;
      // a little hysteresis, so a camera on the line does not flicker
      if (d >= (h.shown >= i ? from * 0.94 : from * 1.06)) {
        want = i;
        break;
      }
    }
    if (want === h.shown && !force) return;
    h.shown = want;
    h.lods.forEach((l, i) => (l.obj.visible = i === want));
  }

  update(_dt: number) {
    const cv = this.game.clockView;
    if (cv) {
      const night = nightFactor(cv.minutes);
      NIGHT.value = THREE.MathUtils.smoothstep(night, 0.15, 0.7);
      FLOOD.value = NIGHT.value;
    }
    for (const h of this.heroes) this.select(h);
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
    });
    for (const m of this.patched) m.dispose();
    this.heroes.length = 0;
  }
}

/** Reads the tile's `landmarks.json` and puts its hero models in the scene. Resolves to the system (or null when the tile has none). */
export async function loadLandmarks(game: Game, tileBase: string | null): Promise<{ system: Landmarks; entries: LandmarkEntry[] } | null> {
  const file = game.ready.tile.landmarks;
  if (!tileBase || !file) return null;
  try {
    const res = await fetch(new URL(file, tileBase).href);
    if (!res.ok) return null;
    const data = parseLandmarks(await res.json());
    if (!data) return null;
    const system = new Landmarks(game);
    void system.load(data.landmarks, document.baseURI);
    return { system, entries: data.landmarks };
  } catch {
    return null;
  }
}
