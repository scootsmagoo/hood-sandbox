"""The Maynard H. Jackson Jr. International Terminal (2012): the landside hall of the international side, a long glass-fronted
building under one big flowing roof like a wing. The roof's leading edge sweeps out over the departures curb (the
elevated Maynard H. Jackson Jr. Boulevard runs along the north front, layer 3), thin at its tip, with a deep white
soffit; it lifts to 33 m at its tip, 28 m over the glass wall, and falls away to the airside, where Concourse F joins the west end.
Drawn on the real outline (airport.json rings[0]); the front is its north side. No lettering.

Night: the soffit is lit (lm_lit), a line of light runs under the leading edge (lm_glow), the facade shader lights the glass.
"""
import math

from airport import apt
from landmarks import lm, parts
from landmarks.lm import shade, srgb

ID = 'atl-international-terminal'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

GLASS = srgb(0x5a88a8)
GLASS_LO = srgb(0x557f9a)
PANEL = srgb(0xd6d7d3)
SLAB = srgb(0xdcdad4)
ROOF_TOP = srgb(0xb9bec2)
SOFFIT = srgb(0xf1f1ee)
FASCIA = srgb(0xe8e9e7)
MULLION = srgb(0x8a9298)
SKY = srgb(0x7fa6bd)
GLOW = srgb(0xfff0d8)

X0, X1 = -106.0, 106.0       # the roof's ends
Z_REAR = 27.0                # its trailing edge (airside)
DEP = 8.4                    # the departures level (the front's slab line)


def z_front(x):
    """The leading edge in plan: furthest out (24 m past the glass) in the middle."""
    return -23.0 - (16.0 + 8.0 * math.cos(math.pi * x / 215.0))


def s_of(x, z):
    return (z - z_front(x)) / (Z_REAR - z_front(x))


def y_top(x, s):
    """The roof's upper surface: a wing whose leading edge lifts to 33 m over the curb, 28 m over the glass wall, falling away
    in a long curve to 20.5 m at the airside edge; the middle a little higher than the ends."""
    return 20.5 + 12.5 * (1.0 - s) ** 1.25 + 1.5 * math.cos(math.pi * x / 210.0) * (1.0 - 0.6 * s)


def thick(s):
    return 0.45 + 2.4 * lm.smoothstep(0.0, 0.34, s)


def y_bot(x, s):
    return y_top(x, s) - thick(s)


def grid(l, mat, P, col, up):
    """Quads over a grid of points P[i][j] (i along x, j across), smooth normals oriented up (up = 1) or down (-1)."""
    ni, nj = len(P), len(P[0])

    def nrm(i, j):
        a, b = P[min(ni - 1, i + 1)][j], P[max(0, i - 1)][j]
        c, d = P[i][min(nj - 1, j + 1)], P[i][max(0, j - 1)]
        t = (a[0] - b[0], a[1] - b[1], a[2] - b[2])
        u = (c[0] - d[0], c[1] - d[1], c[2] - d[2])
        n = (t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0])
        ln = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
        n = (n[0] / ln, n[1] / ln, n[2] / ln)
        return n if n[1] * up >= 0 else (-n[0], -n[1], -n[2])
    N = [[nrm(i, j) for j in range(nj)] for i in range(ni)]
    for i in range(ni - 1):
        for j in range(nj - 1):
            pts = [P[i][j], P[i + 1][j], P[i + 1][j + 1], P[i][j + 1]]
            ns = [N[i][j], N[i + 1][j], N[i + 1][j + 1], N[i][j + 1]]
            l.poly(mat, pts, col, hint=(0, up, 0), normals=ns)


def roof(l, nx, ns, lod):
    xs = [X0 + (X1 - X0) * i / nx for i in range(nx + 1)]
    # profile stations: dense at the leading edge, where the roof thickens
    ss = [((j / ns) ** 1.35) for j in range(ns + 1)]

    def P(x, s, bot=False):
        z = z_front(x) + (Z_REAR - z_front(x)) * s
        return (x, y_bot(x, s) if bot else y_top(x, s), z)
    top = [[P(x, s) for s in ss] for x in xs]
    bot = [[P(x, s, True) for s in ss] for x in xs]
    grid(l, 'lm_metal', top, ROOF_TOP, 1)
    grid(l, 'lm_lit', bot, SOFFIT, -1)
    # the leading and trailing edges
    for j, sg in ((0, -1), (ns, 1)):
        for i in range(nx):
            a, b = top[i][j], top[i + 1][j]
            c, d = bot[i + 1][j], bot[i][j]
            l.poly('lm_metal', [d, c, b, a], FASCIA, hint=(0, 0, sg))
    # the two ends
    for i, sg in ((0, -1), (nx, 1)):
        l.poly('lm_metal', top[i] + bot[i][::-1], FASCIA, hint=(sg, 0, 0))
    if lod == 0:
        # a line of light under the leading edge
        for i in range(nx):
            a, b = P(xs[i], 0.012, True), P(xs[i + 1], 0.012, True)
            c, d = P(xs[i + 1], 0.03, True), P(xs[i], 0.03, True)
            l.poly('lm_glow', [(p[0], p[1] - 0.03, p[2]) for p in (a, b, c, d)], GLOW, hint=(0, -1, 0))
        # skylight bands along the roof, over the departures hall
        for s0, s1 in ((0.47, 0.5), (0.6, 0.63), (0.73, 0.76)):
            for i in range(1, nx - 1):
                q = [P(xs[i], s0), P(xs[i + 1], s0), P(xs[i + 1], s1), P(xs[i], s1)]
                l.poly('lm_glass', [(p[0], p[1] + 0.12, p[2]) for p in q], SKY, hint=(0, 1, 0))
        # standing seams: low ribs across the roof
        for i in range(1, nx):
            x = xs[i]
            pts = [P(x, s) for s in ss]
            for j in range(len(pts) - 1):
                a, b = pts[j], pts[j + 1]
                l.quad('lm_metal', (a[0] - 0.12, a[1] + 0.02, a[2]), (a[0] + 0.12, a[1] + 0.02, a[2]), (b[0] + 0.12, b[1] + 0.02, b[2]), (b[0] - 0.12, b[1] + 0.02, b[2]), shade(ROOF_TOP, 0.85), hint=(0, 1, 0))


def subdivide(a, b, step):
    ln = math.hypot(b[0] - a[0], b[1] - a[1])
    n = max(1, int(math.ceil(ln / step)))
    return [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]


def walls(l, ring, lod):
    """The glass walls up to the soffit: the front (north) in two tiers about the departures slab, the rest glass over a panel base."""
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    u = 0.0
    step = 7.0 if lod == 0 else 30.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz)
        if ln < 1e-6:
            continue
        out = (dz / ln * s, -dx / ln * s)
        front = out[1] < -0.7
        pts = subdivide(a, b, step)
        for k in range(len(pts) - 1):
            p, q = pts[k], pts[k + 1]
            seg = math.hypot(q[0] - p[0], q[1] - p[1])
            yp, yq = y_bot(p[0], s_of(*p)) - 0.05, y_bot(q[0], s_of(*q)) - 0.05
            hint = (out[0], 0, out[1])
            if front:
                l.facade_quad('bld_glass', (p[0], 0, p[1]), (q[0], 0, q[1]), (q[0], DEP, q[1]), (p[0], DEP, p[1]), GLASS_LO, u, lm.K_GLASS, 2, 0, 4, 701, True, hint=hint)
                l.quad('lm_stone', (p[0], DEP, p[1]), (q[0], DEP, q[1]), (q[0], DEP + 0.9, q[1]), (p[0], DEP + 0.9, p[1]), SLAB, hint=hint)
                l.facade_quad('bld_glass', (p[0], DEP + 0.9, p[1]), (q[0], DEP + 0.9, q[1]), (q[0], yq, q[1]), (p[0], yp, p[1]), GLASS, u, lm.K_GLASS, 3, 0, 4, 702, True, hint=hint)
            else:
                l.facade_quad('bld_wall', (p[0], 0, p[1]), (q[0], 0, q[1]), (q[0], 4.5, q[1]), (p[0], 4.5, p[1]), PANEL, u, lm.K_CIVIC, 1, 0, 4, 703, True, hint=hint)
                l.facade_quad('bld_glass', (p[0], 4.5, p[1]), (q[0], 4.5, q[1]), (q[0], yq, q[1]), (p[0], yp, p[1]), GLASS, u, lm.K_GLASS, 3, 0, 4, 704, True, hint=hint)
            if lod == 0:
                # mullions every 3 m over the full height, a transom at the departures slab and halfway up the hall
                nm = max(1, int(round(seg / 3.0)))
                rot = math.atan2(out[0], out[1])
                for j in range(nm):
                    t = j / nm
                    m = (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
                    ym = yp + (yq - yp) * t
                    w = 0.16 if front else 0.12
                    l.box('lm_metal', (m[0] + out[0] * 0.16, ym / 2, m[1] + out[1] * 0.16), (w, ym, 0.32), MULLION, rot=rot, skip=('-z', '+y', '-y'))
                for yb in ((DEP + 0.9 + min(yp, yq)) / 2,) if front else (4.5,):
                    l.quad('lm_metal', (p[0] + out[0] * 0.2, yb, p[1] + out[1] * 0.2), (q[0] + out[0] * 0.2, yb, q[1] + out[1] * 0.2),
                           (q[0] + out[0] * 0.2, yb + 0.2, q[1] + out[1] * 0.2), (p[0] + out[0] * 0.2, yb + 0.2, p[1] + out[1] * 0.2), MULLION, hint=hint)
            u += seg


def build(asset):
    apt.start()
    h = apt.hero(ID)
    ring = [tuple(p) for p in h['rings'][0]]
    lods = []
    for lod in (0, 1, 2):
        l = lm.Lod(lod)
        if lod == 2:
            far = parts.simplify(ring, 3.0, keep=6)
            l.ring_walls('bld_glass', far, 0, 19.0, GLASS, lm.K_GLASS, floor_h=6.0, era=4, fid=705)
            l.cap('bld_roof', far, 19.0, ROOF_TOP)
            roof(l, 4, 3, lod)
            lods.append(l)
            continue
        rr = ring if lod == 0 else parts.simplify(ring, 1.5, keep=6)
        walls(l, rr, lod)
        roof(l, 30 if lod == 0 else 10, 12 if lod == 0 else 5, lod)
        if lod == 0:
            # entrance vestibules on the front at both levels: glass boxes standing out under the soffit
            for x in (-60.0, -20.0, 20.0, 60.0):
                z = -23.2
                for y0, y1 in ((0.0, 3.6),):
                    l.box('lm_glass', (x, (y0 + y1) / 2, z - 1.5), (7.0, y1 - y0, 3.0), srgb(0x6b93ab), skip=('+z',))
                    l.box('lm_metal', (x, y1 + 0.2, z - 1.6), (7.6, 0.4, 3.4), FASCIA, skip=('+z',))
        lods.append(l)
    hull = [(apt.offset(ring, -0.3), 17.5)]
    flatten = [(apt.offset(ring, 2.0), 25.0)]
    return apt.report(asset, ID, lods, hull, lod_from=[0, 600, 1800], flatten=flatten)
