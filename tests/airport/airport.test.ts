/**
 * Hartsfield-Jackson in the sim, on the baked airport tiles (public/tiles/atlanta/airport, read from disk): the player spawns at
 * the Domestic Terminal's curb, walks in through its doors and across the hall, and an arriving aircraft lands, rolls out,
 * turns off and taxis to its gate, where it parks. Skipped when the airport is not baked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAeroway, standPose } from '../../src/shared/aeroway';
import { distToRing } from '../../src/shared/landmarks';
import { AircraftPhase } from '../../src/shared/snapshot';
import { Simulation } from '../../src/sim/Simulation';
import { HttpTileSource } from '../../src/sim/stream/TileSource';
import { TYPES } from '../../src/sim/aircraft/types';
import { cmd, ped, run } from '../helpers';

const DIR = 'public/tiles/atlanta/airport';
const SIDE = 'public/assets/airport/atl-domestic-terminal.json';
const baked = existsSync(`${DIR}/index.json`) && existsSync(`${DIR}/aeroway.json`) && existsSync(SIDE);

const fileFetch = async (url: string) => {
  const p = url.replace(/^file:\/\//, '');
  if (!existsSync(p)) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
  const b = readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(b.toString()), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};

async function airportSim() {
  const source = await HttpTileSource.open(`file://${process.cwd()}/${DIR}/index.json`, fileFetch as never);
  const aeroway = parseAeroway(JSON.parse(readFileSync(`${DIR}/aeroway.json`, 'utf8')));
  return Simulation.createCity({ seed: 1, source, aeroway, traffic: 0, ambientPeds: false, parkedCars: 0 });
}

type Side = { anchor: { x: number; z: number }; cutout: [number, number][]; interior: { walk: { nodes: [number, number, number][]; edges: [number, number, number][]; doors: number[] } } };

describe.skipIf(!baked)('Hartsfield-Jackson', () => {
  it('spawns at the Domestic Terminal curb, and the player walks in through its doors', async () => {
    const sim = await airportSim();
    const side = JSON.parse(readFileSync(SIDE, 'utf8')) as Side;
    const A = side.anchor;
    const ring = side.cutout.map((p) => [p[0] + A.x, p[1] + A.z] as [number, number]);
    const p0 = ped(sim).controller;
    expect(distToRing(p0.x, p0.z, ring)).toBeLessThan(200);
    // a door of the hall and a node 25 m or more inside it, along the walk network
    const w = side.interior.walk;
    const adj = new Map<number, number[]>();
    for (const [a, b] of w.edges) {
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    }
    const W = (i: number) => ({ x: w.nodes[i][0] + A.x, z: w.nodes[i][2] + A.z });
    let ok = 0;
    for (const door of w.doors.slice(0, 3)) {
      // breadth first from the door to the first node 25 m away (as the crow flies) and inside the outline
      const seen = new Set([door]);
      let frontier = [door];
      let target = -1;
      const d0 = W(door);
      for (let k = 0; k < 40 && frontier.length && target < 0; k++) {
        const next: number[] = [];
        for (const n of frontier) for (const m of adj.get(n) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          next.push(m);
          const q = W(m);
          if (Math.hypot(q.x - d0.x, q.z - d0.z) > 25 && distToRing(q.x, q.z, ring) === 0) target = m;
        }
        frontier = next;
      }
      if (target < 0) continue;
      // walk the path from the door to the target, one node after another
      const path: number[] = [target];
      // (back along the BFS is not kept: re-walk greedily towards each next node of a fresh BFS path)
      const prev = new Map<number, number>();
      const q: number[] = [door];
      prev.set(door, -1);
      while (q.length) {
        const n = q.shift()!;
        if (n === target) break;
        for (const m of adj.get(n) ?? []) if (!prev.has(m)) { prev.set(m, n); q.push(m); }
      }
      path.length = 0;
      for (let n = target; n >= 0; n = prev.get(n)!) path.unshift(n);
      const c = ped(sim).controller;
      c.teleport(d0.x, sim.groundAt(d0.x, d0.z) + 0.3, d0.z);
      sim.stream?.checkNow(d0.x, d0.z);
      run(sim, 30, cmd());
      for (const n of path.slice(1)) {
        const t = W(n);
        for (let k = 0; k < 400; k++) {
          const dx = t.x - c.x, dz = t.z - c.z;
          if (Math.hypot(dx, dz) < 1.2) break;
          run(sim, 1, cmd({ axes: { MoveY: 1, Yaw: Math.atan2(-dx, -dz) } }));
        }
      }
      const end = W(target);
      const reached = Math.hypot(c.x - end.x, c.z - end.z);
      if (reached < 2.5) {
        expect(distToRing(c.x, c.z, ring)).toBe(0);
        expect(sim.physics.footprints.inside(c.x, c.y, c.z)).toBe(false);
        ok++;
      } else console.warn(`door ${door}: stopped ${reached.toFixed(1)} m short of node ${target}`);
    }
    expect(ok).toBeGreaterThan(0);
  }, 240_000);

  it('lands an aircraft, taxis it to its gate and parks it there', async () => {
    const sim = await airportSim();
    const at = sim.aircraft!;
    expect(at).toBeTruthy();
    const dt = sim.dt;
    // the next arrival to touch down
    const now = () => sim.tick * dt;
    run(sim, 2, cmd());
    const pick = () => at.flights.filter((f) => f.plan.kind === 'arrival' && f.t0 + f.plan.tRunway > now() + 5).sort((a, b) => a.t0 + a.plan.tRunway - (b.t0 + b.plan.tRunway))[0];
    const f = pick();
    expect(f).toBeTruthy();
    const phases = new Set<number>();
    let worstH = 0, samples = 0;
    const end = f.t0 + f.plan.duration + 2;
    while (now() < end) {
      run(sim, 15, cmd());
      if (now() >= f.t0) {
        phases.add(f.state.phase);
        // (where the sim has the ground loaded: round the player)
        if (f.state.phase === AircraftPhase.TaxiIn && sim.stream?.solidAt(f.state.x, f.state.z)) {
          const h = f.state.y - sim.groundAt(f.state.x, f.state.z);
          if (Math.abs(h) > Math.abs(worstH)) worstH = h;
          samples++;
        }
      }
    }
    expect(phases.has(AircraftPhase.Approach)).toBe(true);
    expect(phases.has(AircraftPhase.Rollout)).toBe(true);
    expect(phases.has(AircraftPhase.TaxiIn)).toBe(true);
    // on the pavement while it taxis (the graph's heights are the ground's)
    console.log(`taxi-in height over the loaded ground: worst ${worstH.toFixed(2)} m over ${samples} samples`);
    expect(Math.abs(worstH)).toBeLessThan(0.6);
    // parked at its stand: the stand has it, where the stand's pose says
    const st = at.stands[f.plan.stand];
    expect(st.occ?.cls).toBe(f.plan.cls);
    const sp = standPose(at.data, at.data.stands[f.plan.stand], TYPES[f.plan.cls].wheelbase);
    expect(Math.hypot(f.state.x - sp.x, f.state.z - sp.z)).toBeLessThan(2);
    console.log(`flight ${f.id} (${f.plan.cls}) landed on runway ${at.data.runways[f.plan.runway].ends[f.plan.end].ref} and parked at ${at.data.stands[f.plan.stand].ref} after ${f.plan.duration.toFixed(0)} s; ${JSON.stringify(at.stats)}`);
  }, 600_000);
});
