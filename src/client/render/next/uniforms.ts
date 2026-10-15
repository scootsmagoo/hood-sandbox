import * as THREE from 'three';

/** Uniform objects shared by every `?gfx=next` material; the system writes them once a frame. */
export const U = {
  /** 0 by day, 1 at night (nightFactor of the game clock). */
  uNight: { value: 0 },
  /** Sky colours the windows reflect, linear. */
  uHorizon: { value: new THREE.Color(0xc9d8e2) },
  uZenith: { value: new THREE.Color(0x4a82c4) },
  uGround: { value: new THREE.Color(0x2a2a2c) },
};
