import { describe, expect, it } from 'vitest';
import { quatFromYaw, rotateVec } from '../../shared/math';
import {
  SPAN_FAST_M,
  SPAN_REST_M,
  flashPhase,
  headingVector,
  radarTransform,
  withinRange,
  worldToRadar,
  zoomForSpeed,
} from './minimapMath';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('zoomForSpeed', () => {
  it('rests at the near span and reaches the far span at full speed', () => {
    expect(zoomForSpeed(0)).toBe(SPAN_REST_M);
    expect(zoomForSpeed(30)).toBe(SPAN_FAST_M);
    expect(zoomForSpeed(80)).toBe(SPAN_FAST_M);
  });

  it('widens monotonically with speed and clamps bad input', () => {
    let prev = -Infinity;
    for (let v = 0; v <= 40; v += 0.5) {
      const z = zoomForSpeed(v);
      expect(z).toBeGreaterThanOrEqual(prev);
      prev = z;
    }
    expect(zoomForSpeed(-5)).toBe(SPAN_REST_M);
    expect(zoomForSpeed(Number.NaN)).toBe(SPAN_REST_M);
  });
});

describe('headingVector', () => {
  it('agrees with the sim rotation: a yaw turns forward (0, 0, -1) the same way', () => {
    for (const yaw of [0, 0.4, 1.3, -2.1, Math.PI]) {
      const f = headingVector(yaw);
      const r = rotateVec(quatFromYaw(yaw), 0, 0, -1);
      near(f[0], r.x);
      near(f[1], r.z);
    }
  });

  it('is north at yaw 0 and east at yaw -PI/2', () => {
    const n = headingVector(0);
    near(n[0], 0);
    near(n[1], -1);
    const e = headingVector(-Math.PI / 2);
    near(e[0], 1);
    near(e[1], 0);
  });
});

describe('worldToRadar', () => {
  const out = { x: 0, y: 0 };
  it('puts what is ahead above the centre and what is to the right on the right', () => {
    // Facing north: 100 m north is up (negative y), 100 m east is right.
    worldToRadar(0, -100, 0, -1, 1, out);
    near(out.x, 0);
    near(out.y, -100);
    worldToRadar(100, 0, 0, -1, 1, out);
    near(out.x, 100);
    near(out.y, 0);
  });

  it('turns with the camera: facing east, the point east is up', () => {
    worldToRadar(100, 0, 1, 0, 0.5, out);
    near(out.x, 0);
    near(out.y, -50);
  });

  it('scales by pixels per metre', () => {
    // Facing north, 10 m east and 10 m south: right and below.
    worldToRadar(10, 10, 0, -1, 2, out);
    near(out.x, 20);
    near(out.y, 20);
  });
});

describe('radarTransform', () => {
  it('maps the atlas centre to the radar centre and agrees with worldToRadar', () => {
    const tf = new Float64Array(6);
    const A = 1;
    const k = 1.7;
    const cx = 90;
    const cy = 90;
    const px = 500;
    const py = 320;
    for (const yaw of [0, 0.9, -2.4]) {
      const f = headingVector(yaw);
      radarTransform(f[0], f[1], px, py, cx, cy, k, tf);
      const apply = (ax: number, ay: number) => [tf[0] * ax + tf[2] * ay + tf[4], tf[1] * ax + tf[3] * ay + tf[5]];
      const c = apply(px, py);
      near(c[0], cx);
      near(c[1], cy);
      // A point 30 m east and 12 m south of the centre, in atlas pixels (A px per m).
      const p = apply(px + 30 * A, py + 12 * A);
      const w = worldToRadar(30, 12, f[0], f[1], k / A, { x: 0, y: 0 });
      near(p[0], cx + w.x);
      near(p[1], cy + w.y);
    }
  });
});

describe('small helpers', () => {
  it('withinRange is a disc', () => {
    expect(withinRange(30, 40, 50)).toBe(true);
    expect(withinRange(30, 40.1, 50)).toBe(false);
  });

  it('flashPhase alternates between red and blue every half period', () => {
    expect(flashPhase(0)).toBe(0);
    expect(flashPhase(250)).toBe(1);
    expect(flashPhase(500)).toBe(0);
    expect(flashPhase(750)).toBe(1);
  });
});
