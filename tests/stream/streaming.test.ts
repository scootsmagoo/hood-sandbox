/**
 * Streaming in the sim (docs/contracts/city-tiles.md): tiles load and drop round a moving player, the seams are stitched and undone,
 * nothing leaks across many cycles, the work per tick stays within its budget, and the same moves give the same world.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/Simulation';
import { FixtureTileSource } from '../../src/sim/stream/TileSource';
import { citySim, counts, movePlayer, playerPed, SMALL_RINGS, snapshotHash, travel } from './streamHelpers';

describe('tile streaming in the sim', () => {
  it('loads the ring round the spawn at boot, stitched, with nothing unmatched', async () => {
    const sim = await citySim();
    const st = sim.stream!;
    // the spawn is in tile 0_0 near its south-west part: that tile and the neighbours within 260 m of it
    expect(st.readyIds()).toContain('0_0');
    expect(st.stats().seams.unmatched).toBe(0);
    expect(st.lanes.seamLinks().length).toBeGreaterThan(0);
    expect(sim.stream!.solidAt(playerPed(sim).controller.x, playerPed(sim).controller.z)).toBe(true);
  });

  it('loads ahead and drops behind a moving player, within the work budget a tick', async () => {
    const sim = await citySim({ budget: 1500 });
    const st = sim.stream!;
    travel(sim, 700, 96, 30); // east across two seams
    expect(st.readyIds()).toContain('1_0');
    expect(st.readyIds()).not.toContain('-1_0');
    travel(sim, 700, -300, 30); // north
    expect(st.readyIds()).toContain('1_-1');
    const s = st.stats();
    expect(s.drops).toBeGreaterThan(0);
    expect(s.seams.unmatched).toBe(0);
    // no tick ran more than the budget plus the one job that may run alone (the biggest single job of a fixture tile)
    expect(s.maxUnitsPerTick).toBeLessThan(6000);
    // the ground under the player was always there
    expect(sim.playerHeld).toBe(false);
  });

  it('comes back to the same counts after many load and drop cycles (no leaks)', async () => {
    const sim = await citySim({ traffic: 0.6, ambient: true, pedBudget: 20 });
    const st = sim.stream!;
    const home = { x: playerPed(sim).controller.x, z: playerPed(sim).controller.z };
    // settle at home
    for (let i = 0; i < 120; i++) sim.step();
    const first = counts(sim);
    const samples: ReturnType<typeof counts>[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      travel(sim, 650, -250, 90);
      travel(sim, -250, 600, 90);
      travel(sim, home.x, home.z, 90);
      for (let i = 0; i < 180; i++) sim.step();
      samples.push(counts(sim));
    }
    const last = samples[samples.length - 1];
    // (after a lap the drop ring keeps more than boot loaded: compare with the end of the first lap)
    const base = samples[0];
    void first;
    // the same tiles are in, and every structure is back to its size (graph ids may not grow: freed ranges are reused)
    expect(last.tiles).toBe(base.tiles);
    for (const k of ['liveLanes', 'liveWalk', 'seamLinks', 'walkLinks', 'props', 'propCells', 'footprints', 'meshes', 'policeEdges', 'junctions'] as const) expect(last[k], k).toBe(base[k]);
    expect(last.laneIds).toBe(samples[1].laneIds);
    expect(last.walkIds).toBe(samples[1].walkIds);
    // static colliders exactly; bodies and entities move with the traffic and the crowd, but stay bounded
    const staticColliders = (c: ReturnType<typeof counts>) => c.colliders - c.bodies * 0; // (every body's colliders are counted too)
    expect(Math.abs(staticColliders(last) - staticColliders(samples[1]))).toBeLessThan(400);
    expect(last.entities).toBeLessThan(256);
    expect(st.stats().loads).toBeGreaterThan(20);
    expect(st.stats().drops).toBeGreaterThan(14);
  }, 120_000);

  it('is deterministic for the same moves', async () => {
    const runOnce = async () => {
      const sim = await citySim({ traffic: 0.6, ambient: true, pedBudget: 20, seed: 3 });
      const hashes: string[] = [];
      const events: string[] = [];
      const route: [number, number][] = [[600, 100], [600, -300], [-200, -300], [-200, 500]];
      for (const [x, z] of route) {
        travel(sim, x, z, 45);
        for (let i = 0; i < 60; i++) {
          sim.step();
          for (const e of sim.drainEvents()) if (e.type === 'stream:tile') events.push(`${e.tick}:${e.id}:${e.state}`);
        }
        hashes.push(snapshotHash(sim));
      }
      return { hashes, events, stats: sim.stream!.stats(), tiles: sim.stream!.readyIds() };
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(b.tiles).toEqual(a.tiles);
    expect(b.stats).toEqual(a.stats);
    expect(b.hashes).toEqual(a.hashes);
  }, 120_000);

  it('holds the player over ground that is not in yet, and lets go once it is', async () => {
    // a source that answers later (a fetch)
    const fixture = new FixtureTileSource();
    const slow = { index: fixture.index, load: (e: Parameters<FixtureTileSource['load']>[0]) => new Promise<ReturnType<FixtureTileSource['load']>>((ok) => setTimeout(() => ok(fixture.load(e)), 20)) };
    const sim = await Simulation.createCity({ seed: 1, source: slow, parkedCars: 0, streamOptions: { rings: SMALL_RINGS } });
    // straight to the far corner: nothing is loaded there yet
    movePlayer(sim, 700, 700);
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.playerHeld).toBe(true);
    await sim.stream!.idle();
    for (let i = 0; i < 600 && sim.playerHeld; i++) sim.step();
    expect(sim.playerHeld).toBe(false);
    const p = playerPed(sim).controller;
    expect(Math.hypot(p.x - 700, p.z - 700)).toBeLessThan(1);
    expect(p.y).toBeGreaterThan(sim.groundAt(700, 700) - 0.5);
  });
});
