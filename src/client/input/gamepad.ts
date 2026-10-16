/**
 * Gamepads with the "standard" mapping (Xbox, PlayStation and most others; Chrome, Safari and
 * Firefox). Polled at the start of every frame as an `InputSource`.
 *
 * On foot the left stick moves and the right stick turns the camera. In a car the triggers are
 * throttle and brake (analog), the left stick steers, and B is the handbrake. X punches on foot, and LB stands the car back up. Buttons hold actions
 * directly, so rebinding the keyboard never breaks the pad.
 *
 * Guns: on foot LT aims and RT fires; X reloads while LT is held (the sim turns a punch into a reload while aiming); the D-pad
 * left and right change weapon; B takes cover. In a car LT and RT stay brake and throttle, so a drive-by aims with RB and fires with X.
 * D-pad down opens the map (the map reads the pad itself while it is open: sticks pan and zoom, A sets a waypoint, B closes).
 */
import type { Action } from './bindings';
import type { Input, InputSource } from './Input';
import { shapeStick, triggerHeld } from './pure';

/** Standard-mapping button indices (w3c.github.io/gamepad/#remapping). */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

/** The action each button holds. The triggers are analog and handled separately. */
export const PAD_ACTIONS: Readonly<Partial<Record<number, Action>>> = {
  [PAD.A]: 'jump',
  [PAD.B]: 'handbrake',
  [PAD.Y]: 'interact',
  [PAD.X]: 'melee',
  [PAD.LB]: 'reset',
  [PAD.RB]: 'sprint',
  [PAD.L3]: 'sprint',
  [PAD.R3]: 'lookBack',
  [PAD.UP]: 'toggleView',
  [PAD.DOWN]: 'map',
  [PAD.LEFT]: 'weaponPrev',
  [PAD.RIGHT]: 'weaponNext',
  [PAD.VIEW]: 'debug',
  [PAD.MENU]: 'help',
};

/** Buttons that hold a second action besides the one in `PAD_ACTIONS`. */
export const PAD_ALSO: Readonly<Partial<Record<number, Action>>> = {
  [PAD.B]: 'cover',
  // the punch on foot; on a train (no punching there) the skip to the next station
  [PAD.X]: 'skip',
};

export const STICK = { moveDead: 0.16, lookDead: 0.12, lookCurve: 2, steerCurve: 1.4, yawRate: 3.2, pitchRate: 2.0 };

export type PadFamily = 'xbox' | 'playstation' | 'generic';

export function padFamily(id: string): PadFamily {
  if (/045e|xbox|xinput/i.test(id)) return 'xbox';
  if (/054c|dualsense|dualshock|playstation|wireless controller/i.test(id)) return 'playstation';
  return 'generic';
}

const XBOX_LABELS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'];
const PS_LABELS = ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'];

export function padButtonLabel(button: number, family: PadFamily): string {
  return (family === 'playstation' ? PS_LABELS : XBOX_LABELS)[button] ?? `Button ${button}`;
}

/** The button that does an action (undefined when none does). */
export function padButtonFor(action: Action): number | undefined {
  for (const [b, a] of Object.entries(PAD_ACTIONS)) if (a === action) return Number(b);
  for (const [b, a] of Object.entries(PAD_ALSO)) if (a === action) return Number(b);
  return undefined;
}

const tmp = { x: 0, y: 0 };

export class GamepadSource implements InputSource {
  family: PadFamily = 'generic';
  private heldButtons = new Map<number, boolean>();
  private ltHeld = false;
  private rtHeld = false;
  private active = false;

  poll(input: Input, dt: number) {
    const pad = this.pick();
    if (!pad) {
      if (this.active) this.release(input);
      return;
    }
    this.family = padFamily(pad.id);
    const btn = (i: number) => pad.buttons[i];
    const val = (i: number) => btn(i)?.value ?? (btn(i)?.pressed ? 1 : 0);

    let used = false;
    // Buttons that hold an action. Two buttons may hold the same action, so combine by action.
    const wanted = new Map<Action, boolean>();
    for (const [i, action] of Object.entries(PAD_ACTIONS) as [string, Action][]) {
      const down = !!btn(Number(i))?.pressed;
      wanted.set(action, (wanted.get(action) ?? false) || down);
      this.heldButtons.set(Number(i), down);
      if (down) used = true;
    }
    for (const [i, action] of Object.entries(PAD_ALSO) as [string, Action][]) wanted.set(action, !!btn(Number(i))?.pressed);
    for (const [action, down] of wanted) input.holdAction(action, down);

    // Triggers: analog throttle and brake.
    const lt = val(PAD.LT);
    const rt = val(PAD.RT);
    this.ltHeld = triggerHeld(lt, this.ltHeld);
    this.rtHeld = triggerHeld(rt, this.rtHeld);
    input.setTriggers(rt > 0.04 ? rt : 0, lt > 0.04 ? lt : 0);
    if (lt > 0.1 || rt > 0.1) used = true;
    // The gun: LT and RT on foot, RB and X from a car (where the triggers are the pedals).
    const car = input.inVehicle;
    input.holdAction('aim', car ? !!btn(PAD.RB)?.pressed : this.ltHeld);
    input.holdAction('fire', car ? !!btn(PAD.X)?.pressed : this.rtHeld);

    // Left stick: move on foot, steer in a car.
    shapeStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK.moveDead, 1.0, tmp);
    input.setAnalogMove('pad', tmp.x, tmp.y);
    if (tmp.x !== 0 || tmp.y !== 0) used = true;

    // Right stick: camera.
    shapeStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, STICK.lookDead, STICK.lookCurve, tmp);
    if (tmp.x !== 0 || tmp.y !== 0) {
      input.addLook(-tmp.x * STICK.yawRate * dt, -tmp.y * STICK.pitchRate * dt);
      used = true;
    }
    this.active = true;
    if (used) input.setDevice('gamepad');
  }

  private release(input: Input) {
    for (const action of new Set([...Object.values(PAD_ACTIONS), ...Object.values(PAD_ALSO), 'aim', 'fire'] as Action[])) input.holdAction(action, false);
    input.setTriggers(0, 0);
    input.setAnalogMove('pad', 0, 0);
    this.heldButtons.clear();
    this.active = false;
  }

  private pick(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }
}
