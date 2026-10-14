import { describe, expect, it } from 'vitest';
import { generateProceduralTile } from '../shared/proceduralTile';
import { AXIS_COUNT, Axis, Button, SIM_DT, type InputCommand } from '../shared/protocol';
import { E, H, SnapshotView, SNAPSHOT_BYTES } from '../shared/snapshot';
import { armDirection, armLength, chaseDistance, chaseFov, chaseYaw, followAngle } from './camera/cameraMath';
import { DEFAULT_BINDINGS, ESSENTIAL_ACTIONS, codeLabel, sanitizeBindings } from './input/bindings';
import { PAD, PAD_ACTIONS, padButtonFor, padButtonLabel, padFamily } from './input/gamepad';
import { WheelAccumulator, keyLookEase, mixDriveAxes, rampSteer, shapeStick, triggerHeld, wheelPixels } from './input/pure';
import { blendEntity, SnapshotInterpolator } from './net/Interpolator';
import { ImpairedTransport } from './transport/ImpairedTransport';
import { LoopbackTransport } from './transport/LoopbackTransport';
import { compassPoint } from './ui/Hud';
import { tierBelow, GraphicsGovernor, pickTier } from './graphics';

describe('bindings', () => {
  it('gives every mouse-capable action a key', () => {
    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
      expect(codes.length, action).toBeGreaterThan(0);
      for (const c of codes) expect(c.startsWith('Mouse'), `${action} only on the mouse`).toBe(false);
    }
  });

  it('repairs a saved set that left an essential action keyless', () => {
    const { bindings, repaired } = sanitizeBindings({ forward: [], interact: ['KeyW'], bogus: ['KeyZ'], left: 'KeyA' });
    expect(bindings.forward).toEqual(['KeyW']);
    expect(repaired.map((r) => r.action)).toContain('forward');
    expect(bindings.left).toEqual(['KeyA']);
    for (const a of ESSENTIAL_ACTIONS) expect(bindings[a].length).toBeGreaterThan(0);
    expect('bogus' in bindings).toBe(false);
  });

  it('is clean for healthy input', () => {
    expect(sanitizeBindings({}).repaired).toEqual([]);
    expect(codeLabel('KeyE')).toBe('E');
    expect(codeLabel('ShiftLeft')).toBe('Shift');
  });
});

describe('wheel accumulator', () => {
  it('turns a trackpad flick and its momentum tail into one step', () => {
    const w = new WheelAccumulator();
    let steps = 0;
    let t = 0;
    for (const d of [4, 9, 16, 28, 40, 44, 40, 34, 28, 22, 17, 13, 9, 6, 4, 2, 1]) {
      steps += Math.abs(w.push(-d, (t += 16)));
    }
    expect(steps).toBe(1);
  });

  it('steps once per mouse wheel notch when rolled on', () => {
    const w = new WheelAccumulator();
    expect(w.push(100, 0, true)).toBe(1);
    expect(w.push(100, 120, true)).toBe(0); // inside the quiet gap
    expect(w.push(100, 400, true)).toBe(1);
    expect(w.push(-100, 900, true)).toBe(-1);
  });

  it('reads lines and pages as pixels', () => {
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(400);
    expect(wheelPixels(5, 0)).toBe(5);
  });
});

describe('stick and key shaping', () => {
  it('has a dead zone and keeps direction', () => {
    const o = { x: 0, y: 0 };
    shapeStick(0.1, 0.05, 0.16, 2, o);
    expect(o).toEqual({ x: 0, y: 0 });
    shapeStick(1, 0, 0.16, 1, o);
    expect(o.x).toBeCloseTo(1, 6);
    shapeStick(0.6, 0.6, 0.16, 2, o);
    expect(o.x).toBeCloseTo(o.y, 9);
    expect(Math.hypot(o.x, o.y)).toBeLessThan(0.85);
  });

  it('eases arrow-key look in', () => {
    expect(keyLookEase(0, 0.25)).toBeCloseTo(0.15, 6);
    expect(keyLookEase(0.25, 0.25)).toBe(1);
    expect(keyLookEase(1, 0)).toBe(1);
  });

  it('keeps trigger hysteresis', () => {
    expect(triggerHeld(0.3, false)).toBe(false);
    expect(triggerHeld(0.4, false)).toBe(true);
    expect(triggerHeld(0.25, true)).toBe(true);
    expect(triggerHeld(0.15, true)).toBe(false);
  });

  it('ramps keyboard steering, and swings back through centre faster', () => {
    const dt = 1 / 60;
    let s = 0;
    for (let i = 0; i < 6; i++) s = rampSteer(s, 1, dt);
    expect(s).toBeGreaterThan(0.2);
    expect(s).toBeLessThan(0.5);
    for (let i = 0; i < 60; i++) s = rampSteer(s, 1, dt);
    expect(s).toBe(1);
    const back = rampSteer(1, 0, dt);
    expect(1 - back).toBeGreaterThan(rampSteer(0, 1, dt));
    const cross = rampSteer(0.5, -1, dt);
    expect(0.5 - cross).toBeGreaterThan(1 - back);
  });

  it('mixes keys, triggers and sticks into drive axes', () => {
    const none = { x: 0, z: 0, driveY: false };
    const t0 = { throttle: 0, brake: 0 };
    expect(mixDriveAxes(true, false, 0.3, t0, none)).toEqual({ throttle: 1, brake: 0, steer: 0.3 });
    expect(mixDriveAxes(false, false, 0, { throttle: 0.4, brake: 0 }, none).throttle).toBe(0.4);
    // a pad stick does not drive throttle, a touch stick does
    expect(mixDriveAxes(false, false, 0, t0, { x: 0.5, z: -1, driveY: false }).throttle).toBe(0);
    const touch = mixDriveAxes(false, false, 0, t0, { x: 0.5, z: -0.7, driveY: true });
    expect(touch.throttle).toBeCloseTo(0.7, 9);
    expect(touch.steer).toBe(0.5);
    expect(mixDriveAxes(false, false, 0, t0, { x: 0, z: 0.6, driveY: true }).brake).toBeCloseTo(0.6, 9);
  });
});

describe('gamepad', () => {
  it('recognises controller families and labels buttons', () => {
    expect(padFamily('Xbox Controller (STANDARD GAMEPAD Vendor: 045e)')).toBe('xbox');
    expect(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c)')).toBe('playstation');
    expect(padFamily('8BitDo')).toBe('generic');
    expect(padButtonLabel(PAD.Y, 'xbox')).toBe('Y');
    expect(padButtonLabel(PAD.Y, 'playstation')).toBe('Triangle');
  });

  it('puts the vehicle controls where drivers expect them', () => {
    expect(PAD_ACTIONS[PAD.Y]).toBe('interact');
    expect(PAD_ACTIONS[PAD.B]).toBe('handbrake');
    expect(padButtonFor('interact')).toBe(PAD.Y);
    // the triggers are analog and never hold an action
    expect(PAD_ACTIONS[PAD.RT]).toBeUndefined();
    expect(PAD_ACTIONS[PAD.LT]).toBeUndefined();
  });
});

describe('camera maths', () => {
  it('puts the arm behind the camera', () => {
    const a = armDirection(0, 0, { x: 0, y: 0, z: 0 });
    expect(a.z).toBeCloseTo(1, 9); // yaw 0 looks north, so the camera sits south
    const b = armDirection(Math.PI / 2, -0.5, { x: 0, y: 0, z: 0 });
    expect(b.x).toBeGreaterThan(0.8 * Math.cos(0.5));
    expect(b.y).toBeGreaterThan(0.4); // looking down: camera is above
    expect(Math.hypot(b.x, b.y, b.z)).toBeCloseTo(1, 9);
  });

  it('chases from behind the nose, leaning toward the direction of travel in a slide', () => {
    const noseNorth = Math.PI; // model forward (sin, cos) = (0, -1)
    expect(chaseYaw(noseNorth, 0, 0, 0)).toBeCloseTo(0, 9);
    // moving straight along the nose: unchanged
    expect(chaseYaw(noseNorth, 0, -20, 20)).toBeCloseTo(0, 9);
    // nose north but sliding east: the camera yaws toward travel (east means a negative camera yaw)
    const slide = chaseYaw(noseNorth, 15, -10, 8);
    expect(slide).toBeLessThan(-0.1);
    // reversing: stays behind the nose
    expect(chaseYaw(noseNorth, 0, 8, -8)).toBeCloseTo(0, 9);
  });

  it('pulls back and widens with speed', () => {
    expect(chaseDistance(30, 1)).toBeGreaterThan(chaseDistance(0, 1));
    expect(chaseDistance(0, 2)).toBeGreaterThan(chaseDistance(0, 0));
    expect(chaseFov(50)).toBeGreaterThan(chaseFov(0) + 10);
  });

  it('follows angles the short way', () => {
    const a = followAngle(3, -3, 100, 1);
    expect(a).toBeCloseTo(-3 + 2 * Math.PI, 3);
  });

  it('snaps in at a wall and eases back out', () => {
    expect(armLength(6, 6, 2, 0.016)).toBeCloseTo(1.92, 6);
    const out = armLength(1.92, 6, 99, 0.016);
    expect(out).toBeGreaterThan(1.92);
    expect(out).toBeLessThan(2.2);
    expect(armLength(6, 6, 0, 0.016)).toBe(0.35);
  });
});

describe('graphics tiers', () => {
  it('honours a forced tier, and steps down only on a sustained slow frame rate', () => {
    expect(pickTier(new URLSearchParams('graphics=low'), false).name).toBe('low');
    expect(pickTier(new URLSearchParams(''), true).name).toBe('medium');
    expect(pickTier(new URLSearchParams(''), false, 'ANGLE (Google, SwiftShader)').name).toBe('low');
    expect(tierBelow('high')).toBe('medium');
    expect(tierBelow('low')).toBeNull();
    const g = new GraphicsGovernor();
    let dropped = false;
    for (let i = 0; i < 60 * 15 && !dropped; i++) dropped = g.update(40, 1 / 60);
    expect(dropped).toBe(true);
    const ok = new GraphicsGovernor();
    for (let i = 0; i < 60 * 30; i++) expect(ok.update(14, 1 / 60)).toBe(false);
  });
});

describe('hud helpers', () => {
  it('names compass points with north at -Z', () => {
    expect(compassPoint(0, -10)).toBe('N');
    expect(compassPoint(10, 0)).toBe('E');
    expect(compassPoint(-10, 10)).toBe('SW');
  });
});

// A small hand-made snapshot with one moving entity.
function snap(tick: number, x: number, extra: Partial<{ id: number; kind: number; roll: number; yaw: number }> = {}): SnapshotView {
  const v = new SnapshotView(new ArrayBuffer(SNAPSHOT_BYTES));
  v.u32[H.Tick] = tick;
  v.u32[H.Count] = 1;
  const o = v.at(0);
  v.u32[o + E.Id] = extra.id ?? 7;
  v.u32[o + E.Kind] = extra.kind ?? 2;
  v.f32[o + E.Px] = x;
  v.f32[o + E.Qw] = 1;
  v.f32[o + E.Vx] = 60; // 1 m per tick
  v.f32[o + E.Aux0] = extra.yaw ?? 0;
  v.f32[o + E.Wheels + 1] = extra.roll ?? 0;
  return v;
}

describe('snapshot interpolation', () => {
  const MS = SIM_DT * 1000;

  it('draws between the two snapshots around the delayed render time', () => {
    const it = new SnapshotInterpolator(2);
    for (let t = 1; t <= 10; t++) it.push(snap(t, t), 1000 + t * MS);
    // render time = now - offset - 2 ticks; at the arrival time of tick 10, that is tick 8
    const s = it.sample(1000 + 10 * MS)!;
    expect(s.a.tick).toBe(8);
    expect(s.b.tick).toBe(9);
    expect(s.alpha).toBeCloseTo(0, 6);
    const mid = it.sample(1000 + 10.5 * MS)!;
    expect(mid.a.tick).toBe(8);
    expect(mid.alpha).toBeCloseTo(0.5, 6);
  });

  it('is smooth when snapshots arrive in bursts', () => {
    const it = new SnapshotInterpolator(2);
    // The first snapshots arrive on time (so the clock offset is right), then delivery turns lumpy.
    let t = 0;
    for (; t < 10; t++) it.push(snap(t, t), 500 + t * MS);
    const poses: number[] = [];
    for (let frame = 0; frame < 60; frame++) {
      const now = 500 + (10 + frame) * MS;
      // every third frame delivers three ticks at once
      if (frame % 3 === 0) for (let k = 0; k < 3; k++) it.push(snap(t, t++), now);
      const s = it.sample(now)!;
      const e = { q: { x: 0, y: 0, z: 0, w: 1 }, wheels: new Float32Array(16) } as unknown as Parameters<typeof blendEntity>[2];
      blendEntity(s, 7, e);
      poses.push(e.x);
    }
    for (let i = 1; i < poses.length; i++) expect(poses[i]).toBeGreaterThanOrEqual(poses[i - 1] - 1e-6);
    const steps = poses.slice(1).map((p, i) => p - poses[i]);
    expect(Math.max(...steps)).toBeLessThan(1.3);
  });

  it('ignores old and duplicate snapshots', () => {
    const it = new SnapshotInterpolator();
    it.push(snap(5, 5), 0);
    it.push(snap(5, 99), 1);
    it.push(snap(3, 3), 2);
    expect(it.size).toBe(1);
  });

  it('extrapolates a little past the newest snapshot and then holds', () => {
    const it = new SnapshotInterpolator(0);
    it.push(snap(1, 1), 1000 + MS);
    it.push(snap(2, 2), 1000 + 2 * MS);
    const e = { q: { x: 0, y: 0, z: 0, w: 1 }, wheels: new Float32Array(16) } as unknown as Parameters<typeof blendEntity>[2];
    blendEntity(it.sample(1000 + 3 * MS)!, 7, e);
    expect(e.x).toBeGreaterThan(2.5);
    blendEntity(it.sample(1000 + 60 * MS)!, 7, e);
    expect(e.x).toBeLessThan(2 + 60 * (0.1 + 0.001));
  });

  it('does not smooth a teleport, and takes the short way round a wheel angle', () => {
    const it = new SnapshotInterpolator(0);
    it.push(snap(1, 0), MS);
    it.push(snap(2, 100), 2 * MS);
    const e = { q: { x: 0, y: 0, z: 0, w: 1 }, wheels: new Float32Array(16) } as unknown as Parameters<typeof blendEntity>[2];
    blendEntity({ a: it.sample(1.5 * MS)!.a, b: it.sample(1.5 * MS)!.b, alpha: 0.5 }, 7, e);
    expect(e.x).toBe(100);

    const a = snap(1, 0, { roll: 6.2 });
    const b = snap(2, 1, { roll: 0.1, yaw: 0 });
    blendEntity({ a, b, alpha: 0.5 }, 7, e);
    const roll = e.wheels[1];
    expect(Math.abs(Math.sin(roll)) < 0.1 || Math.abs(Math.cos(roll) - 1) < 0.01).toBe(true);
    expect(Math.abs(roll - 6.2) < 0.3 || Math.abs(roll - (6.2 - 2 * Math.PI)) < 0.3).toBe(true);
  });
});

describe('impaired transport', () => {
  it('delays and drops what crosses it', async () => {
    const loop = new LoopbackTransport({ manual: true });
    let now = 0;
    const imp = new ImpairedTransport(loop, { lagMs: 100, jitterMs: 0, loss: 0 }, () => now, () => 0.5);
    await imp.start({ seed: 1, tileBaseUrl: null, autoRun: false });
    loop.advance(3);
    expect(imp.drainSnapshots().length).toBe(0);
    now = 99;
    expect(imp.drainSnapshots().length).toBe(0);
    now = 101;
    expect(imp.drainSnapshots().length).toBeGreaterThan(0);

    // input is delayed too
    const cmd: InputCommand = { tick: 1, buttons: Button.Jump, axes: new Array(AXIS_COUNT).fill(0) };
    imp.sendInput(cmd);
    loop.advance(1);
    expect(loop.host.simulation!.players.get(1)!.buttons).toBe(0);
    now = 250;
    imp.drainSnapshots(); // flushes the outbound queue
    loop.advance(1);
    expect(loop.host.simulation!.players.get(1)!.buttons).toBe(Button.Jump);

    const lossy = new ImpairedTransport(loop, { lagMs: 0, jitterMs: 0, loss: 1 }, () => now, () => 0.5);
    loop.advance(2);
    expect(lossy.drainSnapshots()).toEqual([]);
  });
});

describe('loopback transport', () => {
  it('runs the whole pipeline: ready, input, snapshots, events', async () => {
    const t = new LoopbackTransport({ manual: true });
    const ready = await t.start({ seed: 1, tileBaseUrl: null, autoRun: false, startAtVehicle: true });
    expect(ready.tileSource).toBe('procedural');
    expect(ready.sharedSnapshots).toBe(false);
    t.advance(30);
    const first = t.drainSnapshots();
    expect(first.length).toBe(31); // one at start, one per tick
    const last = first[first.length - 1];
    expect(last.tick).toBe(30);
    expect(last.controlled).toBe(ready.playerId);

    const axes = new Array(AXIS_COUNT).fill(0);
    axes[Axis.MoveY] = 1;
    // Look east (yaw -PI/2): the car faces east, so walking alongside it stays in reach.
    axes[Axis.Yaw] = -Math.PI / 2;
    t.sendInput({ tick: 1, buttons: 0, axes });
    t.advance(30);
    const a = t.drainSnapshots();
    const x0 = last.f32[last.at(last.indexOf(ready.playerId)) + E.Px];
    const x1 = a[a.length - 1].f32[a[a.length - 1].at(a[a.length - 1].indexOf(ready.playerId)) + E.Px];
    expect(x1).toBeGreaterThan(x0 + 1);

    t.sendInput({ tick: 2, buttons: Button.Interact, axes });
    t.advance(3);
    expect(t.drainEvents().map((e) => e.type)).toContain('vehicle:enter');
    t.dispose();
  });

  it('reports a malformed tile as a fallback, not a crash', async () => {
    const t = new LoopbackTransport({ manual: true });
    const ready = await t.start({ seed: 1, tileBaseUrl: 'http://127.0.0.1:1/nothing/', autoRun: false });
    expect(ready.tileSource).toBe('procedural');
    expect(ready.fallbackReason).toBeTruthy();
    expect(generateProceduralTile(1).manifest.id).toBe(ready.tile.id);
  });
});
