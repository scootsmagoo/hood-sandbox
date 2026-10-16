/** A transit layer that throws stops the trains and nothing else: the sim goes on, the player is not left under the ground. */
import { describe, expect, it } from 'vitest';
import { cmd } from '../helpers';
import { haveTransitTile, playerOf, transitSim } from './transitHelpers';

describe.skipIf(!haveTransitTile)('transit fails safe', () => {
  it('stops the trains when its update throws, and the sim carries on', async () => {
    const sim = await transitSim();
    const T = sim.transit!;
    const pl = T.data.stations[0].platforms[0];
    playerOf(sim).controller.teleport(pl.c[0], pl.y + 0.1, pl.c[1]);
    for (let i = 0; i < 30; i++) { sim.pushInput(1, cmd()); sim.step(); }
    const warn = console.warn;
    console.warn = () => {};
    (T as unknown as { hits: () => void }).hits = () => { throw new Error('boom'); };
    for (let i = 0; i < 120; i++) { sim.pushInput(1, cmd()); sim.step(); }
    console.warn = warn;
    expect(T.failed).toBe(true);
    // back at the spawn, on the street (not under the ground)
    const c = playerOf(sim).controller;
    expect(T.underground(c.x, c.y, c.z)).toBe(false);
    expect(Math.abs(c.y - sim.groundAt(c.x, c.z))).toBeLessThan(1.5);
  });
});
