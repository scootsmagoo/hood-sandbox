/**
 * Riding on the real Five Points tile: walk from the street down to every underground platform, get on at an open door, ride,
 * skip to the next station, get off; the fare gates (walk through: paid; jump through: fare evasion, a crime the station's
 * transit police officer sees); a train hits someone on its track; the player's train turns back at the edge of the map; and the
 * trains are the same for the same ticks.
 */
import { describe, expect, it } from 'vitest';
import { agencyAt } from '../../src/shared/law';
import type { SimEvent } from '../../src/shared/protocol';
import { H, SnapFlag, SnapshotView, TransitInfo } from '../../src/shared/snapshot';
import type { Simulation } from '../../src/sim/Simulation';
import { cmd, Button } from '../helpers';
import { haveTransitTile, playerOf, stationIndex, transitSim } from './transitHelpers';
import { followPath, nearestWalkNode, walkPath } from './walkBot';

function stepCollect(sim: Simulation, ticks: number, buttons = 0, into?: SimEvent[]) {
  for (let i = 0; i < ticks; i++) {
    sim.pushInput(1, cmd({ buttons }));
    sim.step();
    const ev = sim.drainEvents();
    if (into) into.push(...ev);
  }
}

/** Steps until a train of a route at `station` has its doors open; returns it. */
function waitOpenAt(sim: Simulation, station: number, platform?: number, maxS = 600) {
  const T = sim.transit!;
  for (let i = 0; i < maxS * 60; i++) {
    const tr = T.model.trains.find((t) => {
      const st = T.data.routes[t.route].stops[t.stop];
      return t.phase === 'open' && st?.station === station && (platform === undefined || st.platform === platform);
    });
    if (tr) return tr;
    stepCollect(sim, 1);
  }
  throw new Error('no train opened its doors');
}

describe.skipIf(!haveTransitTile)('riding the trains', () => {
  it('walks from every street entrance down (or up) to its platforms', async () => {
    const sim = await transitSim();
    const t = sim.transit!;
    const p = playerOf(sim);
    let walks = 0;
    for (const st of t.data.stations) {
      for (const e of st.entrances) {
        const from = nearestWalkNode(sim, e.x - Math.sin(e.yaw) * 1.5, e.y, e.z - Math.cos(e.yaw) * 1.5);
        for (const pl of st.platforms) {
          const to = nearestWalkNode(sim, pl.c[0], pl.y, pl.c[1]);
          const path = walkPath(sim, from, to);
          // (an elevated station of two side platforms has a stair for each: this entrance's is the other's)
          if (!st.underground && !path) continue;
          expect(path, `${st.name}: a way down`).not.toBeNull();
          if (!path) continue;
          const n0 = t.data.walk.nodes[path[0]];
          p.controller.teleport(n0[0], n0[1] + 0.3, n0[2]);
          const r = followPath(sim, path, { jog: true });
          expect(r.stuckAt, `${st.name}: stuck on the way down`).toBe(-1);
          expect(Math.abs(p.controller.y - pl.y), `${st.name}: on the platform`).toBeLessThan(0.6);
          walks++;
        }
      }
    }
    expect(walks).toBeGreaterThanOrEqual(14);
  }, 300_000);

  it('gets on at Five Points, skips to the next station and gets off there', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    const fp = stationIndex(sim, 'Five Points');
    const tr = waitOpenAt(sim, fp);
    const p = playerOf(sim);
    const o = T.doorOutside(tr, 2, 1, 0.5);
    p.controller.teleport(o.x, o.y + 0.05, o.z);
    stepCollect(sim, 10);
    const view = new SnapshotView();
    sim.writeSnapshot(view);
    expect(TransitInfo.door(view.u32[H.TransitInfo])).toBe(1);
    const ev: SimEvent[] = [];
    stepCollect(sim, 1, Button.Interact, ev);
    stepCollect(sim, 2, 0, ev);
    expect(p.ride?.trainId).toBe(tr.id);
    expect(ev.some((e) => e.type === 'transit:board' && e.pedId === p.id)).toBe(true);
    sim.writeSnapshot(view);
    expect(view.u32[H.Flags] & SnapFlag.OnTrain).toBeTruthy();
    expect(view.u32[H.Train]).toBe(tr.id);
    // riding: the player sits where the seat is, and moves with the train
    stepCollect(sim, 60 * 40, 0, ev);
    const firstStop = tr.stop;
    // skip: the fade, then the train stands at the next station with its doors opening
    stepCollect(sim, 1, Button.Skip, ev);
    stepCollect(sim, 60, 0, ev);
    const skip = ev.filter((e) => e.type === 'transit:skip');
    expect(skip.map((e) => (e as { phase: string }).phase)).toEqual(['out', 'in']);
    expect(tr.phase === 'opening' || tr.phase === 'open').toBe(true);
    expect(tr.stop).toBeGreaterThanOrEqual(firstStop);
    stepCollect(sim, 120, 0, ev);
    const station = T.data.routes[tr.route].stops[tr.stop].station;
    expect(station).not.toBe(fp);
    stepCollect(sim, 1, Button.Interact, ev);
    stepCollect(sim, 30, 0, ev);
    expect(p.ride).toBeNull();
    expect(ev.some((e) => e.type === 'transit:alight' && e.pedId === p.id && e.station === station)).toBe(true);
    // on the platform of that station, standing
    const plat = T.data.stations[station].platforms;
    expect(plat.some((pl) => Math.abs(p.controller.y - pl.y) < 0.4)).toBe(true);
    expect(p.controller.grounded).toBe(true);
  }, 120_000);

  it('turns the player back at the edge of the map', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    const fp = stationIndex(sim, 'Five Points');
    const tr = waitOpenAt(sim, fp);
    const p = playerOf(sim);
    T.board(p, tr, 0, 0);
    const route0 = tr.route;
    const ev: SimEvent[] = [];
    // ride it out past its last stop
    for (let i = 0; i < 60 * 400 && tr.route === route0; i++) stepCollect(sim, 1, 0, ev);
    expect(tr.route).toBe(T.data.routes[route0].reverse);
    expect(p.ride?.trainId).toBe(tr.id);
    expect(ev.filter((e) => e.type === 'transit:skip').length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('charges a walker at the gates and calls jumping one fare evasion', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    const fp = stationIndex(sim, 'Five Points');
    const st = T.data.stations[fp];
    const [gx, gz, nx, nz] = st.gates[1];
    const y = st.concourse!.c[1];
    const p = playerOf(sim);
    const ev: SimEvent[] = [];
    // walk through a gate gap
    p.controller.teleport(gx - nx * 2.5, y + 0.05, gz - nz * 2.5);
    stepCollect(sim, 30, 0, ev);
    const yaw = Math.atan2(-nx, -nz);
    for (let i = 0; i < 60 * 3; i++) {
      sim.pushInput(1, cmd({ axes: { MoveY: 0.5, Yaw: yaw } }));
      sim.step();
      ev.push(...sim.drainEvents());
    }
    expect(ev.some((e) => e.type === 'transit:fare')).toBe(true);
    expect(ev.some((e) => e.type === 'transit:evade')).toBe(false);
    // back out, then jump through
    p.controller.teleport(gx - nx * 2.5, y + 0.05, gz - nz * 2.5);
    stepCollect(sim, 30, 0, ev);
    ev.length = 0;
    for (let i = 0; i < 60 * 3; i++) {
      const dx = gx - p.controller.x, dz = gz - p.controller.z;
      const close = (dx * nx + dz * nz) < 1.1;
      sim.pushInput(1, cmd({ buttons: close ? Button.Jump : 0, axes: { MoveY: 1, Yaw: yaw } }));
      sim.step();
      ev.push(...sim.drainEvents());
    }
    expect(ev.some((e) => e.type === 'transit:evade')).toBe(true);
    const crime = ev.find((e) => e.type === 'crime') as Extract<SimEvent, { type: 'crime' }> | undefined;
    expect(crime?.crime).toBe('fare_evasion');
    // the station's transit police officer stands at the gates and sees it: reported at once
    expect(ev.some((e) => e.type === 'crime:reported' && e.police)).toBe(true);
    expect(sim.law.heat.level).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('puts the stations under the transit police', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    for (const st of T.data.stations) {
      const p = st.platforms[0];
      expect(agencyAt(sim.law.data, [], p.c[0], p.c[1])?.id, st.name).toBe(T.data.agency);
    }
    // and a street well away from them is the city's
    const fp = T.data.stations[stationIndex(sim, 'Five Points')];
    expect(agencyAt(sim.law.data, [], fp.x + 400, fp.z + 400)?.id).not.toBe(T.data.agency);
  }, 120_000);

  it('hits whoever stands on its track', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    // a train running fast, and a pedestrian put 80 m in front of it
    let tr = null as ReturnType<typeof waitOpenAt> | null;
    for (let i = 0; i < 60 * 300 && !tr; i++) {
      tr = T.model.trains.find((t) => t.phase === 'run' && t.v > 12 && T.underground(...(() => { const q = T.model.pointAt(t.route, t.s + 80); return [q.x, q.y + 0.2, q.z] as [number, number, number]; })())) ?? null;
      if (!tr) stepCollect(sim, 1);
    }
    expect(tr).not.toBeNull();
    const q = T.model.pointAt(tr!.route, tr!.s + 80);
    const ped = sim.addPed(q.x, q.y + 0.05, q.z, 0, 3, true);
    ped.controller.queryGroups = 0;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 60 * 8; i++) {
      stepCollect(sim, 1, 0, ev);
    }
    expect(ev.some((e) => e.type === 'transit:hit' && e.pedId === ped.id)).toBe(true);
    expect(ped.life).not.toBe('alive');
  }, 120_000);

  it('runs the same trains for the same ticks', async () => {
    const snap = async () => {
      const sim = await transitSim();
      stepCollect(sim, 60 * 60);
      return JSON.stringify(sim.transit!.model.trains.map((t) => [t.route, t.s.toFixed(5), t.v.toFixed(5), t.phase]));
    };
    expect(await snap()).toBe(await snap());
  }, 120_000);
});
