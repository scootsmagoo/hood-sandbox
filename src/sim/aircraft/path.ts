/**
 * The geometry and the timing an aircraft moves by: a 3D polyline with its arc length (`Path3`), corners rounded to a turn radius
 * (`fillet`), and a speed profile over a path (`Profile`: limits by curvature and by place, accelerations, stops with a dwell),
 * evaluated as the distance along the path at a time. Pure numbers, no physics: the same plan gives the same pose at the same time.
 */

export type V3 = [number, number, number];

export class Path3 {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** arc length (in plan) at each point */
  readonly s: Float64Array;

  constructor(pts: V3[]) {
    // (consecutive duplicates dropped)
    const keep: V3[] = [];
    for (const p of pts) {
      const l = keep[keep.length - 1];
      if (!l || Math.hypot(p[0] - l[0], p[2] - l[2]) > 0.01) keep.push(p);
    }
    if (keep.length === 1) keep.push([keep[0][0] + 0.02, keep[0][1], keep[0][2]]);
    const n = keep.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = keep[i][0];
      this.y[i] = keep[i][1];
      this.z[i] = keep[i][2];
      if (i) this.s[i] = this.s[i - 1] + Math.hypot(keep[i][0] - keep[i - 1][0], keep[i][2] - keep[i - 1][2]);
    }
  }

  get length(): number {
    return this.s[this.s.length - 1];
  }

  /** The segment index holding arc length `s`. */
  private seg(s: number): number {
    const S = this.s;
    let lo = 0, hi = S.length - 2;
    if (s <= 0) return 0;
    if (s >= S[hi + 1]) return hi;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (S[m] <= s) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** Position at arc length s, and the unit direction in plan there (dx, dz) and the grade (dy / ds). */
  at(s: number, out: { x: number; y: number; z: number; dx: number; dz: number; grade: number }): typeof out {
    const i = this.seg(s);
    const l = this.s[i + 1] - this.s[i] || 1;
    const t = Math.max(0, Math.min(1, (s - this.s[i]) / l));
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    out.dx = (this.x[i + 1] - this.x[i]) / l;
    out.dz = (this.z[i + 1] - this.z[i]) / l;
    out.grade = (this.y[i + 1] - this.y[i]) / l;
    return out;
  }

  /** The heading change per metre at s (1 / turn radius), measured over +-`h` m. */
  curvature(s: number, h = 4): number {
    const a = this.at(Math.max(0, s - h), T1), b = this.at(Math.min(this.length, s + h), T2);
    const da = Math.atan2(a.dx, a.dz), db = Math.atan2(b.dx, b.dz);
    let d = db - da;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const span = Math.min(this.length, s + h) - Math.max(0, s - h);
    return span > 0.1 ? Math.abs(d) / span : 0;
  }
}
const T1 = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };
const T2 = { x: 0, y: 0, z: 0, dx: 0, dz: 0, grade: 0 };

/**
 * Rounds every corner of a polyline to an arc of radius `r` (less where the legs either side are too short), points every `step` m
 * round it. Heights follow the corner's.
 */
export function fillet(pts: V3[], r: number, step = 3): V3[] {
  if (pts.length < 3) return pts.slice();
  const out: V3[] = [pts[0]];
  // the legs' lengths, and how much of each a corner may take (half of it, shared with the corner at its other end)
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i], a = out[out.length - 1], b = pts[i + 1];
    const ux = p[0] - a[0], uz = p[2] - a[2], wx = b[0] - p[0], wz = b[2] - p[2];
    const lu = Math.hypot(ux, uz), lw = Math.hypot(wx, wz);
    if (lu < 1e-6 || lw < 1e-6) continue;
    const cos = Math.max(-1, Math.min(1, (ux * wx + uz * wz) / (lu * lw)));
    const th = Math.acos(cos);
    if (th < (3 * Math.PI) / 180) {
      out.push(p);
      continue;
    }
    // the tangent length r tan(th / 2), at most 0.48 of either leg
    let t = r * Math.tan(th / 2);
    t = Math.min(t, lu * 0.48, lw * 0.48);
    const rr = t / Math.tan(th / 2);
    const p0: V3 = [p[0] - (ux / lu) * t, p[1], p[2] - (uz / lu) * t];
    const p1: V3 = [p[0] + (wx / lw) * t, p[1], p[2] + (wz / lw) * t];
    // the arc's centre: from p0, perpendicular to the incoming leg, on the inside of the turn
    const side = Math.sign(ux * wz - uz * wx) || 1;
    const nx = (-uz / lu) * side, nz = (ux / lu) * side;
    const cx = p0[0] + nx * rr, cz = p0[2] + nz * rr;
    const a0 = Math.atan2(p0[2] - cz, p0[0] - cx), a1 = Math.atan2(p1[2] - cz, p1[0] - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(da) * rr) / step));
    for (let k = 0; k <= n; k++) {
      const ang = a0 + (da * k) / n;
      out.push([cx + Math.cos(ang) * rr, p[1], cz + Math.sin(ang) * rr]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export interface ProfileSpec {
  /** speed at the start and the end, m/s */
  v0: number;
  v1: number;
  /** the highest speed at s (by place: the runway, a taxiway) */
  vmax: (s: number) => number;
  /** acceleration and braking at s, m/s^2 */
  accel: (s: number) => number;
  decel: (s: number) => number;
  /** sideways acceleration allowed in turns, m/s^2 (the turn speed is sqrt(a / curvature)) */
  lateral: number;
  /** a slowest speed through a turn (a jet does not crawl round a fillet) */
  vturnMin?: number;
  /** the sample spacing, m (finer on the ground, coarser in the air) */
  ds: (s: number) => number;
  /** places to stop and wait: arc length and seconds */
  stops?: { s: number; dwell: number }[];
}

/** A speed profile over a path: samples of (s, t, v). */
export class Profile {
  readonly s: Float32Array;
  readonly t: Float32Array;
  readonly v: Float32Array;

  constructor(path: Path3, sp: ProfileSpec) {
    const L = path.length;
    const ss: number[] = [0];
    const stops = [...(sp.stops ?? [])].filter((q) => q.s > 0 && q.s < L).sort((a, b) => a.s - b.s);
    let si = 0;
    for (let s = 0; s < L; ) {
      let next = s + Math.max(0.5, sp.ds(s));
      if (si < stops.length && next >= stops[si].s - 1e-6) {
        next = stops[si].s;
        si++;
      }
      if (next >= L) next = L;
      if (next > s + 1e-6) ss.push(next);
      s = next;
    }
    const n = ss.length;
    const vl = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const c = path.curvature(ss[k]);
      const vturn = c > 1e-5 ? Math.max(sp.vturnMin ?? 0, Math.sqrt(sp.lateral / c)) : Infinity;
      vl[k] = Math.min(sp.vmax(ss[k]), vturn);
    }
    const isStop = new Uint8Array(n);
    const dwell = new Float64Array(n);
    for (const q of stops) {
      // the sample that is the stop
      let best = 0, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const d = Math.abs(ss[k] - q.s);
        if (d < bd) { bd = d; best = k; }
      }
      isStop[best] = 1;
      dwell[best] += q.dwell;
      vl[best] = 0;
    }
    vl[0] = Math.min(vl[0], sp.v0);
    vl[n - 1] = Math.min(vl[n - 1], sp.v1);
    const v = Float64Array.from(vl);
    v[0] = Math.min(sp.v0, vl[0]);
    for (let k = 1; k < n; k++) v[k] = Math.min(vl[k], Math.sqrt(v[k - 1] * v[k - 1] + 2 * sp.accel(ss[k - 1]) * (ss[k] - ss[k - 1])));
    for (let k = n - 2; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] * v[k + 1] + 2 * sp.decel(ss[k]) * (ss[k + 1] - ss[k])));
    // time: the mean speed over each step (a step from rest to rest would take forever: the slowest is a crawl)
    const t = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      const vm = Math.max(0.15, (v[k - 1] + v[k]) / 2);
      t[k] = t[k - 1] + (ss[k] - ss[k - 1]) / vm + (isStop[k - 1] ? dwell[k - 1] : 0);
    }
    if (isStop[n - 1]) t[n - 1] += dwell[n - 1];
    this.s = Float32Array.from(ss);
    this.t = Float32Array.from(t);
    this.v = Float32Array.from(v);
  }

  get duration(): number {
    return this.t[this.t.length - 1];
  }

  get end(): number {
    return this.s[this.s.length - 1];
  }

  /** The sample index at or before time t. */
  private idx(t: number): number {
    const T = this.t;
    if (t <= 0) return 0;
    let lo = 0, hi = T.length - 1;
    if (t >= T[hi]) return hi;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** Distance along the path and speed at time t (seconds from the start). A dwell at a stop holds s and gives 0. */
  sample(t: number, out: { s: number; v: number }): typeof out {
    const k = this.idx(t);
    if (k >= this.t.length - 1) {
      out.s = this.s[this.s.length - 1];
      out.v = this.v[this.v.length - 1];
      return out;
    }
    const s0 = this.s[k], s1 = this.s[k + 1], v0 = this.v[k], v1 = this.v[k + 1];
    const t0 = this.t[k], t1 = this.t[k + 1];
    // the step's own travel time (a stop's dwell is spent at its start)
    const travel = (s1 - s0) / Math.max(0.15, (v0 + v1) / 2);
    const wait = t1 - t0 - travel;
    const into = t - t0;
    if (into <= wait) {
      out.s = s0;
      out.v = 0;
      return out;
    }
    const f = Math.min(1, (into - wait) / Math.max(1e-6, travel));
    // constant acceleration over the step: s = v0 tau + a tau^2 / 2
    const tau = f * travel;
    const a = (v1 - v0) / Math.max(1e-6, travel);
    out.s = Math.min(s1, s0 + v0 * tau + 0.5 * a * tau * tau);
    out.v = v0 + a * tau;
    return out;
  }
}
