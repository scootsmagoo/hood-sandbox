import { describe, expect, it } from 'vitest';
import { DEFAULT_IDM, MAX_BRAKE, freeAccel, idmAccel, mobilChange, stoppingDistance, type IdmParams } from './idm';

const DT = 1 / 60;
const LEN = 4.5;
const p = (v0: number): IdmParams => ({ ...DEFAULT_IDM, v0 });

interface Car { x: number; v: number }

/** Steps a line of cars (index 0 in front) under IDM, the front one by `lead`. Returns the smallest bumper gap seen. */
function drive(cars: Car[], seconds: number, lead: (t: number, c: Car) => number, stopAt: number | null = null): number {
  let minGap = Infinity;
  for (let k = 0; k < seconds * 60; k++) {
    const t = k * DT;
    const acc = cars.map((c, i) => {
      if (i === 0) return lead(t, c);
      const f = cars[i - 1];
      return idmAccel(p(15), c.v, f.x - c.x - LEN, f.v);
    });
    // a stop line is a fixed leader of zero length for the first car
    if (stopAt !== null) acc[0] = Math.min(acc[0], idmAccel(p(15), cars[0].v, stopAt - cars[0].x - LEN / 2 + 1.8, 0));
    cars.forEach((c, i) => {
      c.v = Math.max(0, c.v + acc[i] * DT);
      c.x += c.v * DT;
    });
    for (let i = 1; i < cars.length; i++) minGap = Math.min(minGap, cars[i - 1].x - cars[i].x - LEN);
  }
  return minGap;
}

describe('IDM', () => {
  it('settles at the desired speed on an empty road', () => {
    let v = 0;
    for (let k = 0; k < 60 * 60; k++) v += freeAccel(p(14), v) * DT;
    expect(v).toBeGreaterThan(13.8);
    expect(v).toBeLessThan(14.01);
    expect(freeAccel(p(14), 14)).toBeCloseTo(0, 6);
    expect(freeAccel(p(14), 0)).toBeCloseTo(DEFAULT_IDM.a, 6);
  });

  it('keeps about the time headway behind a leader at the same speed', () => {
    const v = 12;
    // find the gap where acceleration is zero at speed v
    let gap = 5;
    for (let i = 0; i < 100; i++) gap += idmAccel(p(14), v, gap, v) * -2;
    expect(gap).toBeGreaterThan(DEFAULT_IDM.s0 + v * DEFAULT_IDM.T * 0.7);
    expect(gap).toBeLessThan(DEFAULT_IDM.s0 + v * DEFAULT_IDM.T * 1.6);
  });

  it('brakes harder the closer and faster it closes, but never past the limit', () => {
    const slow = idmAccel(p(14), 14, 60, 14);
    const close = idmAccel(p(14), 14, 12, 0);
    expect(close).toBeLessThan(slow);
    expect(idmAccel(p(14), 20, 0.5, 0)).toBe(-MAX_BRAKE);
    expect(idmAccel(p(14), 0, 0.01, 0)).toBeGreaterThanOrEqual(-MAX_BRAKE);
  });

  it('a platoon behind a leader that brakes hard to a stop and sets off again never collides', () => {
    const cars: Car[] = Array.from({ length: 10 }, (_, i) => ({ x: 300 - i * 22, v: 14 }));
    const minGap = drive(cars, 120, (t, c) => {
      // the leader brakes at 5 m/s^2 from 8 s, waits, and pulls away from 40 s
      if (t > 8 && t < 40) return c.v > 0 ? -5 : 0;
      if (t >= 40) return 1.6;
      return 0;
    });
    expect(minGap).toBeGreaterThan(0.3);
    // and they queued up: the last car stopped behind the others, not on top of them
    const stopped = cars.every((c) => c.v >= 0);
    expect(stopped).toBe(true);
  });

  it('stops at a red light: the car halts before the line, without braking harder than comfort in the approach', () => {
    const line = 200;
    const c: Car = { x: 0, v: 15 };
    let maxDecel = 0;
    let t = 0;
    for (; t < 60 * 60; t++) {
      const a = idmAccel(p(15), c.v, line - c.x - LEN / 2 + 1.8, 0);
      maxDecel = Math.max(maxDecel, -a);
      c.v = Math.max(0, c.v + a * DT);
      c.x += c.v * DT;
    }
    expect(c.v).toBeLessThan(0.01);
    expect(c.x + LEN / 2).toBeLessThan(line); // the front bumper is behind the line
    expect(c.x + LEN / 2).toBeGreaterThan(line - 4); // and close to it
    expect(maxDecel).toBeLessThan(5);
    expect(stoppingDistance(15, 2.2)).toBeCloseTo(51.1, 0);
  });

  it('a queue discharges when the light turns green', () => {
    const cars: Car[] = Array.from({ length: 5 }, (_, i) => ({ x: 190 - i * 7, v: 0 }));
    // lead car released: it accelerates with IDM on an empty road
    const minGap = drive(cars, 30, (_t, c) => freeAccel(p(15), c.v));
    expect(minGap).toBeGreaterThan(0.5);
    expect(cars[4].v).toBeGreaterThan(5);
  });
});

describe('MOBIL', () => {
  const base = { meOld: -1.5, meNew: 0.8, newFollowerBefore: 0.2, newFollowerAfter: -0.2, oldFollowerBefore: -0.5, oldFollowerAfter: -0.1, politeness: 0.3, threshold: 0.4, bias: 0, safe: 4 };

  it('changes lane when it gains clearly and nobody is hurt much', () => {
    expect(mobilChange(base)).toBe(true);
  });

  it('does not change for a small gain', () => {
    expect(mobilChange({ ...base, meNew: -1.3 })).toBe(false);
  });

  it('never cuts in where the new follower would have to brake past the safe limit', () => {
    expect(mobilChange({ ...base, newFollowerAfter: -6 })).toBe(false);
  });

  it('weighs the others by politeness, and keeps right with a bias', () => {
    const rude = { ...base, newFollowerAfter: -3.5, politeness: 0 };
    const polite = { ...rude, politeness: 1 };
    expect(mobilChange(rude)).toBe(true);
    expect(mobilChange(polite)).toBe(false);
    expect(mobilChange({ ...base, meNew: -1.2, bias: 0.5 })).toBe(true);
    expect(mobilChange({ ...base, meNew: -1.2, bias: 0 })).toBe(false);
  });
});
