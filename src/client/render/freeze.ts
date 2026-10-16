import type * as THREE from 'three';

const noop = () => {};

/**
 * Makes a subtree that never moves free: its matrices are brought up to date once, and the renderer's
 * per-frame `updateMatrixWorld` walk then skips the whole subtree (three.js visits every descendant of
 * the scene every frame, hundreds of objects for the tile and the cached car assets). Do not move
 * anything under it afterwards, and call this after the subtree is built and before it is drawn.
 */
export function freezeStatic<T extends THREE.Object3D>(root: T): T {
  root.updateMatrix();
  root.matrixAutoUpdate = false;
  root.updateMatrixWorld(true);
  (root as { updateMatrixWorld: () => void }).updateMatrixWorld = noop;
  return root;
}
