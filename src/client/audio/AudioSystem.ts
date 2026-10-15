/**
 * Procedural audio for the player: the car engine, tyre squeal, crash thuds, door clicks and
 * footsteps. Web Audio only, no sample files.
 *
 * The AudioContext is made on the first user gesture (browsers refuse audio before one). `M` mutes
 * and unmutes, and the choice is kept in localStorage. Sim events arrive through `game.onSimEvent`;
 * unknown event types and missing fields are ignored, so new gameplay events can't break audio.
 */
import type { SimEvent } from '../../shared/protocol';
import { EntityKind } from '../../shared/entities';
import { PedFlag, VehicleFlag, WHEEL_COUNT, WHEEL_FLOATS } from '../../shared/snapshot';
import type { EntityState } from '../net/Interpolator';
import type { Game, System } from '../Game';
import { WEAPONS, type WeaponId } from '../../shared/weapons';
import { distanceGain, enginePitch, gunshotFilterHz, gunshotGain, impactGain, squealLevel, strideLength } from './mapping';
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
    this.updateRotor(v.entities);
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

  /** The nearest police helicopter's rotor: a low thump at blade-pass rate, louder and higher as it comes close. */
  private rotor: Rotor | null = null;

  private updateRotor(entities: Map<number, EntityState>) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const cam = this.game.camera.position;
    let best: EntityState | null = null;
    let bestD = 600;
    for (const st of entities.values()) {
      if (st.kind !== EntityKind.Helicopter) continue;
      const d = Math.hypot(st.x - cam.x, st.z - cam.z, (st.y - cam.y) * 0.5);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (!best) {
      this.rotor?.set(0, 0, ctx.currentTime);
      return;
    }
    this.rotor ??= new Rotor(ctx, this.master, this.noise);
    this.rotor.set(distanceGain(bestD * 0.45) * best.aux0, this.spatial(best).pan, ctx.currentTime);
  }

  /** A siren on the nearest police car with its siren sounding, within earshot. Yelps once the police have eyes on the player. */
  private updateSiren(entities: Map<number, EntityState>) {
    const ctx = this.ctx;
    const cam = this.game.camera.position;
    let best: EntityState | null = null;
    let bestD = 220;
    for (const st of entities.values()) {
      if (st.kind !== 2 || (st.flags & VehicleFlag.Siren) === 0 || (st.flags & VehicleFlag.Burnt) !== 0) continue;
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
        case 'weapon:fire': {
          const id = ev.weapon as WeaponId;
          if (WEAPONS[id]) this.gunshot(id, { x: num(ev.x) ?? 0, z: num(ev.z) ?? 0 }, ev.shooterId === this.game.view.ped?.id);
          break;
        }
        case 'weapon:reload': {
          const id = ev.weapon as WeaponId;
          if (WEAPONS[id]) this.reloadClicks(id, num(ev.durationS) ?? 1.5, this.entity(ev.pedId));
          break;
        }
        case 'weapon:empty':
          this.dryClick(this.entity(ev.pedId));
          break;
        case 'weapon:switch':
          if (ev.pedId === this.game.view.ped?.id) this.dryClick(null, 0.5);
          break;
        case 'traffic:honk': {
          // A driver leans on the horn: where their car is.
          this.horn(this.entity(ev.vehicleId));
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

  /** A short filtered noise hit that cleans up only its own nodes (the shared outputs of a gunshot outlive each part). */
  private noiseHit(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, dest: AudioNode, level: number) {
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
    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      src.disconnect();
      filter.disconnect();
      env.disconnect();
    };
    src.start(at, Math.random() * 1.2, dur + 0.05);
    src.stop(at + dur + 0.05);
  }

  /** Active gunshot voices (a burst of automatic fire would otherwise stack hundreds of nodes). */
  private gunVoices = 0;

  /**
   * A gunshot, built from three parts: a crack (a short, bright noise burst), a body (a falling sine
   * thump) and a tail (low-passed noise that rings out, with a late slap for the long guns). Distance
   * lowers the level and closes a low-pass, so far shots are dull. The player's own gun is a little
   * louder and always full-bandwidth.
   */
  private gunshot(id: WeaponId, at: { x: number; z: number }, own: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const cam = this.game.camera.position;
    const dist = own ? 0 : Math.hypot(at.x - cam.x, at.z - cam.z);
    const level = gunshotGain(dist) * (own ? 1.15 : 1);
    if (level < 0.015) return;
    const def = GUN_SOUND[id];
    const { pan } = this.spatial(own ? null : at);
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = def.level * level;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = gunshotFilterHz(dist);
    const panner = ctx.createStereoPanner();
    panner.pan.value = own ? 0 : pan;
    lp.connect(out).connect(panner).connect(this.master);
    // Crack.
    this.noiseHit(now, def.crackS, 'bandpass', def.crackHz * (0.92 + Math.random() * 0.16), 0.7, lp, 1);
    // Body.
    const body = ctx.createOscillator();
    const bg = ctx.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(def.bodyHz[0], now);
    body.frequency.exponentialRampToValueAtTime(def.bodyHz[1], now + def.bodyS);
    bg.gain.setValueAtTime(0.9, now);
    bg.gain.exponentialRampToValueAtTime(0.001, now + def.bodyS);
    body.connect(bg).connect(lp);
    this.live.add(body);
    body.onended = () => {
      this.live.delete(body);
      body.disconnect();
      bg.disconnect();
    };
    body.start(now);
    body.stop(now + def.bodyS + 0.05);
    // Tail, unless there are already plenty of voices going.
    if (this.live.size < 70) {
      this.noiseHit(now + 0.004, def.tailS, 'lowpass', def.tailHz, 0.6, lp, 0.55);
      if (def.slap) this.noiseHit(now + def.slap, def.tailS * 0.8, 'lowpass', def.tailHz * 0.7, 0.5, lp, 0.22);
    }
    // The shared output nodes go when the last source ends; keep a count so a long burst does not pile up.
    this.gunVoices++;
    window.setTimeout(() => {
      this.gunVoices = Math.max(0, this.gunVoices - 1);
      try {
        lp.disconnect();
        out.disconnect();
        panner.disconnect();
      } catch {
        /* Already gone. */
      }
    }, (def.tailS + (def.slap ?? 0) + 0.3) * 1000);
  }

  /** The sounds of a reload: the magazine out and in for most guns, shells one by one and a pump for the shotgun. */
  private reloadClicks(id: WeaponId, durationS: number, at: { x: number; z: number } | null) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const { gain, pan } = this.spatial(at);
    if (gain < 0.05) return;
    const out = ctx.createGain();
    out.gain.value = 0.55 * gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    const now = ctx.currentTime;
    const tick = (t: number, hz: number, dur: number, lvl: number) => this.noiseHit(now + t, dur, 'bandpass', hz, 2.5, out, lvl);
    if (id === 'shotgun') {
      const n = Math.max(2, Math.floor(durationS / 0.55));
      for (let i = 0; i < n; i++) tick(0.2 + i * 0.5, 1500 + (i % 2) * 250, 0.03, 0.8);
      tick(durationS - 0.3, 700, 0.07, 1);
      tick(durationS - 0.18, 1100, 0.05, 0.9);
    } else {
      tick(durationS * 0.18, 2100, 0.025, 0.9);
      tick(durationS * 0.2, 900, 0.05, 0.6);
      tick(durationS * 0.62, 1500, 0.03, 1);
      tick(durationS * 0.66, 600, 0.06, 0.7);
      tick(durationS * 0.9, 2400, 0.02, 0.8);
    }
    window.setTimeout(() => {
      try {
        out.disconnect();
        panner.disconnect();
      } catch {
        /* Already gone. */
      }
    }, (durationS + 0.4) * 1000);
  }

  /** The empty click of a trigger pulled on no rounds, or a weapon being drawn. */
  private dryClick(at: { x: number; z: number } | null, level = 0.7) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const { gain, pan } = this.spatial(at);
    const out = ctx.createGain();
    out.gain.value = level * gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.master);
    this.noiseHit(ctx.currentTime, 0.02, 'bandpass', 3000, 3, out, 1);
    window.setTimeout(() => {
      try {
        out.disconnect();
        panner.disconnect();
      } catch {
        /* Already gone. */
      }
    }, 200);
  }

  /** A car horn: two square tones a third apart, a short blast. */
  private horn(st: { x: number; z: number } | null) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const { gain, pan } = this.spatial(st);
    if (gain < 0.02) return;
    const out = ctx.createGain();
    const now = ctx.currentTime;
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.16 * gain, now + 0.02);
    out.gain.setValueAtTime(0.16 * gain, now + 0.26);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2200;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    filter.connect(out).connect(panner).connect(this.master);
    for (const f of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(filter);
      this.play(o, now, 0.34, out);
    }
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
    this.rotor?.dispose();
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

/** The voice of each gun: crack (Hz, seconds), body (falling sine, Hz and seconds), tail (seconds, low-pass Hz, late slap delay) and loudness. */
const GUN_SOUND: Record<WeaponId, { crackHz: number; crackS: number; bodyHz: [number, number]; bodyS: number; tailS: number; tailHz: number; slap?: number; level: number }> = {
  pistol: { crackHz: 3200, crackS: 0.022, bodyHz: [190, 62], bodyS: 0.1, tailS: 0.34, tailHz: 1500, level: 0.6 },
  smg: { crackHz: 3700, crackS: 0.015, bodyHz: [210, 85], bodyS: 0.07, tailS: 0.2, tailHz: 1700, level: 0.46 },
  shotgun: { crackHz: 1900, crackS: 0.05, bodyHz: [130, 36], bodyS: 0.2, tailS: 0.7, tailHz: 850, slap: 0.09, level: 0.9 },
  rifle: { crackHz: 2700, crackS: 0.03, bodyHz: [150, 45], bodyS: 0.15, tailS: 0.85, tailHz: 750, slap: 0.12, level: 0.8 },
};

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
/** A helicopter overhead: filtered noise chopped at the blade-pass rate (about 21 Hz) with a low thrum under it. */
class Rotor {
  private readonly src: AudioBufferSourceNode;
  private readonly chop: GainNode;
  private readonly level: GainNode;
  private readonly pan: StereoPannerNode;
  private readonly lfo: OscillatorNode;
  private readonly thrum: OscillatorNode;
  private readonly thrumGain: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer) {
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 260;
    band.Q.value = 0.8;
    this.chop = ctx.createGain();
    this.chop.gain.value = 0.5;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sawtooth';
    this.lfo.frequency.value = 21;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    this.lfo.connect(depth).connect(this.chop.gain);
    this.thrum = ctx.createOscillator();
    this.thrum.type = 'sine';
    this.thrum.frequency.value = 58;
    this.thrumGain = ctx.createGain();
    this.thrumGain.gain.value = 0;
    this.level = ctx.createGain();
    this.level.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.src.connect(band).connect(this.chop).connect(this.level);
    this.thrum.connect(this.thrumGain).connect(this.level);
    this.level.connect(this.pan).connect(dest);
    this.src.start();
    this.lfo.start();
    this.thrum.start();
  }

  set(level: number, pan: number, now: number) {
    this.level.gain.setTargetAtTime(0.5 * level, now, 0.15);
    this.thrumGain.gain.setTargetAtTime(0.35 * level, now, 0.15);
    this.pan.pan.setTargetAtTime(pan, now, 0.1);
  }

  dispose() {
    for (const n of [this.src, this.lfo, this.thrum]) {
      try {
        n.stop();
      } catch {
        /* Not started. */
      }
    }
    this.level.disconnect();
  }
}

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
