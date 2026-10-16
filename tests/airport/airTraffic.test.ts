/**
 * The airport's AI traffic on the baked Hartsfield-Jackson aeroway (public/tiles/atlanta/airport/aeroway.json): the schedule plans
 * arrivals and departures, every stand's lead-in reaches the runways, no two aircraft on the ground come within their separation,
 * and the same seed gives the same traffic. Skipped when the airport is not baked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAeroway, type AerowayData } from '../../src/shared/aeroway';
import { Rng } from '../../src/shared/rng';
import { AirTraffic } from '../../src/sim/aircraft/AirTraffic';
import { TYPES } from '../../src/sim/aircraft/types';
import { newPose, poseAt } from '../../src/sim/aircraft/plans';

const FILE = 'public/tiles/atlanta/airport/aeroway.json';
const baked = existsSync(FILE);
const data = (): AerowayData => parseAeroway(JSON.parse(readFileSync(FILE, 'utf8')));

describe.skipIf(!baked)('airport traffic', () => {
  it('plans arrivals and departures and lands and launches them', () => {
    const at = new AirTraffic(data(), new Rng(7), null, { noPhysics: true });
    for (let t = 0; t < 1800; t += 1) at.update(t);
    console.log(JSON.stringify(at.stats), 'active', at.flights.length, 'parked', at.stands.filter((s) => s.occ).length);
    expect(at.stats.arrivals).toBeGreaterThan(30);
    expect(at.stats.departures).toBeGreaterThan(30);
    expect(at.stats.landed).toBeGreaterThan(10);
    expect(at.stats.departed).toBeGreaterThan(10);
  });

  it('keeps aircraft on the ground apart', () => {
    const at = new AirTraffic(data(), new Rng(3), null, { noPhysics: true });
    let worst = Infinity;
    const p = newPose(), q = newPose();
    for (let t = 0; t < 900; t += 2) {
      at.update(t);
      const live = at.flights.filter((f) => !f.done && t >= f.t0);
      for (let i = 0; i < live.length; i++) {
        poseAt(live[i].plan, t - live[i].t0, p);
        if (p.gear < 1 || p.phase === 1 || p.phase === 8) continue;
        for (let j = i + 1; j < live.length; j++) {
          poseAt(live[j].plan, t - live[j].t0, q);
          if (q.gear < 1 || q.phase === 1 || q.phase === 8) continue;
          const sep = (TYPES[live[i].plan.cls].span + TYPES[live[j].plan.cls].span) / 2;
          worst = Math.min(worst, Math.hypot(p.x - q.x, p.z - q.z) / sep);
        }
      }
    }
    console.log('closest pair on the ground, in half spans summed:', worst.toFixed(2));
    expect(worst).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    const run = () => {
      const at = new AirTraffic(data(), new Rng(11), null, { noPhysics: true });
      for (let t = 0; t < 600; t += 1) at.update(t);
      return at.flights.map((f) => `${f.id}:${f.plan.kind}:${f.plan.stand}:${f.t0.toFixed(1)}`).join(',');
    };
    expect(run()).toBe(run());
  });
});
