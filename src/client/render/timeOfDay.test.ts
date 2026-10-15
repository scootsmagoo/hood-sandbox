import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clockFromParams, formatClock, isNight, moonDirection, nightFactor, parseTime, skyLook, sunDirection, sunElevation, newSkyLook, warmth } from './timeOfDay';

const at = (hhmm: string) => parseTime(hhmm)!;

describe('sun position', () => {
  it('rises in the east, is in the south at noon, and sets in the west (game +X east, -Z north)', () => {
    const v = new THREE.Vector3();
    sunDirection(at('07:00'), v);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeLessThan(0.2);
    sunDirection(at('13:23'), v);
    expect(Math.abs(v.x)).toBeLessThan(0.01);
    expect(v.z).toBeGreaterThan(0.5); // south is +Z, and the sun is well south of the zenith
    sunDirection(at('18:00'), v);
    expect(v.x).toBeLessThan(0);
  });

  it('has its horizon crossings near 07:40 and 19:05 in mid-October in Atlanta', () => {
    expect(sunElevation(at('07:30'))).toBeLessThan(0);
    expect(sunElevation(at('07:50'))).toBeGreaterThan(0);
    expect(sunElevation(at('18:55'))).toBeGreaterThan(0);
    expect(sunElevation(at('19:15'))).toBeLessThan(0);
  });

  it('peaks near 48 degrees at solar noon, as the latitude and declination give', () => {
    expect(sunElevation(at('13:23'))).toBeGreaterThan(47);
    expect(sunElevation(at('13:23'))).toBeLessThan(49);
  });

  it('puts the moon opposite the sun at night, always above the horizon', () => {
    const s = new THREE.Vector3();
    const m = new THREE.Vector3();
    sunDirection(at('23:30'), s);
    moonDirection(at('23:30'), m);
    expect(m.y).toBeGreaterThan(0);
    expect(m.x * s.x + m.z * s.z).toBeLessThan(0); // horizontally opposite
    expect(m.length()).toBeCloseTo(1, 6);
  });
});

describe('night', () => {
  it('is 0 by day, 1 late at night, and switches on around the horizon', () => {
    expect(nightFactor(at('13:00'))).toBe(0);
    expect(nightFactor(at('23:30'))).toBe(1);
    expect(isNight(at('23:30'))).toBe(true);
    expect(isNight(at('13:00'))).toBe(false);
    expect(nightFactor(at('19:40'))).toBeGreaterThan(0);
  });
});

describe('sky colour', () => {
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it('is bright and blue by day, with the daylight exposure', () => {
    const k = skyLook(at('13:00'), newSkyLook());
    expect(lum(k.horizon)).toBeGreaterThan(0.5);
    expect(k.zenith.b).toBeGreaterThan(k.zenith.r);
    expect(k.exposure).toBeCloseTo(1.05, 2);
    expect(k.sunIntensity).toBeCloseTo(2.2, 2);
  });

  it('is a dark blue at night, with a dim moon and a little more ambient light than the dark would give', () => {
    const k = skyLook(at('23:30'), newSkyLook());
    expect(k.horizon.b).toBeGreaterThan(k.horizon.r);
    expect(lum(k.horizon)).toBeLessThan(0.05);
    expect(k.sunIntensity).toBeLessThan(0.9);
    expect(k.ambient).toBeGreaterThan(0.2);
    expect(k.hemiIntensity).toBeGreaterThan(0.5);
  });

  it('is warm orange at dusk and dawn', () => {
    for (const t of ['07:40', '19:05']) {
      const k = skyLook(at(t), newSkyLook());
      expect(warmth(at(t))).toBeGreaterThan(0.6);
      expect(k.horizon.r).toBeGreaterThan(k.horizon.b);
      expect(k.sun.r).toBeGreaterThan(k.sun.b);
    }
  });

  it('moves smoothly: neighbouring minutes differ by little', () => {
    let prev = skyLook(at('06:00'), newSkyLook()).horizon.clone();
    for (let m = 6 * 60 + 1; m < 9 * 60; m++) {
      const cur = skyLook(m, newSkyLook()).horizon;
      expect(Math.abs(cur.r - prev.r) + Math.abs(cur.g - prev.g) + Math.abs(cur.b - prev.b)).toBeLessThan(0.06);
      prev = cur.clone();
    }
  });

  it('writes into the given look without allocating a new one', () => {
    const out = newSkyLook();
    expect(skyLook(at('12:00'), out)).toBe(out);
  });
});

describe('clock options from the URL', () => {
  it('reads time, day and timescale, and leaves the defaults when none are given', () => {
    expect(clockFromParams(new URLSearchParams(''))).toBeUndefined();
    expect(clockFromParams(new URLSearchParams('time=07:45&day=5&timescale=0'))).toEqual({ minutes: 465, day: 5, scale: 0 });
  });

  it('ignores values it cannot read', () => {
    expect(clockFromParams(new URLSearchParams('time=25:00&day=9&timescale=-1'))).toBeUndefined();
    expect(parseTime('7:5')).toBeNull();
  });
});

describe('HUD label', () => {
  it('formats the day and the time', () => {
    expect(formatClock(14 * 60, 2)).toBe('Wed 14:00');
    expect(formatClock(7 * 60 + 5, 6)).toBe('Sun 07:05');
    expect(formatClock(1440 + 30, 0)).toBe('Mon 00:30');
  });
});
