import * as THREE from 'three';

/** Uniform objects shared by every look material; the look system writes them once a frame. */
export const U = {
  /** 0 by day, 1 at night (nightFactor of the game clock). */
  uNight: { value: 0 },
  /** Sky colours the windows reflect, linear. */
  uHorizon: { value: new THREE.Color(0xc9d8e2) },
  uZenith: { value: new THREE.Color(0x4a82c4) },
  uGround: { value: new THREE.Color(0x2a2a2c) },
  /** The colour of the street lamps, linear. */
  uSodium: { value: new THREE.Color(1.0, 0.5, 0.16) },
  /** How much street-lamp light spills on the lower walls of the buildings (0 when there are no lamps). */
  uSpill: { value: 0 },
  /** Saturation of the baked wall and roof colours (1 keeps them, lower is the muted GTA IV palette). */
  uWallSat: { value: 0.7 },
  /** How much of the baked ambient occlusion (the alpha of the vertex colour) darkens the sky light: 0 none, 1 all of it. */
  uAo: { value: 0.65 },
};
