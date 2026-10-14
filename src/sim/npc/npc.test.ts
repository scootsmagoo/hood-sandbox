import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../../shared/math';
import { Rng } from '../../shared/rng';
import { BRAIN, FIGHT_CHANCE, PedBrain, newBrainOutput, rollPersonality, type BrainSense } from './brain';
import { awayHeading, chooseFleeHeading, type ClearProbe } from './flee';

const open: ClearProbe = (_h, max) => max;

/** A wall along a line: headings that point into it stop at its distance. Wall is the plane z = wallZ, the ped at z = 0, and the wall is ahead along +Z. */
const wallAhead =
  (wallZ: number): ClearProbe =>
  (h, max) => {
    const dz = Math.cos(h);
    if (dz <= 1e-6) return max;
    return Math.min(max, wallZ / dz);
  };

describe('flee heading', () => {
  it('points straight away from the threat over open ground', () => {
    // threat to the north (−Z), the ped at the origin: run south (+Z), heading 0
    const c = chooseFleeHeading(0, 0, 0, -5, null, open);
    expect(Math.abs(wrapAngle(c.heading - 0))).toBeLessThan(0.01);
    expect(c.cornered).toBe(false);
    // threat to the west: run east, heading +PI/2
    expect(Math.abs(wrapAngle(chooseFleeHeading(0, 0, -5, 0, null, open).heading - Math.PI / 2))).toBeLessThan(0.01);
    expect(awayHeading(1, 1, 1, 1)).toBe(0);
  });

  it('turns away from a wall that is in the way, along it, rather than into it', () => {
    // the threat is behind (north), the wall dead ahead (south) 2 m away
    const c = chooseFleeHeading(0, 0, 0, -5, null, wallAhead(2));
    expect(c.cornered).toBe(false);
    expect(Math.abs(Math.cos(c.heading))).toBeLessThan(0.5); // roughly sideways
    expect(c.clear).toBeGreaterThan(1.8);
  });

  it('keeps the heading it has when two ways are as good, and calls itself cornered when none is open', () => {
    const first = chooseFleeHeading(0, 0, 0, -5, null, wallAhead(2));
    const again = chooseFleeHeading(0, 0, 0, -5, first.heading, wallAhead(2));
    expect(again.heading).toBeCloseTo(first.heading, 6);
    const boxed = chooseFleeHeading(0, 0, 0, -5, null, () => 0.4);
    expect(boxed.cornered).toBe(true);
  });

  it('is a pure function of its inputs', () => {
    const a = chooseFleeHeading(3, 4, -2, 9, 1, wallAhead(3));
    const b = chooseFleeHeading(3, 4, -2, 9, 1, wallAhead(3));
    expect(a).toEqual(b);
  });
});

describe('personality', () => {
  it('rolls from the seed, repeats for the same stream and fights about three times in ten', () => {
    const rolls = Array.from({ length: 400 }, (_, i) => rollPersonality(new Rng(i + 1).fork('ped:3')));
    const again = rollPersonality(new Rng(5).fork('ped:3'));
    expect(again).toEqual(rolls[4]);
    const fights = rolls.filter((r) => r.reaction === 'fight').length / rolls.length;
    expect(fights).toBeGreaterThan(FIGHT_CHANCE - 0.07);
    expect(fights).toBeLessThan(FIGHT_CHANCE + 0.07);
    for (const r of rolls) expect(r.courage >= 0 && r.courage < 1).toBe(true);
  });

  it('can be forced for a test', () => {
    expect(rollPersonality(new Rng(1), 'fight').reaction).toBe('fight');
    expect(rollPersonality(new Rng(1), 'flee').reaction).toBe('flee');
  });
});

describe('brain', () => {
  const sense = (over: Partial<BrainSense> = {}): BrainSense => ({ dt: 1 / 60, x: 0, z: 0, threatX: 0, threatZ: -4, probe: open, ...over });

  it('sits still while seated or dragged', () => {
    const b = new PedBrain({ courage: 0.5, reaction: 'flee' }, 'seated');
    const out = newBrainOutput();
    for (let i = 0; i < 60; i++) b.update(sense(), out);
    expect(out.speed).toBe('stop');
    expect(b.state).toBe('seated');
  });

  it('runs away at a sprint when released, then at a run, and is gone past the escape distance', () => {
    const b = new PedBrain({ courage: 0.2, reaction: 'flee' }, 'dragged');
    b.release();
    expect(b.state).toBe('flee');
    const out = newBrainOutput();
    b.update(sense(), out);
    expect(out.speed).toBe('sprint');
    expect(out.dirZ).toBeGreaterThan(0.9); // away from the threat to the north
    b.update(sense({ threatZ: -40 }), out);
    expect(out.speed).toBe('run');
    b.update(sense({ threatZ: -(BRAIN.escapeDistance + 1) }), out);
    expect(out.escaped).toBe(true);
  });

  it('stops running after the give-up time instead of fleeing forever', () => {
    const b = new PedBrain({ courage: 0.2, reaction: 'flee' }, 'dragged');
    b.release();
    const out = newBrainOutput();
    for (let t = 0; t < BRAIN.fleeGiveUp + 1; t += 1 / 60) b.update(sense({ threatZ: -20 }), out);
    expect(b.state).toBe('calm');
    b.update(sense(), out);
    expect(out.speed).toBe('stop');
  });

  it('fights back: closes in, winds up, lands a punch, repeats, then loses its nerve and runs', () => {
    const b = new PedBrain({ courage: 0.5, reaction: 'fight' }, 'dragged');
    b.release();
    expect(b.state).toBe('fight');
    const out = newBrainOutput();
    // far: runs at the threat
    b.update(sense({ threatZ: 5 }), out);
    expect(out.speed).toBe('run');
    expect(out.dirZ).toBeGreaterThan(0.9);
    expect(out.faceThreat).toBe(true);
    // in reach: stands, swings, hits
    let hits = 0;
    let swung = false;
    let t = 0;
    for (; b.state === 'fight' && t < 20; t += 1 / 60) {
      b.update(sense({ threatZ: BRAIN.reach * 0.8 }), out);
      expect(out.speed).toBe('stop');
      if (b.swing > 0) swung = true;
      if (out.attack) hits++;
    }
    expect(swung).toBe(true);
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(t).toBeGreaterThan(BRAIN.fightTime[0] - 0.1);
    expect(t).toBeLessThan(BRAIN.fightTime[1] + 0.1);
    expect(b.state).toBe('flee');
  });

  it('a punch misses if the target steps out of reach during the wind-up', () => {
    const b = new PedBrain({ courage: 0.9, reaction: 'fight' }, 'dragged');
    b.release();
    const out = newBrainOutput();
    let hit = false;
    for (let i = 0; i < 90; i++) {
      b.update(sense({ threatZ: b.swing > 0 ? 5 : BRAIN.reach * 0.8 }), out);
      hit ||= out.attack;
    }
    expect(hit).toBe(false);
  });

  it('gives up the chase when the threat drives away', () => {
    const b = new PedBrain({ courage: 0.9, reaction: 'fight' }, 'dragged');
    b.release();
    const out = newBrainOutput();
    b.update(sense({ threatZ: BRAIN.fightLeash + 5 }), out);
    expect(b.state).toBe('flee');
  });

  it('turns to fight when boxed in with nowhere to run', () => {
    const b = new PedBrain({ courage: 0.1, reaction: 'flee' }, 'dragged');
    b.release();
    const out = newBrainOutput();
    for (let t = 0; t < BRAIN.corneredFor + 1 && b.state === 'flee'; t += 1 / 60) b.update(sense({ probe: () => 0.2 }), out);
    expect(b.state).toBe('fight');
  });
});
