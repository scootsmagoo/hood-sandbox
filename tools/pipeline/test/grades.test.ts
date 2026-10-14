import { describe, expect, it } from 'vitest';
import { gradeReport, profileGrades, surfaceProfile, type GradeRoad } from '../src/world/grades';

const road = (id: string, pts: [number, number, number][], bridge = false, derived = false): GradeRoad => ({ id, class: 'tertiary', bridge, derived, points: pts });

describe('grade report', () => {
  it('measures a road on the ground against the heightmap, not against its own points', () => {
    const r = road('osm:way/1', [[0, 0, 0], [100, 0, 0]]);
    // the ground under it has a step of 3 m in 4 m at x = 50: 75% over the 6 m window
    const ground = (x: number) => (x < 50 ? 0 : x > 54 ? 3 : (x - 50) * 0.75);
    const rep = gradeReport([r], ground);
    expect(rep.maxGrade).toBeGreaterThan(0.4);
    expect(rep.steepMetres).toBeGreaterThan(2);
    expect(rep.steepMetres).toBeLessThan(15);
    expect(rep.groundSteepMetres).toBe(rep.steepMetres);
    expect(rep.worst[0].id).toBe('osm:way/1');
    expect(Math.abs(rep.worst[0].x - 52)).toBeLessThan(5);
  });
  it('measures a deck along its own heights and tells mapped bridges from derived ones', () => {
    const mapped = road('osm:way/2', [[0, 0, 0], [100, 10, 0]], true);
    const derived = road('osm:way/3', [[0, 0, 5], [100, 100, 5]], true, true);
    const rep = gradeReport([mapped, derived], () => -100);
    expect(rep.deckMetres).toBeCloseTo(200, 0);
    expect(rep.osmDeckMetres).toBeCloseTo(100, 0);
    expect(rep.osmDeckAbove15Metres).toBe(0);
    expect(rep.maxDeckGrade).toBeGreaterThan(0.9);
    const steep = gradeReport([road('osm:way/4', [[0, 0, 0], [50, 20, 0]], true)], () => 0);
    expect(steep.osmDeckAbove15Metres).toBeGreaterThan(40);
  });
  it('samples every metre and measures over the window', () => {
    const prof = surfaceProfile(road('a', [[0, 0, 0], [10, 0, 0]]), (x) => x * 0.2, 1);
    expect(prof.length).toBe(11);
    const g = profileGrades(prof, 6);
    expect(g.every((v) => Math.abs(v - 0.2) < 1e-9)).toBe(true);
  });
});
