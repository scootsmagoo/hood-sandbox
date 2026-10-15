/**
 * The game clock: minutes since midnight and the day of the week, advanced by the fixed sim step so
 * it stays deterministic. GTA's pace by default: one game minute every two real seconds, a 48-minute day.
 */
export const MINUTES_PER_DAY = 1440;
/** Population cycles use two-hour slots, as the README plans. */
export const SLOT_MINUTES = 120;
export const SLOTS_PER_DAY = MINUTES_PER_DAY / SLOT_MINUTES;

export interface ClockOptions {
  /** Minutes since midnight to start at (default 14:00). */
  minutes?: number;
  /** Day of the week, 0 = Monday … 6 = Sunday (default 2, a Wednesday). */
  day?: number;
  /** Game minutes per real second (default 0.5). 0 freezes the clock. */
  scale?: number;
}

export class GameClock {
  minutes: number;
  day: number;
  scale: number;

  constructor(opts: ClockOptions = {}) {
    this.minutes = (((opts.minutes ?? 14 * 60) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    this.day = (((opts.day ?? 2) % 7) + 7) % 7;
    this.scale = opts.scale ?? 0.5;
  }

  step(dtSeconds: number) {
    this.minutes += dtSeconds * this.scale;
    while (this.minutes >= MINUTES_PER_DAY) {
      this.minutes -= MINUTES_PER_DAY;
      this.day = (this.day + 1) % 7;
    }
  }

  /** The two-hour population slot, 0 (00:00–02:00) to 11 (22:00–24:00). */
  get slot(): number {
    return Math.min(SLOTS_PER_DAY - 1, Math.floor(this.minutes / SLOT_MINUTES));
  }

  get weekend(): boolean {
    return this.day >= 5;
  }

  /** "HH:MM", for logs and the HUD. */
  format(): string {
    const m = Math.floor(this.minutes);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
}
