/**
 * The transit layer's materials. `tr_int`, the baked shell of the stations and tunnels, is lit only by its own lamps: the light
 * the pipeline baked into the alpha of its vertex colours (transitMesh.ts), times a fluorescent white, so the sun never reaches
 * a platform 30 m under the street and the cost on a phone is a basic material's. `tr_ext` (viaducts, open stairs) is a lit
 * standard material like the tile's. The cars' and the kit's materials are standard, by the slot names of
 * tools/blender/transit; on the cars the vertex shader slides the door leaves (`aDoor` per vertex, `aOpen` per instance) and
 * tints the destination signs by the line (`aLine` per instance).
 */
import * as THREE from 'three';

/** Shared by every interior material: the colour of the fluorescent tubes and how much light the shell gets at full lamp. */
export const INTERIOR = {
  uLamp: { value: new THREE.Color(1.0, 0.95, 0.86) },
  uGain: { value: 1.7 },
  /** a floor of light (a shell the lamps do not reach is not black) */
  uFloor: { value: 0.06 },
  /** 0 by day, 1 at night: the open parts (stairwells, trenches) are a little darker at night */
  uNight: { value: 0 },
};

/** The baked-light shell. */
export function interiorShellMaterial(): THREE.Material {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, name: 'tr_int' });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, INTERIOR);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uLamp;\nuniform float uGain;\nuniform float uFloor;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  #if defined( USE_COLOR_ALPHA )
    float lamp = vColor.a;
    diffuseColor.a = 1.0;
  #else
    float lamp = 0.5;
  #endif
  diffuseColor.rgb *= uLamp * (uFloor + uGain * lamp * lamp);`,
      );
  };
  m.customProgramCacheKey = () => 'transit-int-v1';
  return m;
}

/** The outdoor structure (viaducts, piers, open stairs). */
export function exteriorShellMaterial(): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: 'tr_ext' });
  m.onBeforeCompile = (shader) => {
    // the alpha is ambient occlusion here, not opacity
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a = 1.0;');
  };
  m.customProgramCacheKey = () => 'transit-ext-v1';
  return m;
}

/** Car (instanced, doors and line colour) or kit material for a slot name. */
export function partMaterial(name: string, opts: { car: boolean; travel?: number; signTexture?: THREE.Texture | null }): THREE.Material {
  const base = { vertexColors: true, name } as const;
  let m: THREE.MeshStandardMaterial;
  switch (name) {
    case 'tr_steel':
      // (no environment map in the scene: a real metal would read black, so a bright satin with a little metal)
      m = new THREE.MeshStandardMaterial({ ...base, color: 0xf2f4f7, roughness: 0.42, metalness: 0.12 });
      break;
    case 'tr_glass':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0x6f7c86, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
      break;
    case 'tr_light':
    case 'tr_lightface':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0xffffff, emissive: 0xfff3e0, emissiveIntensity: 2.2, roughness: 0.5 });
      break;
    case 'tr_head':
      m = new THREE.MeshStandardMaterial({ ...base, emissive: 0xfff2d6, emissiveIntensity: 3.0 });
      break;
    case 'tr_tail':
      m = new THREE.MeshStandardMaterial({ ...base, emissive: 0xff2010, emissiveIntensity: 2.0 });
      break;
    case 'tr_sign':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0x111111, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.6 });
      break;
    case 'tr_screen':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0x050505, emissive: 0xffffff, emissiveIntensity: 1.4, emissiveMap: opts.signTexture ?? null, roughness: 0.4 });
      break;
    case 'tr_signface':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0xffffff, map: opts.signTexture ?? null, emissive: 0xffffff, emissiveIntensity: 0.35, emissiveMap: opts.signTexture ?? null, roughness: 0.6 });
      break;
    case 'tr_dark':
      m = new THREE.MeshStandardMaterial({ ...base, color: 0xffffff, roughness: 0.75, metalness: 0.1 });
      break;
    case 'tr_floor':
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.7 });
      break;
    case 'tr_tile':
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.35 });
      break;
    default:
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.85 });
  }
  if (name === 'tr_signface' || name === 'tr_screen') {
    // the canvas carries the colours; the vertex colour would tint them
    m.vertexColors = false;
  }
  if (!opts.car) return m;
  const travel = (opts.travel ?? 0.64).toFixed(3);
  const sign = name === 'tr_sign';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aDoor;
attribute vec2 aOpen;
${sign ? 'attribute vec3 aLine;\nvarying vec3 vLine;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    float open = aDoor.x > 0.5 ? aOpen.x : aDoor.x < -0.5 ? aOpen.y : 0.0;
    transformed.z += aDoor.y * ${travel} * open;
  }
  ${sign ? 'vLine = aLine;' : ''}`,
      );
    if (sign) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLine;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vLine;');
    }
  };
  m.customProgramCacheKey = () => `transit-car-${name}-v1`;
  return m;
}
