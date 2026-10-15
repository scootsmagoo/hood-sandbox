import { describe, expect, it } from 'vitest';
import { SIGNAL_PLANS, WALK_FLASH_S, cycleLength, greenLeft, groupOfLeg, legState, phaseOf, walkState, type SignalJunction } from './signals';

const junction = (id: string): SignalJunction => ({
  id,
  legs: [
    { dir: [-1, 0], approach: true },
    { dir: [1, 0], approach: true },
    { dir: [0, -1], approach: true },
    { dir: [0, 1], approach: true },
  ],
});

describe('signal phases', () => {
  it('groups the legs by axis: opposite legs together, the cross street in the other group', () => {
    const j = junction('j1');
    const g = [0, 1, 2, 3].map((i) => groupOfLeg(j, i));
    expect(g[0]).toBe(g[1]);
    expect(g[2]).toBe(g[3]);
    expect(g[0]).not.toBe(g[2]);
  });

  it('is a pure function of the junction and the time', () => {
    const a = junction('j7');
    const b = junction('j7');
    for (let t = 0; t < 300; t += 0.37) {
      const pa = phaseOf(a, t);
      const states = [...pa.groups];
      const pb = phaseOf(b, t);
      expect(pb.groups).toEqual(states);
    }
  });

  it('never shows green or amber to both groups, and puts an all-red gap between them', () => {
    for (const id of ['j0', 'j1', 'j2', 'j33', 'j404']) {
      const j = junction(id);
      let sawAllRed = false;
      for (let t = 0; t < 400; t += 0.05) {
        const p = phaseOf(j, t);
        const live = p.groups.filter((s) => s !== 'red').length;
        expect(live).toBeLessThanOrEqual(1);
        if (live === 0) sawAllRed = true;
      }
      expect(sawAllRed).toBe(true);
    }
  });

  it('runs green, amber, red in order for each group, with the cycle of its table', () => {
    const j = junction('j12');
    const cycle = cycleLength(j);
    expect(SIGNAL_PLANS.some((p) => Math.abs(p.green[0] + p.green[1] + 2 * (p.amber + p.allRed) - cycle) < 1e-9)).toBe(true);
    // the sequence of group 0 over one cycle is green -> amber -> red
    const seq: string[] = [];
    for (let t = 0; t < cycle; t += 0.1) {
      const s = phaseOf(j, t).groups[0];
      if (seq[seq.length - 1] !== s) seq.push(s);
    }
    const rotated = seq.join(',');
    expect(['green,amber,red', 'red,green,amber', 'amber,red,green', 'green,amber,red,green', 'red,green,amber,red', 'amber,red,green,amber']).toContain(rotated);
    // and it repeats exactly
    for (const t of [3, 17.5, 40]) expect(phaseOf(j, t).groups[0]).toBe(phaseOf(j, t + cycle).groups[0]);
  });

  it('does not run neighbouring junctions in step: offsets come from the id', () => {
    const offsets = new Set<string>();
    for (let n = 0; n < 40; n++) offsets.add(phaseOf(junction(`j${n}`), 0).groups.join('') + phaseOf(junction(`j${n}`), 13).groups.join(''));
    expect(offsets.size).toBeGreaterThan(3);
  });

  it('tells a car on a leg what its group sees', () => {
    const j = junction('j3');
    for (let t = 0; t < 200; t += 1.3) {
      const p = phaseOf(j, t);
      const g0 = groupOfLeg(j, 0);
      expect(legState(j, 0, t)).toBe(p.groups[g0]);
      expect(legState(j, 1, t)).toBe(p.groups[g0]);
      expect(legState(j, 2, t)).toBe(p.groups[1 - g0]);
    }
  });

  it('lets pedestrians walk across a leg only while that leg is stopped and the cross street has green, and warns before it ends', () => {
    const j = junction('j9');
    let walk = 0;
    let flash = 0;
    for (let t = 0; t < 600; t += 0.1) {
      const w = walkState(j, 0, t);
      if (w === 'dont') continue;
      // cars on leg 0 are stopped, the cross group has the green
      expect(legState(j, 0, t)).toBe('red');
      expect(legState(j, 2, t)).toBe('green');
      if (w === 'walk') walk++;
      else {
        flash++;
        expect(greenLeft(j, groupOfLeg(j, 2), t)).toBeLessThanOrEqual(WALK_FLASH_S + 1e-6);
      }
    }
    expect(walk).toBeGreaterThan(100);
    expect(flash).toBeGreaterThan(40);
  });

  it('reports the green left for a group only while it is green', () => {
    const j = junction('j5');
    for (let t = 0; t < 120; t += 0.5) {
      for (const g of [0, 1] as const) {
        const left = greenLeft(j, g, t);
        expect(phaseOf(j, t).groups[g] === 'green').toBe(left > 0);
      }
    }
  });
});
