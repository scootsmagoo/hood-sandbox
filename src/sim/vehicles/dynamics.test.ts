import { describe, expect, it } from 'vitest';
import { DEG } from '../../shared/math';
import { HANDLING } from '../../shared/handling';
import {
  burnoutHold,
  burnoutWanted,
  driverLock,
  engineAccel,
  loadedMu,
  lowSpeedGrip,
  newTireOutput,
  resolvePedals,
  selfAlignAngle,
  slewSteer,
  slipCurve,
  staticStability,
  steerLock,
  steerRateScale,
  suspensionAccel,
  tireForce,
  type DriveRequest,
  type TireInput,
} from './dynamics';
import { RaycastCar } from './RaycastCar';

const h = HANDLING.sedan;
const t = h.traction;

function tire(over: Partial<TireInput>): TireInput {
  return { vLong: 0, vLat: 0, load: 3900, nominal: 3900, mass: 400, dt: 1 / 60, driveForce: 0, brakeForce: 0, locked: false, gripMult: 1, lateralMult: 1, ...over };
}

describe('slip curve', () => {
  it('rises to a peak at the peak slip angle, then falls to the sliding share and stays there', () => {
    expect(slipCurve(0, t.slideRatio, t.falloff)).toBe(0);
    expect(slipCurve(1, t.slideRatio, t.falloff)).toBe(1);
    expect(slipCurve(0.5, t.slideRatio, t.falloff)).toBeCloseTo(0.75, 6);
    expect(slipCurve(t.falloff, t.slideRatio, t.falloff)).toBeCloseTo(t.slideRatio, 6);
    expect(slipCurve(20, t.slideRatio, t.falloff)).toBeCloseTo(t.slideRatio, 6);
    // rising before the peak, falling after it
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      const y = slipCurve(x, t.slideRatio, t.falloff);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    prev = 1;
    for (let x = 1; x < 5; x += 0.1) {
      const y = slipCurve(x, t.slideRatio, t.falloff);
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });

  it('is symmetric in the sign of the slip', () => {
    expect(slipCurve(-0.7, 0.8, 3)).toBe(slipCurve(0.7, 0.8, 3));
  });
});

describe('load sensitivity', () => {
  it('gives a loaded tyre less grip per newton, so an axle with weight moved across it grips less in total', () => {
    expect(loadedMu(1, 4000, 4000, 0.15)).toBe(1);
    expect(loadedMu(1, 6000, 4000, 0.15)).toBeLessThan(1);
    expect(loadedMu(1, 2000, 4000, 0.15)).toBeGreaterThan(1);
    const even = 2 * loadedMu(1, 4000, 4000, 0.15) * 4000;
    const shifted = loadedMu(1, 6000, 4000, 0.15) * 6000 + loadedMu(1, 2000, 4000, 0.15) * 2000;
    expect(shifted).toBeLessThan(even);
    // still more total force with more load
    expect(loadedMu(1, 6000, 4000, 0.15) * 6000).toBeGreaterThan(4000);
  });
});

describe('engine', () => {
  it('pushes hardest at a standstill, then at constant power, and stops at the limiter', () => {
    const d = h.drive;
    expect(engineAccel(1, 0, d)).toBeCloseTo(d.driveForce, 6);
    expect(engineAccel(1, 30, d)).toBeCloseTo(d.powerPerKg / 30, 6);
    expect(engineAccel(1, 20, d)).toBeGreaterThan(engineAccel(1, 30, d));
    expect(engineAccel(1, d.maxFlatVel, d)).toBe(0);
    expect(engineAccel(0.5, 30, d)).toBeCloseTo(engineAccel(1, 30, d) / 2, 6);
  });

  it('reverses more gently, up to the reverse limit', () => {
    const d = h.drive;
    expect(engineAccel(-1, 0, d)).toBeLessThan(0);
    expect(Math.abs(engineAccel(-1, 0, d))).toBeLessThan(d.driveForce);
    expect(engineAccel(-1, -d.reverseMaxVel, d)).toBeCloseTo(0, 9);
  });
});

describe('pedals', () => {
  const out: DriveRequest = { drive: 0, brake: 0, reversing: false };
  it('brakes while rolling forward and reverses from rest', () => {
    expect(resolvePedals(0, 1, 10, out)).toMatchObject({ drive: 0, brake: 1, reversing: false });
    expect(resolvePedals(0, 1, 0.1, out)).toMatchObject({ drive: -1, brake: 0, reversing: true });
  });
  it('brakes with the throttle while rolling backward', () => {
    expect(resolvePedals(1, 0, -5, out)).toMatchObject({ drive: -0, brake: 1, reversing: true });
  });
  it('wants a burnout for the throttle with the brake or the handbrake, only nearly stopped', () => {
    expect(burnoutWanted(1, 1, false, 0)).toBe(true);
    expect(burnoutWanted(1, 0, true, 1)).toBe(true);
    expect(burnoutWanted(1, 0, false, 0)).toBe(false);
    expect(burnoutWanted(1, 1, false, 10)).toBe(false);
    expect(burnoutHold(0, h.extras)).toBeCloseTo(h.extras.burnoutHold, 6);
    expect(burnoutHold(3, h.extras)).toBeGreaterThan(burnoutHold(0, h.extras));
  });
});

describe('steering', () => {
  const s = h.steering;
  it('narrows with speed', () => {
    expect(steerLock(0, s)).toBeCloseTo(s.lockDeg * DEG, 6);
    expect(steerLock(s.lockRefSpeed, s)).toBeCloseTo(s.lockHighSpeedDeg * DEG, 6);
    expect(steerLock(20, s)).toBeLessThan(steerLock(5, s));
  });

  it('turns slower at speed, and never overshoots its target', () => {
    const dt = 1 / 60;
    expect(steerRateScale(0, s)).toBe(1);
    expect(steerRateScale(s.lockRefSpeed, s)).toBeCloseTo(s.rateHighSpeed, 6);
    const crawl = slewSteer(0, 0.5, dt, s, 0);
    const fast = slewSteer(0, 0.5, dt, s, 35);
    expect(crawl).toBeCloseTo(s.rateDeg * DEG * dt, 6);
    expect(fast).toBeLessThan(crawl);
    expect(slewSteer(0.1, 0.1001, dt, s)).toBeCloseTo(0.1001, 9);
    // coming back is quicker than going out
    expect(0.5 - slewSteer(0.5, 0, dt, s)).toBeGreaterThan(slewSteer(0, 0.5, dt, s));
  });

  it('trails a released wheel toward the direction of travel (caster), only when rolling forward', () => {
    expect(selfAlignAngle(2, 10, 1, 0.6)).toBeCloseTo(Math.atan2(2, 10), 6);
    expect(selfAlignAngle(2, 10, 0.5, 0.6)).toBeCloseTo(Math.atan2(2, 10) * 0.5, 6);
    expect(selfAlignAngle(2, 1, 1, 0.6)).toBe(0);
    expect(selfAlignAngle(20, 10, 1, 0.3)).toBeCloseTo(0.3, 6);
  });

  it('lets the driver counter-steer past the speed lock, toward where the car is going', () => {
    const speedLock = 7 * DEG;
    const full = 35 * DEG;
    // travelling to the left of the nose (tail out to the right): steering left (-1) catches it
    expect(driverLock(-1, 20 * DEG, speedLock, full)).toBeCloseTo(23 * DEG, 6);
    expect(driverLock(-1, 50 * DEG, speedLock, full)).toBeCloseTo(full, 6);
    // steering the other way, or no slide: the speed lock
    expect(driverLock(1, 20 * DEG, speedLock, full)).toBe(speedLock);
    expect(driverLock(-1, 0, speedLock, full)).toBe(speedLock);
  });
});

describe('suspension', () => {
  const omega = 2 * Math.PI * 1.2;
  const rest = 0.29;
  it('is relaxed at the rest length and pushes when compressed', () => {
    expect(suspensionAccel(rest, rest, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBe(0);
    expect(suspensionAccel(rest - 0.1, rest - 0.1, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBeCloseTo(omega * omega * 0.1, 6);
  });

  it('carries the weight at the designed sag', () => {
    const sag = 9.81 / (omega * omega);
    expect(suspensionAccel(rest - sag, rest - sag, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBeCloseTo(9.81, 4);
  });

  it('damps more in rebound than in bump', () => {
    const at = rest - 0.15;
    const still = suspensionAccel(at, at, 1 / 60, rest, omega, 0.3, 0.5, 0.04);
    const bump = suspensionAccel(at, at + 0.01, 1 / 60, rest, omega, 0.3, 0.5, 0.04) - still;
    const rebound = still - suspensionAccel(at, at - 0.01, 1 / 60, rest, omega, 0.3, 0.5, 0.04);
    expect(bump).toBeGreaterThan(0);
    expect(rebound).toBeGreaterThan(bump);
  });

  it('hits a stiff bump stop near full compression, never pulls, and is capped', () => {
    const k = omega * omega;
    expect(suspensionAccel(0.02, 0.02, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBeGreaterThan(k * (rest - 0.02) + k * 5 * 0.02);
    expect(suspensionAccel(rest + 0.05, rest, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBe(0);
    expect(suspensionAccel(0, 0.2, 1 / 60, rest, omega, 0.3, 0.5, 0.04)).toBeLessThanOrEqual(90);
  });
});

describe('tyre', () => {
  const out = newTireOutput();

  it('has no force without load', () => {
    tireForce(tire({ load: 0, vLat: 3, vLong: 10 }), t, out);
    expect(out.fLat).toBe(0);
    expect(out.fLong).toBe(0);
  });

  it('pushes against lateral slip along the slip curve, peaking at mu times load', () => {
    const peakSlip = Math.tan(t.peakSlipDeg * DEG) * 20.8;
    tireForce(tire({ vLong: 20, vLat: peakSlip }), t, out);
    expect(out.fLat).toBeLessThan(0);
    expect(-out.fLat).toBeCloseTo(t.mu * 3900, -1);
    tireForce(tire({ vLong: 20, vLat: -peakSlip }), t, out);
    expect(out.fLat).toBeGreaterThan(0);
  });

  it('grips less once sliding than at the peak (a slide feeds itself)', () => {
    tireForce(tire({ vLong: 20, vLat: Math.tan(t.peakSlipDeg * DEG) * 20.8 }), t, out);
    const peak = Math.abs(out.fLat);
    tireForce(tire({ vLong: 20, vLat: 15 }), t, out);
    expect(Math.abs(out.fLat)).toBeCloseTo(peak * t.slideRatio, -1);
    expect(out.slip).toBeGreaterThan(0.9);
  });

  it('stays stable at a crawl: never more lateral force than stops the slip within a step', () => {
    tireForce(tire({ vLong: 0.2, vLat: 0.05 }), t, out);
    expect(Math.abs(out.fLat)).toBeLessThanOrEqual((0.05 * 400) / (1 / 60));
  });

  it('shares grip between braking and cornering (the friction ellipse)', () => {
    const vLat = Math.tan(4 * DEG) * 20.8;
    tireForce(tire({ vLong: 20, vLat }), t, out);
    const free = Math.abs(out.fLat);
    tireForce(tire({ vLong: 20, vLat, brakeForce: 1e5 }), t, out);
    expect(Math.abs(out.fLat)).toBeLessThan(free * 0.5);
    expect(Math.abs(out.fLat)).toBeGreaterThan(0);
    expect(out.fLong).toBeCloseTo(-t.mu * t.longitudinalMult * 3900, -1);
  });

  it('never brakes a wheel past a stop within one step', () => {
    tireForce(tire({ vLong: 0.01, brakeForce: 1e5 }), t, out);
    expect(Math.abs(out.fLong)).toBeLessThanOrEqual((0.01 * 400) / (1 / 60) + 1e-6);
  });

  it('spins when the engine asks for more than the tyre holds, and then pulls less and corners worse', () => {
    tireForce(tire({ vLong: 5, driveForce: 1000, vLat: 0.3 }), t, out);
    expect(out.spinning).toBe(false);
    const grip = Math.abs(out.fLat);
    tireForce(tire({ vLong: 5, driveForce: 1e5, vLat: 0.3 }), t, out);
    expect(out.spinning).toBe(true);
    expect(out.slip).toBe(1);
    expect(out.fLong).toBeCloseTo(t.mu * 3900 * t.slideRatio, -1);
    expect(Math.abs(out.fLat)).toBeLessThan(grip);
  });

  it('a locked wheel slides against its own velocity at the handbrake friction', () => {
    tireForce(tire({ vLong: 10, vLat: 10, locked: true }), t, out);
    const mag = Math.hypot(out.fLong, out.fLat);
    expect(mag).toBeCloseTo(t.mu * t.handbrakeGrip * 3900, -1);
    expect(out.fLong).toBeCloseTo(out.fLat, 6);
    expect(out.fLong).toBeLessThan(0);
  });

  it('loses grip with load sensitivity and scales with the grip multiplier', () => {
    tireForce(tire({ vLong: 20, vLat: 15 }), t, out);
    const base = Math.abs(out.fLat);
    tireForce(tire({ vLong: 20, vLat: 15, gripMult: 0.5 }), t, out);
    expect(Math.abs(out.fLat)).toBeCloseTo(base * 0.5, 0);
    tireForce(tire({ vLong: 20, vLat: 15, load: 7800 }), t, out);
    expect(Math.abs(out.fLat)).toBeLessThan(base * 2);
  });
});

describe('low-speed traction loss', () => {
  it('only applies to a spinning wheel and fades with speed', () => {
    expect(lowSpeedGrip(0, false, t)).toBe(1);
    expect(lowSpeedGrip(0, true, t)).toBeCloseTo(1 - t.lowSpeedLossMult, 6);
    expect(lowSpeedGrip(t.lowSpeedLossSpeed, true, t)).toBe(1);
  });
});

describe('stability', () => {
  it('needs more lateral g to tip on flat ground than the tyres can give, and the pickup is the tippiest', () => {
    for (const id of ['sedan', 'coupe', 'pickup']) {
      const hh = HANDLING[id];
      expect(staticStability(hh, RaycastCar.restHeight(hh))).toBeGreaterThan(hh.traction.mu);
    }
    expect(staticStability(HANDLING.pickup, RaycastCar.restHeight(HANDLING.pickup))).toBeLessThan(staticStability(HANDLING.coupe, RaycastCar.restHeight(HANDLING.coupe)));
  });
});
