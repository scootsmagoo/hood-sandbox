/**
 * Input maths with no browser in it: wheel and pinch handling, stick shaping, keyboard steering
 * ramps. Ported from Skyrome's input module, where the trackpad cases were found the hard way.
 */
import { clamp } from '../../shared/math';

/** Wheel delta in CSS pixels whatever the event's deltaMode (0 px, 1 lines, 2 pages). */
export function wheelPixels(deltaY: number, deltaMode = 0): number {
  return deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
}

/**
 * Turns a stream of wheel deltas into discrete zoom steps.
 *
 * Deltas are summed; a step fires once the sum passes `threshold`, then the stream is locked until
 * the wheel has been quiet for `quietMs`. A trackpad flick (a ramp-up while the fingers move, then
 * a long decaying momentum tail) is one stream, so it fires once. A deliberate, continued scroll
 * re-arms the lock when a delta is as strong as the stream's peak and looks like a new push (a
 * mouse wheel notch, or a rising delta), because momentum only ever decays.
 *
 * `push` returns -1 (scroll up: zoom in), +1 (scroll down: zoom out) or 0.
 */
export class WheelAccumulator {
  threshold = 60;
  quietMs = 250;
  deadzone = 0.5;
  rearmRatio = 0.8;
  notchGapMs = 50;
  private sum = 0;
  private prevMag = 0;
  private last = -Infinity;
  private lockedAt = -Infinity;
  private locked = false;
  private lockSign = 0;
  private peak = 0;

  /** `discrete`: the event came in lines or pages (a mouse wheel notch). */
  push(delta: number, timeMs: number, discrete = false): -1 | 0 | 1 {
    const gap = timeMs - this.last;
    this.last = timeMs;
    if (gap > this.quietMs) {
      this.locked = false;
      this.sum = 0;
      this.peak = 0;
      this.prevMag = 0;
    }
    if (!Number.isFinite(delta) || Math.abs(delta) < this.deadzone) return 0;
    const mag = Math.abs(delta);
    const prevMag = this.prevMag;
    this.prevMag = mag;
    if (this.locked) {
      const same = Math.sign(delta) === this.lockSign;
      const push = discrete || gap >= this.notchGapMs || mag > prevMag * 1.04;
      if (same && push && timeMs - this.lockedAt >= this.quietMs && mag >= this.rearmRatio * this.peak) {
        this.locked = false;
        this.sum = 0;
        this.peak = 0;
      } else {
        if (same) this.peak = Math.max(this.peak, mag);
        return 0;
      }
    }
    if (this.sum !== 0 && Math.sign(delta) !== Math.sign(this.sum)) {
      this.sum = 0;
      this.peak = 0;
    }
    this.sum += delta;
    this.peak = Math.max(this.peak, mag);
    if (Math.abs(this.sum) < this.threshold) return 0;
    const dir = this.sum < 0 ? -1 : 1;
    this.sum = 0;
    this.locked = true;
    this.lockedAt = timeMs;
    this.lockSign = dir;
    return dir;
  }

  reset() {
    this.sum = 0;
    this.peak = 0;
    this.prevMag = 0;
    this.locked = false;
    this.last = -Infinity;
  }
}

/** Arrow-key look ease-in: 0.15 at the first frame, smoothly to 1 after `easeIn` seconds. */
export function keyLookEase(heldS: number, easeIn: number): number {
  if (easeIn <= 0) return 1;
  const t = Math.min(1, Math.max(0, heldS / easeIn));
  return 0.15 + 0.85 * t * t * (3 - 2 * t);
}

/**
 * Stick shaping: a radial dead zone (the stick's rest wobble reads as 0), the rest rescaled to
 * 0..1 and raised to `curve` for fine control near the centre. The direction is kept.
 */
export function shapeStick(x: number, y: number, dead: number, curve: number, out: { x: number; y: number }) {
  const m = Math.hypot(x, y);
  if (!(m > dead)) {
    out.x = out.y = 0;
    return out;
  }
  const t = Math.min(1, (m - dead) / (1 - dead));
  const k = Math.pow(t, curve) / m;
  out.x = x * k;
  out.y = y * k;
  return out;
}

/** Trigger with hysteresis: on above `on`, off below `off`. */
export function triggerHeld(value: number, wasHeld: boolean, on = 0.35, off = 0.2): boolean {
  return wasHeld ? value > off : value > on;
}

/**
 * Smooths a digital steering key into an analog value: it takes time to reach full lock, comes
 * back faster, and swings across centre faster still, so quick corrections do not lag. At speed
 * (m/s, the car being driven) a held key winds on more slowly and stops short of full lock, the
 * way a GTA IV driver feathers the keys on a highway: a tap is a lane change, not a spin.
 */
export function rampSteer(current: number, target: number, dt: number, speed = 0): number {
  const fast = Math.min(1, Math.max(0, (Math.abs(speed) - 6) / 30));
  const ease = fast * fast * (3 - 2 * fast);
  const RISE = 3.2 - 1.6 * ease;
  const FALL = 5.5 - 1.0 * ease;
  const CROSS = 8 - 2 * ease;
  const goal = target * (1 - 0.3 * ease);
  let rate: number;
  if (goal === 0) rate = FALL;
  else if (Math.sign(goal) !== Math.sign(current) && current !== 0) rate = CROSS;
  else if (Math.abs(goal) < Math.abs(current)) rate = FALL;
  else rate = RISE;
  return current + clamp(goal - current, -rate * dt, rate * dt);
}

/** Combines key and analog sources into throttle, brake and steer. Pure. */
export function mixDriveAxes(
  keyThrottle: boolean,
  keyBrake: boolean,
  keySteer: number,
  triggers: { throttle: number; brake: number },
  stick: { x: number; z: number; driveY: boolean },
): { throttle: number; brake: number; steer: number } {
  const stickThrottle = stick.driveY ? Math.max(0, -stick.z) : 0;
  const stickBrake = stick.driveY ? Math.max(0, stick.z) : 0;
  const throttle = Math.max(keyThrottle ? 1 : 0, triggers.throttle, stickThrottle);
  const brake = Math.max(keyBrake ? 1 : 0, triggers.brake, stickBrake);
  const steer = Math.abs(stick.x) > Math.abs(keySteer) ? stick.x : keySteer;
  return { throttle: clamp(throttle, 0, 1), brake: clamp(brake, 0, 1), steer: clamp(steer, -1, 1) };
}
