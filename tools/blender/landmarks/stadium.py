"""Mercedes-Benz Stadium ("Silverline Stadium" in the game), 2017: a retractable-roof stadium with an angular
shell of silver panels and glass folded into points at the corners, eight triangular roof petals that slide open on
tracks like a camera iris (the pinwheel), and the halo board, a ring of video screens hung in the roof opening.
No marks or lettering: the real shell carries the maker's star on its panels; here they are blank.

The footprint is the data's (a 300 m rounded decagon), which reaches 24 m past the tile's west edge: the model
stands where the building does and the pipeline clips its hull to the tile.
Night: the halo board glows, the glass concourse is lit by the facade shader.
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
        l.tri('lm_metal', B0, B1, T0, PANEL if i % 2 == 0 else PANEL_B, hint=out(((b0[0] + b1[0] + t0[0]) / 3, (b0[1] + b1[1] + t0[1]) / 3)))
        l.tri('lm_glass', B1, T0, T1, GLASS, hint=out(((b1[0] + t0[0] + t1[0]) / 3, (b1[1] + t0[1] + t1[1]) / 3)))
        if detail:
            for a, b in ((B0, T0), (B1, T0), (B1, T1)):
                l.beam('lm_metal', a, b, 0.7, 0.5, shade(PANEL, 0.8))
    return tops


def petals(l, tops, c, detail):
    """Eight roof petals from the eave ring (the antiprism's tops) to the opening, each twisted about 30 degrees from the one outside it."""
    npet = 8
    rows = 4 if detail else 2
    cols = 5 if detail else 2
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
        l.skin('lm_lit', grid, col, closed=False, inside=(c[0], 20.0, c[1]), flip=False)
        # the seam to the next petal
        # the seam to the next petal, a dark groove along the roof's curve
        for r in range(rows):
            a, b = grid[r][-1], grid[r + 1][-1]
            l.beam('lm_dark', (a[0], a[1] + 0.25, a[2]), (b[0], b[1] + 0.25, b[2]), 1.5 if detail else 2.4, 0.5, DARK_SEAM)
    # an oculus rim
    ring_o = circle(R_OCULUS, 32 if detail else 12, c[0], c[1])
    for i in range(len(ring_o)):
        a, b = ring_o[i], ring_o[(i + 1) % len(ring_o)]
        l.quad('lm_metal', (a[0], H_OCULUS - 0.4, a[1]), (b[0], H_OCULUS - 0.4, b[1]), (b[0], H_OCULUS + 0.8, b[1]), (a[0], H_OCULUS + 0.8, a[1]), SEAM, hint=(a[0] - c[0], 0, a[1] - c[1]))


def halo(l, c, n):
    """The halo board: a ring of screens, lit inside, hung at the opening."""
    y0, y1 = 77.0, 85.0
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = (c[0] + HALO_R * math.cos(a0), c[1] + HALO_R * math.sin(a0))
        p1 = (c[0] + HALO_R * math.cos(a1), c[1] + HALO_R * math.sin(a1))
        led = srgb(0xcfe6ff) if (i // 2) % 3 else srgb(0x9fc4ff)
        # inner face: the screen
        l.quad('lm_glow', (p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (p1[0], y1, p1[1]), (p0[0], y1, p0[1]), led, hint=(c[0] - p0[0], 0, c[1] - p0[1]))
        # outer face and the rim
        q0 = (c[0] + (HALO_R + 1.2) * math.cos(a0), c[1] + (HALO_R + 1.2) * math.sin(a0))
        q1 = (c[0] + (HALO_R + 1.2) * math.cos(a1), c[1] + (HALO_R + 1.2) * math.sin(a1))
        l.quad('lm_metal', (q0[0], y0, q0[1]), (q1[0], y0, q1[1]), (q1[0], y1, q1[1]), (q0[0], y1, q0[1]), shade(SEAM, 0.6), hint=(q0[0] - c[0], 0, q0[1] - c[1]))
        l.quad('lm_metal', (p0[0], y1, p0[1]), (p1[0], y1, p1[1]), (q1[0], y1, q1[1]), (q0[0], y1, q0[1]), SEAM, hint=(0, 1, 0))
        l.quad('lm_metal', (p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (q1[0], y0, q1[1]), (q0[0], y0, q0[1]), shade(SEAM, 0.5), hint=(0, -1, 0))


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
        halo(l, c, 40 if detail else 16)
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
