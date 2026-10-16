/**
 * The trains' sounds, made on the fly like the rest of the game's audio (no samples): the rumble of a train going by (filtered
 * noise and a low hum that rise with its speed and fall with the distance, louder and boomier under the ground), the clack of the
 * wheels over the rail joints and the hum of the motors when riding, the squeal of the brakes coming into a station, the hiss of
 * the doors, a two-tone horn, the station chime (an original three-note figure, not the real system's) and the announcer, a
 * speech synthesis voice where the browser has one ("Five Points. Doors closing.").
 */
import { H, SnapFlag, TrainFlag } from '../../shared/snapshot';
import type { SimEvent } from '../../shared/protocol';
import type { Game } from '../Game';

/** The nearest trains that get a voice of their own. */
const VOICES = 2;

interface Voice {
  noise: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  hum: OscillatorNode;
  humGain: GainNode;
  gain: GainNode;
  squeal: BiquadFilterNode;
  squealGain: GainNode;
}

export class TransitAudio {
  private readonly voices: Voice[] = [];
  private clackT = 0;
  private disposed = false;
  private readonly hornOn = new Map<number, boolean>();
  private readonly lastDoors = new Map<number, number>();
  /** the sim events this listens to arrive while the audio exists; null when gone */
  private alive = true;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: GainNode,
    private readonly noise: AudioBuffer,
    private readonly game: Game,
  ) {
    for (let i = 0; i < VOICES; i++) this.voices.push(this.voice());
    game.onSimEvent((e) => {
      if (!this.alive) return;
      try {
        this.onEvent(e);
      } catch {
        this.alive = false;
      }
    });
  }

  private voice(): Voice {
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(filter).connect(gain).connect(this.out);
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 60;
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    const humF = ctx.createBiquadFilter();
    humF.type = 'lowpass';
    humF.frequency.value = 420;
    hum.connect(humF).connect(humGain).connect(this.out);
    const squeal = ctx.createBiquadFilter();
    squeal.type = 'bandpass';
    squeal.frequency.value = 3200;
    squeal.Q.value = 24;
    const squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    noise.connect(squeal).connect(squealGain).connect(this.out);
    noise.start();
    hum.start();
    return { noise, filter, hum, humGain, gain, squeal, squealGain };
  }

  /** One frame: the nearest trains' rumble, the ride's clack, the horns. */
  update(now: number, dt: number): void {
    if (this.disposed) return;
    const g = this.game;
    const tv = g.transit;
    const s = g.view.sample?.b;
    const cam = g.camera.position;
    const heads = tv?.trains?.heads ?? [];
    const riding = s ? s.u32[H.Train] : 0;
    const under = s ? (s.u32[H.Flags] & SnapFlag.Underground) !== 0 : false;
    // the nearest trains by their middle (about 70 m behind the head)
    const near = heads
      .map((h) => ({ h, d: h.id === riding ? 0 : Math.hypot(h.x - cam.x, (h.y - cam.y) * 1.5, h.z - cam.z) }))
      .filter((q) => q.d < 260)
      .sort((a, b) => a.d - b.d)
      .slice(0, VOICES);
    this.voices.forEach((v, i) => {
      const q = near[i];
      const speed = q ? Math.abs(q.h.speed) : 0;
      const d = q ? q.d : 999;
      const fall = 1 / (1 + (d / 25) ** 2);
      const ride = q?.h.id === riding;
      const k = Math.min(1, speed / 20);
      const level = q ? (ride ? 0.05 + 0.13 * k : (0.02 + 0.5 * k) * fall * (under ? 1.6 : 1)) : 0;
      v.gain.gain.setTargetAtTime(level, now, 0.15);
      v.filter.frequency.setTargetAtTime(ride ? 180 + 260 * k : 220 + 900 * k, now, 0.2);
      v.hum.frequency.setTargetAtTime(38 + speed * 6.5, now, 0.2);
      v.humGain.gain.setTargetAtTime(q ? (ride ? 0.03 + 0.05 * k : 0.05 * k * fall) : 0, now, 0.2);
      // the brakes squeal over the last stretch into a station, at low speed
      const braking = q && (q.h.flags & TrainFlag.Arriving) !== 0 && speed > 0.5 && speed < 9;
      v.squealGain.gain.setTargetAtTime(braking ? (ride ? 0.025 : 0.06 * fall) * (1 - speed / 9) : 0, now, 0.12);
      v.squeal.frequency.setTargetAtTime(2600 + speed * 120, now, 0.1);
    });
    // riding: the wheels over the rail joints, one pair of clacks every 18 m
    const mine = heads.find((h) => h.id === riding);
    if (mine && Math.abs(mine.speed) > 2) {
      this.clackT -= dt;
      if (this.clackT <= 0) {
        this.clackT = 18 / Math.abs(mine.speed);
        this.clack(now, 0.07);
        this.clack(now + 2.2 / Math.abs(mine.speed), 0.05);
      }
    }
    // horns and the hiss of the doors
    for (const h of heads) {
      const on = (h.flags & TrainFlag.Horn) !== 0;
      const d = Math.hypot(h.x - cam.x, h.z - cam.z);
      if (on && !this.hornOn.get(h.id) && d < 300) this.horn(now, h.id === riding ? 0.08 : 0.25 / (1 + (d / 60) ** 2));
      this.hornOn.set(h.id, on);
      const was = this.lastDoors.get(h.id) ?? 0;
      if (h.doors > 0.05 && was <= 0.05 && d < 120) this.hiss(now, 0.12 / (1 + (d / 20) ** 2));
      this.lastDoors.set(h.id, h.doors);
    }
    if (this.hornOn.size > 64) {
      const ids = new Set(heads.map((h) => h.id));
      for (const id of [...this.hornOn.keys()]) if (!ids.has(id)) this.hornOn.delete(id);
      for (const id of [...this.lastDoors.keys()]) if (!ids.has(id)) this.lastDoors.delete(id);
    }
  }

  private onEvent(e: SimEvent): void {
    const g = this.game;
    const tv = g.transit;
    if (!tv) return;
    const now = this.ctx.currentTime;
    const s = g.view.sample?.b;
    const riding = s ? s.u32[H.Train] : 0;
    const station = s ? (s.u32[H.TransitInfo] & 0xff) - 1 : -1;
    if (e.type === 'transit:doors' && e.state === 'closing') {
      // the chime: heard on the train and on the platform it stands at
      const head = tv.trains?.heads.find((h) => h.id === e.trainId);
      const cam = g.camera.position;
      const d = head ? Math.hypot(head.x - cam.x, head.z - cam.z) : 999;
      if (e.trainId === riding || d < 200) {
        this.chime(now, e.trainId === riding ? 0.12 : 0.1 / (1 + (d / 80) ** 2));
        if (e.trainId === riding || station >= 0) this.say('Doors closing.');
      }
    } else if (e.type === 'transit:arrive' && e.trainId === riding) {
      const st = tv.data.stations[e.station];
      if (st) {
        const transfer = st.lines.length > 2 ? ' Transfer to all lines.' : '';
        this.chime(now, 0.09);
        this.say(`${st.displayName}.${transfer}`);
      }
    } else if (e.type === 'transit:arrive' && e.station === station && !riding) {
      const st = tv.data.stations[e.station];
      const route = tv.data.routes[e.route];
      if (st && route) this.say(`${tv.data.lines[route.line]?.name ?? 'Train'} to ${route.towards}.`);
    }
  }

  /** An original three-note chime: a soft bell figure, rising a fourth and a third. */
  private chime(t: number, level: number): void {
    const notes = [659.25, 880, 1108.73];
    notes.forEach((f, i) => this.bell(t + i * 0.32, f, level, 1.1));
  }

  private bell(t: number, f: number, level: number, dur: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    g.connect(this.out);
    for (const [mul, amp] of [[1, 1], [2.76, 0.32], [5.4, 0.12]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** A two-tone horn. */
  private horn(t: number, level: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.05);
    g.gain.setValueAtTime(level, t + 0.7);
    g.gain.linearRampToValueAtTime(0, t + 0.85);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    g.connect(this.out);
    f.connect(g);
    for (const hz of [311.13, 392]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.9);
    }
  }

  /** The clack of a wheel over a rail joint: a short thump of filtered noise. */
  private clack(t: number, level: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 160;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 1.5, 0.12);
  }

  /** The doors' pneumatic hiss. */
  private hiss(t: number, level: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.6);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, 0, 0.7);
  }

  /** The announcer: the browser's speech synthesis, quiet and a little slow; silent where there is none. */
  private say(text: string): void {
    const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    if (!synth || this.out.gain.value < 0.001) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.92;
      u.pitch = 0.9;
      u.volume = 0.55;
      const voice = synth.getVoices().find((v) => /en[-_]US/i.test(v.lang));
      if (voice) u.voice = voice;
      synth.speak(u);
    } catch {
      /* no voice: the chime alone */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.alive = false;
    for (const v of this.voices) {
      try {
        v.noise.stop();
        v.hum.stop();
      } catch {
        /* stopped */
      }
      v.gain.disconnect();
      v.humGain.disconnect();
      v.squealGain.disconnect();
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }
}
