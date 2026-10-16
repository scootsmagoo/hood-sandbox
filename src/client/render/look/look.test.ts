import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { lookMode, resolveFx, TIERS } from '../../graphics';
import { hazeClear } from './fog';
import { deriveWallAttributes, hasBakedLook, hasBakedWalls, prepareWallGeometry } from './facade';
import { lampsFromProps, placeLamps } from './lamps';
import { prepareSurfaceGeometry } from './surfaces';

const road = (id: string, cls: string, width: number, pts: [number, number, number][], layer = 0) => ({ id, class: cls, width, layer, points: pts });

describe('the look and its tiers', () => {
  it('is GTA IV by default, with ?gfx=classic (or basic) as the old look', () => {
    expect(lookMode(new URLSearchParams(''))).toBe('gta4');
    expect(lookMode(new URLSearchParams('gfx=next'))).toBe('gta4');
    expect(lookMode(new URLSearchParams('gfx=classic'))).toBe('classic');
    expect(lookMode(new URLSearchParams('gfx=basic'))).toBe('classic');
  });

  it('gives High and Medium everything and Low a cheaper subset with a single grade pass', () => {
    for (const t of [TIERS.high, TIERS.medium]) expect(t.fx).toEqual({ facade: 2, surfaces: 2, post: 2, bloom: 2, haze: true, lamps: 2, trees: 2 });
    const low = TIERS.low.fx;
    expect(low.post).toBe(1);
    expect(low.bloom).toBe(0);
    expect(low.facade).toBeLessThan(2);
    expect(low.facade).toBeGreaterThan(0);
    expect(low.trees).toBe(1); // no alpha leaf cards on Low
  });

  it('turns parts off with ?gfxoff= for A/B tests, and drops bloom with the post pass', () => {
    const fx = resolveFx(TIERS.high, new URLSearchParams('gfxoff=facade,surface,haze,lamps'));
    expect(fx).toMatchObject({ facade: 0, surfaces: 0, haze: false, lamps: 0, post: 2, bloom: 2 });
    expect(resolveFx(TIERS.high, new URLSearchParams('gfxoff=post'))).toMatchObject({ post: 0, bloom: 0 });
    expect(resolveFx(TIERS.high, new URLSearchParams('gfxoff=nonsense'))).toEqual(TIERS.high.fx);
    expect(TIERS.high.fx.post).toBe(2); // the tier itself is not changed
  });
});

describe('haze', () => {
  it('thickens smoothly with distance and swallows nearly everything at the range', () => {
    expect(hazeClear(0, 1000)).toBe(1);
    expect(hazeClear(250, 1000)).toBeGreaterThan(0.7);
    expect(hazeClear(1000, 1000)).toBeLessThan(0.01);
    expect(hazeClear(500, 1000)).toBeGreaterThan(hazeClear(800, 1000));
  });
});

describe('street lamp placement', () => {
  it('puts lamps along streets on alternating sides, past the kerb, and none on motorways or service roads', () => {
    const roads = [
      road('a', 'secondary', 14, [[0, 0, 0], [0, 0, 300]]),
      road('m', 'motorway', 20, [[100, 0, 0], [100, 0, 300]]),
      road('s', 'service', 5, [[200, 0, 0], [200, 0, 300]]),
    ];
    const L = placeLamps(roads, []);
    expect(L.count).toBeGreaterThan(6);
    expect(L.count).toBeLessThan(14); // 300 m at 34 m
    const sides = new Set<number>();
    for (let i = 0; i < L.count; i++) {
      expect(Math.abs(L.x[i])).toBeGreaterThan(7); // half the width, plus the kerb offset
      expect(Math.abs(L.x[i])).toBeLessThan(9);
      sides.add(Math.sign(L.x[i]));
    }
    expect(sides.size).toBe(2);
  });

  it('keeps lamps out of junctions and from piling up where roads overlap', () => {
    const roads = [road('a', 'secondary', 14, [[0, 0, 0], [0, 0, 300]]), road('b', 'secondary', 14, [[0, 0, 0], [0, 0, 300]])];
    const one = placeLamps([roads[0]], []);
    const two = placeLamps(roads, []);
    expect(two.count).toBeLessThan(one.count * 2); // the second copy mostly collides with the first
    const j = placeLamps([roads[0]], [{ x: 0, z: 100 }, { x: 0, z: 200 }]);
    for (let i = 0; i < j.count; i++) for (const z of [100, 200]) expect(Math.hypot(j.x[i], j.z[i] - z)).toBeGreaterThan(11);
  });

  it('points each lamp at its road and reads the grade along it', () => {
    const L = placeLamps([road('a', 'tertiary', 10, [[0, 0, 0], [0, 10, 200]])], []);
    expect(L.count).toBeGreaterThan(2);
    for (let i = 0; i < L.count; i++) {
      // inward is the yaw of the direction toward the road: sin(yaw) is the x component
      expect(Math.sign(Math.sin(L.inward[i]))).toBe(-Math.sign(L.x[i]));
      expect(Math.abs(L.slope[i])).toBeCloseTo(0.05, 2);
    }
  });
});

/** Two walls of a 10 x 6 box, 12 m tall, as four triangles with no shared vertices (the old tile's layout). */
function twoWalls(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p = [0, 0, 0, 10, 0, 0, 10, 12, 0, 0, 12, 0, 10, 0, 0, 10, 0, 6, 10, 12, 6, 10, 12, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

describe('facade attributes', () => {
  it('derives them from the triangles of a tile without baked ones: each wall quad gets its length, base and top, and a building hash', () => {
    const g = twoWalls();
    deriveWallAttributes(g, new THREE.Matrix4());
    const wall = g.getAttribute('gWall');
    expect(wall.getY(0)).toBeCloseTo(10, 5); // length of the first wall
    expect(wall.getY(4)).toBeCloseTo(6, 5); // and of the second
    expect(wall.getZ(0)).toBeCloseTo(0, 5);
    expect(wall.getW(0)).toBeCloseTo(12, 5);
    const uv = g.getAttribute('uv');
    expect(Math.abs(uv.getX(1) - uv.getX(0))).toBeCloseTo(10, 5); // metres along the wall
    expect(uv.getY(2)).toBeCloseTo(12, 5);
    expect(g.getAttribute('gBld').getZ(0)).toBe(0); // floors unknown: the shader lays the wall out by its height
    const bid = g.getAttribute('gBid');
    expect(bid.getX(0)).toBe(bid.getX(3));
    expect(bid.getX(0)).toBeLessThan(65536);
  });

  it('uses the pipeline\'s attributes when the geometry has them, with no derivation', () => {
    const g = twoWalls();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(16).fill(1), 2));
    const wall = new THREE.Float32BufferAttribute(new Array(32).fill(3), 4);
    g.setAttribute('_wall', wall);
    g.setAttribute('_bld', new THREE.Uint8BufferAttribute(new Array(32).fill(2), 4));
    g.setAttribute('_bid', new THREE.Uint16BufferAttribute(new Array(16).fill(5), 2));
    expect(hasBakedWalls(g)).toBe(true);
    prepareWallGeometry(new THREE.Mesh(g));
    expect(g.getAttribute('gWall')).toBe(wall); // the same buffer under the shader's name
    expect(g.getAttribute('gBld').getX(0)).toBe(2);
    expect(g.getAttribute('gBid').getX(0)).toBe(5);
    expect(hasBakedWalls(twoWalls())).toBe(false);
  });

  it('names the baked appearance for the shader, and gives an older tile all zeros (material and style unknown) so the kind alone lays the wall out', () => {
    const baked = twoWalls();
    baked.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(16).fill(1), 2));
    baked.setAttribute('_wall', new THREE.Float32BufferAttribute(new Array(32).fill(3), 4));
    baked.setAttribute('_bld', new THREE.Uint8BufferAttribute(new Array(32).fill(2), 4));
    baked.setAttribute('_bid', new THREE.Uint16BufferAttribute(new Array(16).fill(5), 2));
    const look = new THREE.Uint8BufferAttribute([4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64, 4, 5, 11, 64], 4);
    baked.setAttribute('_look', look);
    expect(hasBakedLook(baked)).toBe(true);
    prepareWallGeometry(new THREE.Mesh(baked));
    expect(baked.getAttribute('gLook')).toBe(look);
    // meshFormat 2: no _look, but the walls are baked
    const old = twoWalls();
    old.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(16).fill(1), 2));
    old.setAttribute('_wall', new THREE.Float32BufferAttribute(new Array(32).fill(3), 4));
    old.setAttribute('_bld', new THREE.Uint8BufferAttribute(new Array(32).fill(2), 4));
    old.setAttribute('_bid', new THREE.Uint16BufferAttribute(new Array(16).fill(5), 2));
    expect(hasBakedLook(old)).toBe(false);
    prepareWallGeometry(new THREE.Mesh(old));
    const zeros = old.getAttribute('gLook');
    expect(zeros.count).toBe(8);
    expect([zeros.getX(0), zeros.getY(0), zeros.getZ(0), zeros.getW(0)]).toEqual([0, 0, 0, 0]);
    // no baked walls at all: derived, with the same zeros
    const derived = twoWalls();
    deriveWallAttributes(derived, new THREE.Matrix4());
    expect(derived.getAttribute('gLook').getX(3)).toBe(0);
  });

  it('names the baked roof appearance for the roof shader', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
    g.setAttribute('_srf', new THREE.Uint8BufferAttribute(new Array(16).fill(0), 4));
    g.setAttribute('_look', new THREE.Uint8BufferAttribute(new Array(16).fill(8), 4));
    expect(prepareSurfaceGeometry(new THREE.Mesh(g))).toEqual({ roadUv: false, land: false, srf: true, look: true });
    expect(g.getAttribute('gLook')).toBe(g.getAttribute('_look'));
  });

  it('names the baked road, land and roof attributes for the shader and says which a geometry has', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    expect(prepareSurfaceGeometry(new THREE.Mesh(g))).toEqual({ roadUv: false, land: false, srf: false, look: false });
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
    g.setAttribute('_land', new THREE.Uint8BufferAttribute(new Array(16).fill(0), 4));
    expect(prepareSurfaceGeometry(new THREE.Mesh(g))).toEqual({ roadUv: true, land: true, srf: false, look: false });
    expect(g.getAttribute('gUv1')).toBe(g.getAttribute('uv1'));
    expect(g.getAttribute('gLand')).toBe(g.getAttribute('_land'));
  });
});

describe('lamps from props.json', () => {
  it('keeps position, yaw, height and kind', () => {
    const L = lampsFromProps([[1, 2, 3, 0.5, 10, 0, 1], [4, 5, 6, -1, 4, 1, 1]]);
    expect(L.count).toBe(2);
    expect([L.x[1], L.y[1], L.z[1], L.h[1], L.kind[1]]).toEqual([4, 5, 6, 4, 1]);
    expect(L.inward[0]).toBeCloseTo(0.5, 5);
  });
});
