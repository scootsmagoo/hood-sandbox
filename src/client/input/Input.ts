/**
 * Keyboard, mouse, trackpad, gamepad and touch input, mapped to named actions.
 *
 * - Game code asks about actions: `input.down('forward')`, `input.pressed('interact')`. Edge
 *   queries (`pressed`/`released`) are valid for one rendered frame.
 * - Every mouse action also has a key. Mouse look uses Pointer Lock (click the canvas); the arrow
 *   keys turn the camera too, with a short ease-in. The click that captures the pointer is
 *   swallowed. Moving the mouse is never required.
 * - The wheel steps the zoom through an accumulator (see pure.ts), so a trackpad's momentum
 *   scrolling fires one step. Pinch zooms the camera and never the page.
 * - Cmd+key (and Ctrl+key) is left to the browser. Releasing Cmd releases every key, since macOS
 *   drops key-up events while Cmd is down.
 * - Keyboard extensions (Vimium and the like) take plain letters unless a form field has focus, so
 *   while playing the focus sits on an invisible, empty <select> (the key sink).
 * - Gamepads and touch controls are sources, polled at the start of every frame. They hold actions
 *   directly (`holdAction`), feed analog movement and triggers, and add look.
 */
import { actionCode, DEFAULT_BINDINGS, type Action, type Bindings } from './bindings';
import { keyLookEase, mixDriveAxes, rampSteer, WheelAccumulator, wheelPixels } from './pure';

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

export interface InputSource {
  poll(input: Input, dt: number): void;
}

const DEG = Math.PI / 180;
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn',
]);
const PINCH_GAIN = 6;

interface AnalogEntry {
  x: number;
  z: number;
  /** The stick's vertical axis drives throttle and brake in a vehicle (touch does; a pad uses its triggers). */
  driveY: boolean;
}

export class Input {
  bindings: Bindings;
  /** Mouse look sensitivity, radians per pixel. */
  sensitivity = 0.0022;
  invertY = false;
  /** When false, gameplay actions read as idle. */
  enabled = true;
  /** Arrow-key look: yaw and pitch rates (rad/s) and ease-in (s). */
  keyLook = { yaw: 150 * DEG, pitch: 90 * DEG, easeIn: 0.25 };
  /** Pointer-look smoothing time constant in seconds (0 = raw). Trackpads like about 0.06. */
  lookSmoothing = 0.06;
  readonly wheel = new WheelAccumulator();
  /** True if pointer, keys or a source turned the camera this frame. */
  lookActive = false;
  device: InputDevice = 'keyboard';
  /** The left button went down with Ctrl held, so it is acting as the right button until it comes up. */
  private ctrlClick = false;
  /** Set by the net system each frame: the player is in a car (the pad's triggers are pedals there, so the gun moves to other buttons). */
  inVehicle = false;

  private held = new Set<string>();
  private pressedCodes = new Set<string>();
  private releasedCodes = new Set<string>();
  private momentary = new Set<string>();
  private codeToActions = new Map<string, Action[]>();
  private lookX = 0;
  private lookY = 0;
  private velX = 0;
  private velY = 0;
  private keyLookHeld = 0;
  private srcYaw = 0;
  private srcPitch = 0;
  private analog = new Map<string, AnalogEntry>();
  private triggers = { throttle: 0, brake: 0 };
  private keySteer = 0;
  private sources: InputSource[] = [];
  private deviceListeners = new Set<(d: InputDevice) => void>();
  private locked = false;
  private gestureScale = 1;
  private lastGestureAt = -Infinity;
  private lastTouchAt = -Infinity;
  private listeners: Array<() => void> = [];
  private sink: HTMLSelectElement | null = null;

  constructor(
    private readonly target: HTMLElement,
    bindings: Partial<Bindings> = {},
  ) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
    this.rebuildIndex();
    this.createSink();
    this.attach();
  }

  // ---------------------------------------------------------------- queries

  down(action: Action): boolean {
    if (!this.enabled && isGameplay(action)) return false;
    if (this.held.has(actionCode(action))) return true;
    for (const c of this.bindings[action] ?? []) if (this.held.has(c)) return true;
    return false;
  }

  pressed(action: Action): boolean {
    if (!this.enabled && isGameplay(action)) return false;
    if (this.pressedCodes.has(actionCode(action))) return true;
    for (const c of this.bindings[action] ?? []) if (this.pressedCodes.has(c)) return true;
    return false;
  }

  released(action: Action): boolean {
    if (this.releasedCodes.has(actionCode(action))) return true;
    for (const c of this.bindings[action] ?? []) if (this.releasedCodes.has(c)) return true;
    return false;
  }

  /** -1..1 movement from WASD, or else from the analog sources (a half-pushed stick walks). */
  moveAxes(): { x: number; z: number } {
    let x = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    let z = (this.down('back') ? 1 : 0) - (this.down('forward') ? 1 : 0);
    if (x === 0 && z === 0 && this.enabled && this.analog.size) {
      for (const a of this.analog.values()) {
        x += a.x;
        z += a.z;
      }
      const l = Math.hypot(x, z);
      if (l > 1) {
        x /= l;
        z /= l;
      }
    }
    return { x, z };
  }

  /** Throttle, brake and steering for a vehicle. Call once per frame: the steering key is smoothed (more gently at `speed`, m/s). */
  driveAxes(dt: number, speed = 0): { throttle: number; brake: number; steer: number } {
    const on = this.enabled;
    const keySteerTarget = on ? (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0) : 0;
    this.keySteer = rampSteer(this.keySteer, keySteerTarget, dt, speed);
    let sx = 0;
    let sz = 0;
    let driveY = false;
    if (on) {
      for (const a of this.analog.values()) {
        sx += a.x;
        sz += a.z;
        driveY ||= a.driveY;
      }
    }
    return mixDriveAxes(on && this.down('forward'), on && this.down('back'), this.keySteer, on ? this.triggers : { throttle: 0, brake: 0 }, { x: sx, z: sz, driveY });
  }

  /** Consumes the camera turning accumulated since the last call (radians; positive yaw turns left). */
  consumeLook(dt: number): { yaw: number; pitch: number } {
    let mx = this.lookX;
    let my = this.lookY;
    this.lookX = this.lookY = 0;
    if (this.lookSmoothing > 0 && dt > 0) {
      // Low-pass the pointer velocity: trackpad jitter becomes smooth turning, and with unity gain
      // the total turn is unchanged (it only lags by about lookSmoothing).
      const k = 1 - Math.exp(-dt / this.lookSmoothing);
      this.velX += (mx / dt - this.velX) * k;
      this.velY += (my / dt - this.velY) * k;
      mx = this.velX * dt;
      my = this.velY * dt;
      if (Math.abs(this.velX) < 0.5) this.velX = 0;
      if (Math.abs(this.velY) < 0.5) this.velY = 0;
    }
    let yaw = -mx * this.sensitivity;
    let pitch = -my * this.sensitivity * (this.invertY ? -1 : 1);
    yaw += this.srcYaw;
    pitch += this.srcPitch;
    this.srcYaw = this.srcPitch = 0;
    if (this.enabled) {
      const l = this.down('lookLeft');
      const r = this.down('lookRight');
      const u = this.down('lookUp');
      const d = this.down('lookDown');
      this.keyLookHeld = l || r || u || d ? this.keyLookHeld + dt : 0;
      const ease = keyLookEase(this.keyLookHeld, this.keyLook.easeIn);
      if (l) yaw += this.keyLook.yaw * ease * dt;
      if (r) yaw -= this.keyLook.yaw * ease * dt;
      if (u) pitch += this.keyLook.pitch * ease * dt;
      if (d) pitch -= this.keyLook.pitch * ease * dt;
    } else {
      yaw = pitch = 0;
      this.velX = this.velY = 0;
      this.keyLookHeld = 0;
    }
    this.lookActive = Math.abs(yaw) > 1e-5 || Math.abs(pitch) > 1e-5;
    return { yaw, pitch };
  }

  get pointerLocked() {
    return this.locked;
  }

  // ---------------------------------------------------------------- sources

  addSource(src: InputSource): () => void {
    this.sources.push(src);
    return () => {
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
    };
  }

  /** Called at the start of every frame, before any system runs. */
  beginFrame(dt: number) {
    for (const s of this.sources) s.poll(this, dt);
  }

  /** Call once at the end of every rendered frame. */
  endFrame() {
    this.focusSink();
    this.pressedCodes.clear();
    this.releasedCodes.clear();
    for (const c of this.momentary) this.held.delete(c);
    this.momentary.clear();
  }

  holdAction(action: Action, isDown: boolean) {
    if (isDown) this.press(actionCode(action));
    else this.release(actionCode(action));
  }

  /** A source's analog movement (-1..1; +x right, +z back). 0, 0 clears it. */
  setAnalogMove(id: string, x: number, z: number, driveY = false) {
    if (x === 0 && z === 0) this.analog.delete(id);
    else {
      const a = this.analog.get(id);
      if (a) {
        a.x = x;
        a.z = z;
        a.driveY = driveY;
      } else this.analog.set(id, { x, z, driveY });
    }
  }

  /** Analog trigger values from a gamepad. */
  setTriggers(throttle: number, brake: number) {
    this.triggers.throttle = throttle;
    this.triggers.brake = brake;
  }

  /** Turns the camera from a source (radians; positive yaw turns left, pitch looks up). */
  addLook(yaw: number, pitch: number) {
    this.srcYaw += yaw;
    this.srcPitch += pitch * (this.invertY ? -1 : 1);
  }

  setDevice(d: InputDevice) {
    if (d === this.device) return;
    this.device = d;
    for (const f of this.deviceListeners) f(d);
  }

  onDeviceChange(fn: (d: InputDevice) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  /** Simulates a raw code going down or up (tests, automation). */
  simulate(code: string, isDown: boolean) {
    if (isDown) this.press(code);
    else this.release(code);
  }

  setBindings(bindings: Partial<Bindings>) {
    this.bindings = { ...this.bindings, ...bindings };
    this.rebuildIndex();
  }

  requestPointerLock() {
    if (document.pointerLockElement === this.target) return;
    try {
      const p = (this.target as HTMLElement & { requestPointerLock(o?: object): Promise<void> | void }).requestPointerLock({ unadjustedMovement: false });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* Safari throws synchronously outside a user gesture */
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose() {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  // ---------------------------------------------------------------- internals

  private rebuildIndex() {
    this.codeToActions.clear();
    for (const [action, codes] of Object.entries(this.bindings) as [Action, string[]][]) {
      for (const c of codes ?? []) {
        const list = this.codeToActions.get(c) ?? [];
        list.push(action);
        this.codeToActions.set(c, list);
      }
    }
  }

  private press(code: string) {
    if (!this.held.has(code)) this.pressedCodes.add(code);
    this.held.add(code);
  }

  private release(code: string) {
    if (this.held.has(code)) this.releasedCodes.add(code);
    this.held.delete(code);
  }

  private pulse(code: string) {
    this.pressedCodes.add(code);
    this.held.add(code);
    this.momentary.add(code);
  }

  private zoomStep(delta: number, timeMs: number, discrete = false) {
    const step = this.wheel.push(delta, timeMs, discrete);
    if (step) this.pulse(step < 0 ? 'WheelUp' : 'WheelDown');
  }

  private isShortcut(e: KeyboardEvent): boolean {
    if (MODIFIER_CODES.has(e.code)) return false;
    if (e.metaKey) return true;
    return e.ctrlKey && !this.codeToActions.has('ControlLeft') && !this.codeToActions.has('ControlRight');
  }

  private focusSink() {
    const sink = this.sink;
    if (!sink || document.hidden || this.device === 'touch') return;
    const a = document.activeElement as HTMLElement | null;
    if (a === sink) return;
    if (a && a !== document.body && a !== document.documentElement && a !== this.target) return;
    try {
      sink.focus({ preventScroll: true });
    } catch {
      /* not focusable right now */
    }
  }

  private createSink() {
    if (!document.body) return;
    const s = document.createElement('select');
    s.dataset.keySink = '1';
    s.tabIndex = -1;
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('aria-label', 'Game keyboard focus');
    s.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;margin:0;';
    // A focused select would open on Space or jump on a typed letter: never.
    s.addEventListener('keydown', (e) => {
      if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    });
    s.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(s);
    this.sink = s;
    this.listeners.push(() => s.remove());
  }

  private attach() {
    const on = <T extends Event>(el: Window | Document | HTMLElement, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.listeners.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.isTrusted && !e.repeat) this.setDevice('keyboard');
      if (isTypingTarget(e.target)) return;
      if (this.isShortcut(e)) return;
      // Keep Space, arrows and the rest from scrolling the page.
      if (this.codeToActions.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.press(e.code);
    });
    on<KeyboardEvent>(window, 'keyup', (e) => {
      this.release(e.code);
      if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta') {
        for (const c of [...this.held]) if (!c.startsWith('Mouse') && !MODIFIER_CODES.has(c)) this.release(c);
      }
    });
    on(window, 'blur', () => {
      for (const c of [...this.held]) this.release(c);
    });

    on<PointerEvent>(window, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') this.lastTouchAt = performance.now();
    }, { capture: true });
    on<MouseEvent>(this.target, 'mousedown', (e) => {
      // A tap also sends a compatibility mousedown: Chrome marks it, Safari does not, so one that
      // follows a touch closely is the tap's.
      const fromTouch = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents || performance.now() - this.lastTouchAt < 1000;
      if (e.isTrusted && !fromTouch) this.setDevice('keyboard');
      if (!this.locked) {
        // This click captures the mouse; it is not an action.
        if (this.enabled && !fromTouch) this.requestPointerLock();
        return;
      }
      // Ctrl-click is the Mac's right click (a Magic Mouse or trackpad without a secondary click), unless Ctrl is bound.
      const right = e.button === 0 && e.ctrlKey && !this.codeToActions.has('ControlLeft') && !this.codeToActions.has('ControlRight');
      this.ctrlClick = right;
      this.press(`Mouse${right ? 2 : e.button}`);
    });
    on<MouseEvent>(window, 'mouseup', (e) => {
      const button = e.button === 0 && this.ctrlClick ? 2 : e.button;
      if (e.button === 0) this.ctrlClick = false;
      this.release(`Mouse${button}`);
    });
    on(this.target, 'contextmenu', (e: Event) => e.preventDefault());
    on<MouseEvent>(window, 'mousemove', (e) => {
      if (!this.locked) return;
      // Chrome sometimes reports absurd spikes right after locking.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.setDevice('keyboard');
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    on<WheelEvent>(
      this.target,
      'wheel',
      (e) => {
        e.preventDefault();
        const t = e.timeStamp || performance.now();
        // Safari reports a pinch as gesture events and may echo it as ctrl+wheel.
        if (e.ctrlKey && t - this.lastGestureAt < 80) return;
        const px = wheelPixels(e.deltaY, e.deltaMode);
        this.zoomStep(e.ctrlKey ? px * PINCH_GAIN : px, t, e.deltaMode !== 0);
      },
      { passive: false },
    );
    // A pinch anywhere must never zoom the page: Chrome sends ctrl+wheel, Safari sends gesture events.
    on<WheelEvent>(window, 'wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    on<Event>(document, 'gesturestart', (e) => {
      e.preventDefault();
      this.gestureScale = 1;
      this.lastGestureAt = e.timeStamp || performance.now();
    });
    on<Event>(document, 'gesturechange', (e) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale ?? 1;
      const t = e.timeStamp || performance.now();
      this.lastGestureAt = t;
      if (e.target !== this.target || !(scale > 0)) return;
      const d = -Math.log(scale / this.gestureScale) * 400;
      this.gestureScale = scale;
      this.zoomStep(d, t);
    });
    on<Event>(document, 'gestureend', (e) => e.preventDefault());
    on<Event>(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
    });
  }
}

const NON_GAMEPLAY: ReadonlySet<Action> = new Set<Action>(['pause', 'debug', 'help']);
const isGameplay = (action: Action) => !NON_GAMEPLAY.has(action);

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.dataset?.keySink === '1') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
