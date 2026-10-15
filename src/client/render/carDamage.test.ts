import { describe, expect, it } from 'vitest';
import { BUMPER_OFF, BUMPER_ON, BUMPER_SAG, DAMAGE, applyBullet, applyExplosion, applyHealth, applyImpact, isDamaged, newDamage, type DamageShape } from './carDamage';

const shape: DamageShape = {
  halfLength: 2.25,
  halfWidth: 0.93,
  windows: [
    { index: 0, x: 0, y: 0.75, z: 0.65 }, // windscreen
    { index: 1, x: 0, y: 0.75, z: -1.05 }, // rear window
    { index: 2, x: 0.8, y: 0.72, z: 0.3 }, // front left
    { index: 3, x: -0.8, y: 0.72, z: 0.3 }, // front right
  ],
  windscreen: 0,
  rearWindow: 1,
};

describe('car damage visuals', () => {
  it('a knock dents the body where it hit, deeper and wider for harder hits', () => {
    const a = newDamage();
    applyImpact(a, shape, 0.6, 0.1, 2.2, 0, 0, -1, 40);
    const b = newDamage();
    applyImpact(b, shape, 0.6, 0.1, 2.2, 0, 0, -1, 400);
    expect(a.dents[0]).toMatchObject({ x: 0.6, y: 0.1, z: 2.2, dz: -1 });
    expect(b.dents[0].d).toBeGreaterThan(a.dents[0].d * 2);
    expect(b.dents[0].r).toBeGreaterThan(a.dents[0].r);
    expect(b.dents[0].d).toBeLessThanOrEqual(DAMAGE.depthMax);
    // a hit at the nose crumples the whole nose too
    expect(b.dents.length).toBe(2);
    expect(isDamaged(a)).toBe(true);
    expect(isDamaged(newDamage())).toBe(false);
  });

  it('bumpers sag after a couple of knocks at their end, then fall off; the other end is untouched', () => {
    const s = newDamage();
    applyImpact(s, shape, -0.5, 0.1, 2.2, 0, 0, -1, 50);
    expect(s.bumperF).toBe(BUMPER_ON);
    applyImpact(s, shape, -0.5, 0.1, 2.2, 0, 0, -1, 50);
    expect(s.bumperF).toBe(BUMPER_SAG);
    expect(s.sagF).toBe(-1); // hit on the right: the right end hangs
    for (let i = 0; i < 3; i++) applyImpact(s, shape, -0.5, 0.1, 2.2, 0, 0, -1, 50);
    expect(s.bumperF).toBe(BUMPER_OFF);
    expect(s.bumperR).toBe(BUMPER_ON);
    expect(s.hood).toBeGreaterThan(0);
  });

  it('the bonnet springs ajar, then pops, under frontal damage only', () => {
    const s = newDamage();
    for (let i = 0; i < 4; i++) applyImpact(s, shape, 0.9, 0.2, 0, -1, 0, 0, 80); // side hits
    expect(s.hood).toBe(0);
    applyImpact(s, shape, 0, 0.2, 2.2, 0, 0, -1, 130);
    expect(s.hood).toBe(1);
    applyImpact(s, shape, 0, 0.2, 2.2, 0, 0, -1, 140);
    expect(s.hood).toBe(2);
  });

  it('windows break from deep dents near them, hard hits at the ends, bullets and a dying body', () => {
    const s = newDamage();
    applyImpact(s, shape, 0.9, 0.6, 0.3, -1, 0, 0, 300);
    expect(s.windows & (1 << 2)).toBeTruthy();
    expect(s.windows & (1 << 3)).toBeFalsy();
    const f = newDamage();
    applyImpact(f, shape, 0, 0.1, 2.2, 0, 0, -1, DAMAGE.windscreenHit + 1);
    expect(f.windows & 1).toBeTruthy();
    const r = newDamage();
    applyImpact(r, shape, 0, 0.1, -2.2, 0, 0, 1, DAMAGE.windscreenHit + 1);
    expect(r.windows & 2).toBeTruthy();
    const b = newDamage();
    applyBullet(b, shape, -0.82, 0.7, 0.35);
    expect(b.windows).toBe(1 << 3);
    applyBullet(b, shape, 0, 0.1, -2.2); // the boot: no glass there
    expect(b.windows).toBe(1 << 3);
    const h = newDamage();
    applyHealth(h, shape, 0.5);
    expect(h.windows).toBe(0);
    applyHealth(h, shape, 0.2);
    expect(h.windows).toBe(1);
  });

  it('an explosion wrecks everything, the same way every time', () => {
    const a = newDamage();
    const b = newDamage();
    applyExplosion(a, shape, 42);
    applyExplosion(b, shape, 42);
    expect(a).toEqual(b);
    expect(a.burnt).toBe(true);
    expect(a.windows).toBe(0b1111);
    expect(a.bumperF).toBe(BUMPER_OFF);
    expect(a.bumperR).toBe(BUMPER_OFF);
    expect(a.hood).toBe(2);
    // nothing more happens to a burnt shell
    const v = a.version;
    applyImpact(a, shape, 0, 0, 2.2, 0, 0, -1, 500);
    expect(a.version).toBe(v);
  });

  it('keeps a bounded list of dents and counts what it dropped', () => {
    const s = newDamage();
    for (let i = 0; i < DAMAGE.maxDents + 10; i++) applyImpact(s, shape, 0.9, 0.2, 0, -1, 0, 0, 10);
    const scrape = newDamage();
    applyImpact(scrape, shape, 0.9, 0.2, 0, -1, 0, 0, DAMAGE.minHit - 1);
    expect(isDamaged(scrape)).toBe(false);
    expect(s.dents.length).toBe(DAMAGE.maxDents);
    expect(s.dropped).toBe(10);
    // every direction is a unit vector
    for (const d of s.dents) expect(Math.hypot(d.dx, d.dy, d.dz)).toBeCloseTo(1, 6);
  });
});
