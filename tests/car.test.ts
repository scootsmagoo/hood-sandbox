import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import { SIM_HZ } from '../src/shared/protocol';
import { Button, cmd, driverSim, makeSim, run, telemetry, vehicle } from './helpers';

describe('raycast car', () => {
  it('rests on its suspension at the designed height and stays put', async () => {
    const sim = await makeSim();
    const car = vehicle(sim).car;
    run(sim, 120, cmd());
    const y = car.body.translation().y;
    run(sim, 120, cmd());
    // |v| includes the solver's vertical sawtooth (about 0.06 m/s), which moves nothing
    expect(car.speed).toBeLessThan(0.1);
    expect(Math.abs(car.body.translation().y - y)).toBeLessThan(0.005);
    expect(y).toBeGreaterThan(0.3);
    expect(y).toBeLessThan(0.45);
    for (const w of car.wheels) expect(w.grounded).toBe(true);
  });

  it('accelerates to 100 km/h in a believable time and tops out below the flat velocity', async () => {
    const { sim, car } = await driverSim();
    let t100 = -1;
    for (let i = 0; i < 25 * SIM_HZ; i++) {
      run(sim, 1, cmd({ axes: { Throttle: 1 } }));
      if (t100 < 0 && car.speedForward > 27.8) t100 = i / SIM_HZ;
    }
    expect(t100).toBeGreaterThan(3);
    expect(t100).toBeLessThan(7);
    expect(car.speedForward).toBeGreaterThan(40);
    expect(car.speedForward).toBeLessThan(car.h.drive.maxFlatVel);
  });

  it('turns the way the driver steers', async () => {
    const { sim, car } = await driverSim();
    run(sim, 150, cmd({ axes: { Throttle: 0.6 } }));
    const x0 = car.body.translation().x;
    run(sim, 90, cmd({ axes: { Throttle: 0.4, Steer: 1 } }));
    // facing north, steering right moves the car east (+X) and turns the nose clockwise
    expect(car.body.translation().x).toBeGreaterThan(x0 + 3);
    expect(telemetry(car).yawRate).toBeLessThan(-0.3);
  });

  it('holds a corner without spinning or rolling', async () => {
    const { sim, car } = await driverSim();
    run(sim, 240, cmd({ axes: { Throttle: 0.6 } }));
    for (let i = 0; i < 180; i++) {
      run(sim, 1, cmd({ axes: { Throttle: 0.3, Steer: -1 } }));
      const t = telemetry(car);
      expect(t.upY).toBeGreaterThan(0.95);
      if (i > 45) {
        expect(Math.abs(t.slideDeg)).toBeLessThan(12);
        const latG = (Math.abs(t.yawRate) * t.speed) / 9.81;
        expect(latG).toBeLessThan(1.8);
        expect(latG).toBeGreaterThan(0.5);
      }
    }
  });

  it('brakes hard in a straight line, then reverses if the pedal stays down', async () => {
    const { sim, car } = await driverSim();
    run(sim, 450, cmd({ axes: { Throttle: 1 } }));
    const z0 = car.body.translation().z;
    const v0 = car.speedForward;
    expect(v0).toBeGreaterThan(30);
    let stopped = -1;
    for (let i = 0; i < 300; i++) {
      run(sim, 1, cmd({ axes: { Brake: 1 } }));
      const t = telemetry(car);
      expect(t.upY).toBeGreaterThan(0.97);
      if (t.forward > 1) expect(Math.abs(t.slideDeg)).toBeLessThan(5);
      if (stopped < 0 && car.speedForward < 0.7) {
        stopped = i;
        expect(Math.abs(car.body.translation().z - z0)).toBeLessThan(v0 * v0 / (2 * 11));
      }
    }
    expect(stopped).toBeGreaterThan(0);
    expect(car.speedForward).toBeLessThan(-2);
  });

  it('drifts under the handbrake with a bounded slide angle, then recovers', async () => {
    const { sim, car } = await driverSim();
    run(sim, 300, cmd({ axes: { Throttle: 0.8 } }));
    let maxSlide = 0;
    for (let i = 0; i < 70; i++) {
      run(sim, 1, cmd({ buttons: i >= 10 && i < 40 ? Button.Handbrake : 0, axes: { Throttle: 0.7, Steer: 0.6 } }));
      maxSlide = Math.max(maxSlide, Math.abs(telemetry(car).slideDeg));
    }
    expect(maxSlide).toBeGreaterThan(15);
    expect(maxSlide).toBeLessThan(65);
    expect(car.speed).toBeGreaterThan(12);
    // steer out of it
    run(sim, 150, cmd({ axes: { Throttle: 0.5, Steer: 0 } }));
    expect(Math.abs(telemetry(car).slideDeg)).toBeLessThan(10);
    expect(telemetry(car).upY).toBeGreaterThan(0.95);
  });

  it('burns out with the handbrake and throttle, and spins the tail around with steering', async () => {
    const { sim, car } = await driverSim();
    run(sim, 20, cmd({ buttons: Button.Handbrake, axes: { Throttle: 1 } }));
    expect(car.wheels[2].slip).toBe(1);
    expect(car.wheels[3].slip).toBe(1);
    expect(car.skidding).toBe(true);
    let turned = 0;
    let prev = car.yaw;
    for (let i = 0; i < 240; i++) {
      run(sim, 1, cmd({ buttons: Button.Handbrake, axes: { Throttle: 1, Steer: 1 } }));
      let d = car.yaw - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turned += d;
      prev = car.yaw;
    }
    expect(Math.abs(turned)).toBeGreaterThan(Math.PI);
    expect(telemetry(car).upY).toBeGreaterThan(0.95);
  });

  it('parks itself when empty', async () => {
    const sim = await makeSim();
    const car = vehicle(sim).car;
    car.body.setLinvel({ x: 0, y: 0, z: -15 }, true);
    run(sim, 240, cmd());
    expect(car.speed).toBeLessThan(0.5);
  });

  it('jumps the ramp, lands on its wheels and is still driveable', async () => {
    // the sample ramp is 60 m ahead of the sedan's spawn; start it close enough to arrive fast
    const tile = generateProceduralTile(1);
    const { sim, car } = await driverSim('sedan', tile, { x: 0, z: -10 });
    let air = 0;
    let maxUp = 0;
    car.teleport(0, 0.45, -10, Math.PI);
    for (let i = 0; i < 6 * SIM_HZ; i++) {
      run(sim, 1, cmd({ axes: { Throttle: 1 } }));
      if (car.airborne) air++;
      maxUp = Math.max(maxUp, car.body.translation().y);
      if (car.body.translation().z < -120) break;
    }
    expect(air).toBeGreaterThan(5);
    expect(maxUp).toBeGreaterThan(2.5);
    expect(telemetry(car).upY).toBeGreaterThan(0.5);
  });

  it('reports a crash into a building', async () => {
    const tile = generateProceduralTile(1);
    const { sim, car } = await driverSim('sedan', tile, { x: 0, z: -100 });
    let impact = 0;
    for (let i = 0; i < 10 * SIM_HZ; i++) {
      run(sim, 1, cmd({ axes: { Throttle: 1 } }));
      for (const e of sim.drainEvents()) if (e.type === 'vehicle:impact') impact = Math.max(impact, e.strength);
    }
    expect(impact).toBeGreaterThan(4);
    expect(car.body.translation().y).toBeLessThan(3);
  });

  it('keeps a coupe sportier than the sedan', async () => {
    const sedan = await driverSim('sedan');
    const coupe = await driverSim('coupe');
    run(sedan.sim, 240, cmd({ axes: { Throttle: 1 } }));
    run(coupe.sim, 240, cmd({ axes: { Throttle: 1 } }));
    expect(coupe.car.speedForward).toBeGreaterThan(sedan.car.speedForward);
  });
});
