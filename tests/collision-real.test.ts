import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBakedTile } from '../src/shared/tile';
import { Rng } from '../src/shared/rng';
import { collectProps, worldSolids } from '../src/shared/props';
import { Simulation } from '../src/sim/Simulation';
import { PedEntity } from '../src/sim/entities';
import { cmd, run } from './helpers';

const DIR = 'public/tiles/atlanta/m1-five-points';
const have = existsSync(`${DIR}/tile.json`) && JSON.parse(readFileSync(`${DIR}/tile.json`, 'utf8')).collision?.buildingTriangles !== undefined;

const fsFetch = async (url: string) => {
  const path = url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

async function realSim(over: Partial<Parameters<typeof Simulation.create>[0]> = {}) {
  const tile = await loadBakedTile(DIR, fsFetch);
  return Simulation.create({ seed: 5, tile, ambientPeds: true, pedBudget: 80, traffic: 0.5, clock: { minutes: 12 * 60 + 30, scale: 0 }, ...over });
}

describe.skipIf(!have)('collision on the baked Five Points tile', () => {
  it('has a solid pole for every signal head it draws, and a bench or shelter for every one of those', async () => {
    const sim = await realSim({ ambientPeds: false, traffic: 0 });
    const tile = sim.tile;
    const props = collectProps(tile.lanes?.junctions, tile.scenarios?.points);
    expect(props.filter((p) => p.kind === 'signal').length).toBeGreaterThan(100);
    expect(sim.physics.props.length).toBe(props.length);
    let missing = 0;
    for (const p of props) {
      const box = worldSolids(p)[0];
      // a person standing at the prop's own spot overlaps it (the first box is the pole, the seat or the sign pole)
      if (!sim.physics.overlapsStatic(box.cx, box.cy - box.hy - 0.02, box.cz)) missing++;
    }
    expect(missing).toBe(0);
  });

  it('puts nobody in a wall when it makes them: every ambient spawn is clear of buildings and solids', async () => {
    for (const seed of [1, 2, 3]) {
      const sim = await realSim({ seed, pedBudget: 150, traffic: 0 });
      // warp the player about so the director fills a new neighbourhood each time
      const g = sim.ambient!.graph;
      const rng = new Rng(seed);
      let checked = 0;
      for (let k = 0; k < 6; k++) {
        const n = rng.int(0, g.nodeCount - 1);
        const me = sim.registry.get(sim.playerPedId) as PedEntity;
        me.controller.teleport(g.x[n], g.y[n] + 0.1, g.z[n]);
        for (let i = 0; i < 120; i++) sim.step();
        for (const p of sim.ambient!.list) {
          const c = p.controller;
          if (p.amb!.spawnedAt < sim.tick - 120) continue;
          checked++;
          expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
          // on the walk network, standing on something
          expect(Number.isNaN(sim.physics.floorBelow(c.x, c.y + 0.6, c.z, 1.6))).toBe(false);
        }
      }
      expect(checked).toBeGreaterThan(40);
    }
  }, 120_000);

  it('keeps walkers that glide out of buildings over minutes of play, with the safety net off', async () => {
    const sim = await realSim({ seed: 11, pedBudget: 100, traffic: 0 });
    // the unstick safety net is off: this is the glide and the planner on their own
    const systems = (sim as unknown as { systems: { name: string }[] }).systems;
    systems.splice(0, systems.length, ...systems.filter((s) => s.name !== 'unstick'));
    const g = sim.ambient!.graph;
    const rng = new Rng(77);
    const me = sim.registry.get(sim.playerPedId) as PedEntity;
    let samples = 0;
    let inside = 0;
    const insideAt: string[] = [];
    for (let minute = 0; minute < 4; minute++) {
      // somewhere new each minute, and a burst of gunfire so people run
      for (;;) {
        const n = rng.int(0, g.nodeCount - 1);
        if (g.degree(n) < 1) continue;
        me.controller.teleport(g.x[n], g.y[n] + 0.1, g.z[n]);
        break;
      }
      for (let i = 0; i < 3600; i++) {
        if (i === 900) sim.ambient!.scare(me.controller.x, me.controller.y, me.controller.z, 60, 'gunfire');
        run(sim, 1, cmd());
        if (i % 20 === 0) {
          for (const p of sim.peds()) {
            if (p === me || p.vehicleId) continue;
            samples++;
            const c = p.controller;
            if (sim.physics.footprints.inside(c.x, c.y, c.z)) {
              inside++;
              if (insideAt.length < 5) insideAt.push(`${p.id} ${c.x.toFixed(1)},${c.z.toFixed(1)} ${p.amb?.mode}`);
            }
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(3000);
    expect(insideAt).toEqual([]);
    expect(inside).toBe(0);
  }, 180_000);

  it('knows which stretches of the walk network cannot be walked, and routes round them', async () => {
    const sim = await realSim({ seed: 3, traffic: 0 });
    const A = sim.ambient!;
    const g = A.graph;
    let blocked = 0;
    for (let e = 0; e < g.edgeCount; e++) if (A.clearance.isBlocked(e)) blocked++;
    // a few per cent: under low decks, behind a pole, up a cliff; not the network
    expect(blocked).toBeGreaterThan(20);
    expect(blocked / g.edgeCount).toBeLessThan(0.15);
    // a walker's lane is pulled in where an edge is narrow
    let narrowed = 0;
    for (let e = 0; e < g.edgeCount && narrowed === 0; e++) {
      if (A.clearance.isBlocked(e)) continue;
      if (Math.abs(A.clearance.lane(e, g.ea[e], 0.55)) < 0.5) narrowed++;
    }
    expect(narrowed).toBe(1);
    // routes never use a blocked edge
    const rng = new Rng(4);
    let routes = 0;
    for (let k = 0; k < 40; k++) {
      const r = g.route(rng.int(0, g.nodeCount - 1), rng.int(0, g.nodeCount - 1));
      if (!r || r.length < 2) continue;
      routes++;
      for (let i = 1; i < r.length; i++) expect(A.clearance.isBlocked(g.edgeBetween(r[i - 1], r[i]))).toBe(false);
    }
    expect(routes).toBeGreaterThan(5);
  });
});
