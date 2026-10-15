/**
 * Soak-style collision audit: the real Five Points tile, headless in Node, with ambient traffic and
 * pedestrians, a scripted player who walks the sidewalks, and now and then gunfire and a shove (so people run).
 * It counts, for everybody on foot, the time spent inside a building footprint (judged against the footprints
 * recovered from the tile's collision.bin, courtyards left open) and the times somebody tried to move and made
 * no progress for 5 s or more.
 *
 *   npm run audit:collision                       (10 sim minutes)
 *   AUDIT_MINUTES=2 AUDIT_TILE=<dir> AUDIT_TRUTH=<dir> npm run audit:collision
 *
 * AUDIT_TILE is the tile the sim runs on; AUDIT_TRUTH the tile whose collision.bin supplies the footprints to judge
 * by (default: the same). Prints one `AUDIT_RESULT {json}` line.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { FootprintIndex } from '../../src/shared/footprints';
import { loadBakedTile } from '../../src/shared/tile';
import { knockDown } from '../../src/sim/combat/damage';
import type { PedEntity } from '../../src/sim/entities';
import { WalkGraph } from '../../src/sim/peds/graph';
import { Simulation } from '../../src/sim/Simulation';
import { Rng } from '../../src/shared/rng';
import { cmd, Button } from '../helpers';
import type { SimEvent } from '../../src/shared/protocol';

const TILE = process.env.AUDIT_TILE ?? 'public/tiles/atlanta/m1-five-points';
const TRUTH = process.env.AUDIT_TRUTH ?? TILE;
const MINUTES = Number(process.env.AUDIT_MINUTES ?? 10);
const SEED = Number(process.env.AUDIT_SEED ?? 7);
const TRACE = Number(process.env.AUDIT_TRACE ?? 0);
const TRACE_FROM = Number(process.env.AUDIT_TRACE_FROM ?? 0) * 60;
const TRACE_TO = Number(process.env.AUDIT_TRACE_TO ?? 1e9) * 60;
const have = existsSync(`${TILE}/tile.json`) && existsSync(`${TRUTH}/tile.json`);

const fsFetch = async (url: string) => {
  const path = existsSync(url) ? url : url.replace(/^\/?/, '');
  const ok = existsSync(path);
  const buf = ok ? readFileSync(path) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

function footprints(dir: string): FootprintIndex {
  const t = JSON.parse(readFileSync(`${dir}/tile.json`, 'utf8'));
  const b = readFileSync(`${dir}/collision.bin`);
  const { vertexCount: vc, indexCount: ic } = t.collision;
  const pos = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + vc * 12));
  const idx = new Uint32Array(b.buffer.slice(b.byteOffset + vc * 12, b.byteOffset + vc * 12 + ic * 4));
  if (t.collision.buildingTriangles === undefined) throw new Error(`${dir}: tile.json has no collision.buildingTriangles; bake with the current pipeline`);
  return new FootprintIndex(pos, idx, t.collision.buildingTriangles);
}

interface Track {
  anchorX: number;
  anchorZ: number;
  far: number;
  samples: number;
  intent: number;
  stuckWindows: number;
  insideRun: number;
  maxInsideRun: number;
  wallRun: number;
}

describe.skipIf(!have)('collision audit', () => {
  it(`${MINUTES} sim minutes on ${TILE}`, async () => {
    const truth = footprints(TRUTH);
    const tile = await loadBakedTile(TILE, fsFetch);
    const sim = await Simulation.create({
      seed: SEED, tile,
      ambientPeds: true, pedBudget: 60, traffic: 0.75, parkedCars: 6, clock: { minutes: 12 * 60 + 30, scale: 0 },
    });
    const graph = new WalkGraph(tile.paths!);
    const rng = new Rng(SEED * 13 + 1);
    const events: Record<string, number> = {};
    const unstuck: Record<string, number> = {};
    const unstuckSamples: string[] = [];
    const tap = (list: SimEvent[]) => {
      for (const e of list) {
        events[e.type] = (events[e.type] ?? 0) + 1;
        if ((e.type as string) === 'ped:unstuck') {
          const u = e as unknown as { reason: string; action: string; pedId: number; fromX: number; fromZ: number; toX: number; toZ: number; tick: number };
          const k = `${u.reason}/${u.action}`;
          unstuck[k] = (unstuck[k] ?? 0) + 1;
          if (unstuckSamples.length < Number(process.env.AUDIT_SAMPLES ?? 25)) {
            const p = sim.registry.get(u.pedId) as PedEntity | undefined;
            let what = '';
            if (u.reason === 'overlap' && p) {
              const col = sim.physics.overlapping(u.fromX, p.controller.y, u.fromZ);
              const t = col?.translation();
              what = col ? ` overlaps shape=${col.shape.type} at ${t!.x.toFixed(1)},${t!.y.toFixed(1)},${t!.z.toFixed(1)}` : ' overlaps nothing now';
            }
            unstuckSamples.push(`${what}${k} ped ${u.pedId} t=${(u.tick / 60).toFixed(0)}s from ${u.fromX.toFixed(1)},${u.fromZ.toFixed(1)} to ${u.toX.toFixed(1)},${u.toZ.toFixed(1)} ${p ? `${p.amb?.mode ?? p.role}/${p.brain?.state}/${p.life} y=${p.controller.y.toFixed(2)} ground=${sim.groundAt(u.fromX, u.fromZ).toFixed(2)} lite=${p.amb?.lite}` : 'gone'}`);
          }
        }
      }
    };

    const player = sim.registry.get(sim.playerPedId) as PedEntity;
    // ---- the player bot: walk routes over the network, jump to somewhere else every 90 s
    let route: number[] = [];
    let ri = 0;
    let pAnchor = { x: player.controller.x, z: player.controller.z, t: 0 };
    let playerStuck = 0;
    const playerSpots: string[] = [];
    const planRoute = () => {
      const from = graph.nearestNode(player.controller.x, player.controller.z, 60);
      for (let k = 0; k < 20; k++) {
        const to = rng.int(0, graph.nodeCount - 1);
        const d = Math.hypot(graph.x[to] - player.controller.x, graph.z[to] - player.controller.z);
        if (d < 100 || d > 500 || from < 0) continue;
        const r = graph.route(from, to);
        if (r && r.length > 3) { route = r; ri = 1; return; }
      }
      route = [];
    };
    const warp = () => {
      for (let k = 0; k < 50; k++) {
        const n = rng.int(0, graph.nodeCount - 1);
        if (graph.adjStart[n + 1] - graph.adjStart[n] < 1) continue;
        player.controller.teleport(graph.x[n], graph.y[n] + 0.1, graph.z[n]);
        route = [];
        return;
      }
    };

    const tracks = new Map<number, Track>();
    let insidePedSeconds = 0, wallPedSeconds = 0, pedSamples = 0;
    const insidePeds = new Set<number>(), longInsidePeds = new Set<number>(), wallPeds = new Set<number>();
    const stuckPeds = new Set<number>();
    let stuckEpisodes = 0, stuckPedSeconds = 0;
    const stuckWhy: Record<string, number> = {};
    const stuckSpots: string[] = [];
    const insideSpots: string[] = [];
    let ambientSeen = 0;
    const total = Math.round(MINUTES * 60 * 60);
    const t0 = performance.now();
    let stepMs = 0, stepMax = 0;
    for (let tick = 1; tick <= total; tick++) {
      if (tick % 5400 === 1) warp();
      if (route.length === 0 || ri >= route.length) planRoute();
      // steer
      let mx = 0, my = 0, yaw = 0;
      if (ri < route.length) {
        const n = route[ri];
        const dx = graph.x[n] - player.controller.x, dz = graph.z[n] - player.controller.z;
        if (Math.hypot(dx, dz) < 1.2) ri++;
        else { yaw = Math.atan2(-dx, -dz); my = 1; }
      }
      sim.pushInput(1, cmd({ buttons: my > 0 && tick % 1200 < 300 ? Button.Sprint : 0, axes: { MoveY: my, MoveX: mx, Yaw: yaw } }));
      if (tick % 1500 === 700 && sim.ambient) {
        const c = player.controller;
        sim.ambient.scare(c.x, c.y, c.z, 60, 'gunfire');
      }
      if (tick % 2400 === 1000) {
        let n = 0;
        for (const p of sim.peds()) {
          if (p === player || p.vehicleId || p.life !== 'alive') continue;
          if (Math.hypot(p.controller.x - player.controller.x, p.controller.z - player.controller.z) > 30) continue;
          const a = rng.range(0, Math.PI * 2);
          knockDown(sim, p, 2.5, Math.sin(a) * 7, Math.cos(a) * 7, 3);
          if (++n >= 4) break;
        }
      }
      const s0 = performance.now();
      sim.step();
      const ms = performance.now() - s0;
      stepMs += ms; stepMax = Math.max(stepMax, ms);
      tap(sim.drainEvents());

      if (tick % 300 === 0) {
        const c = player.controller;
        if (Math.hypot(c.x - pAnchor.x, c.z - pAnchor.z) < 0.6 && my > 0) {
          playerStuck++;
          route = [];
          // what is it pressed against: a prop (the bot does not steer round furniture), a wall, the terrain?
          let near = 'none', nd = 2.5;
          for (const pr of sim.physics.props) {
            const d = Math.hypot(pr.at.x - c.x, pr.at.z - c.z);
            if (d < nd) { nd = d; near = `${pr.kind} ${d.toFixed(1)} m`; }
          }
          if (playerSpots.length < 20) playerSpots.push(`${c.x.toFixed(1)},${c.z.toFixed(1)} t=${(tick / 60).toFixed(0)}s near ${near}, wall ${truth.nearestWall(c.x, c.z, 3, undefined, c.y).toFixed(1)} m`);
        }
        pAnchor = { x: c.x, z: c.z, t: tick };
      }
      if (TRACE && tick % 30 === 0 && tick >= TRACE_FROM && tick <= TRACE_TO) {
        const p = sim.registry.get(TRACE) as PedEntity | undefined;
        const a = p?.amb;
        if (p && a) {
          const c = p.controller;
          const g = sim.ambient!.graph;
          const wc = sim.physics.wallClearance(c.x, c.z, c.y);
          const nx = a.next >= 0 ? `${g.x[a.next].toFixed(1)},${g.z[a.next].toFixed(1)}` : '-';
          process.stdout.write(`TRACE t=${(tick / 60).toFixed(1)} ${c.x.toFixed(2)},${c.z.toFixed(2)} y=${c.y.toFixed(2)} mode=${a.mode} lite=${a.lite} node=${a.node} next=${a.next}@${nx} edge=${a.edge} lane=${a.lane.toFixed(2)} in=${p.input.moveX.toFixed(1)},${p.input.moveY.toFixed(1)} vel=${c.speed.toFixed(2)} wall=${wc.toFixed(2)} stuckN=${a.stuckN} ground=${sim.groundAt(c.x, c.z).toFixed(2)} liteY=${a.liteY.toFixed(2)} nodeY=${a.next >= 0 ? g.y[a.next].toFixed(2) : '-'} overlap=${(() => { const o = sim.physics.overlapping(c.x, c.y, c.z); return o ? `shape${o.shape.type}@${o.translation().x.toFixed(1)},${o.translation().y.toFixed(1)},${o.translation().z.toFixed(1)}` : 'none'; })()}\n`);
        }
      }
      if (tick % 30 === 0) {
        const seen = new Set<number>();
        for (const p of sim.peds()) {
          if (p === player || p.vehicleId || p.busy) continue;
          seen.add(p.id);
          const c = p.controller;
          let tr = tracks.get(p.id);
          if (!tr) tracks.set(p.id, (tr = { anchorX: c.x, anchorZ: c.z, far: 0, samples: 0, intent: 0, stuckWindows: 0, insideRun: 0, maxInsideRun: 0, wallRun: 0 }));
          if (p.amb) ambientSeen++;
          pedSamples++;
          const inside = truth.inside(c.x, c.y, c.z);
          if (inside) {
            insidePedSeconds += 0.5;
            insidePeds.add(p.id);
            tr.insideRun++;
            if (tr.insideRun === 3) { longInsidePeds.add(p.id); if (insideSpots.length < 12) insideSpots.push(`${p.id}@${c.x.toFixed(1)},${c.z.toFixed(1)} t=${(tick / 60).toFixed(0)}s ${p.amb?.mode ?? p.role}/${p.brain?.state}`); }
          } else tr.insideRun = 0;
          if (!inside && truth.nearestWall(c.x, c.z, 0.2, undefined, c.y) < 0.2) { wallPedSeconds += 0.5; wallPeds.add(p.id); }
          tr.samples++;
          tr.far = Math.max(tr.far, Math.hypot(c.x - tr.anchorX, c.z - tr.anchorZ));
          if (p.life === 'alive' && Math.hypot(p.input.moveX, p.input.moveY) > 0.2) tr.intent++;
          if (tr.samples === 10) {
            if (tr.intent >= 8 && tr.far < 0.6) {
              if (tr.stuckWindows === 0) { stuckEpisodes++; stuckWhy[`${p.amb?.mode ?? p.role}/${p.brain?.state}`] = (stuckWhy[`${p.amb?.mode ?? p.role}/${p.brain?.state}`] ?? 0) + 1; if (stuckSpots.length < 12) stuckSpots.push(`${p.id}@${c.x.toFixed(1)},${c.z.toFixed(1)} t=${(tick / 60).toFixed(0)}s ${p.amb?.mode ?? p.role}/${p.brain?.state}`); }
              tr.stuckWindows++;
              stuckPedSeconds += 5;
              stuckPeds.add(p.id);
            } else tr.stuckWindows = 0;
            tr.anchorX = c.x; tr.anchorZ = c.z; tr.far = 0; tr.samples = 0; tr.intent = 0;
          }
        }
        if (tick % 1800 === 0) for (const id of tracks.keys()) if (!seen.has(id)) tracks.delete(id);
      }
    }
    const result = {
      tile: TILE, truth: TRUTH, seed: SEED, simMinutes: MINUTES, wallSeconds: +((performance.now() - t0) / 1000).toFixed(1),
      stepMsMean: +(stepMs / total).toFixed(3), stepMsMax: +stepMax.toFixed(1),
      pedSamples, ambientSeen,
      pedsEverInsideFootprint: insidePeds.size, pedsInsideOver1s: longInsidePeds.size, insidePedSeconds,
      pedsAtAWall: wallPeds.size, wallPedSeconds,
      stuckEpisodesOver5s: stuckEpisodes, stuckPeds: stuckPeds.size, stuckPedSeconds, stuckWhy,
      playerStuckWindows: playerStuck, playerSpots, unstuck, unstuckSamples, insideSpots, stuckSpots,
      spawned: sim.ambient?.spawned, removed: sim.ambient?.removed, peds: [...sim.peds()].length, vehicles: [...sim.vehicles()].length,
    };
    const text = JSON.stringify(result, null, 1);
    if (process.env.AUDIT_OUT) writeFileSync(process.env.AUDIT_OUT, text);
    process.stdout.write('AUDIT_RESULT ' + text + '\n');
  }, 3_600_000);
});
