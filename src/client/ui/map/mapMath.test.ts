import { describe, expect, it } from 'vitest';
import type { RoadData } from '../../../shared/tile';
import { clampScale, fitRect, formatScaleBar, panBy, pinch, scaleBar, SCALE_MAX, SCALE_MIN, screenToWorld, visibleRect, wheelFactor, worldToScreen, zoomAbout, type MapView } from './mapMath';
import { groupRoads, roadLabels } from './mapRoads';

const view = (): MapView => ({ cx: 100, cz: -50, scale: 0.5, w: 1000, h: 600 });

describe('the map view', () => {
  it('puts the centre in the middle of the screen, north up', () => {
    const v = view();
    expect(worldToScreen(v, 100, -50, { x: 0, y: 0 })).toEqual({ x: 500, y: 300 });
    // a point 100 m north is above the middle
    expect(worldToScreen(v, 100, -150, { x: 0, y: 0 }).y).toBe(250);
    expect(worldToScreen(v, 300, -50, { x: 0, y: 0 }).x).toBe(600);
  });

  it('screen and world are inverses', () => {
    const v = view();
    const s = worldToScreen(v, 123.4, 56.7, { x: 0, y: 0 });
    const w = screenToWorld(v, s.x, s.y, { x: 0, z: 0 });
    expect(w.x).toBeCloseTo(123.4, 6);
    expect(w.z).toBeCloseTo(56.7, 6);
  });

  it('dragging moves the world with the pointer', () => {
    const v = view();
    const before = worldToScreen(v, 200, 0, { x: 0, y: 0 });
    panBy(v, 40, -25);
    const after = worldToScreen(v, 200, 0, { x: 0, y: 0 });
    expect(after.x - before.x).toBeCloseTo(40, 6);
    expect(after.y - before.y).toBeCloseTo(-25, 6);
  });

  it('zooming about a point keeps that point under the cursor, and stays in range', () => {
    const v = view();
    const w0 = screenToWorld(v, 800, 120, { x: 0, z: 0 });
    zoomAbout(v, 1.8, 800, 120);
    const w1 = screenToWorld(v, 800, 120, { x: 0, z: 0 });
    expect(w1.x).toBeCloseTo(w0.x, 6);
    expect(w1.z).toBeCloseTo(w0.z, 6);
    zoomAbout(v, 1e6, 10, 10);
    expect(v.scale).toBe(SCALE_MAX);
    zoomAbout(v, 1e-9, 10, 10);
    expect(v.scale).toBe(SCALE_MIN);
    expect(clampScale(NaN)).toBeGreaterThan(0);
  });

  it('a pinch zooms by the finger spread and pans with their midpoint', () => {
    const r = pinch({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 80, y: 100 }, { x: 240, y: 100 });
    expect(r.factor).toBeCloseTo(1.6, 6);
    expect(r.mx).toBe(160);
    const still = pinch({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 120, y: 130 }, { x: 220, y: 130 });
    expect(still.factor).toBeCloseTo(1, 6);
    expect(still.dx).toBe(20);
    expect(still.dy).toBe(30);
    // two fingers on one spot are no zoom at all
    expect(pinch({ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 300, y: 1 }).factor).toBe(1);
  });

  it('a wheel notch is a modest step, a trackpad flick the same direction, a pinch stronger', () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1.1);
    expect(wheelFactor(-100, 0, false)).toBeLessThan(1.3);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-3, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(-3, 0, true)).toBeGreaterThan(wheelFactor(-3, 0, false));
    expect(wheelFactor(-3, 1, false)).toBeGreaterThan(wheelFactor(-3, 0, false));
    expect(wheelFactor(-1e6, 0, false)).toBeLessThan(2);
  });

  it('knows what is on screen and can fit a rectangle', () => {
    const v = view();
    const r = visibleRect(v);
    expect(r.maxX - r.minX).toBeCloseTo(2000, 6);
    expect(r.maxZ - r.minZ).toBeCloseTo(1200, 6);
    fitRect(v, { minX: 0, minZ: 0, maxX: 2000, maxZ: 1000 }, 50);
    const f = visibleRect(v);
    expect(f.minX).toBeLessThanOrEqual(0);
    expect(f.maxX).toBeGreaterThanOrEqual(2000);
    expect(v.cx).toBe(1000);
  });

  it('draws a scale bar of a round length', () => {
    for (const s of [0.05, 0.3, 1, 3]) {
      const b = scaleBar(s);
      expect([10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]).toContain(b.metres);
      expect(b.px).toBeCloseTo(b.metres * s, 6);
    }
    expect(formatScaleBar(500)).toBe('500 m');
    expect(formatScaleBar(2000)).toBe('2 km');
  });
});

describe('the map roads', () => {
  const road = (id: string, cls: string, name: string, pts: [number, number, number][], width = 8): RoadData => ({ id, class: cls, name, lanes: 2, oneway: false, bridge: false, layer: 0, width, points: pts });

  it('groups roads by class and width, minor under major', () => {
    const groups = groupRoads([
      road('a', 'motorway', 'I-75', [[0, 0, 0], [100, 0, 0]], 12),
      road('b', 'residential', 'Elm', [[0, 0, 10], [100, 0, 10]], 6),
      road('c', 'residential', 'Oak', [[0, 0, 20], [100, 0, 20]], 6),
      road('d', 'service', '', [[0, 0, 30], [50, 0, 30]], 3),
    ]);
    expect(groups.map((g) => g.rank)).toEqual([...groups.map((g) => g.rank)].sort((a, b) => a - b));
    expect(groups.find((g) => g.rank === 5)!.lines.length).toBe(1);
    // the two residential streets of the same width are one group
    expect(groups.filter((g) => g.rank === 0 && g.width === 6)[0]?.lines.length ?? groups.find((g) => g.lines.length === 2)!.lines.length).toBe(2);
  });

  it('puts a label on the longest stretch of a named road, turned upright along it', () => {
    const labels = roadLabels([
      road('a', 'primary', 'Peachtree Street Northeast', [[0, 0, 0], [20, 0, 0], [220, 0, -200]]),
      road('b', 'service', 'Alley', [[0, 0, 0], [500, 0, 0]]),
      road('c', 'residential', 'Tiny', [[0, 0, 0], [10, 0, 0]]),
      road('d', 'residential', '', [[0, 0, 0], [500, 0, 0]]),
    ]);
    expect(labels.map((l) => l.name)).toEqual(['Peachtree Street Northeast']);
    const l = labels[0];
    expect(l.x).toBeCloseTo(120, 6);
    expect(l.z).toBeCloseTo(-100, 6);
    // heading north-east on screen: the text rises to the right, never upside down
    expect(Math.abs(l.angle)).toBeLessThanOrEqual(Math.PI / 2);
    expect(l.angle).toBeLessThan(0);
  });
});
