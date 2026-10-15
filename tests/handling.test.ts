/**
 * Car feel as numbers: the GTA IV envelopes the handling has to stay inside. Heavy cars with
 * momentum, soft long-travel suspension that rolls, dives and squats, weight transfer that changes
 * grip (lift-off oversteer, understeer on a too-fast entry), slides that build gradually and can be
 * caught, a handbrake that locks the rears and swings the tail, crashes that bounce a little and
 * transfer momentum, rollovers off a kerb, and three cars that feel different. They run the real
 * sim on flat ground and read the car's own body, so a change to the maths or to handling.json that
 * breaks the feel fails here. docs/physics.md has the table these numbers come from.
 */
import { describe, expect, it } from 'vitest';
import { HANDLING } from '../src/shared/handling';
import { SIM_HZ } from '../src/shared/protocol';
import { staticStability } from '../src/sim/vehicles/dynamics';
import { RaycastCar } from '../src/sim/vehicles/RaycastCar';
import { Button, cmd, driverSim, makeSim, run, telemetry, vehicle } from './helpers';
import { R2D, atSpeed, attitude, box, holding, max, mean, min, tileWith, trace, turned } from './carHelpers';

const TYPES = ['sedan', 'coupe', 'pickup'] as const;

/** Seconds from rest to 100 km/h at full throttle, and the speed after 40 s. */
async function zeroTo100(type: string) {
  const d = await driverSim(type);
  let t = -1;
  for (let i = 0; i < 40 * SIM_HZ; i++) {
    run(d.sim, 1, cmd({ axes: { Throttle: 1 } }));
    if (t < 0 && d.car.speedForward > 100 / 3.6) t = i / SIM_HZ;
  }
  return { t, top: d.car.speedForward };
}

/** Metres from 100 km/h to a stop with the brake flat, and the trace. */
async function brake100(type: string) {
  const d = await atSpeed(type, 100 / 3.6 + 0.5);
  while (d.car.speedForward > 100 / 3.6) run(d.sim, 1, cmd());
  const z0 = d.car.body.translation().z;
  const t: ReturnType<typeof trace> = [];
  // (the brake pedal reverses once stopped: stop measuring there)
  for (let i = 0; i < 8 * SIM_HZ && d.car.speedForward > 0.3; i++) t.push(...trace(d, 1, { axes: { Brake: 1 } }));
  return { dist: Math.abs(d.car.body.translation().z - z0), t, d };
}

/** A steady corner: hold `speed` with the wheel at `steer` for 6 s; the last 3 s are the steady state. */
async function skidpad(type: string, speed: number, steer: number) {
  const d = await atSpeed(type, speed);
  const t = trace(d, 6 * SIM_HZ, holding(d, speed, steer));
  return { all: t, steady: t.slice(3 * SIM_HZ), d };
}

describe('weight and pace', () => {
  it('reaches 100 km/h in GTA IV times: the coupe quickest, the pickup slowest, all heavy enough to carry momentum', async () => {
    const r = Object.fromEntries(await Promise.all(TYPES.map(async (t) => [t, await zeroTo100(t)] as const)));
    expect(r.sedan.t).toBeGreaterThan(7.5);
    expect(r.sedan.t).toBeLessThan(10);
    expect(r.coupe.t).toBeGreaterThan(5);
    expect(r.coupe.t).toBeLessThan(7);
    expect(r.pickup.t).toBeGreaterThan(9.5);
    expect(r.pickup.t).toBeLessThan(13);
    // top speeds: sedan about 165 km/h, coupe past 200, pickup about 140
    expect(r.sedan.top * 3.6).toBeGreaterThan(150);
    expect(r.coupe.top * 3.6).toBeGreaterThan(190);
    expect(r.pickup.top * 3.6).toBeLessThan(r.sedan.top * 3.6);
    for (const t of TYPES) {
      expect(HANDLING[t].mass).toBeGreaterThanOrEqual(1300);
      expect(HANDLING[t].mass).toBeLessThanOrEqual(2200);
    }
  });

  it('coasts a long way: off the throttle at 100 km/h it is still above 80 after 3 s', async () => {
    const d = await atSpeed('sedan', 100 / 3.6);
    run(d.sim, 3 * SIM_HZ, cmd());
    expect(d.car.speedForward * 3.6).toBeGreaterThan(80);
  });
});

describe('brakes', () => {
  it('stops from 100 km/h in about 40 m (60-0 mph in 35-45 m), straight, with the nose diving', async () => {
    for (const [type, lo, hi] of [['sedan', 38, 46], ['coupe', 34, 42], ['pickup', 40, 50]] as const) {
      const { dist, t } = await brake100(type);
      expect(dist, type).toBeGreaterThan(lo);
      expect(dist, type).toBeLessThan(hi);
      expect(max(t, (s) => Math.abs(s.slide)), type).toBeLessThan(3);
      // the nose dives: about 2 to 4 degrees on the sedan, more on the pickup
      const dive = -min(t, (s) => s.pitch);
      if (type === 'sedan') {
        expect(dive).toBeGreaterThan(2);
        expect(dive).toBeLessThan(4.5);
      }
      if (type === 'pickup') expect(dive).toBeGreaterThan(2.8);
    }
  });

  it('moves the weight forward: the front tyres carry far more than at rest while braking hard', async () => {
    const d = await atSpeed('sedan', 25);
    const front0 = d.car.wheels[0].nominal + d.car.wheels[1].nominal;
    trace(d, 30, { axes: { Brake: 1 } });
    const front = d.car.loadOf(0) + d.car.loadOf(1);
    const rear = d.car.loadOf(2) + d.car.loadOf(3);
    expect(front / front0).toBeGreaterThan(1.25);
    expect(rear).toBeLessThan(front * 0.6);
  });
});

describe('suspension: roll, dive and squat', () => {
  it('rolls about 5 to 8 degrees in a hard corner on the sedan, more on the pickup, less on the coupe', async () => {
    const roll: Record<string, number> = {};
    for (const t of TYPES) {
      const { all } = await skidpad(t, 25, 0.5);
      roll[t] = max(all, (s) => Math.abs(s.roll));
      expect(min(all, (s) => s.upY), t).toBeGreaterThan(0.97);
    }
    expect(roll.sedan).toBeGreaterThan(4.5);
    expect(roll.sedan).toBeLessThan(8);
    expect(roll.pickup).toBeGreaterThan(roll.sedan * 1.3);
    expect(roll.pickup).toBeLessThan(12);
    expect(roll.coupe).toBeLessThan(roll.sedan);
  });

  it('squats under full throttle from rest, and the body overshoots and settles (soft, lightly damped)', async () => {
    const d = await driverSim('sedan');
    const t = trace(d, 2 * SIM_HZ, { axes: { Throttle: 1 } });
    const squat = max(t, (s) => s.pitch);
    expect(squat).toBeGreaterThan(0.8);
    expect(squat).toBeLessThan(3);
    // lift off at speed: the nose pitches down past level, then comes back
    const lift = trace(d, SIM_HZ, { axes: {} });
    expect(min(lift, (s) => s.pitch)).toBeLessThan(0);
    expect(Math.abs(lift[lift.length - 1].pitch)).toBeLessThan(1);
  });

  it('sits at its designed height at rest on long travel', async () => {
    for (const t of TYPES) {
      const sim = await makeSim(undefined, t);
      const car = vehicle(sim).car;
      run(sim, 120, cmd());
      expect(Math.abs(car.body.translation().y - RaycastCar.restHeight(car.h))).toBeLessThan(0.02);
      expect(car.h.suspension.travel).toBeGreaterThanOrEqual(0.34);
    }
  });
});

describe('grip and weight transfer', () => {
  it('pulls about 0.8 to 1 g on a skidpad, the coupe most and the pickup least', async () => {
    const g: Record<string, number> = {};
    for (const t of TYPES) g[t] = mean((await skidpad(t, 25, 0.5)).steady, (s) => s.latG);
    expect(g.sedan).toBeGreaterThan(0.78);
    expect(g.sedan).toBeLessThan(0.95);
    expect(g.coupe).toBeGreaterThan(g.sedan);
    expect(g.coupe).toBeLessThan(1.05);
    expect(g.pickup).toBeLessThan(g.sedan);
    expect(g.pickup).toBeGreaterThan(0.65);
  });

  it('understeers when it turns in too fast: at 30 m/s full lock turns far less than the wheels point, front first', async () => {
    const d = await atSpeed('sedan', 30);
    const wheelbase = d.car.h.wheels.frontZ - d.car.h.wheels.rearZ;
    const t = trace(d, 90, { axes: { Steer: 1 } });
    const asked = max(t, (s) => (s.speed * Math.tan(Math.abs(s.steerDeg) / R2D)) / wheelbase);
    const got = max(t, (s) => Math.abs(s.yawRate));
    expect(got / asked).toBeLessThan(0.4);
    // the car does not spin: it ploughs on, sliding only a little
    expect(max(t, (s) => Math.abs(s.slide))).toBeLessThan(15);
    expect(min(t, (s) => s.upY)).toBeGreaterThan(0.97);
  });

  it('lets the tail go when the throttle is lifted mid-corner (lift-off oversteer), and the slide is catchable', async () => {
    for (const type of ['sedan', 'pickup'] as const) {
      const d = await atSpeed(type, 21);
      const before = trace(d, 150, holding(d, 21, 0.55));
      const lift = trace(d, 50, { axes: { Steer: 0.55 } });
      const s0 = Math.abs(before[before.length - 1].slide);
      const r0 = Math.abs(before[before.length - 1].yawRate);
      expect(max(lift, (s) => Math.abs(s.slide)), type).toBeGreaterThan(s0 + 0.3);
      expect(max(lift, (s) => Math.abs(s.yawRate)), type).toBeGreaterThan(r0 * 1.08);
      // and it does not snap round: unwinding the wheel catches it within a second and a half
      const out = trace(d, 90, { axes: {} });
      expect(max(out, (s) => Math.abs(s.slide)), type).toBeLessThan(25);
      expect(Math.abs(out[out.length - 1].slide), type).toBeLessThan(3);
    }
  });

  it('keeps a keyboard driver on the road: full throttle with the wheel hard over at city speeds slides but does not spin', async () => {
    for (const type of ['sedan', 'pickup'] as const) {
      for (const v of [8, 14]) {
        const d = await atSpeed(type, v);
        const t = trace(d, 2 * SIM_HZ, { axes: { Throttle: 1, Steer: 1 } });
        expect(max(t, (s) => Math.abs(s.slide)), `${type} ${v}`).toBeLessThan(25);
      }
    }
  });
});

describe('slides', () => {
  it('follows a slip curve that peaks and falls off: a slide builds over a few tenths, not in one step', async () => {
    const d = await atSpeed('sedan', 18);
    const t = trace(d, 30, { buttons: Button.Handbrake, axes: { Steer: 0.6 } });
    // the yaw rate grows step by step
    const r = t.map((s) => Math.abs(s.yawRate));
    expect(r[3]).toBeLessThan(0.3);
    for (let i = 1; i < r.length; i++) expect(r[i] - r[i - 1]).toBeLessThan(0.12);
  });

  it('a handbrake tap swings the tail, and letting go of everything catches it', async () => {
    for (const type of TYPES) {
      const d = await atSpeed(type, 18);
      const y0 = d.car.yaw;
      const tap = trace(d, 18, { buttons: Button.Handbrake, axes: { Steer: 0.6 } });
      const after = trace(d, 2 * SIM_HZ, { axes: {} });
      const all = [...tap, ...after];
      expect(max(all, (s) => Math.abs(s.slide)), type).toBeGreaterThan(4);
      expect(Math.abs(turned(y0, d.car.yaw)) * R2D, type).toBeGreaterThan(8);
      expect(Math.abs(turned(y0, d.car.yaw)) * R2D, type).toBeLessThan(60);
      const settle = after.findIndex((s, i) => i > 6 && Math.abs(s.slide) < 3 && Math.abs(s.yawRate) < 0.15);
      expect(settle, type).toBeGreaterThanOrEqual(0);
      expect(settle / SIM_HZ, type).toBeLessThan(1.5);
    }
  });

  it('a longer pull locks the rears and brings the car round 60 degrees or more; a counter-steer and some throttle drive out of it', async () => {
    const d = await atSpeed('sedan', 18);
    const y0 = d.car.yaw;
    const pull = trace(d, 36, { buttons: Button.Handbrake, axes: { Steer: 0.6 } });
    // locked: the rear wheels do not turn while the handbrake is on
    const roll0 = d.car.wheels[2].roll;
    run(d.sim, 3, cmd({ buttons: Button.Handbrake, axes: { Steer: 0.6 } }));
    expect(d.car.wheels[2].roll).toBe(roll0);
    const out = trace(d, 3 * SIM_HZ, (i) => {
      const sl = telemetry(d.car).slideDeg;
      // a driver catching it: wheel into the slide, a little throttle
      return cmd({ axes: { Steer: Math.max(-1, Math.min(1, -sl / 30)), Throttle: 0.35 } });
    });
    expect(Math.abs(turned(y0, out[20].yaw)) * R2D).toBeGreaterThan(45);
    expect(max(pull, (s) => Math.abs(s.slide))).toBeGreaterThan(12);
    const last = out.slice(-30);
    expect(max(last, (s) => Math.abs(s.slide))).toBeLessThan(6);
    expect(mean(last, (s) => s.speed)).toBeGreaterThan(3);
  });

  it('burns out with the throttle and the brake: the rear tyres smoke and the car stays put', async () => {
    const d = await driverSim('sedan');
    const p0 = d.car.pose();
    trace(d, 120, { axes: { Throttle: 1, Brake: 1 } });
    const p1 = d.car.pose();
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(1.5);
    expect(d.car.wheels[2].slip).toBe(1);
    expect(d.car.wheels[3].slip).toBe(1);
    expect(d.car.wheels[0].slip).toBeLessThan(0.5);
    expect(d.car.skidding).toBe(true);
  });
});

describe('steering', () => {
  it('has a slower rack at speed and a narrower lock', async () => {
    const reach = async (v: number) => {
      const d = v > 0 ? await atSpeed('sedan', v) : await driverSim('sedan');
      const t = trace(d, 60, holding(d, v, 1));
      const lock = max(t, (s) => Math.abs(s.steerDeg));
      return { lock, at: t.findIndex((s) => Math.abs(s.steerDeg) > lock * 0.9) };
    };
    const slow = await reach(0);
    const fast = await reach(30);
    expect(fast.lock).toBeLessThan(slow.lock * 0.6);
    // the rate (degrees per second) is lower at speed
    expect(fast.lock / Math.max(1, fast.at)).toBeLessThan(slow.lock / Math.max(1, slow.at));
  });

  it('stays planted on a motorway lane change at 40 m/s', async () => {
    const d = await atSpeed('sedan', 40);
    const t = trace(d, 120, (i) => cmd({ axes: { Throttle: 0.6, Steer: i < 30 ? 0.4 : i < 60 ? -0.4 : 0 } }));
    expect(max(t, (s) => Math.abs(s.slide))).toBeLessThan(6);
    expect(min(t, (s) => s.upY)).toBeGreaterThan(0.98);
    expect(Math.abs(t[t.length - 1].yawRate)).toBeLessThan(0.15);
  });
});

describe('crashes', () => {
  /** A car driven into a wall at `v`: the bounce back as a share of the speed in. */
  async function wall(type: string, v: number) {
    const sim = await makeSim(tileWith([box(0, -40, 30, 4, 2)]), type);
    const car = vehicle(sim).car;
    car.teleport(0, 0.5, -39 + 1 + car.h.chassis.halfExtents[2] + 2, Math.PI);
    run(sim, 30, cmd());
    car.body.setLinvel({ x: 0, y: 0, z: -v }, true);
    car.adopt();
    let back = 0;
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      run(sim, 1, cmd());
      back = Math.max(back, car.body.linvel().z);
      peak = Math.max(peak, car.impactSpeedLoss);
    }
    return { cor: back / v, peak, upY: telemetry(car).upY };
  }

  it('hits a wall heavily: a little bounce (restitution 0.1 to 0.3), not a pillow and not a trampoline', async () => {
    for (const type of ['sedan', 'pickup']) {
      for (const v of [14, 22]) {
        const r = await wall(type, v);
        expect(r.cor, `${type} ${v}`).toBeGreaterThan(0.1);
        expect(r.cor, `${type} ${v}`).toBeLessThan(0.3);
        expect(r.peak).toBeGreaterThan(v);
        expect(r.upY).toBeGreaterThan(0.9);
      }
    }
  });

  it('passes momentum on: a rear-end shunt sends the parked car off, and a T-bone spins the car that is hit', async () => {
    const sim = await makeSim(undefined, 'sedan');
    const a = vehicle(sim);
    a.car.teleport(0, 0.5, 20, Math.PI);
    const b = sim.spawnVehicle('sedan', 0, 0, 10, Math.PI, 0xffffff);
    run(sim, 30, cmd());
    a.car.body.setLinvel({ x: 0, y: 0, z: -15 }, true);
    a.car.adopt();
    run(sim, 30, cmd());
    const va = -a.car.body.linvel().z;
    const vb = -b.car.body.linvel().z;
    // equal masses: the struck car takes most of the speed, the striker keeps a little, and they part (restitution)
    expect(vb).toBeGreaterThan(6);
    expect(vb - va).toBeGreaterThan(1);
    expect(va).toBeLessThan(6);

    const sim2 = await makeSim(undefined, 'pickup');
    const p = vehicle(sim2);
    p.car.teleport(-12, 0.5, 0, Math.PI / 2);
    const s = sim2.spawnVehicle('sedan', 0, 0, 0.8, Math.PI, 0xffffff);
    run(sim2, 30, cmd());
    p.car.body.setLinvel({ x: 20, y: 0, z: 0 }, true);
    p.car.adopt();
    const y0 = s.car.yaw;
    let spin = 0;
    for (let i = 0; i < 120; i++) {
      run(sim2, 1, cmd());
      spin = Math.max(spin, Math.abs(telemetry(s.car).yawRate));
    }
    expect(spin).toBeGreaterThan(0.6);
    expect(Math.abs(turned(y0, s.car.yaw)) * R2D).toBeGreaterThan(20);
    expect(Math.hypot(s.car.body.translation().x, s.car.body.translation().z - 0.8)).toBeGreaterThan(4);
  });
});

describe('rollovers', () => {
  /** Slides the car sideways at `v` into a kerb `h` high; true when it went over. */
  async function kerb(type: string, h: number, v: number) {
    const sim = await makeSim(tileWith([box(6, 0, 4, h, 60)]), type);
    const car = vehicle(sim).car;
    car.teleport(0, 0.5, 0, Math.PI);
    run(sim, 30, cmd());
    car.body.setLinvel({ x: v, y: 0, z: 0 }, true);
    car.adopt();
    let lo = 1;
    for (let i = 0; i < 240; i++) {
      run(sim, 1, cmd());
      lo = Math.min(lo, telemetry(car).upY);
    }
    return lo < 0;
  }

  it('trips over a kerb when it slides into it sideways fast enough, the top-heavy pickup first', async () => {
    expect(await kerb('sedan', 0.15, 6)).toBe(false);
    expect(await kerb('sedan', 0.15, 16)).toBe(true);
    expect(await kerb('pickup', 0.15, 6)).toBe(false);
    expect(await kerb('pickup', 0.15, 11)).toBe(true);
    // the coupe sits low and wide: the same 11 m/s that rolls the pickup does not roll it
    expect(await kerb('coupe', 0.15, 11)).toBe(false);
  });

  it('never rolls on flat ground in ordinary hard driving: the static stability factor is above the tyres\' grip', async () => {
    for (const t of TYPES) {
      const ssf = staticStability(HANDLING[t], RaycastCar.restHeight(HANDLING[t]));
      expect(ssf, t).toBeGreaterThan(1.1);
      const { all } = await skidpad(t, 30, 0.8);
      expect(min(all, (s) => s.upY), t).toBeGreaterThan(0.95);
    }
    expect(staticStability(HANDLING.pickup, RaycastCar.restHeight(HANDLING.pickup))).toBeLessThan(staticStability(HANDLING.sedan, RaycastCar.restHeight(HANDLING.sedan)));
  });
});

describe('three different cars', () => {
  it('the coupe answers the wheel quickest and the pickup slowest', async () => {
    const response = async (type: string) => {
      const d = await atSpeed(type, 20);
      const t = trace(d, 40, holding(d, 20, 0.5));
      const peak = max(t, (s) => Math.abs(s.yawRate));
      return t.findIndex((s) => Math.abs(s.yawRate) > peak * 0.63);
    };
    const coupe = await response('coupe');
    const sedan = await response('sedan');
    const pickup = await response('pickup');
    expect(coupe).toBeLessThan(sedan);
    expect(pickup).toBeGreaterThan(sedan);
  });

  it('the coupe is tail-happy: from rest, full throttle with full lock slides it far more than the sedan', async () => {
    const slide = async (type: string) => {
      const d = await driverSim(type);
      return max(trace(d, 3 * SIM_HZ, { axes: { Throttle: 1, Steer: 1 } }).filter((s) => s.speed > 3), (s) => Math.abs(s.slide));
    };
    expect(await slide('coupe')).toBeGreaterThan((await slide('sedan')) + 10);
  });

  it('the pickup wallows: it rolls further and takes longer to settle after a lane change than the sedan', async () => {
    const wallow = async (type: string) => {
      const d = await atSpeed(type, 22);
      const t = trace(d, 3 * SIM_HZ, (i) => cmd({ axes: { Throttle: 0.4, Steer: i < 24 ? 0.6 : i < 48 ? -0.6 : 0 } }));
      const peak = max(t, (s) => Math.abs(s.roll));
      const settle = t.findIndex((s, i) => i > 48 && t.slice(i).every((x) => Math.abs(x.roll) < 0.5));
      return { peak, settle };
    };
    const sedan = await wallow('sedan');
    const pickup = await wallow('pickup');
    expect(pickup.peak).toBeGreaterThan(sedan.peak * 1.15);
    expect(pickup.settle).toBeGreaterThan(sedan.settle);
  });

  it('each type has its own entry and body, and the pickup is the heaviest', async () => {
    expect(HANDLING.pickup.body).toBe('pickup');
    expect(HANDLING.pickup.mass).toBeGreaterThan(HANDLING.sedan.mass * 1.25);
    expect(HANDLING.coupe.mass).toBeLessThan(HANDLING.sedan.mass);
    const d = await driverSim('pickup');
    expect(d.car.h.id).toBe('pickup');
    const t = trace(d, 300, { axes: { Throttle: 1, Steer: 0.1 } });
    expect(min(t, (s) => s.upY)).toBeGreaterThan(0.97);
    void attitude;
  });
});
