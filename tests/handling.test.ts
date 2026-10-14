/**
 * Car feel as numbers: the envelopes the arcade handling has to stay inside (planted at speed, a
 * predictable handbrake drift, a steady donut, a pickup that is clearly heavier and softer). They
 * run the real sim on flat ground and read the car's own body, so a change to the maths or to
 * handling.json that breaks the feel fails here.
 */
import { describe, expect, it } from 'vitest';
import { Button, cmd, driverSim, run, telemetry } from './helpers';

type Driver = Awaited<ReturnType<typeof driverSim>>;

interface Trace {
  speed: number;
  yawRate: number;
  slide: number;
  upY: number;
  x: number;
  z: number;
  roll: number;
}

/** Runs `ticks` of the same command and records the car each tick. */
function drive(d: Driver, ticks: number, c: Parameters<typeof cmd>[0]): Trace[] {
  const out: Trace[] = [];
  for (let i = 0; i < ticks; i++) {
    run(d.sim, 1, cmd(c));
    const t = telemetry(d.car);
    const p = d.car.pose();
    out.push({ speed: t.speed, yawRate: t.yawRate, slide: t.slideDeg, upY: t.upY, x: p.x, z: p.z, roll: Math.acos(Math.min(1, t.upY)) * (180 / Math.PI) });
  }
  return out;
}

const max = (a: Trace[], f: (t: Trace) => number) => Math.max(...a.map(f));
const min = (a: Trace[], f: (t: Trace) => number) => Math.min(...a.map(f));
const mean = (a: Trace[], f: (t: Trace) => number) => a.reduce((s, t) => s + f(t), 0) / a.length;
const abs = Math.abs;

/** Least-squares circle through the path (Kasa fit): centre and radius. */
function fitCircle(pts: Trace[]) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const mz = pts.reduce((a, p) => a + p.z, 0) / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.z - mz;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det;
  const vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det;
  return { cx: mx + uc, cz: mz + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/** The last seconds of a donut: the best-fit circle (radius and how far the path strays from it) and the window. */
function circle(t: Trace[], seconds = 3) {
  const w = t.slice(-60 * seconds);
  const { cx, cz, r } = fitCircle(w);
  const dist = w.map((s) => Math.hypot(s.x - cx, s.z - cz));
  return { w, r, rSpread: Math.max(...dist) - Math.min(...dist) };
}


/** Gets up to a speed (m/s) on a straight line, then lets the caller carry on. */
async function atSpeed(type: string, speed: number): Promise<Driver> {
  const d = await driverSim(type);
  for (let i = 0; i < 60 * 25 && d.car.speedForward < speed; i++) run(d.sim, 1, cmd({ axes: { Throttle: 1 } }));
  return d;
}

describe('planted at speed', () => {
  it('stays on its line at 40 m/s with the wheel hard over, then straightens out', async () => {
    const d = await atSpeed('sedan', 40);
    const turn = drive(d, 90, { axes: { Throttle: 0.6, Steer: 1 } });
    expect(max(turn, (t) => abs(t.slide))).toBeLessThan(4);
    expect(max(turn, (t) => abs(t.yawRate))).toBeLessThan(0.95);
    expect(min(turn, (t) => t.upY)).toBeGreaterThan(0.99);
    const out = drive(d, 120, { axes: { Throttle: 0.6 } });
    expect(max(out, (t) => abs(t.slide))).toBeLessThan(4);
    expect(abs(out[out.length - 1].yawRate)).toBeLessThan(0.02);
  });

  it('corners hard at a moderate speed without sliding', async () => {
    const d = await atSpeed('sedan', 22);
    const t = drive(d, 120, { axes: { Throttle: 0.5, Steer: 0.6 } }).slice(40);
    const latG = mean(t, (x) => (abs(x.yawRate) * x.speed) / 9.81);
    expect(latG).toBeGreaterThan(1.0);
    expect(max(t, (x) => abs(x.slide))).toBeLessThan(6);
  });
});

describe('handbrake drift', () => {
  async function drift(type: string, steer: number) {
    const d = await atSpeed(type, 22);
    const entry = drive(d, 24, { buttons: Button.Handbrake, axes: { Throttle: 0.8, Steer: steer } });
    const hold = drive(d, 90, { axes: { Throttle: 0.8, Steer: steer } });
    const recover = drive(d, 90, { axes: { Throttle: 0.6, Steer: 0 } });
    return { entry, hold, recover };
  }

  it('kicks the tail out on a tap, holds an angle that follows the steering, and recovers quickly', async () => {
    const half = await drift('sedan', 0.5);
    const full = await drift('sedan', 1);
    const light = await drift('sedan', 0.3);
    // entry: the nose swings, but not into a spin
    expect(max(half.entry, (t) => abs(t.yawRate))).toBeGreaterThan(0.9);
    expect(max(half.entry, (t) => abs(t.yawRate))).toBeLessThan(2.4);
    // the held slide angle (deg) grows with the steering and stays bounded
    const a = (r: typeof half) => mean(r.hold.slice(30), (t) => abs(t.slide));
    expect(a(light)).toBeGreaterThan(10);
    expect(a(half)).toBeGreaterThan(a(light));
    expect(a(full)).toBeGreaterThan(a(half));
    expect(a(full)).toBeLessThan(55);
    for (const r of [light, half, full]) {
      expect(max([...r.entry, ...r.hold], (t) => abs(t.slide))).toBeLessThan(62);
      expect(max([...r.entry, ...r.hold], (t) => abs(t.yawRate))).toBeLessThan(2.4);
      expect(min([...r.entry, ...r.hold], (t) => t.upY)).toBeGreaterThan(0.97);
      // still moving fast enough to be a drift, not a spin-out
      expect(mean(r.hold.slice(30), (t) => t.speed)).toBeGreaterThan(11);
    }
    // recovery: straightened in under a second, and no swing back past straight
    for (const r of [light, half, full]) {
      const settle = r.recover.findIndex((t) => abs(t.slide) < 8);
      expect(settle).toBeGreaterThanOrEqual(0);
      expect(settle / 60).toBeLessThan(1);
      const swing = max(r.recover, (t) => -Math.sign(r.hold[r.hold.length - 1].slide) * t.slide);
      expect(swing).toBeLessThan(6);
    }
  });

  it('does not slide without the handbrake', async () => {
    const d = await atSpeed('sedan', 22);
    const t = drive(d, 90, { axes: { Throttle: 0.8, Steer: 1 } });
    expect(max(t, (x) => abs(x.slide))).toBeLessThan(8);
  });
});

describe('burnout and donut', () => {
  it('burns out in place with the handbrake and throttle: the tail spins, the car stays put', async () => {
    const d = await driverSim('sedan');
    const p0 = d.car.pose();
    const t = drive(d, 120, { buttons: Button.Handbrake, axes: { Throttle: 1 } });
    const p1 = d.car.pose();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(1.5);
    expect(d.car.wheels[2].slip).toBe(1);
    expect(d.car.wheels[3].slip).toBe(1);
    expect(d.car.wheels[0].slip).toBeLessThan(0.5);
    expect(max(t, (x) => abs(x.yawRate))).toBeLessThan(0.5);
  });

  for (const [type, lo, hi] of [
    ['sedan', 4, 6.5],
    ['pickup', 5, 8],
  ] as const) {
    it(`holds a steady donut in the ${type}: a circle of ${lo} to ${hi} m radius, tail out, never a spin on the spot`, async () => {
      const d = await driverSim(type);
      const t = drive(d, 60 * 8, { axes: { Throttle: 1, Steer: 1 } });
      const { w, r, rSpread } = circle(t);
      // a circle, not a spin on the spot and not a long arc
      expect(r).toBeGreaterThan(lo);
      expect(r).toBeLessThan(hi);
      expect(rSpread).toBeLessThan(0.6);
      // the speed and the yaw rate stay in a band: steady, no wobble
      expect(min(w, (s) => s.speed)).toBeGreaterThan(6.5);
      expect(max(w, (s) => s.speed)).toBeLessThan(10);
      expect(max(w, (s) => s.speed) - min(w, (s) => s.speed)).toBeLessThan(0.6);
      expect(min(w, (s) => -s.yawRate)).toBeGreaterThan(1.1);
      expect(max(w, (s) => -s.yawRate)).toBeLessThan(2.1);
      // tail out on the outside, travelling to the left of the nose while turning right
      expect(min(w, (s) => s.slide)).toBeGreaterThan(25);
      expect(max(w, (s) => s.slide)).toBeLessThan(65);
      // never spins up past the envelope, never rolls
      expect(max(t, (s) => abs(s.yawRate))).toBeLessThan(2.6);
      expect(min(t, (s) => s.upY)).toBeGreaterThan(0.98);
      // rear tyres smoking, front ones not
      expect(d.car.wheels[2].slip).toBe(1);
      expect(d.car.skidding).toBe(true);
    });
  }

  it('turns the other way with the wheel the other way', async () => {
    const d = await driverSim('sedan');
    const t = drive(d, 60 * 6, { axes: { Throttle: 1, Steer: -1 } });
    const w = t.slice(-90);
    expect(min(w, (s) => s.yawRate)).toBeGreaterThan(1.1);
    expect(max(w, (s) => s.slide)).toBeLessThan(-25);
  });

  it('starts from a handbrake turn at speed and settles into the same donut', async () => {
    const d = await atSpeed('sedan', 11);
    drive(d, 30, { buttons: Button.Handbrake, axes: { Throttle: 1, Steer: 1 } });
    const t = drive(d, 60 * 5, { axes: { Throttle: 1, Steer: 1 } });
    const { r } = circle(t);
    expect(r).toBeGreaterThan(4);
    expect(r).toBeLessThan(6.5);
  });

  it('lets go cleanly: off the throttle it rolls to a stop, off the wheel it drives away straight', async () => {
    const lift = await driverSim('sedan');
    drive(lift, 60 * 5, { axes: { Throttle: 1, Steer: 1 } });
    const l = drive(lift, 60 * 3, { axes: {} });
    expect(max(l, (s) => abs(s.yawRate))).toBeLessThan(1.8);
    expect(l[l.length - 1].speed).toBeLessThan(2);
    expect(abs(l[l.length - 1].yawRate)).toBeLessThan(0.1);

    const straight = await driverSim('sedan');
    drive(straight, 60 * 5, { axes: { Throttle: 1, Steer: 1 } });
    const s = drive(straight, 60 * 4, { axes: { Throttle: 1, Steer: 0 } });
    expect(max(s, (x) => abs(x.yawRate))).toBeLessThan(1.8);
    const settled = s.findIndex((x) => abs(x.slide) < 8 && abs(x.yawRate) < 0.4);
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(settled / 60).toBeLessThan(2);
    expect(s[s.length - 1].speed).toBeGreaterThan(14);
  });
});

describe('the pickup', () => {
  it('is heavier, slower off the line and lazier to turn than the sedan', async () => {
    const sedan = await driverSim('sedan');
    const pickup = await driverSim('pickup');
    expect(pickup.car.h.mass).toBeGreaterThan(sedan.car.h.mass * 1.3);
    run(sedan.sim, 180, cmd({ axes: { Throttle: 1 } }));
    run(pickup.sim, 180, cmd({ axes: { Throttle: 1 } }));
    expect(pickup.car.speedForward).toBeLessThan(sedan.car.speedForward * 0.85);
    expect(pickup.car.speedForward).toBeGreaterThan(sedan.car.speedForward * 0.4);
  });

  it('leans into a corner several times as far as the sedan, and has a wider donut', async () => {
    const lean = async (type: string) => {
      const d = await atSpeed(type, 20);
      const t = drive(d, 150, { axes: { Throttle: 0.4, Steer: 0.7 } });
      return max(t.slice(60), (s) => s.roll);
    };
    const sedanRoll = await lean('sedan');
    const pickupRoll = await lean('pickup');
    expect(sedanRoll).toBeGreaterThan(0.3);
    expect(pickupRoll).toBeGreaterThan(sedanRoll * 2.5);
    expect(pickupRoll).toBeLessThan(10);

    const radius = async (type: string) => {
      const d = await driverSim(type);
      return circle(drive(d, 60 * 8, { axes: { Throttle: 1, Steer: 1 } })).r;
    };
    expect(await radius('pickup')).toBeGreaterThan((await radius('sedan')) + 0.4);
  });

  it('is a stand-in with its own handling entry and body', async () => {
    const d = await driverSim('pickup');
    expect(d.car.h.id).toBe('pickup');
    expect(d.car.h.body).toBe('pickup');
    expect(d.car.h.chassis.halfExtents[2]).toBeGreaterThan(2.4);
    // still driveable and stable
    const t = drive(d, 300, { axes: { Throttle: 1, Steer: 0.1 } });
    expect(min(t, (s) => s.upY)).toBeGreaterThan(0.97);
  });
});
