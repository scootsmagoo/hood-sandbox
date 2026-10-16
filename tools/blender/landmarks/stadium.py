"""Mercedes-Benz Stadium ("Silverline Stadium" in the game), 2017: a retractable-roof stadium with an angular
shell of silver panels and glass folded into points at the corners, eight triangular roof petals that slide open on
tracks like a camera iris (the pinwheel), and the halo board, a ring of video screens hung in the roof opening.
No marks or lettering: the real shell carries the maker's star on its panels; here they are blank.

The footprint is the data's (a 300 m rounded decagon), which reaches 24 m past the tile's west edge: the model
stands where the building does and the pipeline clips its hull to the tile.
Night: the halo board glows, the glass concourse is lit by the facade shader.

Structure drawn (level 0): the shell's silver facets are cut into panels (`facet`) and its glass facets are glazed with
mullions, with rib beams along every fold; an eave ring beam runs round the top of the wings; each seam between two
petals is a radial girder (a truss: top and bottom chords and diagonals) that carries the petals' tracks from the eave to
the oculus; the oculus is ringed by a deep compression-ring truss; and the halo board hangs from that ring on rods,
a double band of screens inside its own truss ring.
"""
import math

from . import common, lm, parts
from .lm import circle, shade, srgb

ID = 'mercedes-benz-stadium'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

PANEL = srgb(0xc3c7cc)
PANEL_B = srgb(0xaeb3b9)
GLASS = srgb(0x35495a)
CONCRETE = srgb(0x77767a)
PETAL_A = srgb(0xe4e7ea)
PETAL_B = srgb(0xd6dadd)
SEAM = srgb(0x7c8187)
DARK_SEAM = srgb(0x3a3d42)
H_BASE = 24.0     # the glass concourse wall
H_EAVE = 66.0     # where the roof petals start (the mean of the wavy eave)
H_OCULUS = 90.0   # the roof's highest ring, at the opening (the model is 93 m in the data)
R_OCULUS = 36.0
HALO_R = 30.0
HALO_Y0, HALO_Y1 = 70.0, 84.0
STEEL = srgb(0x8f959b)
STEEL_D = srgb(0x5d6268)


def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def scaled(ring, s, c):
    return [(c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s) for p in ring]


def ray(ring, c, ang):
    """Where a ray from c at angle `ang` leaves a star-shaped ring."""
    dx, dz = math.cos(ang), math.sin(ang)
    best = None
    hit = None
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        ex, ez = b[0] - a[0], b[1] - a[1]
        den = dx * ez - dz * ex
        if abs(den) < 1e-9:
            continue
        t = ((a[0] - c[0]) * ez - (a[1] - c[1]) * ex) / den
        s = ((a[0] - c[0]) * dz - (a[1] - c[1]) * dx) / den
        if t > 0 and -1e-9 <= s <= 1 + 1e-9 and (best is None or t < best):
            best = t
            hit = (i, max(0.0, min(1.0, s)))
    return (c[0] + dx * best, c[1] + dz * best), hit


def eave_heights(n):
    """The eave is not level: the folded wings rise to a point at some corners and dip at others."""
    return [H_EAVE + (9.0 if i % 2 == 0 else -5.0) * (1.0 if (i // 2) % 2 == 0 else 0.55) for i in range(n)]


def shade_of(i, j, k):
    """A small deterministic variation per panel (no randomness): 0.93 to 1.05."""
    return 0.93 + 0.03 * ((i * 7 + j * 13 + k * 5) % 5)


def facet(l, mat, A, B, C, n, col, hint, k=0):
    """A triangle cut into n*n small triangles (the panels of a folded wing), each a little lighter or darker than its neighbours."""
    def p(i, j):
        return (A[0] + (B[0] - A[0]) * i / n + (C[0] - A[0]) * j / n, A[1] + (B[1] - A[1]) * i / n + (C[1] - A[1]) * j / n, A[2] + (B[2] - A[2]) * i / n + (C[2] - A[2]) * j / n)
    for i in range(n):
        for j in range(n - i):
            l.tri(mat, p(i, j), p(i + 1, j), p(i, j + 1), shade(col, shade_of(i, j, k)), hint=hint)
            if i + j < n - 1:
                l.tri(mat, p(i + 1, j), p(i + 1, j + 1), p(i, j + 1), shade(col, shade_of(i + 3, j + 1, k + 2)), hint=hint)


def mullions(l, A, B, C, hint, nrows, nfan, w=0.22):
    """Glazing bars on a glass triangle A (the foot), B, C (the top edge): rows parallel to the top and a fan from the foot."""
    off = tuple(x * 0.16 for x in hint)

    def at(P, Q, t):
        return tuple(P[m] + (Q[m] - P[m]) * t + off[m] for m in range(3))
    for r in range(1, nrows + 1):
        t = r / (nrows + 1)
        l.beam('lm_metal', at(A, B, t), at(A, C, t), w, w, STEEL, caps=False)
    for f in range(1, nfan + 1):
        t = f / (nfan + 1)
        l.beam('lm_metal', tuple(A[m] + off[m] for m in range(3)), at(B, C, t), w, w, STEEL, caps=False)


def unit(v):
    ln = math.sqrt(sum(x * x for x in v)) or 1.0
    return tuple(x / ln for x in v)


def shell(l, ring, c, detail):
    n = len(ring)
    top = scaled(ring, 0.80, c)
    # the folded shell: an antiprism of silver panels (pointing up) and glass (pointing down) from the concourse to the eave
    mids = [((ring[i][0] + ring[(i + 1) % n][0]) / 2, (ring[i][1] + ring[(i + 1) % n][1]) / 2) for i in range(n)]
    tops = [(c[0] + (m[0] - c[0]) * 0.80, c[1] + (m[1] - c[1]) * 0.80) for m in mids]
    out = lambda p: (p[0] - c[0], 0, p[1] - c[1])
    hts = eave_heights(n)
    for i in range(n):
        b0, b1 = ring[i], ring[(i + 1) % n]
        t0, t1 = tops[i], tops[(i + 1) % n]
        B0, B1 = (b0[0], H_BASE, b0[1]), (b1[0], H_BASE, b1[1])
        T0, T1 = (t0[0], hts[i], t0[1]), (t1[0], hts[(i + 1) % n], t1[1])
        h0 = out(((b0[0] + b1[0] + t0[0]) / 3, (b0[1] + b1[1] + t0[1]) / 3))
        h1 = out(((b1[0] + t0[0] + t1[0]) / 3, (b1[1] + t0[1] + t1[1]) / 3))
        col = PANEL if i % 2 == 0 else PANEL_B
        if detail:
            facet(l, 'lm_metal', B0, B1, T0, 4, col, h0, k=i)
            l.tri('lm_glass', B1, T0, T1, GLASS, hint=h1)
            # the glass wing's bars, and the ribs along every fold
            from math import sqrt
            nrm = unit(lm_cross(tuple(T0[m] - B1[m] for m in range(3)), tuple(T1[m] - B1[m] for m in range(3))))
            if sum(nrm[m] * h1[m] for m in range(3)) < 0:
                nrm = tuple(-x for x in nrm)
            mullions(l, B1, T0, T1, nrm, 4, 5)
            for a, b, w in ((B0, T0, 1.1), (B1, T0, 1.1), (B1, T1, 1.1), (B0, B1, 0.8)):
                l.beam('lm_metal', a, b, w, w * 0.8, shade(PANEL, 0.8))
        else:
            l.tri('lm_metal', B0, B1, T0, col, hint=h0)
            l.tri('lm_glass', B1, T0, T1, GLASS, hint=h1)
    if detail:
        # the ring beam along the eave, over the tops of the wings
        path = [(tops[i % n][0], hts[i % n] + 0.3, tops[i % n][1]) for i in range(n + 1)]
        l.tube('lm_metal', path, [0.95] * len(path), 6, shade(PANEL, 0.78), caps=False)
    return tops


def lm_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def girder(l, pts, up=0.0):
    """A radial truss along a polyline of 3D points: a lower and an upper chord with diagonals between them, silver steel."""
    lo = [(p[0], p[1] + 0.5, p[2]) for p in pts]
    hi = [(p[0], p[1] + 2.4, p[2]) for p in pts]
    for i in range(len(pts) - 1):
        l.beam('lm_metal', lo[i], lo[i + 1], 0.9, 0.7, STEEL)
        l.beam('lm_metal', hi[i], hi[i + 1], 0.9, 0.7, STEEL)
        a, b = (lo[i], hi[i + 1]) if i % 2 == 0 else (hi[i], lo[i + 1])
        l.beam('lm_metal', a, b, 0.5, 0.5, STEEL_D, caps=False)
    for p in (0, len(pts) - 1):
        l.beam('lm_metal', lo[p], hi[p], 0.7, 0.7, STEEL, caps=False)


def petals(l, tops, c, detail):
    """Eight roof petals from the eave ring (the antiprism's tops) to the opening, each twisted about 30 degrees from the one outside it."""
    npet = 8
    rows = 8 if detail else 2
    cols = 6 if detail else 2
    twist = math.radians(30)
    base = math.radians(22.5)
    hts = eave_heights(len(tops))
    for k in range(npet):
        k2 = (k + 1) % npet
        a0 = base + 2 * math.pi * k / npet
        a1 = base + 2 * math.pi * (k + 1) / npet
        q0 = (c[0] + R_OCULUS * math.cos(a0 + twist), c[1] + R_OCULUS * math.sin(a0 + twist))
        q1 = (c[0] + R_OCULUS * math.cos(a1 + twist), c[1] + R_OCULUS * math.sin(a1 + twist))
        # outer edge: sampled along the eave polyline between P_k and P_k2
        outer = []
        outer_y = []
        for j in range(cols + 1):
            ang = a0 + (a1 - a0) * j / cols
            p, (ei, fr) = ray(tops, c, ang)
            outer.append(p)
            outer_y.append(hts[ei] + (hts[(ei + 1) % len(tops)] - hts[ei]) * fr)
        inner = [(q0[0] + (q1[0] - q0[0]) * j / cols, q0[1] + (q1[1] - q0[1]) * j / cols) for j in range(cols + 1)]
        grid = []
        for r in range(rows + 1):
            t = r / rows
            e = 1.0 - (1.0 - t) ** 2  # the roof is convex: steep at the eave, flat at the top
            row = []
            for j in range(cols + 1):
                x = outer[j][0] + (inner[j][0] - outer[j][0]) * t
                z = outer[j][1] + (inner[j][1] - outer[j][1]) * t
                row.append((x, outer_y[j] + (H_OCULUS - outer_y[j]) * e, z))
            grid.append(row)
        col = PETAL_A if k % 2 == 0 else PETAL_B
        # the skin is panels: a row's shade steps a little, so the joints read
        l.skin('lm_lit', grid, (lambda i, j, p, col=col: shade(col, 1.0 if (i + j) % 2 == 0 else 0.955)) if detail else col, closed=False, inside=(c[0], 20.0, c[1]), flip=False)
        # the seam to the next petal: a radial girder (the track the petals slide on) with a dark groove on its top
        seam = [grid[r][-1] for r in range(rows + 1)]
        if detail:
            girder(l, seam)
        for r in range(rows):
            a, b = seam[r], seam[r + 1]
            lift = 2.9 if detail else 0.25
            l.beam('lm_dark', (a[0], a[1] + lift, a[2]), (b[0], b[1] + lift, b[2]), 0.7 if detail else 2.4, 0.4, DARK_SEAM)
    # the oculus: a rim skirt and, in the detailed level, a deep compression-ring truss
    ring_o = circle(R_OCULUS, 32 if detail else 12, c[0], c[1])
    for i in range(len(ring_o)):
        a, b = ring_o[i], ring_o[(i + 1) % len(ring_o)]
        l.quad('lm_metal', (a[0], H_OCULUS - 0.4, a[1]), (b[0], H_OCULUS - 0.4, b[1]), (b[0], H_OCULUS + 0.8, b[1]), (a[0], H_OCULUS + 0.8, a[1]), SEAM, hint=(a[0] - c[0], 0, a[1] - c[1]))
    if detail:
        y_lo, y_hi = H_OCULUS + 0.6, H_OCULUS + 3.4
        for yy in (y_lo, y_hi):
            path = [(p[0], yy, p[1]) for p in circle(R_OCULUS - 0.3, 48, c[0], c[1])]
            path.append(path[0])
            l.tube('lm_metal', path, [0.7] * len(path), 6, STEEL, caps=False)
        pts = circle(R_OCULUS - 0.3, 48, c[0], c[1])
        for i in range(48):
            p, q = pts[i], pts[(i + 1) % 48]
            l.beam('lm_metal', (p[0], y_lo, p[1]), (p[0], y_hi, p[1]), 0.4, 0.4, STEEL_D, caps=False)
            a, b = ((p[0], y_lo, p[1]), (q[0], y_hi, q[1])) if i % 2 == 0 else ((p[0], y_hi, p[1]), (q[0], y_lo, q[1]))
            l.beam('lm_metal', a, b, 0.4, 0.4, STEEL_D, caps=False)


def halo(l, c, n, detail=True):
    """The halo board: a double band of screens, lit inside, in a truss ring, hung from the oculus ring on rods."""
    y0, y1 = HALO_Y0, HALO_Y1
    ym = (y0 + y1) / 2
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = (c[0] + HALO_R * math.cos(a0), c[1] + HALO_R * math.sin(a0))
        p1 = (c[0] + HALO_R * math.cos(a1), c[1] + HALO_R * math.sin(a1))
        q0 = (c[0] + (HALO_R + 1.2) * math.cos(a0), c[1] + (HALO_R + 1.2) * math.sin(a0))
        q1 = (c[0] + (HALO_R + 1.2) * math.cos(a1), c[1] + (HALO_R + 1.2) * math.sin(a1))
        inward = (c[0] - p0[0], 0, c[1] - p0[1])
        # inner face: the screens, two bands with a dark gap between and a tone that changes panel to panel
        led = srgb(0xcfe6ff) if (i // 2) % 3 else srgb(0x9fc4ff)
        if detail:
            for lo, hi, tone in ((y0 + 0.5, ym - 0.25, 1.0), (ym + 0.25, y1 - 0.5, 0.88)):
                l.quad('lm_glow', (p0[0], lo, p0[1]), (p1[0], lo, p1[1]), (p1[0], hi, p1[1]), (p0[0], hi, p0[1]), shade(led, tone), hint=inward)
        else:
            l.quad('lm_glow', (p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (p1[0], y1, p1[1]), (p0[0], y1, p0[1]), led, hint=inward)
        # outer face and the rim
        l.quad('lm_metal', (q0[0], y0, q0[1]), (q1[0], y0, q1[1]), (q1[0], y1, q1[1]), (q0[0], y1, q0[1]), shade(SEAM, 0.6), hint=(q0[0] - c[0], 0, q0[1] - c[1]))
        l.quad('lm_metal', (p0[0], y1, p0[1]), (p1[0], y1, p1[1]), (q1[0], y1, q1[1]), (q0[0], y1, q0[1]), SEAM, hint=(0, 1, 0))
        l.quad('lm_metal', (p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (q1[0], y0, q1[1]), (q0[0], y0, q0[1]), shade(SEAM, 0.5), hint=(0, -1, 0))
    if detail:
        # the truss ring round the board (chords, posts and diagonals) and the rods it hangs from
        r_t = HALO_R + 1.9
        for yy in (y1 + 0.6, y1 + 2.8):
            path = [(p[0], yy, p[1]) for p in circle(r_t, 48, c[0], c[1])]
            path.append(path[0])
            l.tube('lm_metal', path, [0.4] * len(path), 5, STEEL, caps=False)
        pts = circle(r_t, 48, c[0], c[1])
        for i in range(48):
            p, q = pts[i], pts[(i + 1) % 48]
            l.beam('lm_metal', (p[0], y1 + 0.6, p[1]), (p[0], y1 + 2.8, p[1]), 0.3, 0.3, STEEL_D, caps=False)
            a, b = ((p[0], y1 + 0.6, p[1]), (q[0], y1 + 2.8, q[1])) if i % 2 == 0 else ((p[0], y1 + 2.8, p[1]), (q[0], y1 + 0.6, q[1]))
            l.beam('lm_metal', a, b, 0.3, 0.3, STEEL_D, caps=False)
        # links from the truss ring down onto the board's top, and the rods up to the oculus ring
        for i in range(0, 48, 3):
            a = 2 * math.pi * i / 48
            x, z = c[0] + (HALO_R + 0.6) * math.cos(a), c[1] + (HALO_R + 0.6) * math.sin(a)
            l.beam('lm_metal', (x, y1, z), (c[0] + r_t * math.cos(a), y1 + 0.6, c[1] + r_t * math.sin(a)), 0.35, 0.35, STEEL_D, caps=False)
        for i in range(16):
            a = 2 * math.pi * (i + 0.5) / 16
            l.beam('lm_metal', (c[0] + r_t * math.cos(a), y1 + 2.8, c[1] + r_t * math.sin(a)), (c[0] + (R_OCULUS - 0.3) * math.cos(a), H_OCULUS + 0.6, c[1] + (R_OCULUS - 0.3) * math.sin(a)), 0.5, 0.5, STEEL_D, caps=False)


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = parts.simplify([tuple(p) for p in fp['ring']], 7.0, keep=8)
    c = centroid(ring)
    _, _, ang, L, W = lm.min_obb(ring)
    lods = []
    for i, detail in ((0, True), (1, False)):
        l = lm.Lod(i)
        # the concourse wall: dark glass between white piers, on a concrete plinth
        l.ring_walls('bld_glass', ring, 2.0, H_BASE, GLASS, lm.K_GLASS, floor_h=6.0, fid=21)
        plinth = scaled(ring, 1.006, c)
        for k in range(len(plinth)):
            a, b = plinth[k], plinth[(k + 1) % len(plinth)]
            s = 1.0 if lm.area2(plinth) > 0 else -1.0
            out = ((b[1] - a[1]) * s, 0, -(b[0] - a[0]) * s)
            l.quad('lm_stone', (a[0], -4.0, a[1]), (b[0], -4.0, b[1]), (b[0], 2.0, b[1]), (a[0], 2.0, a[1]), CONCRETE, hint=out)
            # the top of the concourse wall: a deep white fascia
            l.quad('lm_metal', (a[0], H_BASE - 1.5, a[1]), (b[0], H_BASE - 1.5, b[1]), (b[0], H_BASE, b[1]), (a[0], H_BASE, a[1]), PANEL, hint=out)
        for p in ring:
            l.box('lm_metal', (p[0], H_BASE / 2, p[1]), (2.2 if detail else 3.0, H_BASE, 2.2 if detail else 3.0), PANEL)
        tops = shell(l, ring, c, detail)
        petals(l, tops, c, detail)
        halo(l, c, 40 if detail else 16, detail)
        # the bowl seen through the opening: stepped stands in two tiers (treads and risers), a concourse ledge between, and the field
        steps = 9 if detail else 1
        for k in range(steps):
            s0, s1 = 0.50 + 0.14 * k / steps, 0.50 + 0.14 * (k + 1) / steps
            y0, y1 = 2.0 + 36.0 * k / steps, 2.0 + 36.0 * (k + 1) / steps
            if detail and k == steps // 2:
                s1 += 0.02  # the concourse ledge between the lower and upper tiers
            r0, r1 = scaled(ring, s0, c), scaled(ring, s1, c)
            seat = srgb(0x35465c) if k % 2 == 0 else srgb(0x2c3a4b)
            for q in range(len(ring)):
                a0, b0 = r0[q], r0[(q + 1) % len(ring)]
                a1, b1 = r1[q], r1[(q + 1) % len(ring)]
                # tread (a slope up and outwards) and riser
                l.quad('lm_stone', (a0[0], y0, a0[1]), (b0[0], y0, b0[1]), (b1[0], y1, b1[1]), (a1[0], y1, a1[1]), seat, hint=(0, 1, 0))
        if detail:
            # a wrap-around canopy on columns round the foot of the shell: the stadium's pedestrian-level skirt
            outer = lm.inset_ring(plinth, -9.0)
            for q in range(len(plinth)):
                a0, b0 = plinth[q], plinth[(q + 1) % len(plinth)]
                a1, b1 = outer[q], outer[(q + 1) % len(plinth)]
                l.quad('lm_stone', (a0[0], 11.0, a0[1]), (b0[0], 11.0, b0[1]), (b1[0], 11.0, b1[1]), (a1[0], 11.0, a1[1]), PANEL_B, hint=(0, -1, 0))
                l.quad('lm_metal', (a0[0], 11.0, a0[1]), (b0[0], 11.0, b0[1]), (b1[0], 11.6, b1[1]), (a1[0], 11.6, a1[1]), PANEL, hint=(0, 1, 0))
                out = parts.outward(outer, q)
                l.quad('lm_metal', (a1[0], 10.6, a1[1]), (b1[0], 10.6, b1[1]), (b1[0], 11.6, b1[1]), (a1[0], 11.6, a1[1]), PANEL, hint=out)
                # columns every 18 m along the edge
                ln = math.hypot(b1[0] - a1[0], b1[1] - a1[1])
                n = max(1, int(ln // 18.0))
                for j in range(n):
                    t = (j + 0.5) / n
                    x, z = a1[0] + (b1[0] - a1[0]) * t, a1[1] + (b1[1] - a1[1]) * t
                    parts.column(l, x, z, 0.7, 0.0, 10.6, 8, PANEL)
        field = circle(52.0, 24 if detail else 10, c[0], c[1], ry=34.0)
        field = lm.rot_pts(field, ang, c[0], c[1])
        l.cap('lm_stone', field, 2.0, srgb(0x3d6b3a))
        lods.append(l)
    hull = [(scaled(ring, 0.995, c), H_BASE), (scaled(ring, 0.8, c), H_EAVE)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 650])
