"""Shapes several landmarks share: ledges, cornices, pyramidal roofs, columns, struts."""
import math

from . import lm
from .lm import shade


def outward(ring, i):
    a, b = ring[i], ring[(i + 1) % len(ring)]
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    return ((b[1] - a[1]) * s, 0.0, -(b[0] - a[0]) * s)


def band(l, ring, y0, y1, grow, col, mat='lm_stone', top=True):
    """A ledge round a ring: the ring grown by `grow` metres, from y0 to y1, with its upper face (a cornice, a floor slab, a plinth)."""
    r = lm.inset_ring(ring, -grow) if grow else ring
    for i in range(len(r)):
        a, b = r[i], r[(i + 1) % len(r)]
        out = outward(r, i)
        l.quad(mat, (a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), col, hint=out)
    if top and grow:
        for i in range(len(r)):
            a, b = r[i], r[(i + 1) % len(r)]
            a0, b0 = ring[i], ring[(i + 1) % len(ring)]
            l.quad(mat, (a0[0], y1, a0[1]), (b0[0], y1, b0[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), shade(col, 1.08), hint=(0, 1, 0))


def pyramid(l, ring, y0, apex, col, mat='lm_metal', cx=None, cz=None):
    """A roof rising from a ring to a point (cx, cz default the mean), flat-shaded faces."""
    if cx is None:
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        l.tri(mat, (a[0], y0, a[1]), (b[0], y0, b[1]), (cx, apex, cz), col, hint=((a[0] + b[0]) / 2 - cx, 0.6, (a[1] + b[1]) / 2 - cz))


def column(l, cx, cz, r, y0, y1, n, col, mat='lm_stone'):
    l.lathe(mat, [(r * 1.25, y0), (r * 1.25, y0 + 0.5), (r, y0 + 0.7), (r * 0.9, y1 - 0.8), (r, y1 - 0.7), (r * 1.3, y1)], n, col, cx=cx, cz=cz, smooth=False)


def mean(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def scaled(ring, s, c=None):
    c = c or mean(ring)
    return [(c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s) for p in ring]


def tower_stack(l, ring, y0, y1, wall_col, kind, floor_h, fid, roof_col, era=3, cap=True, band_col=None):
    """A facade prism with a parapet lip."""
    l.prism('bld_wall' if kind != lm.K_GLASS else 'bld_glass', ring, y0, y1, wall_col, roof_col, kind, floor_h=floor_h, era=era, fid=fid, cap=cap)


def simplify(ring, tol, keep=8):
    """Douglas-Peucker on a closed ring: the corners that matter (the stadium's decagon from its rounded outline). Never fewer than `keep`."""
    n = len(ring)

    def dist(p, a, b):
        dx, dz = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dz * dz
        if l2 == 0:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2))
        return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz))

    def rec(i, j, out):
        best, bi = 0.0, -1
        for k in range(i + 1, j):
            d = dist(ring[k % n], ring[i % n], ring[j % n])
            if d > best:
                best, bi = d, k
        if best > tol and bi > 0:
            rec(i, bi, out)
            out.append(bi % n)
            rec(bi, j, out)

    # split at the two points furthest apart
    a = max(range(n), key=lambda k: math.hypot(ring[k][0] - ring[0][0], ring[k][1] - ring[0][1]))
    keepi = {0, a}
    for i, j in ((0, a), (a, n)):
        out = []
        rec(i, j, out)
        keepi.update(out)
    r = [ring[k] for k in sorted(keepi)]
    if len(r) < keep and tol > 0.5:
        return simplify(ring, tol * 0.7, keep)
    return r
