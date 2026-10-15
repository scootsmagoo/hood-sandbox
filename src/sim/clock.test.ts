import { describe, expect, it } from 'vitest';
import { GameClock } from './clock';

describe('GameClock', () => {
  it('starts on a Wednesday afternoon by default', () => {
    const c = new GameClock();
    expect(c.format()).toBe('14:00');
    expect(c.day).toBe(2);
    expect(c.slot).toBe(7);
    expect(c.weekend).toBe(false);
  });

  it('runs at half a game minute per real second, and rolls over midnight into the next day', () => {
    const c = new GameClock({ minutes: 23 * 60 + 59, day: 4 });
    for (let i = 0; i < 4 * 60; i++) c.step(1 / 60); // 4 real seconds = 2 game minutes
    expect(c.format()).toBe('00:01');
    expect(c.day).toBe(5);
    expect(c.weekend).toBe(true);
    expect(c.slot).toBe(0);
  });

  it('freezes at scale 0 and wraps out-of-range starts', () => {
    const c = new GameClock({ minutes: -60, day: 9, scale: 0 });
    c.step(100);
    expect(c.format()).toBe('23:00');
    expect(c.day).toBe(2);
  });
});
