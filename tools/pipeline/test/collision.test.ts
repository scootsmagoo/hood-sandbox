import { describe, expect, it } from 'vitest';
import type { V2 } from '../src/geo';
import { MeshBuilder } from '../src/mesh/builder';
import { extrudeFootprint } from '../src/mesh/extrude';
import { collisionRings, COLLISION_TOLERANCE } from '../src/world/collisionRings';

const ring = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** Area of the flat roof triangles in a builder. */
function roofArea(b: MeshBuilder): number {
  let a = 0;
  for (let i = 0; i < b.indices.length; i += 3) {
    const p = [0, 1, 2].map((k) => [b.positions[b.indices[i + k] * 3], b.positions[b.indices[i + k] * 3 + 2]]);
    a += Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;
  }
  return a;
}

describe('the collision footprint of a building', () => {
  it('keeps courtyards: the collision roof covers the building, not the courtyard (no invisible solid where the drawn building is open)', () => {
    const outer = ring(0, 0, 40, 30);
    const court = ring(12, 8, 28, 22);
    const drawn = new MeshBuilder(), drawnWalls = new MeshBuilder();
    extrudeFootprint([outer, court], { baseY: 0, topY: 20, wall: drawnWalls, roof: drawn, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    const col = new MeshBuilder(), colWalls = new MeshBuilder();
    extrudeFootprint(collisionRings([outer, court]), { baseY: 0, topY: 20, wall: colWalls, roof: col, wallColor: [1, 1, 1], roofColor: [1, 1, 1] });
    expect(roofArea(drawn)).toBeCloseTo(40 * 30 - 16 * 14, 3);
    expect(roofArea(col)).toBeCloseTo(roofArea(drawn), 3);
    // the courtyard's inner walls are in the collision mesh as in the drawn one
    expect(colWalls.triangleCount).toBe(drawnWalls.triangleCount);
  });

  it('simplifies the outline by no more than its tolerance, and drops a courtyard that collapses', () => {
    // a wavy wall: 0.05 m wobbles are smoothed away, 1 m features are kept
    const wavy: V2[] = [];
    for (let x = 0; x <= 20; x += 1) wavy.push([x, x % 2 === 0 ? 0 : 0.05]);
    wavy.push([20, 10], [0, 10]);
    const r = collisionRings([wavy])[0];
    expect(r.length).toBeLessThan(wavy.length);
    expect(r.length).toBeGreaterThanOrEqual(4);
    // a 0.5 m x 0.5 m shaft is not worth a hole
    expect(collisionRings([ring(0, 0, 30, 30), ring(10, 10, 10.5, 10.5)]).length).toBe(1);
    expect(COLLISION_TOLERANCE).toBeLessThanOrEqual(0.2);
  });
});
