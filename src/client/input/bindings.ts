/**
 * Actions and their default bindings. Game code asks about actions, never raw keys. Every action
 * that a mouse could do also has a key, because the owner plays on a trackpad.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'interact'
  | 'handbrake'
  | 'reset'
  | 'melee'
  | 'aim'
  | 'fire'
  | 'reload'
  | 'cover'
  | 'weaponNext'
  | 'weaponPrev'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'weapon4'
  | 'lookLeft'
  | 'lookRight'
  | 'lookUp'
  | 'lookDown'
  | 'lookBack'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleView'
  /** On a train: fade to the next station. */
  | 'skip'
  | 'pause'
  | 'debug'
  | 'help'
  | 'map';

/** Binding codes are `KeyboardEvent.code` values plus `Mouse0..4`, `WheelUp` and `WheelDown`. */
export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  // Space is both the jump and the handbrake; the sim uses whichever applies.
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE', 'KeyF'],
  handbrake: ['Space'],
  reset: ['KeyR'],
  melee: ['KeyQ'],
  // Right mouse aims, left fires (Z and G, or Enter, for a trackpad). R is the car reset (it does nothing on foot, but it is taken), so reload is T.
  aim: ['Mouse2', 'KeyZ'],
  fire: ['Mouse0', 'KeyG', 'Enter'],
  reload: ['KeyT'],
  cover: ['KeyX'],
  // The wheel also cycles weapons while aiming (the camera rig leaves the zoom alone then); the brackets do it any time.
  weaponNext: ['BracketRight'],
  weaponPrev: ['BracketLeft'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  lookLeft: ['ArrowLeft'],
  lookRight: ['ArrowRight'],
  lookUp: ['ArrowUp'],
  lookDown: ['ArrowDown'],
  lookBack: ['KeyC'],
  zoomIn: ['WheelUp', 'Equal'],
  zoomOut: ['WheelDown', 'Minus'],
  toggleView: ['KeyV'],
  // N for the next station (only on a train)
  skip: ['KeyN'],
  pause: ['Escape'],
  debug: ['Backquote', 'IntlBackslash'],
  help: ['KeyH', 'Slash'],
  // The full-screen map: Tab, or P (one key a one-button mouse can reach). Clicking the radar opens it too.
  map: ['Tab', 'KeyP'],
};

/** The code a source holds to press an action directly (`@jump`), whatever its key bindings. */
export const actionCode = (action: Action): string => `@${action}`;

/** Actions the game cannot be played without. A saved binding set may never leave one keyless. */
export const ESSENTIAL_ACTIONS: readonly Action[] = ['forward', 'back', 'left', 'right', 'jump', 'handbrake', 'interact', 'toggleView'];

export interface BindingRepair {
  action: Action;
  codes: string[];
}

/**
 * Repairs a saved binding set (the player's overrides merged over the defaults). Pure.
 * Unknown actions and non-string or empty codes are dropped, duplicates within an action removed.
 * An essential action left without keys gets its default keys back, taken from any non-essential
 * action that holds them.
 */
export function sanitizeBindings(saved?: Partial<Record<string, unknown>> | null): { bindings: Bindings; repaired: BindingRepair[] } {
  const out = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([a, c]) => [a, [...c]])) as Bindings;
  for (const [a, v] of Object.entries(saved ?? {})) {
    if (!(a in DEFAULT_BINDINGS) || !Array.isArray(v)) continue;
    out[a as Action] = [...new Set(v.filter((c): c is string => typeof c === 'string' && c.length > 0))];
  }
  const essential = new Set<Action>(ESSENTIAL_ACTIONS);
  const repaired: BindingRepair[] = [];
  for (const action of ESSENTIAL_ACTIONS) {
    if (out[action].length > 0) continue;
    const codes = [...DEFAULT_BINDINGS[action]];
    for (const code of codes) {
      for (const a of Object.keys(out) as Action[]) {
        if (a !== action && !essential.has(a)) out[a] = out[a].filter((c) => c !== code);
      }
    }
    out[action] = codes;
    repaired.push({ action, codes });
  }
  return { bindings: out, repaired };
}

/** A readable label for a binding code, for prompts. */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Mouse0: 'Left click',
    BracketLeft: '[',
    BracketRight: ']',
    Mouse1: 'Middle click',
    Mouse2: 'Right click',
    WheelUp: 'Scroll up',
    WheelDown: 'Scroll down',
    Space: 'Space',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    Escape: 'Esc',
    Tab: 'Tab',
    Backquote: '`',
    Equal: '=',
    Minus: '-',
    Slash: '?',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
  };
  return map[code] ?? code;
}
