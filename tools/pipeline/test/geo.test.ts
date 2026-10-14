import { describe, expect, it } from 'vitest';
import { clipPolyline, clipSegment, createProjector, pointInRing, resample, segmentIntersection, signedArea, simplifyRing } from '../src/geo';

const PROJ = '+proj=tmerc +lat_0=33.85 +lon_0=-84.3 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m';
const ORIGIN = { lat: 33.7539, lon: -84.3916 };

describe('projection', () => {
  const p = createProjector(PROJ, ORIGIN);
  it('puts the origin at 0,0', () => {
    const [x, z] = p.toGame(ORIGIN.lon, ORIGIN.lat);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(z)).toBeLessThan(1e-6);
  });
  it('+X is east and north is -Z', () => {
    const [xe] = p.toGame(ORIGIN.lon + 0.001, ORIGIN.lat);
    const [, zn] = p.toGame(ORIGIN.lon, ORIGIN.lat + 0.001);
    expect(xe).toBeGreaterThan(90);
    expect(xe).toBeLessThan(100);
    expect(zn).toBeLessThan(-105);
    expect(zn).toBeGreaterThan(-115);
  });
  it('round-trips', () => {
    const [x, z] = p.toGame(-84.38, 33.76);
    const [lon, lat] = p.toLonLat(x, z);
    expect(lon).toBeCloseTo(-84.38, 8);
    expect(lat).toBeCloseTo(33.76, 8);
  });
});

describe('clipping', () => {
  const r = { minX: -10, minZ: -10, maxX: 10, maxZ: 10 };
  it('clips a crossing segment', () => {
    const c = clipSegment([-20, 0], [20, 0], r)!;
    expect(c[0][0]).toBeCloseTo(-10);
    expect(c[1][0]).toBeCloseTo(10);
  });
  it('rejects outside segments', () => {
    expect(clipSegment([-20, 20], [20, 20], r)).toBeNull();
  });
  it('splits a polyline that leaves and re-enters', () => {
    const parts = clipPolyline([[-5, 0], [20, 0], [20, 5], [5, 5]], r);
    expect(parts.length).toBe(2);
    expect(parts[0][0]).toEqual([-5, 0]);
    expect(parts[1][parts[1].length - 1]).toEqual([5, 5]);
  });
});

describe('polygons', () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  it('area sign and containment', () => {
    expect(Math.abs(signedArea(sq))).toBe(100);
    expect(signedArea(sq)).toBe(-signedArea([...sq].reverse()));
    expect(pointInRing(5, 5, sq)).toBe(true);
    expect(pointInRing(15, 5, sq)).toBe(false);
  });
  it('simplifies collinear points', () => {
    const ring: [number, number][] = [[0, 0], [5, 0.01], [10, 0], [10, 10], [5, 10.01], [0, 10], [0, 5], [0, 2]];
    const s = simplifyRing(ring, 0.1);
    expect(s.length).toBe(4);
  });
  it('resamples to the max length', () => {
    const r = resample([[0, 0], [10, 0]], 3);
    expect(r.length).toBe(5);
    expect(r[4]).toEqual([10, 0]);
  });
  it('intersects segments', () => {
    const i = segmentIntersection([0, 0], [10, 10], [0, 10], [10, 0])!;
    expect(i.x).toBeCloseTo(5);
    expect(i.t).toBeCloseTo(0.5);
    expect(segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
  });
});
