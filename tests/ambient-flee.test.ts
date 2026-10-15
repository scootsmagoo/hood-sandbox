import { describe, expect, it } from 'vitest';
import type { PedEntity } from '../src/sim/entities';
import { pedSim } from './pedHelpers';

const dist = (p: PedEntity, x: number, z: number) => Math.hypot(p.controller.x - x, p.controller.z - z);

describe('fleeing ambient pedestrians', () => {
  it('runs along the walk network, away from the threat', async () => {
    const sim = await pedSim({ peds: 14, seed: 3 });
    for (let i = 0; i < 120; i++) sim.step();
    const A = sim.ambient!;
    const g = A.graph;
    const me = sim.playerPosition();
    // an explosion on the crossroads: everyone who can see it and is not too close to cower runs
    A.scare(me.x, me.y, me.z, 40, 'explosion');

    const runs = new Map<number, { d0: number; last: number; onGraph: number; onCrossing: number; n: number }>();
    for (let i = 0; i < 360; i++) {
      sim.step();
      for (const p of A.list) {
        if (p.amb!.mode !== 'flee') continue;
        let r = runs.get(p.id);
        if (!r) runs.set(p.id, (r = { d0: dist(p, me.x, me.z), last: 0, onGraph: 0, onCrossing: 0, n: 0 }));
        r.last = dist(p, me.x, me.z);
        const hit = g.nearestEdge(p.controller.x, p.controller.z, 2.5);
        r.n++;
        if (hit) r.onGraph++;
        if (hit && g.kindOf(hit.edge) === 'crossing') r.onCrossing++;
      }
    }
    const all = [...runs.values()];
    console.log(all.map((r) => `d0=${r.d0.toFixed(1)} last=${r.last.toFixed(1)} graph=${(r.onGraph / r.n).toFixed(2)} cross=${(r.onCrossing / r.n).toFixed(2)} n=${r.n}`).join('\n'));
    expect(all.length).toBeGreaterThan(2);
    const onGraph = all.reduce((s, r) => s + r.onGraph, 0) / all.reduce((s, r) => s + r.n, 0);
    const onCrossing = all.reduce((s, r) => s + r.onCrossing, 0) / all.reduce((s, r) => s + r.n, 0);
    expect(onGraph).toBeGreaterThan(0.9);
    expect(onCrossing).toBeLessThan(0.15);
    expect(all.filter((r) => r.last > r.d0 + 4).length / all.length).toBeGreaterThan(0.8);
  });
});
