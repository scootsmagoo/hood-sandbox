import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ownDepth, ownDepthAll } from './depthMaterials';

const mesh = (colour: boolean, cast = true) => {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);
  m.castShadow = cast;
  if (colour) m.setColorAt(0, new THREE.Color(1, 0, 0));
  return m;
};

describe('depth materials of instanced casters', () => {
  it('shares one depth material per kind: with an instance colour, and without', () => {
    const a = mesh(false);
    const b = mesh(false);
    const c = mesh(true);
    const d = mesh(true);
    for (const m of [a, b, c, d]) ownDepth(m);
    expect(a.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(a.customDepthMaterial).toBe(b.customDepthMaterial);
    expect(c.customDepthMaterial).toBe(d.customDepthMaterial);
    expect(a.customDepthMaterial).not.toBe(c.customDepthMaterial);
    // the same packing the renderer's own depth material uses, so the shadows are the same
    expect((a.customDepthMaterial as THREE.MeshDepthMaterial).depthPacking).toBe(THREE.RGBADepthPacking);
  });

  it('a scan covers casters anywhere in the scene, leaves other meshes and custom materials alone, and follows a mesh that gains a colour', () => {
    const root = new THREE.Group();
    const inner = new THREE.Group();
    root.add(inner);
    const cast = mesh(false);
    const quiet = mesh(false, false);
    const own = mesh(false);
    const mine = new THREE.MeshDepthMaterial();
    own.customDepthMaterial = mine;
    inner.add(cast, quiet, own, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    ownDepthAll(root);
    expect(cast.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(quiet.customDepthMaterial).toBeUndefined();
    expect(own.customDepthMaterial).toBe(mine);
    const before = cast.customDepthMaterial;
    cast.setColorAt(0, new THREE.Color(0, 1, 0));
    ownDepthAll(root);
    expect(cast.customDepthMaterial).not.toBe(before);
  });
});
