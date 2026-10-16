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
 *   lm_water             animated jets: COLOR_0 r = height along the jet, g = its phase; the vertex shader moves them (see JET)
 * Levels of detail are `lod0`, `lod1`... groups, one visible at a time by distance (times the tier's `lodScale`).
 *
 * Animated parts: a node of a level named `lod<N>_<name>` whose glTF extras say `anim`:
 *   spin      the node (and the meshes under it) turns about `axis` through its own origin, `period` seconds a turn (the wheel)
 *   gondolas  the meshes under the node are drawn `count` times as instances that ride a circle about `hub` (round `axis`, with
 *             the wheel's `period`) without turning, so they hang level (the wheel's cabins)
 * They move only while their level is the one drawn and the camera is within `ANIM_RANGE` of the model, and cost a few matrices a frame.
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
/** Seconds, for the fountain's jets (the vertex shader of `lm_water` reads it). */
const JET = { value: 0 };
/** The jets' height from foot to tip at rest (m): fountain.py's JET_Y1 - JET_Y0. */
const JET_RISE = '2.73';
/** How far from a model (m) its moving parts are driven. */
const ANIM_RANGE = 700;
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
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLmW;\nvarying vec3 vLmN;').replace('#include <project_vertex>', '#include <project_vertex>\n  vec4 lmP = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n  lmP = instanceMatrix * lmP;\n#endif\n  vLmW = (modelMatrix * lmP).xyz;\n  vLmN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);');
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
    case 'lm_water': {
      // Jets: the colour attribute is data (r: height along the jet, g: phase), the albedo is set here. A wave of heights runs round
      // each ring and the rings breathe slowly, so the fountain plays without any per-frame work but one uniform.
      const m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.2, metalness: 0, side: THREE.DoubleSide });
      m.customProgramCacheKey = () => `${LIFT}-water`;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uJetT = JET;
        shader.uniforms.uLmNight = NIGHT;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uJetT;\nvarying float vJet;\nvarying float vPh;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
  {
    float hf = color.r;
    float ph = color.g;
    float wave = sin(6.2831853 * (ph * 3.0 + uJetT * 0.21));
    float swell = 0.65 + 0.35 * sin(uJetT * 0.13 + ph * 6.2831853 * 0.5);
    float s = clamp(0.62 + 0.55 * wave * swell + 0.05 * sin(uJetT * 11.0 + ph * 57.0), 0.18, 1.5);
    // the jets rise and fall about their feet and lean towards the middle of their ring (colour b: the bearing), so a ring is a crown of arches
    float ang = color.b * 6.2831853;
    float lean = 0.9 * hf * hf * s;
    transformed.y += (s - 1.0) * hf * ${JET_RISE} / max(length(modelMatrix[1].xyz), 1e-4);
    transformed.x += cos(ang) * lean / max(length(modelMatrix[0].xyz), 1e-4);
    transformed.z += sin(ang) * lean / max(length(modelMatrix[2].xyz), 1e-4);
    vJet = hf;
    vPh = ph;
  }`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uLmNight;\nvarying float vJet;\nvarying float vPh;')
          // streaks: broad at the foot, thin threads at the tip
          .replace('#include <color_fragment>', '#include <color_fragment>\n  if (abs(fract(vPh * 96.0) - 0.5) * 2.0 > mix(0.66, 0.14, vJet)) discard;\n  diffuseColor.rgb = mix(vec3(0.46, 0.62, 0.74), vec3(0.93, 0.97, 1.0), vJet);')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(0.5, 0.7, 0.95) * (0.1 + 0.9 * uLmNight) * (0.15 + 0.85 * vJet);');
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

/** A moving part of a model (see "Animated parts" above). */
interface Anim {
  /** the level it belongs to */
  lod: number;
  step(t: number): void;
}

interface Hero {
  entry: LandmarkEntry;
  root: THREE.Group;
  lods: { obj: THREE.Object3D; from: number }[];
  anims: Anim[];
  shown: number;
  radius: number;
}

const readVec = (v: unknown): THREE.Vector3 | null => (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number') ? new THREE.Vector3(v[0], v[1], v[2]) : null);

/** The moving parts of a loaded model: a node that turns, and cabins that ride a circle without turning. Allocates only here, not per frame. */
function findAnims(scene: THREE.Object3D): Anim[] {
  const out: Anim[] = [];
  scene.traverse((node) => {
    const ud = node.userData as { anim?: string; axis?: unknown; hub?: unknown; period?: number; count?: number };
    if (!ud.anim) return;
    const lod = Number(/^lod(\d+)_/.exec(node.name)?.[1] ?? 0);
    const axis = readVec(ud.axis)?.normalize();
    const turn = ud.period && ud.period > 0 ? (Math.PI * 2) / ud.period : 0;
    if (!axis || !turn) return;
    if (ud.anim === 'spin') {
      const q = new THREE.Quaternion();
      out.push({
        lod,
        step: (t) => {
          node.quaternion.copy(q.setFromAxisAngle(axis, (t * turn) % (Math.PI * 2)));
          node.updateMatrixWorld(true);
        },
      });
    } else if (ud.anim === 'gondolas') {
      const hub = readVec(ud.hub);
      const count = Math.max(1, Math.floor(ud.count ?? 0));
      if (!hub) return;
      // the template is drawn at the node's origin; the instances are offsets from it, in each mesh's own (quantised) frame
      const rest = node.position.clone().sub(hub);
      const meshes: { im: THREE.InstancedMesh; inv: THREE.Vector3 }[] = [];
      for (const child of [...node.children]) {
        const src = child as THREE.Mesh;
        if (!src.isMesh) continue;
        const im = new THREE.InstancedMesh(src.geometry, src.material, count);
        im.name = src.name;
        im.position.copy(src.position);
        im.quaternion.copy(src.quaternion);
        im.scale.copy(src.scale);
        im.castShadow = src.castShadow;
        im.receiveShadow = src.receiveShadow;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let k = 0; k < count; k++) im.setMatrixAt(k, new THREE.Matrix4());
        node.remove(src);
        node.add(im);
        meshes.push({ im, inv: new THREE.Vector3(1 / src.scale.x, 1 / src.scale.y, 1 / src.scale.z) });
      }
      const v = new THREE.Vector3();
      const d = new THREE.Vector3();
      const stepAngle = (Math.PI * 2) / count;
      out.push({
        lod,
        step: (t) => {
          const base = (t * turn) % (Math.PI * 2);
          for (let k = 0; k < count; k++) {
            // the rest offset turned about the axis through the hub (Rodrigues), minus itself: how far the cabin has moved
            const a = base + k * stepAngle;
            const c = Math.cos(a), s = Math.sin(a);
            v.copy(axis).cross(rest).multiplyScalar(s);
            d.copy(rest).multiplyScalar(c).add(v).addScaledVector(axis, axis.dot(rest) * (1 - c)).sub(rest);
            for (const m of meshes) {
              const e = m.im.instanceMatrix.array;
              e[k * 16] = 1; e[k * 16 + 5] = 1; e[k * 16 + 10] = 1; e[k * 16 + 15] = 1;
              e[k * 16 + 12] = d.x * m.inv.x;
              e[k * 16 + 13] = d.y * m.inv.y;
              e[k * 16 + 14] = d.z * m.inv.z;
            }
          }
          for (const m of meshes) m.im.instanceMatrix.needsUpdate = true;
        },
      });
    }
  });
  return out;
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
              mesh.castShadow = name !== 'lm_glow' && name !== 'lm_water';
              mesh.receiveShadow = name !== 'lm_glow' && name !== 'lm_water';
            });
            for (let i = 0; i < h.lods.length; i++) {
              const obj = gltf.scene.getObjectByName(`lod${i}`);
              if (!obj) continue;
              obj.visible = i === 0;
              lods.push({ obj, from: h.lods[i].from });
            }
            const anims = findAnims(gltf.scene);
            root.add(gltf.scene);
            const hero: Hero = { entry: e, root, lods, anims, shown: 0, radius: Math.max(20, e.radius) };
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

  /** Seconds the moving parts have run (the game's frame time, summed). */
  private t = 0;

  update(dt: number) {
    const cv = this.game.clockView;
    if (cv) {
      const night = nightFactor(cv.minutes);
      NIGHT.value = THREE.MathUtils.smoothstep(night, 0.15, 0.7);
      FLOOD.value = NIGHT.value;
    }
    this.t += dt;
    JET.value = this.t;
    const cam = this.game.camera.position;
    for (const h of this.heroes) {
      this.select(h);
      if (!h.anims.length) continue;
      const dx = cam.x - h.entry.x, dz = cam.z - h.entry.z;
      if (dx * dx + dz * dz > (ANIM_RANGE + h.radius) * (ANIM_RANGE + h.radius)) continue;
      for (const a of h.anims) if (a.lod === h.shown) a.step(this.t);
    }
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
