import { describe, expect, it } from 'vitest';
import { DEG } from '../../shared/math';
import { HANDLING } from '../../shared/handling';
import {
  burnoutHold,
  counterSteer,
  donutAccel,
  donutRamp,
  donutTargetSpeed,
  donutTurnRate,
  donutWanted,
  donutYawAccel,
  donutYawTarget,
  driftAssistAccel,
  engineAccel,
  lowSpeedGrip,
  newTireOutput,
  resolvePedals,
  slewSteer,
  steerLock,
  suspensionAccel,
  torqueCurve,
  tireForce,
  tractionCoefficient,
  type DriveRequest,
  type TireInput,
} from './dynamics';

const h = HANDLING.sedan;

function tire(over: Partial<TireInput>): TireInput {
  return { vLong: 0, vLat: 0, load: 3700, mass: 375, dt: 1 / 60, driveForce: 0, brakeForce: 0, gripMult: 1, lateralMult: 1, ...over };
}

describe('traction curve', () => {
  it('holds the peak up to the peak slip angle and falls to the sliding value', () => {
    const t = h.traction;
    expect(tractionCoefficient(0, t)).toBe(t.curveMax);
    expect(tractionCoefficient(t.curveLateralDeg * DEG, t)).toBe(t.curveMax);
    expect(tractionCoefficient(t.curveLateralDeg * DEG * 2.5, t)).toBeCloseTo(t.curveMin, 6);
    expect(tractionCoefficient(Math.PI / 2, t)).toBeCloseTo(t.curveMin, 6);
    let prev = Infinity;
    for (let a = 0; a < 1.5; a += 0.05) {
      const mu = tractionCoefficient(a, t);
      expect(mu).toBeLessThanOrEqual(prev + 1e-9);
      prev = mu;
    }
  });

  it('is symmetric in the sign of the slip angle', () => {
    expect(tractionCoefficient(-0.3, h.traction)).toBe(tractionCoefficient(0.3, h.traction));
  });
});

describe('engine', () => {
  it('has full torque at a standstill and none at the flat velocity', () => {
    expect(torqueCurve(0, 50)).toBe(1);
    expect(torqueCurve(50, 50)).toBe(0);
    expect(torqueCurve(80, 50)).toBe(0);
    expect(torqueCurve(25, 50)).toBeCloseTo(0.75, 6);
  });

  it('pushes forward and backward, and reverses more gently', () => {
    const d = h.drive;
    expect(engineAccel(1, 0, d)).toBeCloseTo(d.driveForce, 6);
    expect(engineAccel(-1, 0, d)).toBeLessThan(0);
    expect(Math.abs(engineAccel(-1, 0, d))).toBeLessThan(d.driveForce);
    expect(engineAccel(-1, -d.reverseMaxVel, d)).toBe(-0);
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
    expect(resolvePedals(0, 0.5, -5, out)).toMatchObject({ drive: -0.5, brake: 0 });
  });
  it('accelerates when both pedals are down but the throttle wins', () => {
    expect(resolvePedals(1, 0.5, 0, out)).toMatchObject({ drive: 1, brake: 0 });
  });
});

describe('steering', () => {
  it('narrows with speed', () => {
    const s = h.steering;
    expect(steerLock(0, s)).toBeCloseTo(s.lockDeg * DEG, 6);
    expect(steerLock(s.lockRefSpeed, s)).toBeCloseTo(s.lockHighSpeedDeg * DEG, 6);
    expect(steerLock(100, s)).toBeCloseTo(s.lockHighSpeedDeg * DEG, 6);
    expect(steerLock(20, s)).toBeLessThan(steerLock(5, s));
  });

  it('slews at the configured rates and never overshoots', () => {
    const s = h.steering;
    const dt = 1 / 60;
    let a = 0;
    a = slewSteer(a, 0.5, dt, s);
    expect(a).toBeCloseTo(s.rateDeg * DEG * dt, 6);
    for (let i = 0; i < 100; i++) a = slewSteer(a, 0.5, dt, s);
    expect(a).toBe(0.5);
    const back = slewSteer(0.5, 0, dt, s);
    expect(0.5 - back).toBeCloseTo(s.returnRateDeg * DEG * dt, 6);
    // crossing through centre to the other side counts as returning, then turning
    expect(slewSteer(0.01, -0.5, dt, s)).toBeLessThan(0.01);
  });

  it('counter-steers toward the direction of travel only in a real slide', () => {
    const lock = 34 * DEG;
    expect(counterSteer(1, 20, 0.75, lock)).toBe(0); // 3 degrees
    expect(counterSteer(8, 20, 0.75, lock)).toBeGreaterThan(0); // travelling left of the nose: steer left
    expect(counterSteer(-8, 20, 0.75, lock)).toBeLessThan(0);
    expect(counterSteer(20, 5, 0.75, lock)).toBeLessThanOrEqual(lock * 0.75);
    expect(counterSteer(8, -10, 0.75, lock)).toBe(0); // reversing
    expect(counterSteer(8, 20, 0, lock)).toBe(0);
  });
});

describe('suspension', () => {
  const omega = 2 * Math.PI * 1.9;
  const rest = 0.19;
  it('is relaxed at the rest length and pushes when compressed', () => {
    expect(suspensionAccel(rest, rest, 1 / 60, rest, omega, 0.7, 0.04)).toBe(0);
    expect(suspensionAccel(rest + 0.05, rest + 0.05, 1 / 60, rest, omega, 0.7, 0.04)).toBe(0); // extended: no pull
    const a = suspensionAccel(rest - 0.05, rest - 0.05, 1 / 60, rest, omega, 0.7, 0.04);
    expect(a).toBeCloseTo(omega * omega * 0.05, 6);
  });

  it('carries the weight at the designed compression', () => {
    const x = 9.81 / (omega * omega);
    expect(suspensionAccel(rest - x, rest - x, 1 / 60, rest, omega, 0.7, 0.04)).toBeCloseTo(9.81, 6);
  });

  it('damps: pushes harder while compressing, softer while extending', () => {
    const len = rest - 0.05;
    const still = suspensionAccel(len, len, 1 / 60, rest, omega, 0.7, 0.04);
    expect(suspensionAccel(len, len + 0.005, 1 / 60, rest, omega, 0.7, 0.04)).toBeGreaterThan(still);
    expect(suspensionAccel(len, len - 0.005, 1 / 60, rest, omega, 0.7, 0.04)).toBeLessThan(still);
  });

  it('hits a stiff bump stop near full compression and is capped', () => {
    const soft = suspensionAccel(0.05, 0.05, 1 / 60, rest, omega, 0.7, 0.04);
    const stop = suspensionAccel(0.01, 0.01, 1 / 60, rest, omega, 0.7, 0.04);
    expect(stop).toBeGreaterThan(soft * 1.5);
    expect(suspensionAccel(0, 0.3, 1 / 60, rest, omega, 0.7, 0.04)).toBe(60);
  });
});

describe('tyre', () => {
  const out = newTireOutput();
  const t = h.traction;

  it('has no force without load', () => {
    tireForce(tire({ load: 0, vLat: 5 }), t, out);
    expect(out.fLat).toBe(0);
    expect(out.fLong).toBe(0);
  });

  it('pushes against lateral slip and saturates at mu times load', () => {
    tireForce(tire({ vLat: 0.05, vLong: 20 }), t, out);
    expect(out.fLat).toBeLessThan(0);
    expect(Math.abs(out.fLat)).toBeLessThan(t.curveMax * 3700);
    tireForce(tire({ vLat: 5, vLong: 20 }), t, out);
    expect(out.fLat).toBeCloseTo(-tractionCoefficient(out.slipAngle, t) * 3700, 3);
    tireForce(tire({ vLat: -5, vLong: 20 }), t, out);
    expect(out.fLat).toBeGreaterThan(0);
  });

  it('grips less once sliding than at the peak', () => {
    tireForce(tire({ vLat: 3, vLong: 20 }), t, out);
    const peak = Math.abs(out.fLat);
    tireForce(tire({ vLat: 12, vLong: 10 }), t, out);
    expect(Math.abs(out.fLat)).toBeLessThan(peak);
    expect(out.slip).toBeGreaterThan(0.9);
  });

  it('shares grip between braking and cornering', () => {
    tireForce(tire({ vLat: 6, vLong: 20 }), t, out);
    const free = Math.abs(out.fLat);
    tireForce(tire({ vLat: 6, vLong: 20, brakeForce: 20000 }), t, out);
    expect(Math.abs(out.fLat)).toBeLessThan(free);
    expect(Math.abs(out.fLat)).toBeGreaterThan(free * 0.4);
    expect(out.fLong).toBeLessThan(0);
  });

  it('never brakes a wheel past a stop within one step', () => {
    tireForce(tire({ vLong: 0.01, brakeForce: 50000 }), t, out);
    expect(Math.abs(out.fLong)).toBeLessThanOrEqual((0.01 * 375) / (1 / 60) + 1e-6);
    tireForce(tire({ vLong: -3, brakeForce: 1000 }), t, out);
    expect(out.fLong).toBe(1000);
  });

  it('spins when the engine asks for more than the tyre holds, and then pulls less', () => {
    tireForce(tire({ driveForce: 3000, vLong: 5 }), t, out);
    expect(out.spinning).toBe(false);
    expect(out.fLong).toBe(3000);
    tireForce(tire({ driveForce: 9000, vLong: 5 }), t, out);
    expect(out.spinning).toBe(true);
    expect(out.slip).toBe(1);
    expect(out.fLong).toBeLessThan(t.curveMax * 3700);
    expect(out.fLong).toBeGreaterThan(0);
  });

  it('scales with the grip multipliers', () => {
    tireForce(tire({ vLat: 6, vLong: 20 }), t, out);
    const normal = Math.abs(out.fLat);
    tireForce(tire({ vLat: 6, vLong: 20, lateralMult: 0.3 }), t, out);
    expect(Math.abs(out.fLat)).toBeCloseTo(normal * 0.3, 3);
  });
});

describe('low-speed traction loss', () => {
  it('only applies to a spinning wheel and fades with speed', () => {
    const t = h.traction;
    expect(lowSpeedGrip(0, false, t)).toBe(1);
    expect(lowSpeedGrip(0, true, t)).toBeCloseTo(1 - t.lowSpeedLossMult, 6);
    expect(lowSpeedGrip(t.lowSpeedLossSpeed, true, t)).toBe(1);
    expect(lowSpeedGrip(4, true, t)).toBeGreaterThan(lowSpeedGrip(1, true, t));
  });
});

describe('drift assist', () => {
  const a = h.assists;
  it('is off in ordinary driving', () => {
    expect(driftAssistAccel(0.5, 0.3, 0.3, 2 * DEG, 25, false, a)).toBe(0);
    expect(driftAssistAccel(0.5, 0.3, 0.3, 30 * DEG, 1, false, a)).toBe(0);
  });
  it('turns the nose into the slide the steering asks for', () => {
    // steering right asks for travel to the left of the nose; from a straight car it asks for a right turn
    expect(driftAssistAccel(1, 0, 0, 0, 25, true, a)).toBeLessThan(0);
    expect(driftAssistAccel(-1, 0, 0, 0, 25, true, a)).toBeGreaterThan(0);
  });
  it('pulls an over-rotated car back', () => {
    const wanted = 0.5 * a.maxSlideDeg * DEG;
    expect(driftAssistAccel(0.5, 0, 0, wanted + 25 * DEG, 25, false, a)).toBeGreaterThan(0);
    expect(driftAssistAccel(0.5, 0, 0, wanted - 25 * DEG, 25, true, a)).toBeLessThan(0);
  });
  it('is quiet at the balance point', () => {
    const wanted = 0.5 * a.maxSlideDeg * DEG;
    expect(Math.abs(driftAssistAccel(0.5, 0.4, 0.4, wanted, 25, true, a))).toBeLessThan(1e-9);
  });
});

describe('donut', () => {
  const a = h.assists;

  it('wants one with throttle and full lock, on a handbrake or a launch, and not at speed', () => {
    expect(donutWanted(1, 1, 0, false, false, a)).toBe(true); // launch from rest, wheel flat to the stop
    expect(donutWanted(1, 0.6, 0, false, false, a)).toBe(false); // not enough wheel to start without the handbrake
    expect(donutWanted(1, 0.6, 8, true, false, a)).toBe(true); // handbrake turn
    expect(donutWanted(1, 1, 20, true, false, a)).toBe(false); // too fast: that is a drift
    expect(donutWanted(0.3, 1, 0, true, false, a)).toBe(false); // needs throttle
    expect(donutWanted(1, 0.4, 0, true, false, a)).toBe(false); // and wheel
  });

  it('holds on through a wobble of the inputs, and gives up when they are eased off or the car is too fast', () => {
    expect(donutWanted(0.5, 0.4, 8, false, true, a)).toBe(true);
    expect(donutWanted(0.2, 1, 8, false, true, a)).toBe(false);
    expect(donutWanted(1, 0.2, 8, false, true, a)).toBe(false);
    expect(donutWanted(1, 1, a.donutMaxSpeed + 4, false, true, a)).toBe(false);
  });

  it('is off for a car without donut assist', () => {
    expect(donutWanted(1, 1, 0, true, false, { ...a, donutYawRate: 0 })).toBe(false);
  });

  it('ramps in quickly and out slowly, within 0 to 1', () => {
    expect(donutRamp(0, true, 1 / 60)).toBeCloseTo(1 / 60 / 0.15, 6);
    expect(donutRamp(0.5, false, 1 / 60)).toBeCloseTo(0.5 - 1 / 60 / 0.5, 6);
    expect(donutRamp(0.99, true, 1)).toBe(1);
    expect(donutRamp(0.01, false, 1)).toBe(0);
    expect(donutRamp(0, true, 0.15) * 1).toBeCloseTo(1, 6);
  });

  it('turns the way the wheel does, harder with more wheel, and builds up with speed', () => {
    expect(donutYawTarget(1, 8, a)).toBeCloseTo(-a.donutYawRate, 6); // right wheel: a clockwise (negative) yaw
    expect(donutYawTarget(-1, 8, a)).toBeCloseTo(a.donutYawRate, 6);
    expect(Math.abs(donutYawTarget(0.6, 8, a))).toBeLessThan(a.donutYawRate);
    expect(donutYawTarget(0, 8, a)).toBeCloseTo(0, 9);
    expect(Math.abs(donutYawTarget(1, 0, a))).toBeCloseTo(a.donutYawRate * 0.4, 6);
    expect(Math.abs(donutYawTarget(1, 1, a))).toBeLessThan(Math.abs(donutYawTarget(1, 4, a)));
  });

  it('settles at a speed that a tighter wheel lowers, and governs toward it', () => {
    expect(donutTargetSpeed(1, a)).toBeCloseTo(a.donutSpeed, 6);
    expect(donutTargetSpeed(0.3, a)).toBeLessThan(a.donutSpeed);
    expect(donutAccel(0, 1, 9, a)).toBe(9); // from rest: full push (capped by what the engine has)
    expect(donutAccel(a.donutSpeed, 1, 9, a)).toBeCloseTo(0, 6);
    expect(donutAccel(a.donutSpeed + 2, 1, 9, a)).toBeLessThan(0); // too fast: brake
    expect(donutAccel(40, 1, 9, a)).toBe(-a.donutBrake);
  });

  it('pulls the yaw rate to its target, never harder than the cap', () => {
    expect(donutYawAccel(0, -1.5)).toBeLessThan(0);
    expect(donutYawAccel(-1.5, -1.5)).toBe(0);
    expect(donutYawAccel(0, 10)).toBe(14);
    expect(donutYawAccel(0, -10)).toBe(-14);
  });

  it('bends the direction of travel so the slide angle settles at the configured angle, tail out', () => {
    const target = a.donutSlideDeg * DEG;
    // turning right (negative yaw): the tail swings left, so the car travels left of its nose (positive slide)
    expect(donutTurnRate(-1.5, -1.5, target, a)).toBeCloseTo(-1.5, 6); // at the angle: travel turns with the nose
    expect(donutTurnRate(-1.5, -1.5, 0, a)).toBeGreaterThan(-1.5); // too straight: travel turns slower than the nose, so the slide opens
    expect(donutTurnRate(-1.5, -1.5, target + 0.3, a)).toBeLessThan(-1.5); // too far out: catch up
    expect(donutTurnRate(1.5, 1.5, -target, a)).toBeCloseTo(1.5, 6); // mirror image
    expect(donutTurnRate(0, 0.7, 1, a)).toBe(0.7); // no yaw target, nothing to bend
  });
});

describe('burnout hold', () => {
  const a = h.assists;
  it('brakes the front axle and harder once the car creeps faster than it should', () => {
    expect(burnoutHold(0, a)).toBeCloseTo(a.burnoutHold, 6);
    expect(burnoutHold(a.burnoutCreep, a)).toBeCloseTo(a.burnoutHold, 6);
    expect(burnoutHold(a.burnoutCreep + 2, a)).toBeGreaterThan(burnoutHold(a.burnoutCreep, a));
    expect(burnoutHold(100, a)).toBe(12);
  });
});
