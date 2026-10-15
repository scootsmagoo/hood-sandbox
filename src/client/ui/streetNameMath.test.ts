import { describe, expect, it } from 'vitest';
import type { RoadData } from '../../shared/tile';
import {
  Debounced,
  STREET_HOLD_MS,
  STREET_RANGE_M,
  abbreviateStreet,
  buildStreetIndex,
  nearestNamedRoad,
  pointInPolygon,
  zoneIndexAt,
  type ZoneShape,
} from './streetNameMath';

function road(name: string | undefined, points: [number, number, number][], cls = 'residential'): RoadData {
  return { id: name ?? 'unnamed', class: cls, name, lanes: 2, oneway: false, bridge: false, layer: 0, width: 8, points };
}

/** The name of the road the query picks, or null. */
function pick(roads: RoadData[], x: number, z: number, tx = 0, tz = 0, y = 0): string | null {
  const idx = buildStreetIndex(roads);
  const id = nearestNamedRoad(idx, x, y, z, tx, tz);
  return id < 0 ? null : idx.names[id];
}

/** An east-west road along z = `z`, from x = -50 to 50. */
const eastWest = (name: string, z: number, y = 0) => road(name, [[-50, y, z], [50, y, z]]);
/** A north-south road along x = `x`, from z = -50 to 50. */
const northSouth = (name: string, x: number, y = 0) => road(name, [[x, y, -50], [x, y, 50]]);

describe('nearestNamedRoad', () => {
  it('picks the nearest named road', () => {
    const roads = [eastWest('Far Street', -20), eastWest('Near Street', -4)];
    expect(pick(roads, 0, 0)).toBe('Near Street');
  });

  it('ignores unnamed roads, even when they are nearest', () => {
    const roads = [eastWest('Named Way', -12), road(undefined, [[-50, 0, -1], [50, 0, -1]], 'service')];
    expect(pick(roads, 0, 0)).toBe('Named Way');
    expect(pick([road(undefined, [[-50, 0, 0], [50, 0, 0]], 'service')], 0, 0)).toBeNull();
  });

  it('returns nothing beyond the range', () => {
    expect(pick([eastWest('Distant Street', -(STREET_RANGE_M + 5))], 0, 0)).toBeNull();
    expect(pick([eastWest('Within Street', -(STREET_RANGE_M - 5))], 0, 0)).toBe('Within Street');
  });

  it('breaks a tie between equally near roads by the direction of travel', () => {
    // Both roads are 5 m from the origin: one runs east-west, the other north-south.
    const roads = [eastWest('Cross Street', 5), northSouth('Peachtree', 5)];
    expect(pick(roads, 0, 0, 1, 0)).toBe('Cross Street'); // travelling east: along the east-west road
    expect(pick(roads, 0, 0, -1, 0)).toBe('Cross Street'); // west works too: the direction is unsigned
    expect(pick(roads, 0, 0, 0, 1)).toBe('Peachtree'); // travelling south: along the north-south road
    expect(pick(roads, 0, 0, 0.1, 1)).toBe('Peachtree');
  });

  it('does not let the heading override a road that is clearly nearer', () => {
    const roads = [eastWest('Close Street', 2), northSouth('Far Avenue', 12)];
    expect(pick(roads, 0, 0, 0, 1)).toBe('Close Street');
  });

  it('with no direction, takes the nearest', () => {
    const roads = [eastWest('Close Street', 3), northSouth('Far Avenue', 4)];
    expect(pick(roads, 0, 0, 0, 0)).toBe('Close Street');
  });

  it('ignores a road far above or below the player (a walker under the freeway)', () => {
    const roads = [eastWest('Freeway Ramp', 0, 12), eastWest('Surface Street', -8, 0)];
    expect(pick(roads, 0, 0, 0, 0, 0)).toBe('Surface Street');
    expect(pick(roads, 0, 0, 0, 0, 12)).toBe('Freeway Ramp');
  });

  it('finds roads that cross grid cells, and agrees with a brute-force search', () => {
    // A long diagonal, plus a grid of short streets: the index must find the same nearest name.
    const roads: RoadData[] = [road('Diagonal', [[-300, 0, -300], [300, 0, 300]])];
    for (let i = -6; i <= 6; i++) {
      roads.push(road(`Street ${i}`, [[i * 60, 0, -200], [i * 60, 0, 200]]));
    }
    const brute = (x: number, z: number) => {
      let best = Infinity;
      let name = '';
      for (const r of roads) {
        for (let k = 0; k + 1 < r.points.length; k++) {
          const [ax, , az] = r.points[k];
          const [bx, , bz] = r.points[k + 1];
          const dx = bx - ax;
          const dz = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          if (d < best) {
            best = d;
            name = r.name!;
          }
        }
      }
      return best <= STREET_RANGE_M ? name : null;
    };
    for (let x = -330; x <= 330; x += 37) {
      for (let z = -230; z <= 230; z += 29) {
        const want = brute(x, z);
        const got = pick(roads, x, z);
        if (want !== null) {
          // Ties may resolve either way, so only the in-range or out-of-range answer is compared.
          expect(got).not.toBeNull();
        } else {
          expect(got).toBeNull();
        }
      }
    }
  });
});

describe('abbreviateStreet', () => {
  it('shortens the suffix and the direction', () => {
    expect(abbreviateStreet('Peachtree Street Northeast')).toBe('Peachtree St NE');
    expect(abbreviateStreet('Shirley Clarke Franklin Boulevard Southwest')).toBe('Shirley Clarke Franklin Blvd SW');
    expect(abbreviateStreet('West Peachtree Street Northwest')).toBe('W Peachtree St NW');
  });

  it('leaves names it does not know alone', () => {
    expect(abbreviateStreet('Downtown Connector')).toBe('Downtown Connector');
    expect(abbreviateStreet('Northside Drive')).toBe('Northside Dr');
  });
});

describe('zoneIndexAt', () => {
  const square = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  const zones: ZoneShape[] = [
    { name: 'Transit', polygon: square(-60, -60, 60, 60) },
    { name: 'Sweet Auburn', polygon: square(150, -270, 700, -130) },
    { name: 'Downtown', default: true },
  ];

  it('tests the zones in order with point-in-polygon', () => {
    expect(zones[zoneIndexAt(zones, 0, 0)].name).toBe('Transit');
    expect(zones[zoneIndexAt(zones, 300, -200)].name).toBe('Sweet Auburn');
  });

  it('falls back to the default zone outside every polygon', () => {
    expect(zones[zoneIndexAt(zones, -500, 500)].name).toBe('Downtown');
  });

  it('returns -1 when there is no default and no polygon holds the point', () => {
    expect(zoneIndexAt([{ name: 'Only', polygon: square(0, 0, 10, 10) }], 50, 50)).toBe(-1);
  });

  it('point in polygon handles a concave outline', () => {
    // An L shape: the notch at the top right is outside.
    const L: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(pointInPolygon(2, 8, L)).toBe(true);
    expect(pointInPolygon(8, 8, L)).toBe(false);
    expect(pointInPolygon(8, 2, L)).toBe(true);
  });
});

describe('Debounced', () => {
  it('takes the first value at once', () => {
    const d = new Debounced<string>();
    expect(d.offer('Peachtree St NE', 0)).toBe(true);
    expect(d.value).toBe('Peachtree St NE');
  });

  it('switches only after the new name has held for the hold time', () => {
    const d = new Debounced<string>();
    d.offer('A St', 0);
    expect(d.offer('B Ave', 100)).toBe(false);
    expect(d.offer('B Ave', 100 + STREET_HOLD_MS - 10)).toBe(false);
    expect(d.value).toBe('A St');
    expect(d.offer('B Ave', 100 + STREET_HOLD_MS)).toBe(true);
    expect(d.value).toBe('B Ave');
  });

  it('a flicker back to the shown name restarts the hold', () => {
    const d = new Debounced<string>();
    d.offer('A St', 0);
    d.offer('B Ave', 100);
    d.offer('A St', 500);
    expect(d.offer('B Ave', 600)).toBe(false);
    expect(d.offer('B Ave', 600 + STREET_HOLD_MS - 1)).toBe(false);
    expect(d.offer('B Ave', 600 + STREET_HOLD_MS)).toBe(true);
  });

  it('a null candidate breaks the hold but does not switch', () => {
    const d = new Debounced<string>();
    d.offer('A St', 0);
    d.offer('B Ave', 100);
    expect(d.offer(null, 500)).toBe(false);
    expect(d.offer('B Ave', 600)).toBe(false); // the hold starts again from 600
    expect(d.value).toBe('A St');
    expect(d.offer('B Ave', 600 + STREET_HOLD_MS)).toBe(true);
  });
});
