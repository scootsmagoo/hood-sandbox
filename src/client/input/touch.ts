/**
 * Minimal touch controls: a floating stick on the left half (walk; steer and throttle in a car),
 * drag-to-look on the right half, and a few buttons. Shown on touch devices, or after the first
 * touch anywhere. Everything goes through `Input`, so the rest of the game cannot tell.
 */
import type { Action } from './bindings';
import type { Input, InputSource } from './Input';

const STICK_RADIUS = 56;
const LOOK_GAIN = { yaw: 0.0055, pitch: 0.0045 };

const BUTTONS: { label: string; actions: Action[]; cls: string }[] = [
  { label: 'Jump', actions: ['jump', 'handbrake'], cls: 'b-jump' },
  { label: 'Run', actions: ['sprint'], cls: 'b-run' },
  { label: 'Get in', actions: ['interact'], cls: 'b-use' },
  { label: 'Reset', actions: ['reset'], cls: 'b-reset' },
  { label: 'Punch', actions: ['melee'], cls: 'b-melee' },
];

export class TouchControls implements InputSource {
  private root: HTMLElement;
  private stickBase: HTMLElement;
  private stickKnob: HTMLElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookDelta = { x: 0, y: 0 };
  private shown = false;
  private useButton: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly input: Input,
  ) {
    const root = (this.root = document.createElement('div'));
    root.className = 'touch';
    root.hidden = true;
    root.innerHTML = '<div class="touch-zone touch-move"></div><div class="touch-zone touch-look"></div>';
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'touch-stick';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'touch-knob';
    this.stickBase.appendChild(this.stickKnob);
    this.stickBase.hidden = true;
    root.appendChild(this.stickBase);

    const pad = document.createElement('div');
    pad.className = 'touch-buttons';
    for (const b of BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `touch-btn ${b.cls}`;
      el.textContent = b.label;
      if (b.cls === 'b-use') this.useButton = el;
      const set = (down: boolean) => {
        for (const a of b.actions) input.holdAction(a, down);
        el.classList.toggle('on', down);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        input.setDevice('touch');
        set(true);
      });
      const up = (e: PointerEvent) => {
        e.preventDefault();
        set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      pad.appendChild(el);
    }
    root.appendChild(pad);
    parent.appendChild(root);

    const move = root.querySelector('.touch-move') as HTMLElement;
    const look = root.querySelector('.touch-look') as HTMLElement;
    move.addEventListener('pointerdown', (e) => this.stickDown(e, move));
    move.addEventListener('pointermove', (e) => this.stickMove(e));
    move.addEventListener('pointerup', (e) => this.stickUp(e));
    move.addEventListener('pointercancel', (e) => this.stickUp(e));
    look.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      e.preventDefault();
      look.setPointerCapture(e.pointerId);
      input.setDevice('touch');
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.lookDelta.x += e.clientX - this.lookLast.x;
      this.lookDelta.y += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const lookUp = (e: PointerEvent) => {
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    look.addEventListener('pointerup', lookUp);
    look.addEventListener('pointercancel', lookUp);

    // Show on touch devices at once, and anywhere else after the first touch.
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (coarse || navigator.maxTouchPoints > 0) this.show(true);
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.show(true); }, { capture: true, passive: true });
  }

  show(on: boolean) {
    this.shown = on;
    this.root.hidden = !on;
    document.body.classList.toggle('has-touch', on);
  }

  get visible() {
    return this.shown;
  }

  /** Lets the HUD relabel the use button. */
  setUseLabel(text: string) {
    if (this.useButton && this.useButton.textContent !== text) this.useButton.textContent = text;
  }

  private stickDown(e: PointerEvent, zone: HTMLElement) {
    if (this.stickId !== null) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    this.input.setDevice('touch');
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.stickBase.hidden = false;
    this.stickBase.style.left = `${e.clientX}px`;
    this.stickBase.style.top = `${e.clientY}px`;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
  }

  private stickMove(e: PointerEvent) {
    if (e.pointerId !== this.stickId) return;
    let dx = (e.clientX - this.stickOrigin.x) / STICK_RADIUS;
    let dy = (e.clientY - this.stickOrigin.y) / STICK_RADIUS;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
    }
    this.stick.x = dx;
    this.stick.y = dy;
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx * STICK_RADIUS}px), calc(-50% + ${dy * STICK_RADIUS}px))`;
  }

  private stickUp(e: PointerEvent) {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.stick.x = this.stick.y = 0;
    this.stickBase.hidden = true;
  }

  poll(input: Input) {
    const dead = 0.12;
    const m = Math.hypot(this.stick.x, this.stick.y);
    const k = m < dead ? 0 : (m - dead) / (1 - dead) / m;
    input.setAnalogMove('touch', this.stick.x * k, this.stick.y * k, true);
    if (this.lookDelta.x || this.lookDelta.y) {
      input.addLook(-this.lookDelta.x * LOOK_GAIN.yaw, -this.lookDelta.y * LOOK_GAIN.pitch);
      this.lookDelta.x = this.lookDelta.y = 0;
    }
  }
}
