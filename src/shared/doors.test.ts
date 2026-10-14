import { describe, expect, it } from 'vitest';
import { CARJACK_TIMES, DOOR_REACH, atDriverDoor, carjackPhase, distanceToDriverDoor, doorGeometry, SEAT_DROP } from './doors';
import { HANDLING } from './handling';

describe('door geometry', () => {
  for (const id of Object.keys(HANDLING)) {
    it(`puts the ${id}'s seat inside its cabin and its door on the driver's (left) side`, () => {
      const h = HANDLING[id];
      const g = doorGeometry(h);
      const hx = h.chassis.halfExtents[0];
      const cab = h.chassis.cabin;
      expect(g.seat.x).toBeGreaterThan(0);
      expect(g.seat.x).toBeLessThan(hx);
      expect(g.seat.y + 0.8).toBeLessThanOrEqual(cab.offset[1] + cab.halfExtents[1] + 0.05); // head under the roof
      expect(Math.abs(g.seat.z - cab.offset[2])).toBeLessThan(cab.halfExtents[2]);
      expect(g.door.x).toBe(hx);
      expect(g.stand.x).toBeGreaterThan(hx);
      expect(g.eject.x).toBeGreaterThan(g.stand.x);
      expect(SEAT_DROP).toBeGreaterThan(0.7);
    });
  }

  it('works the door from its standing spot, not from the passenger side or from afar', () => {
    const h = HANDLING.sedan;
    const g = doorGeometry(h);
    expect(atDriverDoor(h, g.stand.x, 0, g.stand.z)).toBe(true);
    expect(atDriverDoor(h, g.stand.x + DOOR_REACH * 0.9, 0, g.stand.z)).toBe(true);
    expect(atDriverDoor(h, g.stand.x + DOOR_REACH * 1.5, 0, g.stand.z)).toBe(false);
    expect(atDriverDoor(h, -g.stand.x, 0, g.stand.z)).toBe(false);
    expect(atDriverDoor(h, g.stand.x, 3, g.stand.z)).toBe(false);
    expect(distanceToDriverDoor(h, g.stand.x, g.stand.z)).toBe(0);
  });
});

describe('carjack timeline', () => {
  it('opens the door, drags the driver out, lets them go, then seats the new driver and shuts the door', () => {
    const T = CARJACK_TIMES;
    const at = (t: number) => ({ ...carjackPhase(t) });
    expect(at(0)).toMatchObject({ door: 0, pull: 0, climb: 0, released: false, done: false });
    expect(at(T.doorOpen).door).toBeCloseTo(1, 6);
    expect(at(T.pullStart).pull).toBe(0);
    expect(at((T.pullStart + T.pullEnd) / 2).pull).toBeGreaterThan(0.3);
    expect(at((T.pullStart + T.pullEnd) / 2).pull).toBeLessThan(0.7);
    expect(at(T.pullEnd - 0.01).released).toBe(false);
    expect(at(T.pullEnd).released).toBe(true);
    expect(at(T.pullEnd).pull).toBe(1);
    expect(at(T.done - 0.01).done).toBe(false);
    expect(at(T.done).done).toBe(true);
    expect(at(T.done).climb).toBe(1);
    expect(at(T.doorClose).door).toBeCloseTo(0, 6);
    // about a second and a half in all
    expect(T.done).toBeGreaterThan(1);
    expect(T.done).toBeLessThan(2);
  });

  it('only ever moves forward through each part', () => {
    let prev = carjackPhase(0);
    let pull = 0;
    let climb = 0;
    for (let t = 0; t <= 1.6; t += 1 / 60) {
      const p = carjackPhase(t);
      expect(p.pull).toBeGreaterThanOrEqual(pull - 1e-9);
      expect(p.climb).toBeGreaterThanOrEqual(climb - 1e-9);
      pull = p.pull;
      climb = p.climb;
      prev = p;
    }
    expect(prev.done).toBe(true);
  });
});
