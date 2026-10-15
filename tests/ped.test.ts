import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../src/shared/proceduralTile';
import { PED } from '../src/sim/character/locomotion';
import { Button, cmd, makeSim, ped, run } from './helpers';

/** Camera yaw 0 looks toward -Z, so MoveY = 1 walks north. */
const walk = (over: Parameters<typeof cmd>[0] = {}) => cmd({ ...over, axes: { MoveY: 1, ...over.axes } });

describe('on foot', () => {
  it('settles on the ground and stands still', async () => {
    const sim = await makeSim();
    run(sim, 60, cmd());
    const c = ped(sim).controller;
    expect(c.grounded).toBe(true);
    expect(Math.abs(c.y)).toBeLessThan(0.05);
  });

  it('jogs at the run speed and sprints faster', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    c.teleport(-200, 0, 0);
    run(sim, 60, walk());
    expect(c.speed).toBeCloseTo(PED.runSpeed, 1);
    run(sim, 60, walk({ buttons: Button.Sprint }));
    expect(c.speed).toBeCloseTo(PED.sprintSpeed, 1);
    // north is -Z: a second each of jogging and sprinting covers about runSpeed + sprintSpeed metres
    expect(c.z).toBeLessThan(-(PED.runSpeed + PED.sprintSpeed) * 0.8);
  });

  it('walks when the stick is half pushed, camera-relative', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    c.teleport(-200, 0, 0);
    run(sim, 60, cmd({ axes: { MoveY: 0.5, Yaw: Math.PI / 2 } }));
    expect(c.speed).toBeCloseTo(PED.walkSpeed, 1);
    // camera yaw PI/2 looks along -X (west)
    expect(c.vel.x).toBeLessThan(-1);
    expect(Math.abs(c.vel.z)).toBeLessThan(0.1);
  });

  it('jumps to about v^2 / 2g and lands', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    run(sim, 30, cmd());
    let apex = 0;
    run(sim, 1, cmd({ buttons: Button.Jump }));
    for (let i = 0; i < 90; i++) {
      run(sim, 1, cmd());
      apex = Math.max(apex, c.y);
    }
    const expected = (PED.jumpSpeed * PED.jumpSpeed) / (2 * PED.gravity);
    expect(apex).toBeGreaterThan(expected * 0.85);
    expect(apex).toBeLessThan(expected * 1.1);
    expect(c.grounded).toBe(true);
    expect(c.y).toBeLessThan(0.05);
  });

  it('is stopped by a wall taller than a step', async () => {
    const tile = generateProceduralTile(1);
    const sim = await makeSim(tile);
    const c = ped(sim).controller;
    // the 1 m wall box at x -14, z 10 (6 wide, 0.6 deep): approach from the south walking north
    c.teleport(-14, 0, 16);
    run(sim, 120, walk());
    expect(c.z).toBeGreaterThan(10.3);
    expect(c.y).toBeLessThan(0.2);
  });

  it('steps up kerbs and stairs without jumping', async () => {
    const sim = await makeSim(generateProceduralTile(1));
    const c = ped(sim).controller;
    // 0.3 m kerb at x -14, z 2 (3 deep): walk north across it from z 6
    c.teleport(-14, 0, 7);
    let top = 0;
    for (let i = 0; i < 180; i++) {
      run(sim, 1, walk({ axes: { MoveY: 0.6 } }));
      top = Math.max(top, c.y);
    }
    expect(top).toBeGreaterThan(0.25);
    expect(top).toBeLessThan(0.4);
    // stairs: three 0.18 m risers, walking west (camera yaw PI/2) from x -17 to the top at x -22
    c.teleport(-17, 0, 0);
    let stairTop = 0;
    for (let i = 0; i < 200; i++) {
      run(sim, 1, cmd({ axes: { MoveY: 0.6, Yaw: Math.PI / 2 } }));
      stairTop = Math.max(stairTop, c.y);
    }
    expect(stairTop).toBeGreaterThan(0.5);
    expect(stairTop).toBeLessThan(0.62);
  });

  it('turns to face the way it moves', async () => {
    const sim = await makeSim();
    const c = ped(sim).controller;
    c.teleport(-200, 0, 0);
    run(sim, 40, cmd({ axes: { MoveX: 1 } }));
    // moving east: forward vector (sin yaw, cos yaw) = (1, 0)
    expect(Math.sin(c.yaw)).toBeGreaterThan(0.95);
  });
});
