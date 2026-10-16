/**
 * The props.json anchors (street lamps, trees, hydrants, bins, bollards): the models built by
 * tools/blender/props are the size the sim's colliders are, and a car at 30 m/s is stopped by a
 * lamp pole and by a tree trunk. The sizes are in src/shared/data/propDims.json.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUPS } from '../src/sim/physics/rapier';
import { LAMP_MODELS, TREE_SPECIES, anchorProps, collectProps, lampPole, lampScale, placeHash, treeScale, treeSpecies, treeTrunk, worldSolids } from '../src/shared/props';
import type { PropsData } from '../src/shared/tile';
import { checkProps } from '../tools/blender/props/verify.ts';
import * as THREE from 'three';
import { SODIUM_GLSL, SODIUM_MAX, SodiumField, addSodium, sodiumUniforms } from '../src/client/render/look/sodium';
import { cmd, driverSim, run, vehicle } from './helpers';
import { boxTile } from './collisionHelpers';

const trees = resolve(__dirname, '../public/assets/props/trees.glb');
const furniture = resolve(__dirname, '../public/assets/props/furniture.glb');

const anchors = (over: Partial<PropsData>): PropsData => ({ version: 1, trees: [], lamps: [], hydrants: [], bins: [], bollards: [], ...over });

describe('tree and furniture assets', () => {
  it('are built, within their budgets, and as thick as the colliders', async () => {
    expect(existsSync(trees) && existsSync(furniture), 'run npm run assets').toBe(true);
    const r = await checkProps(trees, furniture);
    expect(r.problems).toEqual([]);
  });
});

describe('drawn equals solid', () => {
  it('makes a pole, a trunk, a hydrant, a bin and a bollard solid from propDims.json, scaled as the models are', () => {
    const a = anchors({
      trees: [[10, 0, 20, 12, 4.6, 0, 1], [30, 0, 20, 16, 3, 1, 1], [50, 0, 20, 5.7, 2.3, 2, 1]],
      lamps: [[0, 0, 0, 0, 9.5, 0, 1], [5, 0, 0, 0, 4.5, 1, 1], [9, 0, 0, 0, 14, 2, 1]],
      hydrants: [[1, 0, 1]],
      bins: [[2, 0, 2]],
      bollards: [[3, 0, 3]],
    });
    const props = anchorProps(a);
    expect(props.map((p) => p.kind)).toEqual(['lamp', 'lamp', 'lamp', 'tree', 'tree', 'tree', 'hydrant', 'bin', 'bollard']);
    for (const p of props) {
      const boxes = worldSolids(p);
      expect(boxes.length).toBe(1);
      const b = boxes[0];
      if (p.kind === 'lamp') {
        const m = LAMP_MODELS[p.variant!];
        // the drawn pole is r thick at 1 m on a lamp of refH, and the model is scaled evenly to the anchor's height
        expect(b.hx).toBeCloseTo(m.r * lampScale(p.variant!, p.size!), 6);
        expect(b.hx).toBe(b.hz);
        expect(b.cy - b.hy).toBeCloseTo(p.at.y, 6);
        expect(b.cx).toBe(p.at.x);
      }
      if (p.kind === 'tree') {
        const sp = TREE_SPECIES[p.variant!];
        // the trunk is drawn r thick on a tree of the reference crown; the instance is scaled across by crownR / refR
        expect(b.hx).toBeCloseTo(sp.r * treeScale(p.variant!, 12, p.size!).xz, 6);
        expect(b.hy * 2).toBe(sp.solidH);
      }
    }
    expect(lampPole(0, 9.5).w).toBeCloseTo(0.23, 6);
    expect(treeTrunk(0, 4.6).w).toBeCloseTo(0.56, 6);
  });

  it('picks a species by class and a stable mix for broadleaf', () => {
    expect(treeSpecies(1, 1, 1)).toBe(2);
    expect(treeSpecies(1, 1, 2)).toBe(3);
    const n = [0, 0, 0, 0, 0];
    for (let i = 0; i < 2000; i++) n[treeSpecies(i * 7.3, i * 3.1, 0)]++;
    expect(n[2] + n[3]).toBe(0);
    expect(n[0]).toBeGreaterThan(600);
    expect(n[1]).toBeGreaterThan(400);
    expect(n[4]).toBeGreaterThan(400);
    expect(treeSpecies(12.5, -40, 0)).toBe(treeSpecies(12.5, -40, 0));
    expect(placeHash(1, 2)).toBeGreaterThanOrEqual(0);
  });

  it('puts them into collectProps after the signals and the bench and stop props', () => {
    const props = collectProps(undefined, undefined, anchors({ lamps: [[0, 0, 0, 0, 9, 0, 1]], trees: [[5, 0, 5, 10, 4, 0, 1]] }));
    expect(props.map((p) => p.kind)).toEqual(['lamp', 'tree']);
  });
});

describe('a car at 30 m/s', () => {
  for (const what of ['lamp pole', 'tree trunk'] as const) {
    it(`is stopped by a ${what}`, async () => {
      const a = what === 'lamp pole' ? anchors({ lamps: [[0, 0, 800, 0, 9.5, 0, 1]] }) : anchors({ trees: [[0, 0, 800, 12, 4.6, 0, 1]] });
      const tile = { ...boxTile([]), anchors: a };
      const { sim, car } = await driverSim('sedan', tile, { x: 0, z: 900 });
      expect(sim.physics.props.length).toBe(1);
      car.body.setLinvel({ x: 0, y: 0, z: -30 }, true);
      let maxSpeed = 0;
      let passed = false;
      for (let i = 0; i < 60 * 7; i++) {
        run(sim, 1, cmd({ axes: { Throttle: 1 } }));
        maxSpeed = Math.max(maxSpeed, car.speed);
        if (car.body.translation().z < 800 - 0.5) passed = true;
      }
      expect(maxSpeed).toBeGreaterThan(25);
      expect(passed).toBe(false);
      expect(vehicle(sim).car.speed).toBeLessThan(10);
    });
  }

  it('drives past a tree whose trunk it misses, under the crown (no collider for the crown)', async () => {
    const tile = { ...boxTile([]), anchors: anchors({ trees: [[4, 0, 800, 12, 4.6, 0, 1]] }) };
    const { sim, car } = await driverSim('sedan', tile, { x: 0, z: 900 });
    car.body.setLinvel({ x: 0, y: 0, z: -20 }, true);
    for (let i = 0; i < 60 * 5; i++) run(sim, 1, cmd({ axes: { Throttle: 1 } }));
    expect(car.body.translation().z).toBeLessThan(780);
  });
});

describe('prop colliders', () => {
  it('merge the anchors of a 40 m cell into one compound collider in the prop group', async () => {
    const tile = {
      ...boxTile([]),
      anchors: anchors({ lamps: [[0, 0, 0, 0, 9.5, 0, 1], [10, 0, 5, 0, 9.5, 0, 1]], hydrants: [[3, 0, 3]], trees: [[5, 0, 20, 12, 4.6, 0, 1], [300, 0, 300, 12, 4.6, 0, 1]] }),
    };
    const { sim } = await driverSim('sedan', tile, { x: 0, z: 900 });
    expect(sim.physics.props.length).toBe(5);
    const groups: number[] = [];
    sim.physics.world.forEachCollider((c) => {
      if (c.collisionGroups() === GROUPS.prop) groups.push(c.handle);
    });
    // four props in the first 40 m cell, one far away
    expect(groups.length).toBe(2);
    // and every one of them is still solid where it is drawn
    for (const p of sim.physics.props) {
      const b = worldSolids(p)[0];
      expect(sim.physics.overlapsStatic(b.cx, b.cy - b.hy - 0.02, b.cz)).toBe(true);
    }
    expect(sim.physics.overlapsStatic(40, 0, 40)).toBe(false);
  });
});

describe('the sodium hook', () => {
  it('hands the lamps nearest a point ahead of the camera to the shaders, at most eight', () => {
    // 20 lamps along x = 0 every 8 m (z 0 to 152), head 9 m up, reach 18 m; the camera at z = 100 looks toward -z
    const heads = new Float32Array(20 * 4);
    for (let i = 0; i < 20; i++) heads.set([0, 9, i * 8, 18], i * 4);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 2, 100);
    cam.lookAt(0, 2, 0);
    cam.updateMatrixWorld(true);
    new SodiumField().select(heads, 20, cam, 8);
    expect(sodiumUniforms.uSodN.value).toBe(8);
    const zs = sodiumUniforms.uSodLamps.value.slice(0, 8).map((v) => v.z);
    // the focus is 12 m ahead (z = 88): the nearest are 88 (z = 88 is a lamp), 80, 96, 72, ...: all within 36 m of it
    expect(Math.max(...zs.map((z) => Math.abs(z - 88)))).toBeLessThanOrEqual(40);
    expect(zs[0]).toBe(88);
    // the Low tier asks for fewer
    new SodiumField().select(heads, 20, cam, 4);
    expect(sodiumUniforms.uSodN.value).toBe(4);
    // far from any lamp: none
    cam.position.set(500, 2, 500);
    cam.updateMatrixWorld(true);
    new SodiumField().select(heads, 20, cam, 8);
    expect(sodiumUniforms.uSodN.value).toBe(0);
    expect(SODIUM_MAX).toBe(8);
  });

  it('adds itself to a shader once, before the output, and shares its uniforms', () => {
    const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}' };
    addSodium(shader);
    const once = shader.fragmentShader;
    addSodium(shader);
    expect(shader.fragmentShader).toBe(once);
    expect(once).toContain(SODIUM_GLSL.trim().split('\n')[0]);
    expect(once.indexOf('sodiumLight(sodP')).toBeLessThan(once.indexOf('#include <opaque_fragment>'));
    expect(shader.uniforms.uSodLamps).toBe(sodiumUniforms.uSodLamps);
    expect(shader.uniforms.uSodOn).toBe(sodiumUniforms.uSodOn);
  });
});
