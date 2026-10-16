/**
 * A route the GPS has found: a polyline in the city frame, how far along it each turn is, and the lookups the radar, the map and the
 * turn prompt make on it every frame. Pure: no DOM, no three.js.
 */
import { abbreviateStreet } from '../ui/streetNameMath';

export type RouteMode = 'drive' | 'walk';
export type TurnKind = 'left' | 'right' | 'uturn' | 'turnaround' | 'straight' | 'ramp' | 'arrive';

export interface RouteStep {
  /** Metres along the route where the manoeuvre starts. */
  s: number;
  kind: TurnKind;
  /** The street you turn onto ('' when it has no name). */
  street: string;
}

export interface Located {
  /** Metres along the solid part of the route (the progress). */
  s: number;
  /** Plan distance from the query point to the route. */
  off: number;
  /** The segment found (first point index). */
  seg: number;
}

export class RouteBuilder {
  xs: number[] = [];
  ys: number[] = [];
  zs: number[] = [];

  add(x: number, y: number, z: number) {
    const n = this.xs.length;
    if (n > 0 && Math.hypot(x - this.xs[n - 1], z - this.zs[n - 1]) < 0.05) return;
    this.xs.push(x);
    this.ys.push(y);
    this.zs.push(z);
  }

  /** Adds points `first .. first + count - 1` of a packed xyz array, from `s0` to `s1` metres along them (the ends are interpolated). */
  addAlong(pts: ArrayLike<number>, first: number, count: number, s0: number, s1: number) {
    let acc = 0;
    let started = false;
    for (let i = 0; i < count; i++) {
      const o = (first + i) * 3;
      const x = pts[o], y = pts[o + 1], z = pts[o + 2];
      if (i > 0) {
        const px = pts[o - 3], py = pts[o - 2], pz = pts[o - 1];
        const l = Math.hypot(x - px, z - pz);
        const a = acc;
        const b = acc + l;
        if (!started && s0 <= b) {
          const t = l > 1e-9 ? (s0 - a) / l : 0;
          this.add(px + (x - px) * t, py + (y - py) * t, pz + (z - pz) * t);
          started = true;
        }
        if (started) {
          if (s1 <= b) {
            const t = l > 1e-9 ? Math.max(0, (s1 - a) / l) : 1;
            this.add(px + (x - px) * t, py + (y - py) * t, pz + (z - pz) * t);
            return;
          }
          this.add(x, y, z);
        }
        acc = b;
      } else if (s0 <= 0) {
        this.add(x, y, z);
        started = true;
      }
    }
  }

  get length() {
    return this.xs.length;
  }
}

export class Route {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  /** Distance along the route of each point. */
  readonly cum: Float32Array;
  /** Length of the solid part, m. */
  readonly length: number;
  /** A straight dashed leg from the last point to here: the road gave out (the edge of the loaded map, or no road near the waypoint). */
  readonly tail: { x: number; z: number } | null;
  readonly tailLen: number;
  /** The route ends at the edge of the loaded area, not at the waypoint: it is extended when more of the map loads. */
  readonly partial: boolean;
  steps: RouteStep[];
  /** What it was found over, so it can be told apart from a later one. */
  readonly id: number;
  private static nextId = 1;

  constructor(
    readonly mode: RouteMode,
    b: RouteBuilder,
    opts: { tail?: { x: number; z: number } | null; partial?: boolean; steps?: RouteStep[] } = {},
  ) {
    const n = b.length;
    this.xs = Float32Array.from(b.xs);
    this.ys = Float32Array.from(b.ys);
    this.zs = Float32Array.from(b.zs);
    this.cum = new Float32Array(n);
    for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.zs[i] - this.zs[i - 1]);
    this.length = n > 0 ? this.cum[n - 1] : 0;
    this.tail = opts.tail ?? null;
    this.tailLen = this.tail && n > 0 ? Math.hypot(this.tail.x - this.xs[n - 1], this.tail.z - this.zs[n - 1]) : 0;
    this.partial = !!opts.partial;
    this.steps = opts.steps ?? [];
    this.id = Route.nextId++;
  }

  get count(): number {
    return this.xs.length;
  }

  /** Metres from progress `s` to the end of the route (the straight tail included). */
  remaining(s: number): number {
    return Math.max(0, this.length - s) + this.tailLen;
  }

  /**
   * Where (x, z) is on the route. Searches the segments near `hint` first (the player moves a little each frame) and the whole
   * route when that finds nothing within `wide` m.
   */
  locate(x: number, z: number, hint: number, out: Located, wide = 60): Located {
    const n = this.count;
    out.s = 0;
    out.off = Infinity;
    out.seg = 0;
    if (n === 0) return out;
    if (n === 1) {
      out.off = Math.hypot(x - this.xs[0], z - this.zs[0]);
      return out;
    }
    const lo = Math.max(0, hint - 6);
    const hi = Math.min(n - 1, hint + 80);
    this.scan(x, z, lo, hi, out);
    if (out.off > wide && (lo > 0 || hi < n - 1)) this.scan(x, z, 0, n - 1, out);
    return out;
  }

  private scan(x: number, z: number, lo: number, hi: number, out: Located) {
    let best = out.off * out.off;
    const { xs, zs, cum } = this;
    for (let i = lo; i < hi; i++) {
      const ax = xs[i], az = zs[i];
      const dx = xs[i + 1] - ax, dz = zs[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        out.s = cum[i] + (cum[i + 1] - cum[i]) * t;
        out.seg = i;
      }
    }
    out.off = Math.sqrt(best);
  }

  /** The index of the first point at or past `s` (binary search). */
  indexAt(s: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] < s) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** The next manoeuvre ahead of progress `s` (one that starts less than `behind` m back still counts), or null. */
  nextStep(s: number, behind = 6): RouteStep | null {
    for (const st of this.steps) if (st.s >= s - behind) return st;
    return null;
  }

  /** The point `s` metres along the solid part, written to `out` as x, z. */
  pointAt(s: number, out: { x: number; z: number }): { x: number; z: number } {
    const n = this.count;
    if (n === 0) return out;
    if (s <= 0) {
      out.x = this.xs[0];
      out.z = this.zs[0];
      return out;
    }
    if (s >= this.length) {
      out.x = this.xs[n - 1];
      out.z = this.zs[n - 1];
      return out;
    }
    const i = Math.max(1, this.indexAt(s));
    const l = this.cum[i] - this.cum[i - 1];
    const t = l > 1e-9 ? (s - this.cum[i - 1]) / l : 0;
    out.x = this.xs[i - 1] + (this.xs[i] - this.xs[i - 1]) * t;
    out.z = this.zs[i - 1] + (this.zs[i] - this.zs[i - 1]) * t;
    return out;
  }
}

/** Distance as the prompt writes it: metres under a kilometre (to 10 m above 100), else kilometres with a decimal. */
export function formatDistance(m: number): string {
  if (!(m > 0)) return '0 m';
  if (m < 100) return `${Math.max(5, Math.round(m / 5) * 5)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** A turn as the prompt says it: "Turn left onto Peachtree St NE". */
export function describeStep(step: RouteStep): string {
  const street = step.street ? abbreviateStreet(step.street) : '';
  const onto = street ? ` onto ${street}` : '';
  switch (step.kind) {
    case 'left':
      return `Turn left${onto}`;
    case 'right':
      return `Turn right${onto}`;
    case 'uturn':
      return 'Make a U-turn';
    case 'turnaround':
      return 'Make a U-turn when possible';
    case 'ramp':
      return street ? `Take the ramp to ${street}` : 'Take the ramp';
    case 'straight':
      return street ? `Continue onto ${street}` : 'Continue straight';
    case 'arrive':
      return 'Your destination';
  }
}
