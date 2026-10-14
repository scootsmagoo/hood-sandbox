/**
 * A police siren voice: a wail (slow sweep) or a yelp (fast chirp), pitched by the doppler shift
 * of the car it sits on and panned and attenuated by distance.
 *
 * Not used yet. There is no police in the sim, and no snapshot flag marks a police car. When police
 * arrive, the code that spawns them calls `createSiren` once and feeds `update` each frame for the
 * nearest car with its siren on, then `stop` when it is gone.
 */
import { clamp } from '../../shared/math';
import { distanceGain, dopplerFactor } from './mapping';

export interface SirenFeed {
  /** Metres from the listener. */
  distance: number;
  /** m/s, positive when the siren is closing on the listener. */
  radialSpeed: number;
  /** -1 left to +1 right. */
  pan: number;
  mode?: 'wail' | 'yelp';
}

export interface Siren {
  update(feed: SirenFeed): void;
  stop(): void;
}

export function createSiren(ctx: AudioContext, dest: AudioNode): Siren {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 900;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.35;
  const depth = ctx.createGain();
  depth.gain.value = 400;
  lfo.connect(depth).connect(osc.frequency);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2400;
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const pan = ctx.createStereoPanner();
  osc.connect(tone).connect(amp).connect(pan).connect(dest);
  osc.start();
  lfo.start();

  let stopped = false;
  return {
    update({ distance, radialSpeed, pan: p, mode = 'wail' }) {
      if (stopped) return;
      const t = ctx.currentTime;
      const shift = dopplerFactor(radialSpeed);
      const yelp = mode === 'yelp';
      lfo.frequency.setTargetAtTime(yelp ? 7 : 0.35, t, 0.05);
      depth.gain.setTargetAtTime((yelp ? 250 : 400) * shift, t, 0.05);
      osc.frequency.setTargetAtTime(900 * shift, t, 0.1);
      amp.gain.setTargetAtTime(0.12 * distanceGain(distance), t, 0.1);
      pan.pan.setTargetAtTime(clamp(p, -1, 1), t, 0.05);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      amp.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      osc.stop(ctx.currentTime + 0.3);
      lfo.stop(ctx.currentTime + 0.3);
      window.setTimeout(() => {
        osc.disconnect();
        lfo.disconnect();
        depth.disconnect();
        tone.disconnect();
        amp.disconnect();
        pan.disconnect();
      }, 400);
    },
  };
}
