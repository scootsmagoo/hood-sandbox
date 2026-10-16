import { describe, expect, it } from 'vitest';
import { distToRing, landmarkAt, parseLandmarks, RING_MARGIN_M, type LandmarkEntry } from '../src/shared/landmarks';
import { Settled } from '../src/client/ui/streetNameMath';

const sq = (cx: number, cz: number, h: number): [number, number][] => [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];
const e = (id: string, x: number, z: number, extra: Partial<LandmarkEntry> = {}): LandmarkEntry => ({ id, name: id, displayName: id.toUpperCase(), x, z, radius: 40, ...extra });

describe('landmarks.json', () => {
  it('parses the tile file, defaults the display name to the name, and drops entries without a position', () => {
    const d = parseLandmarks({ version: 1, landmarks: [{ id: 'a', name: 'Real', displayName: 'Parody', x: 1, z: 2, radius: 30 }, { id: 'b', name: 'Plain', x: 3, z: 4 }, { id: 'c', name: 'No position' }, null] });
    expect(d!.landmarks.map((l) => [l.id, l.displayName, l.radius])).toEqual([['a', 'Parody', 30], ['b', 'Plain', 45]]);
    expect(parseLandmarks({ version: 2, landmarks: [] })).toBeNull();
    expect(parseLandmarks(null)).toBeNull();
  });

  it('measures the distance to a footprint: zero inside, the gap outside', () => {
    expect(distToRing(0, 0, sq(0, 0, 10))).toBe(0);
    expect(distToRing(13, 0, sq(0, 0, 10))).toBeCloseTo(3);
    expect(distToRing(13, 14, sq(0, 0, 10))).toBeCloseTo(5);
  });

  it('says which landmark a point is at: inside a hero footprint or near it, or within a radius', () => {
    const list = [e('hero', 0, 0, { ring: sq(0, 0, 30) }), e('park', 200, 0, { radius: 100 }), e('kiosk', 500, 0)];
    expect(landmarkAt(list, 0, 0)?.id).toBe('hero');
    expect(landmarkAt(list, 30 + RING_MARGIN_M - 1, 0)?.id).toBe('hero');
    expect(landmarkAt(list, 30 + RING_MARGIN_M + 1, 0)).toBeNull();
    expect(landmarkAt(list, 150, 20)?.id).toBe('park');
    expect(landmarkAt(list, 520, 0)?.id).toBe('kiosk');
    expect(landmarkAt(list, 700, 0)).toBeNull();
  });

  it('prefers the footprint you are inside over a bigger radius around it', () => {
    const list = [e('park', 0, 0, { radius: 120 }), e('hero', 40, 0, { ring: sq(40, 0, 20) })];
    expect(landmarkAt(list, 45, 5)?.id).toBe('hero');
    expect(landmarkAt(list, -60, 0)?.id).toBe('park');
  });
});

describe('the landmark under the street-name label', () => {
  it('settles on a name after it has held, and clears once you have left', () => {
    const s = new Settled<string>(800);
    expect(s.offer('Westin', 0)).toBe(false);
    expect(s.value).toBeNull();
    expect(s.offer('Westin', 900)).toBe(true);
    expect(s.value).toBe('Westin');
    // a flicker outside does not clear it
    expect(s.offer(null, 1000)).toBe(false);
    expect(s.offer('Westin', 1100)).toBe(false);
    expect(s.value).toBe('Westin');
    // leaving for good does
    s.offer(null, 2000);
    expect(s.offer(null, 2900)).toBe(true);
    expect(s.value).toBeNull();
  });
});
