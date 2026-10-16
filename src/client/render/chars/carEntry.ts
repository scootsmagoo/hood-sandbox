/**
 * Getting into and out of a car, as the view draws it. The sim moves the body between the door's
 * standing spot and the seat in one step (shared/doors.ts), so the view walks it across over the
 * `enter_car` / `exit_car` clip (0.9 s and 0.8 s): the door swings open, the body ducks in over the
 * sill, turns from facing the door to facing the road, and sits; getting out is the reverse, the body
 * staying in the seat while it leans out. These are the curves (k is the clip's progress, 0 to 1).
 */

const ease = (k: number, a: number, b: number) => {
  const x = Math.min(1, Math.max(0, (k - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** How far the driver's door stands open (0 shut, 1 wide) while someone gets in (it shuts behind them) or out (it stays until they are clear). */
export function doorOpenAmount(k: number, enter: boolean): number {
  return enter ? Math.min(ease(k, 0, 0.1), 1 - ease(k, 0.8, 0.97)) : Math.min(ease(k, 0, 0.08), 1 - ease(k, 0.65, 0.95));
}

export interface EntryStep {
  /** 0 at the start spot, 1 at the end spot. */
  move: number;
  /** 0 facing as at the start, 1 as at the end. */
  turn: number;
  /** A hop over the sill, metres, added to the height. */
  hop: number;
}

/** Where the body is between its two spots at clip progress `k`. */
export function entryStep(k: number, enter: boolean, out: EntryStep = { move: 0, turn: 0, hop: 0 }): EntryStep {
  out.move = enter ? ease(k, 0.05, 0.8) : ease(k, 0.3, 1.0);
  out.turn = enter ? ease(k, 0.15, 0.7) : ease(k, 0.4, 0.95);
  const h = enter ? k / 0.8 : (k - 0.3) / 0.7;
  out.hop = 0.1 * Math.sin(Math.PI * Math.min(1, Math.max(0, h)));
  return out;
}
