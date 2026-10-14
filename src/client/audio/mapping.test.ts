import { describe, expect, it } from 'vitest';
import { distanceGain, dopplerFactor, enginePitch, gearFor, IDLE_HZ, impactGain, REDLINE_HZ, squealLevel } from './mapping';

describe('gearFor', () => {
  it('shifts up at each threshold', () => {
    expect(gearFor(0)).toBe(1);
    expect(gearFor(8.9)).toBe(1);
    expect(gearFor(9)).toBe(2);
    expect(gearFor(18)).toBe(3);
    expect(gearFor(36)).toBe(5);
    expect(gearFor(60)).toBe(5);
  });

  it('uses the magnitude, so reversing is a low gear', () => {
    expect(gearFor(-10)).toBe(2);
  });
});

describe('enginePitch', () => {
  it('idles when stopped with no throttle', () => {
    expect(enginePitch(0, 0).hz).toBe(IDLE_HZ);
  });

  it('revs up on throttle even at rest', () => {
    expect(enginePitch(0, 1).hz).toBeGreaterThan(IDLE_HZ);
  });

  it('rises with speed within a gear', () => {
    expect(enginePitch(12, 1).hz).toBeGreaterThan(enginePitch(10, 1).hz);
  });

  it('drops when the speed crosses a gear threshold', () => {
    const before = enginePitch(8.99, 1);
    const after = enginePitch(9.01, 1);
    expect(after.gear).toBe(before.gear + 1);
    expect(after.hz).toBeLessThan(before.hz);
  });

  it('stays within idle and redline', () => {
    for (let s = 0; s <= 60; s += 0.5) {
      const { hz } = enginePitch(s, 1);
      expect(hz).toBeGreaterThanOrEqual(IDLE_HZ);
      expect(hz).toBeLessThanOrEqual(REDLINE_HZ);
    }
  });
});

describe('squealLevel', () => {
  it('is silent below walking pace', () => {
    expect(squealLevel([1, 1, 1, 1], true, 1)).toBe(0);
  });

  it('follows the worst wheel slip and the skid flag', () => {
    expect(squealLevel([0, 0.2, 0.1, 0], false, 10)).toBeCloseTo(0.2);
    expect(squealLevel([0, 0, 0, 0], true, 10)).toBeCloseTo(0.6);
  });
});

describe('curves', () => {
  it('impact gain is zero under the sim threshold and capped at one', () => {
    expect(impactGain(3)).toBe(0);
    expect(impactGain(100)).toBe(1);
  });

  it('distance gain falls off and stays at one up close', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(50)).toBeLessThan(distanceGain(5));
  });

  it('doppler is above one when closing and below one when receding', () => {
    expect(dopplerFactor(20)).toBeGreaterThan(1);
    expect(dopplerFactor(-20)).toBeLessThan(1);
    expect(dopplerFactor(0)).toBe(1);
  });
});
