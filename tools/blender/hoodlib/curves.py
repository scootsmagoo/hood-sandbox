"""Smooth 1D profiles for lofting: y(z) through control points, without overshoot."""
import math


class Profile:
    """A monotone cubic (Fritsch-Carlson) through (t, v) points: smooth, and it never overshoots
    between two control points, so a hood line or a roof line stays where it was drawn."""

    def __init__(self, points):
        pts = sorted(points)
        self.t = [p[0] for p in pts]
        self.v = [p[1] for p in pts]
        n = len(pts)
        if n < 2:
            raise ValueError('a profile needs two points')
        d = [(self.v[i + 1] - self.v[i]) / (self.t[i + 1] - self.t[i]) for i in range(n - 1)]
        m = [0.0] * n
        m[0] = d[0]
        m[-1] = d[-1]
        for i in range(1, n - 1):
            m[i] = 0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2
        for i in range(n - 1):
            if d[i] == 0:
                m[i] = m[i + 1] = 0.0
                continue
            a = m[i] / d[i]
            b = m[i + 1] / d[i]
            s = a * a + b * b
            if s > 9:
                k = 3 / math.sqrt(s)
                m[i] = k * a * d[i]
                m[i + 1] = k * b * d[i]
        self.m = m

    def __call__(self, t):
        ts, vs, ms = self.t, self.v, self.m
        if t <= ts[0]:
            return vs[0] + ms[0] * (t - ts[0])
        if t >= ts[-1]:
            return vs[-1] + ms[-1] * (t - ts[-1])
        lo, hi = 0, len(ts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if ts[mid] <= t:
                lo = mid
            else:
                hi = mid
        h = ts[hi] - ts[lo]
        s = (t - ts[lo]) / h
        h00 = 2 * s ** 3 - 3 * s ** 2 + 1
        h10 = s ** 3 - 2 * s ** 2 + s
        h01 = -2 * s ** 3 + 3 * s ** 2
        h11 = s ** 3 - s ** 2
        return h00 * vs[lo] + h10 * h * ms[lo] + h01 * vs[hi] + h11 * h * ms[hi]


def stations(z0, z1, step, extra=(), dense=()):
    """Loft stations from z0 to z1: an even spacing of `step`, every z in `extra`, and in each
    (a, b, step) of `dense` a finer spacing. Sorted, deduplicated to 1 mm."""
    out = set()
    n = max(1, round((z1 - z0) / step))
    for i in range(n + 1):
        out.add(round(z0 + (z1 - z0) * i / n, 4))
    for z in extra:
        if z0 <= z <= z1:
            out.add(round(z, 4))
    for a, b, s in dense:
        k = max(1, round((b - a) / s))
        for i in range(k + 1):
            z = a + (b - a) * i / k
            if z0 <= z <= z1:
                out.add(round(z, 4))
    zs = sorted(out)
    clean = [zs[0]]
    for z in zs[1:]:
        if z - clean[-1] > 0.004:
            clean.append(z)
    if clean[-1] != zs[-1]:
        clean[-1] = zs[-1]
    return clean


def round_corner(z, z_end, radius, half, sign):
    """Plan-view half-width of a rectangle of half-width `half` whose end at `z_end` (sign +1 the
    front, -1 the rear) has corners rounded by `radius`."""
    d = (z_end - z) * sign  # distance in from the end
    if d >= radius:
        return half
    d = max(0.0, d)
    a = radius - d
    return half - radius + math.sqrt(max(0.0, radius * radius - a * a))
