/**
 * Procedural audio for the player: the car engine, tyre squeal, crash thuds, door clicks and
 * footsteps. Web Audio only, no sample files.
 *
 * The AudioContext is made on the first user gesture (browsers refuse audio before one). `M` mutes
 * and unmutes, and the choice is kept in localStorage. Sim events arrive through `game.onSimEvent`;
 * unknown event types and missing fields are ignored, so new gameplay events can't break audio.
 */
import type { SimEvent } from '../../shared/protocol';
import { PedFlag, VehicleFlag, WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import type { EntityState } from '../net/Interpolator';
import type { Game, System } from '../Game';
import { distanceGain, enginePitch, impactGain, squealLevel, strideLength } from './mapping';
import { createSiren, type Siren } from './siren';

const MUTE_KEY = 'KeyM';
const STORAGE_KEY = 'hood-sandbox.audio.muted';
const MASTER_LEVEL = 0.7;

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* Private windows and blocked storage: the mute still works for this visit. */
  }
}

type Num = number | undefined;
const num = (v: unknown): Num => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class AudioSystem implements System {
  readonly name = 'audio';
  readonly priority = 30;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: Engine | null = null;
  private squeal: Squeal | null = null;
  private muted = readMuted();
  private disposed = false;
  private readonly live = new Set<AudioScheduledSourceNode>();
  private lastPed: { x: number; z: number } | null = null;
  private stride = 0;
  private readonly doorOpen = new Map<number, boolean>();
  private siren: Siren | null = null;
  private sirenCar = 0;

  constructor(private readonly game: Game) {
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('touchend', this.unlock);
    game.onSimEvent((e) => this.onSimEvent(e));
  }

  /** Whether sound is on (the M key toggles it). */
  get isMuted() {
    return this.muted;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    writeMuted(muted);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, this.ctx.currentTime, 0.05);
  }

  private readonly unlock = () => {
    if (this.ctx || this.disposed) return;
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : MASTER_LEVEL;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.noise = makeNoise(ctx);
      this.engine = new Engine(ctx, master);
      this.squeal = new Squeal(ctx, master, this.noise);
      void ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
      return;
    }
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('touchend', this.unlock);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    this.unlock();
    if (e.code !== MUTE_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    this.setMuted(!this.muted);
  };

  update(dt: number) {
    void dt;
    if (!this.ctx || this.disposed) return;
    const v = this.game.view;
    const now = this.ctx.currentTime;

    // Engine and squeal belong to the car the player is driving.
    const car = v.inVehicle ? v.vehicle : null;
    if (car) {
      const throttle = Math.abs(car.aux1);
      const { hz } = enginePitch(car.speed, throttle);
      this.engine?.set(hz, throttle, true, now);
      const slips = [];
      for (let i = 0; i < WHEEL_COUNT; i++) slips.push(car.wheels[i * WHEEL_FLOATS + 3]);
      const level = squealLevel(slips, (car.flags & VehicleFlag.Skidding) !== 0, car.speed);
      this.squeal?.set(level, 1800 + Math.abs(car.speed) * 25, now);
    } else {
      this.engine?.set(0, 0, false, now);
      this.squeal?.set(0, 1800, now);
    }

    this.updateFootsteps(v.ped, v.inVehicle);
    this.updateDoors(v.entities);
    this.updateSiren(v.entities);
  }

  private updateFootsteps(ped: EntityState | null, inVehicle: boolean) {
    if (!ped || inVehicle || (ped.flags & (PedFlag.Dragged | PedFlag.Busy)) !== 0) {
      this.lastPed = null;
      this.stride = 0;
      return;
    }
    const prev = this.lastPed;
    this.lastPed = { x: ped.x, z: ped.z };
    if (!prev) return;
    const d = Math.hypot(ped.x - prev.x, ped.z - prev.z);
    // A jump this big is a teleport, not a step.
    if (d > 2 || (ped.flags & PedFlag.Grounded) === 0 || ped.speed < 0.6) return;
    this.stride += d;
    const len = strideLength((ped.flags & PedFlag.Sprinting) !== 0);
    if (this.stride >= len) {
      this.stride -= len;
      this.footstep();
    }
  }

  /** Door clicks come from the vehicle's door bit changing, so every car gets them, not just the player's. */
  private updateDoors(entities: Map<number, EntityState>) {
    for (const [id, st] of entities) {
      if (st.kind !== 2) continue;
      const open = (st.flags & VehicleFlag.DoorOpen) !== 0;
      const was = this.doorOpen.get(id);
      this.doorOpen.set(id, open);
      if (was !== undefined && was !== open) this.doorClick(st);
    }
    for (const id of this.doorOpen.keys()) if (!entities.has(id)) this.doorOpen.delete(id);
  }

  /** A siren on the nearest police car with its lightbar on, within earshot. Yelps once the police have eyes on the player. */
  private updateSiren(entities: Map<number, EntityState>) {
    const ctx = this.ctx;
    const cam = this.game.camera.position;
    let best: EntityState | null = null;
    let bestD = 220;
    for (const st of entities.values()) {
      if (st.kind !== 2 || (st.flags & VehicleFlag.Lightbar) === 0 || (st.flags & VehicleFlag.Burnt) !== 0) continue;
      const d = Math.hypot(st.x - cam.x, st.z - cam.z);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (!ctx || !this.master || !best) {
      this.siren?.stop();
      this.siren = null;
      this.sirenCar = 0;
      return;
    }
    if (!this.siren || this.sirenCar !== best.id) {
      this.siren?.stop();
      this.siren = createSiren(ctx, this.master);
      this.sirenCar = best.id;
    }
    // Closing speed: the car's velocity along the line to the listener.
    const dx = cam.x - best.x;
    const dz = cam.z - best.z;
    const d = Math.hypot(dx, dz) || 1;
    const radial = (best.vx * dx + best.vz * dz) / d;
    this.siren.update({ distance: d, radialSpeed: radial, pan: this.spatial(best).pan, mode: this.game.view.heatPhase === 2 ? 'yelp' : 'wail' });
  }

  private onSimEvent(e: SimEvent) {
    if (!this.ctx || this.disposed) return;
    // Read the type as a plain string: events added later by other agents must fall through quietly.
    const ev = e as unknown as Record<string, unknown>;
    try {
      switch (ev.type) {
        case 'vehicle:impact': {
          const car = this.entity(ev.vehicleId);
          const g = impactGain(num(ev.strength) ?? 0);
          if (g > 0) this.thud(car, 0.3 + 0.7 * g);
          break;
        }
        // `ped:attack` fires with the `damage` it causes, so only `damage` makes a sound.
        case 'damage': {
          // A blow lands: a short, soft thud where the victim is.
          const amount = num(ev.damage) ?? num(ev.amount) ?? 10;
          const victim = this.entity(ev.targetId ?? ev.id);
          this.thud(victim, clamp01(0.15 + amount / 60), 0.6);
          break;
        }
        // Door clicks come from the door flag in `updateDoors`, not from enter, exit or carjack events,
        // which would click twice.
        // 'crime' and 'heat:change' have no sound yet. Add them here when the law and heat systems want one.
        default:
          break;
      }
    } catch {
      /* Audio is never allowed to take the game down. */
    }
  }

  /** Where an entity is, or the player's position when it is unknown. Null when there is no context. */
  private entity(id: unknown): EntityState | null {
    const eid = num(id);
    const v = this.game.view;
    return (eid !== undefined ? v.entities.get(eid) : undefined) ?? v.controlled ?? null;
  }

  /** Left and right, and how loud at the listener, for a point in the world. */
  private spatial(st: { x: number; z: number } | null): { gain: number; pan: number } {
    if (!st) return { gain: 0.5, pan: 0 };
    const cam = this.game.camera;
    const dx = st.x - cam.position.x;
    const dz = st.z - cam.position.z;
    const dist = Math.hypot(dx, dz);
    const e = cam.matrixWorld.elements;
    // Column 0 of the camera's world matrix is its right-hand axis.
    const pan = dist < 0.01 ? 0 : (dx * e[0] + dz * e[2]) / dist;
    return { gain: distanceGain(dist), pan: Math.max(-1, Math.min(1, pan)) };
  }

  private thud(at: { x: number; z: number } | null, level: number, gainScale = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const { gain, pan } = this.spatial(at);
    const out = ctx.createGain();
    out.gain.value = level * gain * gainScale;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    const now = ctx.currentTime;
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(110, now);
    body.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    body.connect(out);
    this.play(body, now, 0.25, out);
    this.burst(now, 0.08, 'lowpass', 500, 0.8, out, 0.6);
  }

  private doorClick(st: EntityState | null) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const { gain, pan } = this.spatial(st);
    const out = ctx.createGain();
    out.gain.value = 0.5 * gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    this.burst(ctx.currentTime, 0.02, 'bandpass', 2600, 2, out, 0.9);
  }

  private footstep() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const out = ctx.createGain();
    out.gain.value = 0.25 * (0.8 + Math.random() * 0.4);
    out.connect(this.master);
    this.burst(ctx.currentTime, 0.03, 'bandpass', 700 + Math.random() * 400, 1.2, out, 1);
  }

  /** A short filtered noise tick, the building block of thuds, clicks and steps. */
  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, dest: AudioNode, level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter).connect(env).connect(dest);
    this.play(src, at, dur, dest);
  }

  /** Starts a one-shot source and stops and disconnects it when it ends. */
  private play(src: AudioScheduledSourceNode, at: number, dur: number, out: AudioNode) {
    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      src.disconnect();
      out.disconnect();
    };
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('touchend', this.unlock);
    window.removeEventListener('keydown', this.onKey);
    for (const src of this.live) {
      try {
        src.stop();
      } catch {
        /* Already stopped. */
      }
    }
    this.live.clear();
    this.siren?.stop();
    this.siren = null;
    this.engine?.dispose();
    this.squeal?.dispose();
    this.engine = null;
    this.squeal = null;
    this.noise = null;
    this.master?.disconnect();
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }
}

/** Two seconds of white noise, shared by every noise source. */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Engine: a sawtooth for the body, a square an octave down for the growl, through a low-pass that opens with throttle. */
class Engine {
  private readonly saw: OscillatorNode;
  private readonly square: OscillatorNode;
  private readonly lp: BiquadFilterNode;
  private readonly out: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = 38;
    this.square = ctx.createOscillator();
    this.square.type = 'square';
    this.square.frequency.value = 19;
    const squareGain = ctx.createGain();
    squareGain.gain.value = 0.35;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 500;
    this.lp.Q.value = 2;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.saw.connect(this.lp);
    this.square.connect(squareGain).connect(this.lp);
    this.lp.connect(this.out).connect(dest);
    this.saw.start();
    this.square.start();
  }

  /** `active` false fades the engine out (on foot). */
  set(hz: number, throttle: number, active: boolean, now: number) {
    const t = now;
    this.saw.frequency.setTargetAtTime(hz, t, 0.04);
    this.square.frequency.setTargetAtTime(hz / 2, t, 0.04);
    this.lp.frequency.setTargetAtTime(350 + 1400 * throttle, t, 0.08);
    this.out.gain.setTargetAtTime(active ? 0.05 + 0.18 * throttle : 0, t, 0.15);
  }

  dispose() {
    try {
      this.saw.stop();
      this.square.stop();
    } catch {
      /* Not started. */
    }
    this.saw.disconnect();
    this.square.disconnect();
    this.lp.disconnect();
    this.out.disconnect();
  }
}

/** Tyre squeal: band-passed noise whose level follows slip. */
class Squeal {
  private readonly src: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer) {
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 1800;
    this.filter.Q.value = 4;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.filter).connect(this.gain).connect(dest);
    this.src.start();
  }

  set(level: number, freq: number, now: number) {
    this.gain.gain.setTargetAtTime(0.22 * level * level, now, 0.06);
    this.filter.frequency.setTargetAtTime(freq, now, 0.1);
  }

  dispose() {
    try {
      this.src.stop();
    } catch {
      /* Not started. */
    }
    this.src.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
