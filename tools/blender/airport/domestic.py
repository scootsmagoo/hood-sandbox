"""Hartsfield-Jackson's Domestic Terminal, walk-in: the North Terminal (ticketing and baggage claim, the curb along its north face), the
great glass-roofed Atrium between it and the South Terminal (the food court, the departures boards, the security checkpoint across its
east end and the post-security hall with the Plane Train escalators, which leads on into Concourse T), and the room at its west end
left for the MARTA platform (the rail layer builds the station; its rectangle is `hooks.transitStation`). The South Terminal is drawn
from outside only, its doors closed.

Model frame (apt.py): origin at the hero's anchor on the floor, +X east, +Y up, +Z south. The outline is the data's (airport.json rings
0..2) squared off: the North block z -77.5..-37.6, the Atrium block z -37.6..39.4, the South block z 39.4..78.2, the west face at
x -156.9; the Atrium block meets Concourse T at x 141.4 (the seam; Concourse T draws everything east of it, floors at the same
elevation, the walk networks joined by door nodes facing each other across it).

No lettering anywhere: airline and shop signs are blank colour panels (`lm_screen`), their names only data.
"""
import math

from landmarks import lm
from landmarks.lm import mix, shade, srgb

from . import apt, interior as it
from .interior import (BLACK, BOARD, BRANDS, CEIL, COUNTER, COUNTER_F, GLASS_W, LIGHT, SEAT, STEEL, STEEL_D, TERRAZZO, TERRAZZO_D,
                       TERRAZZO_L, WALL, WALL_D, WOOD, hquad, solid, vquad, wall)

ID = 'atl-domestic-terminal'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

# ---------------------------------------------------------------------------------------------- the plan's numbers
XW = -156.9          # the west face
XE_N = 156.0         # the North block's east face
XE_S = 155.5         # the South block's east face
ZN = -77.5           # the north curb face
ZS = 78.2            # the south curb face
ZAN = -37.6          # the Atrium's north wall (the North block's south face)
ZAS = 39.4           # the Atrium's south wall
XSEAM = 141.4        # where Concourse T takes over
XM = -110.0          # the MARTA room's east wall
XA_E = 115.0         # the Atrium's high roof ends here (the post-security hall goes on under a flat ceiling)
X_NOTCH_N, Z_NOTCH_N = -136.0, -71.9
X_NOTCH_S, Z_NOTCH_S = -135.8, 72.0
T = 0.6              # wall thickness

H_BLOCK = 17.0       # North and South blocks' roofs
H_HALL = 9.0         # the North Terminal's ceiling
H_MARTA = 12.0       # the MARTA room's ceiling
H_CLER = 21.5        # the Atrium's eaves
H_RIDGE = 26.5       # the Atrium's ridge
Z_RIDGE = 0.9
H_GLAZE = 8.5        # the curb glazing's head

DOORS_N = [-104.5, -59.5, -11.0, 37.5, 72.5, 107.5]     # six entrances in the north facade (4 m)
DOORS_S = [-104.5, -59.5, -11.0, 37.5, 72.5, 107.5]     # the South Terminal's (closed)
DOOR_W = 4.0
OPEN_N = [(-108.0, -98.0), (-66.0, -53.0), (-20.0, -4.0), (31.0, 44.0)]   # North Terminal -> Atrium openings (x), head 7 m
OPEN_HEAD = 7.0
MARTA_OPEN = (-14.0, 14.0)    # the MARTA room -> Atrium opening (z), head 9 m
ISLANDS = [-127.0, -82.0, -37.0]           # ticketing counter islands (centre x), 30 m each
Z_COUNTER = -60.6                          # their front (the bag scales)
CAROUSELS = [20.0, 55.0, 90.0, 125.0]      # baggage carousels (centre x), along z
CAR_Z0, CAR_Z1 = -72.0, -44.0
LANES = [-17.5 + 5.0 * i for i in range(8)]  # security lanes (walk line z)
X_ARCH = 87.75
WELL = (110.0, -11.0, 134.0, 2.0)          # the Plane Train escalator well (x0, z0, x1, z1)
TRUSS_X = [-110.0 + 11.25 * k for k in range(21)]

# colours (linear)
PRECAST = srgb(0xcfc8ba)
PRECAST_D = srgb(0xb3ac9e)
GLASS_X = srgb(0x3c5566)
CANOPY = srgb(0xe8e8e4)
ROOF = srgb(0x8c8f92)
TRUSS = srgb(0xe9ebec)
PLANT = srgb(0x9ba1a6)

OUT_N, OUT_S, OUT_W, OUT_E = (0.0, -1.0), (0.0, 1.0), (-1.0, 0.0), (1.0, 0.0)


def facade(l, mat, a, b, y0, y1, col, u0, floors, out, fid, kind=lm.K_CIVIC):
    """A facade quad from a to b (x, z), ordered left to right seen from outside; returns u at its right end."""
    d = (out[1], -out[0])
    if (b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1] < 0:
        a, b = b, a
    l.facade_quad(mat, (a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), col, u0, kind, floors, 0, 3, fid, True, hint=(out[0], 0, out[1]))
    return u0 + math.hypot(b[0] - a[0], b[1] - a[1])


def spans(x0, x1, holes):
    """The parts of [x0, x1] outside the holes [(a, b)]."""
    out = []
    t = x0
    for a, b in sorted(holes):
        if b <= x0 or a >= x1:
            continue
        if a > t:
            out.append((t, a))
        t = max(t, b)
    if t < x1:
        out.append((t, x1))
    return out


# ---------------------------------------------------------------------------------------------- exterior
def curb_face(l, plan, z, x0, x1, out, doors, open_doors, detail, fid):
    """A curb facade along x at z (the North or South block's long face): glazing at the street level with entrance doors and vestibules,
    precast above, pilasters, a spandrel and a cornice, and the deep canopy on columns at the kerb."""
    sz = out[1]
    holes = [(d - DOOR_W / 2, d + DOOR_W / 2) for d in doors]
    u = 0.0
    # street level: glass between the doors, glass transoms over them
    if open_doors:
        for a, b in spans(x0, x1, holes):
            if detail:
                it.window_wall(l, (a, z), (b, z), it.FLOOR_Y, H_GLAZE, out, u, floors=2, step=2.0, transoms=(3.6,), fid=fid, ext_col=GLASS_X)
            else:
                facade(l, 'bld_glass', (a, z), (b, z), 0.0, H_GLAZE, GLASS_X, u, 2, out, fid)
        for d in doors:
            a, b = d - DOOR_W / 2, d + DOOR_W / 2
            if detail:
                it.window_wall(l, (a, z), (b, z), 3.6, H_GLAZE, out, 0.0, floors=1, step=2.0, fid=fid, ext_col=GLASS_X)
            else:
                facade(l, 'bld_glass', (a, z), (b, z), 3.6, H_GLAZE, GLASS_X, 0.0, 1, out, fid)
    else:
        u = facade(l, 'bld_glass', (x0, z), (x1, z), 0.0, H_GLAZE, GLASS_X, 0.0, 2, out, fid)
    # precast over the glazing
    facade(l, 'bld_wall', (x0, z), (x1, z), H_GLAZE, H_BLOCK, PRECAST, 0.0, 2, out, fid)
    # spandrel band and cornice
    zc = z + sz * 0.25
    l.box('lm_stone', ((x0 + x1) / 2, H_GLAZE + 0.45, zc), (x1 - x0, 0.9, 0.5), PRECAST_D, skip=('-x', '+x'))
    l.box('lm_stone', ((x0 + x1) / 2, H_BLOCK + 0.35, z + sz * 0.3), (x1 - x0 + 0.6, 1.3, 0.6), PRECAST, skip=('-x', '+x', '-y'))
    # pilasters: precast fins every 12 m (not across a door), slim mullion fins between them
    n = int((x1 - x0) / 12.0)
    for k in range(1, n):
        x = x0 + (x1 - x0) * k / n
        if any(abs(x - d) < DOOR_W / 2 + 1.0 for d in doors):
            continue
        l.box('lm_stone', (x, H_BLOCK / 2, z + sz * 0.42), (0.7, H_BLOCK, 0.84), PRECAST, skip=('-y',) if detail else ('-y', '+y'))
        if plan is not None:
            plan.add(lm.rect(x, z + sz * 0.42, 0.7, 0.84), H_BLOCK)
        for f in ((-1, 1) if detail else ()):
            xf = x + f * 4.0
            if any(abs(xf - d) < DOOR_W / 2 + 0.3 for d in doors):
                continue
            l.box('lm_metal', (xf, H_GLAZE / 2, z + sz * 0.2), (0.12, H_GLAZE, 0.4), STEEL_D, skip=('-y', '+y'))
    if not detail:
        for k in range(n * 3):
            xf = x0 + (x1 - x0) * (k + 0.5) / (n * 3)
            if not any(abs(xf - d) < DOOR_W / 2 + 0.3 for d in doors):
                l.box('lm_metal', (xf, H_GLAZE / 2, z + sz * 0.2), (0.12, H_GLAZE, 0.4), STEEL_D, skip=('-y', '+y', '-x' if sz < 0 else '+x'))
    # vestibules (glass boxes on the sidewalk, 6 x 3.5 m, 4 m high)
    for d in doors:
        zf = z + sz * 3.5
        if detail:
            glass = 'lm_window' if open_doors else 'lm_glass'
            for sx in (-1, 1):
                xs = d + sx * 3.0
                vquad(l, glass, (xs, z), (xs, zf), 0.0, 4.0, GLASS_W, (sx, 0))
                l.box('lm_metal', (xs, 2.0, zf), (0.14, 4.0, 0.14), STEEL_D, skip=('-y',))
            for a, b in ((d - 3.0, d - DOOR_W / 2), (d + DOOR_W / 2, d + 3.0)):
                vquad(l, glass, (a, zf), (b, zf), 0.0, 4.0, GLASS_W, out)
            vquad(l, glass, (d - DOOR_W / 2, zf), (d + DOOR_W / 2, zf), 3.1, 4.0, GLASS_W, out)
            l.box('lm_metal', (d, 3.1, zf), (DOOR_W, 0.16, 0.16), STEEL_D)
            if open_doors:
                # the sliding leaves, open behind the fixed panes
                for sx in (-1, 1):
                    vquad(l, 'lm_window', (d + sx * 2.05, zf - sz * 0.12), (d + sx * 2.95, zf - sz * 0.12), 0.0, 3.05, GLASS_W, out)
            else:
                vquad(l, 'lm_dark', (d - DOOR_W / 2, zf + sz * 0.02), (d + DOOR_W / 2, zf + sz * 0.02), 0.0, 3.1, srgb(0x2a3540), out)
                l.box('lm_metal', (d, 1.55, zf + sz * 0.05), (0.08, 3.1, 0.06), STEEL_D)
            l.box('lm_metal', (d, 4.15, (z + zf) / 2), (6.3, 0.3, 3.7), STEEL)
        else:
            l.box('lm_glass', (d, 2.0, z + sz * 1.75), (6.0, 4.0, 3.5), GLASS_W, skip=('-y',))
        if plan is not None:
            for sx in (-1, 1):
                plan.add(apt.seg_prism((d + sx * 3.0, z + sz * 0.3), (d + sx * 3.0, zf), 0.3), 4.0)
            for a, b in ((d - 3.15, d - DOOR_W / 2), (d + DOOR_W / 2, d + 3.15)):
                plan.add(apt.seg_prism((a, zf), (b, zf), 0.55), 4.0)
            if not open_doors:
                plan.add(apt.seg_prism((d - DOOR_W / 2, zf), (d + DOOR_W / 2, zf), 0.3), 4.0)
    # the canopy over the curb: 14 m deep, on columns at the kerb
    cz0, cz1 = z, z + sz * 14.0
    ca, cb = x0 + 6.0, x1 - 4.0
    yb, yt = 7.2, 8.0
    hquad(l, 'lm_stone', ca, min(cz0, cz1), cb, max(cz0, cz1), yb, CANOPY, up=False)
    hquad(l, 'lm_metal', ca, min(cz0, cz1), cb, max(cz0, cz1), yt, shade(CANOPY, 0.9), up=True)
    vquad(l, 'lm_metal', (ca, cz1), (cb, cz1), yb - 0.3, yt + 0.25, STEEL, out)
    for xx, sg in ((ca, -1), (cb, 1)):
        vquad(l, 'lm_metal', (xx, cz0), (xx, cz1), yb - 0.3, yt + 0.25, STEEL, (sg, 0))
    if detail:
        for k in range(3):
            zz = z + sz * (3.0 + 4.0 * k)
            hquad(l, 'lm_glow', ca + 1, min(zz, zz + sz * 0.3), cb - 1, max(zz, zz + sz * 0.3), yb - 0.01, srgb(0xfff0d0), up=False)
        # cantilever ribs over the columns
    # blank airline panels on the fascia over each door
    for k, d in enumerate(doors):
        it.screen(l, d, yb + 0.35, cz1 + sz * 0.08, 7.0, 0.8, out, col=BRANDS[(k * 3 + (0 if open_doors else 1)) % len(BRANDS)], depth=0.1)
    ncol = int((cb - ca) / 18.0)
    for k in range(ncol + 1):
        x = ca + 1.5 + (cb - ca - 3.0) * k / ncol
        zc = z + sz * 12.8
        if detail:
            l.lathe('lm_stone', [(0.45, -3.0), (0.4, 0.4), (0.38, yb - 0.6), (0.6, yb)], 10, CANOPY, cx=x, cz=zc, smooth=False)
            l.beam('lm_metal', (x, yb - 0.25, z + sz * 0.6), (x, yb - 0.25, cz1 - sz * 0.2), 0.35, 0.5, STEEL, caps=False)
        else:
            l.box('lm_stone', (x, (yb - 3.0) / 2, zc), (0.8, yb + 3.0, 0.8), CANOPY, skip=('-y',))
        plan and plan.add(lm.circle(0.5, 8, x, zc, phase=math.pi / 8), yb)


def block_walls(l, detail):
    """The rest of the outside: the blocks' end faces, the MARTA room's west face, the roofs and their plant."""
    fid = 7
    # North block: notch and west and east faces
    facade(l, 'bld_wall', (X_NOTCH_N, ZN), (X_NOTCH_N, Z_NOTCH_N), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_W, fid)
    facade(l, 'bld_wall', (XW, Z_NOTCH_N), (X_NOTCH_N, Z_NOTCH_N), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_N, fid)
    facade(l, 'bld_wall', (XW, ZAN), (XW, Z_NOTCH_N), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_W, fid)
    facade(l, 'bld_wall', (XE_N, ZN), (XE_N, ZAN), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_E, fid)
    # South block
    facade(l, 'bld_wall', (X_NOTCH_S, ZS), (X_NOTCH_S, Z_NOTCH_S), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_W, fid + 1)
    facade(l, 'bld_wall', (XW, Z_NOTCH_S), (X_NOTCH_S, Z_NOTCH_S), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_S, fid + 1)
    facade(l, 'bld_wall', (XW, ZAS), (XW, Z_NOTCH_S), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_W, fid + 1)
    facade(l, 'bld_wall', (XE_S, ZAS), (XE_S, ZS), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_E, fid + 1)
    # the MARTA room's west face: open below its ceiling (the rail layer's), a fascia above
    facade(l, 'bld_wall', (XW, ZAN), (XW, ZAS), H_MARTA, H_BLOCK, PRECAST, 0.0, 1, OUT_W, fid + 2)
    if not detail:
        vquad(l, 'lm_dark', (XW + 0.5, ZAN), (XW + 0.5, ZAS), 0.0, H_MARTA, srgb(0x23262a), OUT_W)
    l.box('lm_stone', (XW - 0.3, H_MARTA + 0.4, (ZAN + ZAS) / 2), (0.6, 0.8, ZAS - ZAN), PRECAST_D, skip=('-z', '+z'))
    # the seam face above Concourse T's roof
    facade(l, 'bld_wall', (XSEAM, ZAN), (XSEAM, ZAS), 7.0, H_BLOCK, PRECAST, 0.0, 2, OUT_E, fid + 3)
    # roofs
    nring = [(XW, ZAN), (XW, Z_NOTCH_N), (X_NOTCH_N, Z_NOTCH_N), (X_NOTCH_N, ZN), (XE_N, ZN), (XE_N, ZAN)]
    sring = [(XW, ZAS), (XE_S, ZAS), (XE_S, ZS), (X_NOTCH_S, ZS), (X_NOTCH_S, Z_NOTCH_S), (XW, Z_NOTCH_S)]
    l.cap('bld_roof', nring, H_BLOCK, ROOF)
    l.cap('bld_roof', sring, H_BLOCK, ROOF)
    l.cap('bld_roof', [(XW, ZAN), (XM, ZAN), (XM, ZAS), (XW, ZAS)], H_BLOCK, ROOF)
    l.cap('bld_roof', [(XA_E, ZAN), (XSEAM, ZAN), (XSEAM, ZAS), (XA_E, ZAS)], H_BLOCK, ROOF)
    # parapets on the end faces (the curb faces have their cornice)
    for a, b, o in (((XW, ZAN), (XW, Z_NOTCH_N), OUT_W), ((XE_N, ZN), (XE_N, ZAN), OUT_E), ((XW, ZAS), (XW, Z_NOTCH_S), OUT_W), ((XE_S, ZAS), (XE_S, ZS), OUT_E)):
        vquad(l, 'lm_stone', a, b, H_BLOCK, H_BLOCK + 1.0, PRECAST_D, o)
    # skylight strips over the halls (low glass ridges)
    for zc in (-62.0, -50.0, 52.0, 64.0):
        for xa, xb in ((-128.0, -4.0), (8.0, 148.0)):
            zw = 2.2
            l.quad('lm_glass', (xa, H_BLOCK, zc - zw), (xb, H_BLOCK, zc - zw), (xb, H_BLOCK + 1.4, zc), (xa, H_BLOCK + 1.4, zc), srgb(0x6f8ea0), hint=(0, 1, -1))
            l.quad('lm_glass', (xa, H_BLOCK + 1.4, zc), (xb, H_BLOCK + 1.4, zc), (xb, H_BLOCK, zc + zw), (xa, H_BLOCK, zc + zw), srgb(0x6f8ea0), hint=(0, 1, 1))
            for xx, sg in ((xa, -1), (xb, 1)):
                l.tri('lm_metal', (xx, H_BLOCK, zc - zw), (xx, H_BLOCK, zc + zw), (xx, H_BLOCK + 1.4, zc), PLANT, hint=(sg, 0, 0))
    # rooftop plant
    units = [(-120, -58, 14, 6), (-70, -50, 10, 5), (-20, -62, 16, 6), (40, -55, 12, 5), (95, -60, 18, 7), (135, -52, 9, 5),
             (-118, 58, 14, 6), (-60, 56, 12, 5), (0, 62, 18, 7), (60, 55, 10, 5), (110, 60, 16, 6)]
    for k, (x, z, w, d) in enumerate(units):
        h = 2.6 + (k % 3) * 0.6
        l.box('lm_metal', (x, H_BLOCK + h / 2, z), (w, h, d), shade(PLANT, 0.92 + 0.04 * (k % 3)), skip=('-y',))
        if detail:
            for f in range(int(w // 4)):
                l.disc('lm_dark', x - w / 2 + 2 + f * 4, H_BLOCK + h + 0.02, z, 1.1, 8, BLACK)
    if detail:
        for k, (x, z) in enumerate([(-90, -45), (10, -45), (80, -70), (-30, 70), (90, 48)]):
            l.box('lm_metal', (x, H_BLOCK + 1.6, z), (6, 3.2, 4), shade(PLANT, 0.85))


def atrium_roof(l, detail):
    """The Atrium's raised roof: clerestories over the blocks' roofs, a pitched glass roof on transverse steel trusses, glass gables."""
    glass = 'lm_window' if detail else 'lm_glass'
    gcol = GLASS_W if detail else srgb(0x7e98a6)

    def roof_y(z):
        if z <= Z_RIDGE:
            return H_CLER + (H_RIDGE - H_CLER) * (z - ZAN) / (Z_RIDGE - ZAN)
        return H_CLER + (H_RIDGE - H_CLER) * (ZAS - z) / (ZAS - Z_RIDGE)
    xa, xb = XM, XA_E
    # clerestories
    for z, o in ((ZAN, OUT_N), (ZAS, OUT_S)):
        vquad(l, glass, (xa, z), (xb, z), H_BLOCK, H_CLER, gcol, o)
        if detail:
            it.mullion_run(l, (xa, z), (xb, z), H_BLOCK, H_CLER, 5.625, o, col=TRUSS, w=0.18, d=0.25)
            # and outside: the frame at the eaves
        l.box('lm_metal', ((xa + xb) / 2, H_CLER + 0.3, z), (xb - xa + 0.8, 0.6, 0.8), TRUSS, skip=())
        l.box('lm_metal', ((xa + xb) / 2, H_BLOCK + 0.25, z), (xb - xa, 0.5, 0.6), TRUSS, skip=('-y',))
    # the glass slopes, one pane strip per truss bay
    xs = TRUSS_X if detail else [xa, xb]
    for i in range(len(xs) - 1):
        x0, x1 = xs[i], xs[i + 1]
        l.quad(glass, (x0, H_CLER, ZAN), (x1, H_CLER, ZAN), (x1, H_RIDGE, Z_RIDGE), (x0, H_RIDGE, Z_RIDGE), gcol, hint=(0, 1, -0.3))
        l.quad(glass, (x0, H_RIDGE, Z_RIDGE), (x1, H_RIDGE, Z_RIDGE), (x1, H_CLER, ZAS), (x0, H_CLER, ZAS), gcol, hint=(0, 1, 0.3))
    # ridge cap
    l.beam('lm_metal', (xa, H_RIDGE + 0.2, Z_RIDGE), (xb, H_RIDGE + 0.2, Z_RIDGE), 1.2, 0.4, TRUSS)
    # gables
    for x, o in ((xa, OUT_W), (xb, OUT_E)):
        pts = [(x, H_BLOCK, ZAN), (x, H_BLOCK, ZAS), (x, H_CLER, ZAS), (x, H_RIDGE, Z_RIDGE), (x, H_CLER, ZAN)]
        l.poly(glass, pts, gcol, hint=(o[0], 0, o[1]))
        if detail:
            for k in range(1, 12):
                z = ZAN + (ZAS - ZAN) * k / 12
                l.beam('lm_metal', (x + o[0] * 0.1, H_BLOCK, z), (x + o[0] * 0.1, roof_y(z) - 0.05, z), 0.2, 0.25, TRUSS, caps=False)
    if not detail:
        for x in TRUSS_X[1:-1]:
            l.beam('lm_metal', (x, H_CLER + 0.15, ZAN), (x, H_RIDGE + 0.15, Z_RIDGE), 0.4, 0.3, TRUSS, caps=False)
            l.beam('lm_metal', (x, H_RIDGE + 0.15, Z_RIDGE), (x, H_CLER + 0.15, ZAS), 0.4, 0.3, TRUSS, caps=False)
            for z, o in ((ZAN, OUT_N), (ZAS, OUT_S)):
                l.box('lm_metal', (x, (H_BLOCK + H_CLER) / 2, z + o[1] * 0.1), (0.25, H_CLER - H_BLOCK, 0.2), TRUSS, skip=('-y', '+y'))
        return
    # the frame over the glass (seen from above): a rib over each truss
    for x in TRUSS_X[1:-1]:
        l.beam('lm_metal', (x, H_CLER + 0.15, ZAN), (x, H_RIDGE + 0.15, Z_RIDGE), 0.3, 0.2, TRUSS, caps=False)
        l.beam('lm_metal', (x, H_RIDGE + 0.15, Z_RIDGE), (x, H_CLER + 0.15, ZAS), 0.3, 0.2, TRUSS, caps=False)
    # purlins (along x) and the trusses (across z)
    zs = [ZAN + (Z_RIDGE - ZAN) * k / 4 for k in range(1, 4)] + [Z_RIDGE + (ZAS - Z_RIDGE) * k / 4 for k in range(1, 4)]
    for z in zs:
        y = roof_y(z) - 0.2
        l.beam('lm_metal', (xa, y, z), (xb, y, z), 0.22, 0.3, TRUSS, caps=False)
    for x in TRUSS_X:
        yb = 18.6
        # top chords
        l.beam('lm_metal', (x, H_CLER - 0.25, ZAN), (x, H_RIDGE - 0.3, Z_RIDGE), 0.4, 0.5, TRUSS, caps=False)
        l.beam('lm_metal', (x, H_RIDGE - 0.3, Z_RIDGE), (x, H_CLER - 0.25, ZAS), 0.4, 0.5, TRUSS, caps=False)
        # bottom chord, a shallow arch
        pts = []
        for k in range(9):
            t = k / 8
            z = ZAN + (ZAS - ZAN) * t
            pts.append((x, yb + 2.2 * math.sin(math.pi * t), z))
        for a, b in zip(pts, pts[1:]):
            l.beam('lm_metal', a, b, 0.32, 0.36, TRUSS, caps=False)
        # web: a warren of diagonals between the chords
        for k in range(8):
            za, zb = pts[k][2], pts[k + 1][2]
            ya = pts[k][1]
            top = (x, roof_y(zb) - 0.35, zb)
            l.beam('lm_metal', (x, ya, za), top, 0.16, 0.16, TRUSS, caps=False)


# ---------------------------------------------------------------------------------------------- interior
def floors(l):
    """Terrazzo: bands across the North Terminal, a grid of squares in the Atrium, plain in the MARTA room."""
    fy = it.FLOOR_Y
    # North Terminal: 6 m bands, a dark border by the walls
    xs = [-150.0 + 6.0 * k for k in range(52)] + [XE_N - T]
    xs = sorted(set(min(x, XE_N - T) for x in xs))
    for i in range(len(xs) - 1):
        c = TERRAZZO if i % 2 == 0 else TERRAZZO_L
        if xs[i] >= 0.0:
            c = shade(c, 0.86)
        z0 = ZN + T if xs[i] >= X_NOTCH_N - 1e-6 else Z_NOTCH_N + T
        if xs[i] < X_NOTCH_N < xs[i + 1]:
            hquad(l, 'lm_floor', xs[i], Z_NOTCH_N + T, X_NOTCH_N, ZAN - T / 2, fy, c)
            hquad(l, 'lm_floor', X_NOTCH_N, ZN + T, xs[i + 1], ZAN - T / 2, fy, c)
            continue
        hquad(l, 'lm_floor', xs[i], z0, xs[i + 1], ZAN - T / 2, fy, c)
    # Atrium and the post-security hall: squares of 7.5 m, with a dark frame line every other one
    x = XM + T / 2
    gx = [XM + T / 2] + [XM + 7.5 * k for k in range(1, 31)] + [XSEAM]
    gx = [v for v in gx if v <= XSEAM]
    gz = [ZAN + T / 2] + [ZAN + 7.7 * k for k in range(1, 10)] + [ZAS - T / 2]
    w0, wz0, w1, wz1 = WELL
    for i in range(len(gx) - 1):
        for j in range(len(gz) - 1):
            a, b, c, d = gx[i], gz[j], gx[i + 1], gz[j + 1]
            if a >= w0 - 1e-6 and c <= w1 + 1e-6 and b >= wz0 - 1e-6 and d <= wz1 + 1e-6:
                continue
            col = TERRAZZO_L if (i + j) % 2 == 0 else TERRAZZO
            if i % 4 == 0 or j % 4 == 0:
                col = shade(col, 0.93)
            # cut the well out of the squares it touches
            if c > w0 and a < w1 and d > wz0 and b < wz1:
                for (p, q, r, s) in ((a, b, c, wz0), (a, wz1, c, d), (a, max(b, wz0), w0, min(d, wz1)), (w1, max(b, wz0), c, min(d, wz1))):
                    if r - p > 0.05 and s - q > 0.05:
                        hquad(l, 'lm_floor', p, q, r, s, fy, col)
                continue
            hquad(l, 'lm_floor', a, b, c, d, fy, col)
    # MARTA room
    hquad(l, 'lm_floor', XW, ZAN + T / 2, XM, ZAS - T / 2, fy, shade(TERRAZZO, 0.9))


def ceilings(l):
    """The North Terminal's and the post-security hall's ceilings at 9 m with light strips and downstand beams, the MARTA room's at 12."""
    # North Terminal
    hquad(l, 'lm_interior', X_NOTCH_N + T, ZN + T, XE_N - T, ZAN - T / 2, H_HALL, CEIL, up=False)
    hquad(l, 'lm_interior', -150.0, Z_NOTCH_N + T, X_NOTCH_N + T, ZAN - T / 2, H_HALL, CEIL, up=False)
    for k in range(6):
        z = ZN + 4.0 + 6.4 * k
        it.light_strip(l, -149.0 if z > Z_NOTCH_N else X_NOTCH_N + 1.0, z, XE_N - 1.5, z + 0.5, H_HALL - 0.02)
    for k in range(17):
        x = -144.0 + 18.0 * k
        if x > XE_N - 2:
            break
        l.box('lm_interior', (x, H_HALL - 0.4, (ZN + ZAN) / 2), (0.7, 0.8, ZAN - ZN - 1.2), shade(CEIL, 0.92), skip=('+y', '-z', '+z'))
    # post-security, east of the Atrium roof
    hquad(l, 'lm_interior', XA_E, ZAN + T / 2, XSEAM, ZAS - T / 2, H_HALL, CEIL, up=False)
    for k in range(6):
        z = ZAN + 6.0 + 12.5 * k
        if z > ZAS - 2:
            break
        it.light_strip(l, XA_E + 1, z, XSEAM - 1, z + 0.5, H_HALL - 0.02)
    # bulkhead at the Atrium's east end (9 m up to the blocks' roof line), facing west
    vquad(l, 'lm_interior', (XA_E, ZAN + T / 2), (XA_E, ZAS - T / 2), H_HALL, H_BLOCK, WALL, OUT_W)
    hquad(l, 'lm_interior', XA_E, ZAN + T / 2, XA_E + 0.6, ZAS - T / 2, H_HALL, CEIL, up=False)
    # at the seam: Concourse T's ceiling is at 7 m, a downstand closes the step
    vquad(l, 'lm_interior', (XSEAM, ZAN + T / 2), (XSEAM, ZAS - T / 2), 7.0, H_HALL, WALL, OUT_W)
    # MARTA room
    hquad(l, 'lm_interior', XW, ZAN + T / 2, XM - T / 2, ZAS - T / 2, H_MARTA, CEIL, up=False)
    for k in range(5):
        z = ZAN + 8.0 + 15.0 * k
        it.light_strip(l, XW + 1.0, z, XM - 1.5, z + 0.6, H_MARTA - 0.02)


def walls(l, plan):
    """The walls: the exterior walls' inside faces and their prisms, the Atrium's long walls, the MARTA room's east wall, the North
    Terminal's west partition."""
    # North facade (inside): the glazing is drawn by curb_face; a band over it to the ceiling, and the prisms with the door gaps
    gaps = [(d - DOOR_W / 2 - X_NOTCH_N, d + DOOR_W / 2 - X_NOTCH_N, None) for d in DOORS_N]
    wall(l, plan, (X_NOTCH_N, ZN + T / 2), (XE_N, ZN + T / 2), H_HALL, T, gaps, sides={-1: ('lm_interior', WALL)}, hull_h=H_BLOCK, y0=H_GLAZE, ends=False)
    # notch, west and east walls of the North block
    wall(l, plan, (X_NOTCH_N + T / 2, ZN), (X_NOTCH_N + T / 2, Z_NOTCH_N), H_HALL, T, sides={1: ('lm_interior', WALL)}, hull_h=H_BLOCK)
    wall(l, plan, (XW, Z_NOTCH_N + T / 2), (X_NOTCH_N, Z_NOTCH_N + T / 2), H_HALL, T, sides={-1: ('lm_interior', WALL)}, hull_h=H_BLOCK)
    wall(l, plan, (XW + T / 2, Z_NOTCH_N), (XW + T / 2, ZAN), H_HALL, T, sides={}, hull_h=H_BLOCK)
    wall(l, plan, (XE_N - T / 2, ZN), (XE_N - T / 2, ZAN), H_HALL, T, sides={-1: ('lm_interior', WALL)}, hull_h=H_BLOCK)
    # the North Terminal's west partition (back of house beyond)
    wall(l, plan, (-150.0, Z_NOTCH_N + T), (-150.0, ZAN - T / 2), H_HALL, 0.4, sides={1: ('lm_interior', WALL_D)}, hull_h=H_HALL)
    # the Atrium's north wall: North Terminal side to 9 m, Atrium side to 17 m (12 in the MARTA room, 9 east of the Atrium roof)
    gaps = [(a - XW, b - XW, OPEN_HEAD) for a, b in OPEN_N]
    wall(l, plan, (XW, ZAN), (XE_N, ZAN), H_HALL, T, gaps, sides={1: ('lm_interior', WALL)}, hull_h=H_BLOCK)
    for x0, x1, h in ((XW, XM, H_MARTA), (XM, XA_E, H_BLOCK), (XA_E, XSEAM, H_HALL)):
        g = [(a - x0, b - x0, OPEN_HEAD) for a, b in OPEN_N if a >= x0 and b <= x1]
        wall(l, None, (x0, ZAN), (x1, ZAN), h, T, g, sides={-1: ('lm_interior', WALL)})
    # the Atrium's south wall: the South Terminal is closed (its whole block is one prism)
    for x0, x1, h in ((XW, XM, H_MARTA), (XM, XA_E, H_BLOCK), (XA_E, XSEAM, H_HALL)):
        vquad(l, 'lm_interior', (x0, ZAS - T / 2), (x1, ZAS - T / 2), 0.0, h, WALL, OUT_N)
    plan.add([(XW, ZAS - T / 2), (XE_S, ZAS - T / 2), (XE_S, ZS), (X_NOTCH_S, ZS), (X_NOTCH_S, Z_NOTCH_S), (XW, Z_NOTCH_S)], H_BLOCK)
    # the MARTA room's east wall, with its opening into the Atrium; up to the blocks' roof on the Atrium side
    g = [(MARTA_OPEN[0] - (ZAN + T / 2), MARTA_OPEN[1] - (ZAN + T / 2), 9.0)]
    wall(l, plan, (XM, ZAN + T / 2), (XM, ZAS - T / 2), H_MARTA, T, g, sides={-1: ('lm_interior', WALL)}, hull_h=H_BLOCK)
    wall(l, None, (XM, ZAN + T / 2), (XM, ZAS - T / 2), H_BLOCK, T, g, sides={1: ('lm_interior', WALL)})
    # the Atrium's engaged pilasters under each truss, on both long walls, and a ledge at 9 m
    for x in TRUSS_X[1:-1]:
        if XM + 1 < x < XA_E - 1:
            for z, sg in ((ZAN + T / 2, 1), (ZAS - T / 2, -1)):
                if any(a - 0.8 < x < b + 0.8 for a, b in OPEN_N) and sg == 1:
                    continue
                if sg == -1 and -101.0 < x < -19.0:
                    continue
                solid(l, plan, 'lm_interior', x, z + sg * 0.35, 1.1, 0.7, 0.0, H_BLOCK, shade(WALL, 0.95))
    for z, sg in ((ZAN + T / 2, 1), (ZAS - T / 2, -1)):
        l.box('lm_interior', ((XM + XA_E) / 2, 9.2, z + sg * 0.3), (XA_E - XM, 0.4, 0.6), shade(WALL, 0.88), skip=('-x', '+x'))
    # a stone dado on the walls people walk along
    dado = srgb(0x8f877b)
    for a, b in spans(XM, XSEAM, OPEN_N):
        vquad(l, 'lm_stone', (a, ZAN + T / 2 + 0.03), (b, ZAN + T / 2 + 0.03), 0.0, 1.2, dado, OUT_S)
    for a, b in spans(-150.0, XE_N - T, OPEN_N):
        vquad(l, 'lm_stone', (a, ZAN - T / 2 - 0.03), (b, ZAN - T / 2 - 0.03), 0.0, 1.2, dado, OUT_N)
    for a, b in ((XM, -101.0), (-19.0, XSEAM)):
        vquad(l, 'lm_stone', (a, ZAS - T / 2 - 0.03), (b, ZAS - T / 2 - 0.03), 0.0, 1.2, dado, OUT_N)


def ticketing(l, plan, sc):
    """Counter islands parallel to the facade: bag scales and counters, the agents' lane, a bag belt, a back wall with blank airline
    panels; queue mazes in front; self-service kiosks."""
    zf = Z_COUNTER
    for k, cx in enumerate(ISLANDS):
        x0, x1 = cx - 15.0, cx + 15.0
        # counter (top, front panel) and scales
        solid(l, None, 'lm_interior', cx, zf + 0.95, 30.0, 0.8, 0.0, 1.1, COUNTER_F)
        l.box('lm_interior', (cx, 1.12, zf + 0.95), (30.2, 0.05, 0.95), COUNTER, skip=('-y',))
        for p in range(15):
            x = x0 + 1.0 + 2.0 * p
            l.box('lm_metal', (x, 0.18, zf + 0.3), (0.8, 0.36, 0.6), STEEL, skip=('-y',))
            # the agent's screen on the counter
            l.box('lm_dark', (x + 0.5, 1.35, zf + 1.05), (0.45, 0.32, 0.05), BLACK, skip=('-y',))
        # the belt behind the agents
        solid(l, None, 'lm_metal', cx, zf + 3.3, 30.0, 0.9, 0.0, 0.62, STEEL_D)
        l.box('lm_dark', (cx, 0.64, zf + 3.3), (30.0, 0.04, 0.7), BLACK, skip=('-y',))
        # the back wall with three airlines' panels
        solid(l, None, 'lm_interior', cx, zf + 4.05, 31.0, 0.5, 0.0, 4.6, WALL_D)
        for s in range(3):
            col = BRANDS[(k * 3 + s) % len(BRANDS)]
            xs = x0 + 5.0 + 10.0 * s
            it.screen(l, xs, 3.3, zf + 3.78, 8.6, 1.5, (0, -1), col=col, depth=0.06)
            # the counter-number screens below
            for q in range(4):
                it.screen(l, xs - 3.6 + q * 2.4, 2.1, zf + 3.79, 0.9, 0.45, (0, -1), col=shade(col, 0.6), depth=0.04)
        # the island's bulkhead: a lit fascia band over the counters, hung from the ceiling
        l.box('lm_interior', (cx, 6.6, zf + 1.6), (31.0, 1.2, 3.6), shade(WALL, 0.95), skip=())
        for s2 in range(3):
            col = BRANDS[(k * 3 + s2) % len(BRANDS)]
            vquad(l, 'lm_screen', (x0 + 10.0 * s2 + 0.3, zf - 0.21), (x0 + 10.0 * (s2 + 1) - 0.3, zf - 0.21), 6.2, 6.9, shade(col, 1.1), OUT_N)
        for xh in (x0 + 2.0, cx, x1 - 2.0):
            l.box('lm_metal', (xh, 8.1, zf + 1.6), (0.06, 1.8, 0.06), STEEL_D, skip=('-y', '+y'))
        it.light_strip(l, x0 + 0.5, zf + 0.2, x1 - 0.5, zf + 0.6, 5.99)
        plan.add(it.rect_xz(x0, zf, x1, zf + 3.8), 1.1)
        plan.add(it.rect_xz(x0 - 0.5, zf + 3.8, x1 + 0.5, zf + 4.3), 4.6)
        # queue maze in front (visual) and the people waiting in it
        rows = it.maze(l, cx - 11.0, cx + 11.0, -66.0, -62.6, 3)
        for r in range(3):
            z = -66.0 + (r + 0.5) * (3.4 / 3)
            for q in range(4):
                x = cx - 9.0 + q * 6.0 + (r % 2) * 2.0
                sc.append(('corner', x, z, it.yaw_of(0, 1), 1))
        # kiosks at the island's ends
        for x in (x0 + 0.5, x0 + 2.0, x1 - 2.0, x1 - 0.5):
            solid(l, None, 'lm_interior', x, -68.6, 0.6, 0.5, 0.0, 1.45, srgb(0xdedad2))
            l.box('lm_screen', (x, 1.25, -68.86), (0.42, 0.3, 0.02), srgb(0x6fa8e0), rot=0.0)
            plan.add(lm.rect(x, -68.6, 0.8, 0.7), 1.45)
            sc.append(('corner', x, -69.75, it.yaw_of(0, 1), 1))


def baggage(l, plan, sc):
    """Four oval carousels along z with their sloped feed belts out of the Atrium wall, arrival screens hung over their ends."""
    for k, cx in enumerate(CAROUSELS):
        cz = (CAR_Z0 + CAR_Z1) / 2
        it.carousel(l, plan, cx, cz, CAR_Z1 - CAR_Z0, 7.0, along_x=False)
        # the feed belt: down from a slot in the wall (4.4 m) onto the carousel's south end
        a = (cx, 4.4, ZAN - T / 2 - 0.1)
        b = (cx, 1.0, CAR_Z1 - 1.0)
        l.beam('lm_metal', (a[0], a[1] - 0.2, a[2]), (b[0], b[1] - 0.2, b[2]), 1.5, 0.45, STEEL)
        l.beam('lm_dark', (a[0], a[1] + 0.05, a[2]), (b[0], b[1] + 0.05, b[2]), 1.2, 0.08, BLACK, caps=False)
        for sx in (-1, 1):
            l.beam('lm_metal', (a[0] + sx * 0.72, a[1] + 0.3, a[2]), (b[0] + sx * 0.72, b[1] + 0.3, b[2]), 0.06, 0.5, STEEL_D, caps=False)
        vquad(l, 'lm_dark', (cx - 1.0, ZAN - T / 2 - 0.02), (cx + 1.0, ZAN - T / 2 - 0.02), 3.9, 5.6, BLACK, OUT_N)
        l.box('lm_metal', (cx, 5.8, ZAN - T / 2 - 0.4), (2.6, 0.4, 0.8), STEEL)
        plan.add(it.rect_xz(cx - 0.9, CAR_Z1 - 0.8, cx + 0.9, CAR_Z1 + 1.6), 2.2)
        # the hanging arrival screens at the north end
        for sx in (-1, 1):
            l.box('lm_metal', (cx + sx * 1.0, 6.9, CAR_Z0 - 2.0), (0.06, 4.2, 0.06), STEEL_D, skip=('-y', '+y'))
        it.screen(l, cx, 4.3, CAR_Z0 - 2.0, 3.2, 1.0, (0, 1), col=BOARD, rows=4, depth=0.18)
        it.screen(l, cx, 4.3, CAR_Z0 - 2.0 - 0.01, 3.2, 1.0, (0, -1), col=BOARD, rows=4, depth=0.1)
        # people waiting round it, facing the belt
        for side in (-1, 1):
            for q in range(5):
                z = CAR_Z0 + 3.0 + q * 5.5
                sc.append(('corner', cx + side * 4.8, z, it.yaw_of(-side, 0), 2))
        sc.append(('corner', cx, CAR_Z0 - 1.6, it.yaw_of(0, 1), 2))
        # lightboxes on the wall either side of the feed slot
        for sx in (-1, 1):
            it.screen(l, cx + sx * 7.0, 2.4, ZAN - T / 2 - 0.08, 3.0, 2.0, OUT_N, col=BRANDS[(k * 2 + (sx > 0)) % len(BRANDS)], depth=0.12)
    # baggage service offices at the east end: glazed fronts, a counter, blank signs
    for k, zc in enumerate((-67.2, -57.5, -47.8)):
        xf = XE_N - 5.0
        col = BRANDS[(k + 2) % len(BRANDS)]
        vquad(l, 'lm_window', (xf, zc - 4.45), (xf, zc - 1.4), 0.0, 3.2, GLASS_W, OUT_W)
        vquad(l, 'lm_window', (xf, zc + 1.4), (xf, zc + 4.45), 0.0, 3.2, GLASS_W, OUT_W)
        vquad(l, 'lm_interior', (xf, zc - 4.85), (xf, zc + 4.85), 3.2, 4.4, shade(WALL, 0.9), OUT_W)
        it.screen(l, xf - 0.1, 3.8, zc, 6.0, 0.7, OUT_W, col=col, depth=0.12)
        solid(l, plan, 'lm_interior', xf + 2.0, zc, 0.8, 4.0, 0.0, 1.1, COUNTER_F)
        l.box('lm_interior', (xf + 2.5, 2.2, zc - 4.85), (5.0, 4.4, 0.2), WALL_D)
        plan.add(apt.seg_prism((xf, zc - 4.85), (xf, zc - 1.4), 0.3), 4.4)
        plan.add(apt.seg_prism((xf, zc + 1.4), (xf, zc + 4.85), 0.3), 4.4)
        plan.add(apt.seg_prism((xf, zc - 4.85), (XE_N - T, zc - 4.85), 0.3), 4.4)
        hquad(l, 'lm_interior', xf, zc - 4.85, XE_N - T, zc + 4.85, 4.4, CEIL, up=False)
        sc.append(('corner', xf - 1.4, zc + 2.6, it.yaw_of(1, 0), 1))
    plan.add(apt.seg_prism((XE_N - 5.0, -42.95), (XE_N - T, -42.95), 0.3), 4.4)
    l.box('lm_interior', (XE_N - 2.5, 2.2, -42.95), (5.0, 4.4, 0.2), WALL_D)


def atrium(l, plan, sc):
    """The Atrium: the food court on the south wall, tables, planters with tall trees, the departures pylon and the board wall over the
    MARTA opening, benches, hanging banners."""
    # food court: eight counters against the South Terminal's wall
    for k in range(8):
        x0 = -100.0 + 10.0 * k
        x1 = x0 + 10.0
        cx = (x0 + x1) / 2
        col = BRANDS[(k * 3 + 1) % len(BRANDS)]
        zc = 34.8
        solid(l, plan, 'lm_interior', cx, zc + 0.4, 8.6, 0.8, 0.0, 1.1, shade(col, 0.5))
        l.box('lm_interior', (cx, 1.12, zc + 0.4), (8.8, 0.05, 1.0), COUNTER, skip=('-y',))
        # partitions between units, to the wall
        if k == 0:
            solid(l, plan, 'lm_interior', x0, (zc + ZAS - T / 2) / 2, 0.3, ZAS - T / 2 - zc, 0.0, 5.6, WALL_D)
        solid(l, plan, 'lm_interior', x1, (zc + ZAS - T / 2) / 2, 0.3, ZAS - T / 2 - zc, 0.0, 5.6, WALL_D)
        # the sign fascia and a menu board on the back wall (blank)
        it.screen(l, cx, 5.0, zc - 0.1, 9.4, 1.0, (0, -1), col=col, depth=0.2)
        it.screen(l, cx, 3.2, ZAS - T / 2 - 0.08, 6.0, 1.3, (0, -1), col=shade(col, 0.45), rows=3, depth=0.06)
        # back counter
        l.box('lm_metal', (cx, 0.5, ZAS - T / 2 - 0.5), (8.0, 1.0, 0.8), STEEL, skip=('-y',))
        sc.append(('eatery', cx - 2.0, zc - 1.2, it.yaw_of(0, 1), 2))
        sc.append(('eatery', cx + 2.0, zc - 1.2, it.yaw_of(0, 1), 2))
    # tables and chairs
    for i in range(8):
        for j in range(3):
            x = -96.0 + 9.6 * i + (j % 2) * 3.6
            z = 19.0 + 4.6 * j
            l.lathe('lm_metal', [(0.3, 0.0), (0.05, 0.05), (0.05, 0.72), (0.45, 0.72), (0.45, 0.76)], 8, STEEL, cx=x, cz=z, smooth=False)
            for q in range(4):
                a = math.pi / 4 + q * math.pi / 2
                px, pz = x + math.cos(a) * 0.85, z + math.sin(a) * 0.85
                rot = -a + math.pi / 2
                l.box('lm_interior', (px, 0.45, pz), (0.45, 0.06, 0.45), WOOD, rot=rot, skip=('-y',))
                bx, bz = x + math.cos(a) * 1.08, z + math.sin(a) * 1.08
                l.box('lm_interior', (bx, 0.68, bz), (0.45, 0.5, 0.05), shade(WOOD, 0.8), rot=rot)
            sc.append(('eatery', x + 1.5, z, it.yaw_of(-1, 0), 2))
    # planters with tall trees on the axis, benches beside them
    beds = [(-92.0, 0.0, 7.0, 3.0, 2), (-30.0, 0.0, 4.5, 3.0, 1), (0.0, 0.0, 4.5, 3.0, 1), (30.0, 0.0, 4.5, 3.0, 1), (-72.0, -20.0, 4.0, 3.0, 1),
            (-8.0, -20.0, 4.0, 3.0, 1), (48.0, -18.0, 4.0, 3.0, 1)]
    for k, (x, z, w, d, n) in enumerate(beds):
        it.planter(l, plan, x, z, w, d, trees=n, tree_h=8.5 - (k % 3) * 1.2, seed=k)
        for sz in (-1, 1):
            solid(l, plan, 'lm_interior', x, z + sz * (d / 2 + 1.4), min(w, 3.2), 0.55, 0.0, 0.45, WOOD)
            sc.append(('plaza', x + 1.6, z + sz * (d / 2 + 2.6), it.yaw_of(0, -sz), 2))
            sc.append(('plaza', x - 1.6, z + sz * (d / 2 + 2.6), it.yaw_of(0, -sz), 2))
    # the information desk: a round counter with a blank sign drum over it
    l.lathe('lm_interior', [(3.0, 0.0), (3.0, 1.05), (3.2, 1.1), (3.2, 1.16), (2.2, 1.16), (2.2, 0.0)], 16, COUNTER_F, cx=-31.0, cz=-19.0, smooth=False)
    l.lathe('lm_screen', [(2.6, 4.4), (2.6, 5.4)], 16, srgb(0x2b5fb0), cx=-31.0, cz=-19.0, smooth=False)
    for k in range(3):
        a = k * 2 * math.pi / 3
        l.box('lm_metal', (-31.0 + 2.6 * math.cos(a), 2.8, -19.0 + 2.6 * math.sin(a)), (0.08, 3.2, 0.08), STEEL_D, skip=('-y', '+y'))
    plan.add(lm.circle(3.2, 10, -31.0, -19.0), 1.16)
    sc.append(('corner', -31.0 + 4.0, -19.0, it.yaw_of(-1, 0), 2))
    sc.append(('corner', -31.0, -19.0 + 4.0, it.yaw_of(0, -1), 2))
    # wayfinding: blank hanging panels over the openings to the North Terminal and on the way to security
    for k, (a, b) in enumerate(OPEN_N):
        xm = (a + b) / 2
        for o in (OUT_N, OUT_S):
            it.screen(l, xm, 7.9, ZAN + 2.2 + o[1] * 0.06, b - a - 2.0, 0.9, o, col=srgb(0x1d2f5c) if k < 3 else srgb(0xe2b33c), depth=0.08)
    for z in (-12.0, 12.0):
        for o in (OUT_W, OUT_E):
            it.screen(l, 55.0 + o[0] * 0.06, 6.0, z, 9.0, 1.0, o, col=srgb(0xe2b33c), depth=0.08)
        for sx in (-1, 1):
            l.box('lm_metal', (55.0, 12.5, z + sx * 4.0), (0.05, 12.0, 0.05), STEEL_D, skip=('-y', '+y'))
    # the departures pylon (two faces) at x -60 on the axis
    solid(l, plan, 'lm_stone', -60.0, 0.0, 1.4, 13.0, 0.0, 8.2, srgb(0x6b7075))
    for sx in (-1, 1):
        it.screen(l, -60.0 + sx * 0.72, 5.0, 0.0, 11.0, 4.6, (sx, 0), col=BOARD, rows=12, depth=0.06)
        sc.append(('plaza', -60.0 + sx * 4.5, -3.0, it.yaw_of(-sx, 0), 3))
        sc.append(('plaza', -60.0 + sx * 4.5, 3.0, it.yaw_of(-sx, 0), 3))
    # the board wall over the MARTA opening, facing east
    it.screen(l, XM + 0.45, 12.6, 0.0, 26.0, 5.0, (1, 0), col=BOARD, rows=14, depth=0.12)
    for x in (-98.0, -88.0):
        for z in (-8.0, -2.0, 4.0, 10.0):
            sc.append(('plaza', x, z, it.yaw_of(-1, 0), 2))
    # banners hung from the trusses
    for k, x in enumerate(TRUSS_X[2:-2]):
        if k % 2:
            continue
        col = BRANDS[k % len(BRANDS)]
        for z in (-26.0, 27.0):
            a, b = (x - 1.3, z), (x + 1.3, z)
            vquad(l, 'lm_interior', a, b, 11.5, 18.0, col, (0, 1))
            vquad(l, 'lm_interior', a, b, 11.5, 18.0, shade(col, 0.9), (0, -1))
    # a few more people in the open
    for x in (-80.0, -45.0, -15.0, 15.0, 45.0):
        for z in (-28.0, -9.0, 10.0):
            sc.append(('plaza', x + 2.0, z + 1.2, it.yaw_of(1, 0), 2))


def security(l, plan, sc):
    """The checkpoint across the Atrium's east end: a stanchion maze, document podiums, eight lanes of divest belts, x-ray tunnels and
    walk-through arches, glass partitions closing the rest; the post-security hall beyond."""
    it.maze(l, 63.0, 77.0, -15.0, 15.0, 10)
    for z in (-15.0, -5.0, 5.0, 15.0):
        solid(l, plan, 'lm_interior', 79.1, z, 0.9, 1.3, 0.0, 1.15, srgb(0x5a6878))
        it.screen(l, 79.1, 1.3, z, 0.6, 0.3, (-1, 0), col=srgb(0x9fd0ff), depth=0.04)
        sc.append(('corner', 77.9, z, it.yaw_of(1, 0), 1))
    for r in range(10):
        z = -15.0 + 3.0 * (r + 0.5)
        sc.append(('corner', 66.0 + (r % 3) * 4.0, z, it.yaw_of(1 if r % 2 else -1, 0), 1))
    xr = srgb(0x8d9aa8)
    for i, c in enumerate(LANES):
        zb0, zb1 = c - 1.85, c - 1.05
        # divest belt, x-ray tunnel, exit belt
        solid(l, None, 'lm_metal', 83.5, (zb0 + zb1) / 2, 5.0, 0.8, 0.0, 0.85, STEEL)
        solid(l, None, 'lm_metal', 92.0, (zb0 + zb1) / 2, 5.0, 0.8, 0.0, 0.85, STEEL)
        for x in (83.5, 92.0):
            l.box('lm_dark', (x, 0.87, (zb0 + zb1) / 2), (5.0, 0.03, 0.64), BLACK, skip=('-y',))
        solid(l, None, 'lm_metal', X_ARCH, c - 1.45, 3.5, 1.2, 0.0, 1.9, xr)
        for sx in (-1, 1):
            vquad(l, 'lm_dark', (X_ARCH + sx * 1.76, c - 1.8), (X_ARCH + sx * 1.76, c - 1.1), 0.85, 1.5, BLACK, (sx, 0))
        plan.add(it.rect_xz(81.0, c - 2.05, 94.5, c - 0.85), 1.0)
        plan.add(it.rect_xz(X_ARCH - 1.75, c - 2.05, X_ARCH + 1.75, c - 0.85), 1.9)
        # the arch: two posts and a head
        for sg in (-1, 1):
            # drawn 0.3 thick; the prism grows away from the walk-through gap so it keeps 0.5 m^2
            solid(l, None, 'lm_metal', X_ARCH, c + sg * 0.7, 0.6, 0.3, 0.0, 2.2, srgb(0xc6ccd2))
            plan.add(it.rect_xz(X_ARCH - 0.35, min(c + sg * 0.55, c + sg * 1.3), X_ARCH + 0.35, max(c + sg * 0.55, c + sg * 1.3)), 2.2)
        l.box('lm_metal', (X_ARCH, 2.3, c), (0.6, 0.2, 1.7), srgb(0xc6ccd2))
        l.box('lm_screen', (X_ARCH - 0.31, 2.3, c), (0.02, 0.1, 0.5), srgb(0x60e080))
        # the glass divider to the next lane's tunnel
        z0, z1 = c + 0.85, (LANES[i + 1] - 2.05) if i + 1 < len(LANES) else ZAS - T / 2
        vquad(l, 'lm_window', (X_ARCH, z0), (X_ARCH, z1), 0.0, 2.4, GLASS_W, (1, 0))
        l.box('lm_metal', (X_ARCH, 2.42, (z0 + z1) / 2), (0.08, 0.06, z1 - z0), STEEL_D)
        plan.add(apt.seg_prism((X_ARCH, z0), (X_ARCH, z1), 0.3), 2.4)
    # the partition from the north wall to the first lane's tunnel
    z0, z1 = ZAN + T / 2, LANES[0] - 2.05
    vquad(l, 'lm_window', (X_ARCH, z0), (X_ARCH, z1), 0.0, 2.4, GLASS_W, (1, 0))
    l.box('lm_metal', (X_ARCH, 2.42, (z0 + z1) / 2), (0.08, 0.06, z1 - z0), STEEL_D)
    plan.add(apt.seg_prism((X_ARCH, z0), (X_ARCH, z1), 0.3), 2.4)
    # recompose benches beyond
    for c in LANES:
        solid(l, plan, 'lm_interior', 97.5, c + 1.6, 2.4, 0.6, 0.0, 0.45, WOOD)


def post_security(l, plan, sc):
    """The hall past security: the Plane Train escalators down behind a glass balustrade, seat rows, two island shops, columns."""
    x0, z0, x1, z1 = WELL
    # the well: walls down, a floor far below, three escalators descending east
    dep = -10.0
    for a, b, o in (((x0, z0), (x1, z0), (0, 1)), ((x1, z0), (x1, z1), (-1, 0)), ((x1, z1), (x0, z1), (0, -1)), ((x0, z1), (x0, z0), (1, 0))):
        vquad(l, 'lm_interior', a, b, dep, it.FLOOR_Y, WALL_D, o)
    hquad(l, 'lm_floor', x0, z0, x1, z1, dep, TERRAZZO_D)
    for k, zc in enumerate((z0 + 2.5, (z0 + z1) / 2, z1 - 2.5)):
        it.escalator(l, x0 + 1.0, zc, x0 + 1.0 + 17.0, zc, 0.0, dep + 0.2)
    # the balustrade (glass, a steel rail, a taller screen above it so nobody climbs in)
    for a, b, o in (((x0, z0), (x1, z0), (0, -1)), ((x1, z0), (x1, z1), (1, 0)), ((x1, z1), (x0, z1), (0, 1)), ((x0, z1), (x0, z0), (-1, 0))):
        vquad(l, 'lm_window', a, b, 0.0, 2.4, GLASS_W, o)
        l.beam('lm_metal', (a[0], 1.1, a[1]), (b[0], 1.1, b[1]), 0.08, 0.08, STEEL, caps=False)
        l.beam('lm_metal', (a[0], 2.42, a[1]), (b[0], 2.42, b[1]), 0.1, 0.06, STEEL_D, caps=False)
        vquad(l, 'lm_metal', a, b, -0.4, 0.0, STEEL_D, o)
        plan.add(apt.seg_prism(a, b, 0.3), 2.4)
    # a hanging sign panel over the escalators (blank, Plane Train green)
    it.screen(l, x0 - 0.3, 4.6, (z0 + z1) / 2, 8.0, 1.0, (-1, 0), col=srgb(0x2f9a5a), depth=0.25)
    # seat rows by the windows of the post-security hall
    for zr in (18.0, 24.0, 30.0):
        pts = it.seat_row(l, plan, (103.0, zr), (113.0, zr), (0, -1), 10, pair=True)
        for p in pts[::3]:
            sc.append(('seat', p[0], p[1], p[2], 1))
    # two island shops
    for k, (cx, cz) in enumerate(((126.0, 22.0), (124.0, -27.0))):
        col = BRANDS[(k + 5) % len(BRANDS)]
        solid(l, plan, 'lm_interior', cx, cz, 7.0, 4.2, 0.0, 1.1, shade(col, 0.55))
        l.box('lm_interior', (cx, 1.12, cz), (7.2, 0.05, 4.4), COUNTER, skip=('-y',))
        l.box('lm_interior', (cx, 2.2, cz), (3.0, 2.2, 1.4), WALL_D, skip=('-y',))
        for sx in (-1, 1):
            for sz in (-1, 1):
                l.box('lm_metal', (cx + sx * 3.3, 2.0, cz + sz * 1.9), (0.1, 2.0, 0.1), STEEL_D, skip=('-y', '+y'))
        l.box('lm_interior', (cx, 3.25, cz), (7.4, 0.3, 4.6), shade(col, 0.8))
        for f, (o, w) in enumerate((((0, -1), 7.0), ((0, 1), 7.0), ((-1, 0), 4.2), ((1, 0), 4.2))):
            px, pz = cx + o[0] * (2.32 if o[0] else 0), cz + o[1] * (2.32 if o[1] else 0)
            if o[0]:
                px = cx + o[0] * 3.72
            it.screen(l, px, 3.6, pz, w - 0.6, 0.4, o, col=col, depth=0.04)
        for o in ((0, -1), (0, 1), (-1, 0)):
            sc.append(('shopfront', cx + o[0] * 4.6, cz + o[1] * 3.3, it.yaw_of(-o[0], -o[1]), 2))
    # columns under the flat ceiling
    for x in (XA_E + 2.0, XA_E + 14.0):
        for z in (-31.0, -18.0, 10.0, 31.0):
            it.column(l, plan, x, z, 0.45, H_HALL, col=WALL)
    # a gate-information screen pylon
    solid(l, plan, 'lm_stone', 104.0, -24.0, 1.0, 3.0, 0.0, 3.6, srgb(0x6b7075))
    it.screen(l, 104.0 - 0.52, 2.4, -24.0, 2.6, 1.8, (-1, 0), col=BOARD, rows=8, depth=0.04)
    it.screen(l, 104.0 + 0.52, 2.4, -24.0, 2.6, 1.8, (1, 0), col=BOARD, rows=8, depth=0.04)
    sc.append(('corner', 101.0, -24.0, it.yaw_of(1, 0), 3))


def north_columns(l, plan):
    """The North Terminal's columns: on an 18 m grid wherever they stand clear of the counters, carousels and doors."""
    for k in range(18):
        x = -141.0 + 18.0 * k
        if x > XE_N - 4:
            break
        for z in (-70.5, -53.5):
            if plan.clearance((x, z), reach=3.0) < 2.6 or any(abs(x - d) < 5.0 for d in DOORS_N):
                continue
            it.column(l, plan, x, z, 0.5, H_HALL, col=WALL, n=8)


def marta_room(l, plan):
    """The empty hall at the west end left for the MARTA platform: walls and lights only (the rail layer builds the station)."""
    for z, o in ((ZAN + T / 2, (0, 1)), (ZAS - T / 2, (0, -1))):
        for k in range(4):
            x = XW + 6.0 + 11.0 * k
            l.box('lm_interior', (x, H_MARTA / 2, z + o[1] * 0.3), (0.9, H_MARTA, 0.6), shade(WALL, 0.93), skip=('-y',))
            plan.add(lm.rect(x, z + o[1] * 0.3, 0.9, 0.6), H_MARTA)


# ---------------------------------------------------------------------------------------------- the walk network
def walk(plan, sc):
    P = plan
    FZ, BZ, BB = -74.4, -50.0, -40.6     # the North Terminal's front lane, back lane (ticketing), back lane (baggage claim)
    maze_z = [-66.0 + (r + 0.5) * (3.4 / 3) for r in range(3)]
    gap_x = sorted([cx + s * 17.5 for cx in ISLANDS for s in (-1, 1)])
    flank_x = sorted([cx + s * 11.8 for cx in ISLANDS for s in (-1, 1)])
    car_x = sorted([cx + s * 5.9 for cx in CAROUSELS for s in (-1, 1)])
    open_x = [(a + b) / 2 for a, b in OPEN_N]
    # --- North Terminal
    xs = sorted(set([-134.6, -131.5, XE_N - 7.5] + DOORS_N + gap_x + flank_x + car_x + [x for x in open_x if x > 0]))
    NZ = -70.2      # the front lane in the notch (west of x -136 the facade steps in to z -71.9)
    fz = lambda x: FZ if x > -134.0 else NZ
    P.path([(-148.0, NZ)] + [(x, fz(x)) for x in xs], w=4.0, step=7.0)
    xb = sorted(set([-148.0, -3.0] + gap_x + flank_x + [x for x in open_x if x < 0]))
    P.path([(x, BZ) for x in xb] + [(4.5, BB)] + [(x, BB) for x in sorted(set(car_x + [x for x in open_x if x > 0] + [XE_N - 7.5]))], w=4.0, step=7.0)
    for x in gap_x:
        P.path([(x, fz(x)), (x, BZ)], w=3.0, step=6.0)
    for cx in ISLANDS:
        for x in (cx - 11.8, cx + 11.8):
            P.path([(x, fz(x))] + [(x, z) for z in maze_z] + [(x, -61.8)], w=2.5, step=5.0)
        P.path([(cx - 11.8, -61.8), (cx + 11.8, -61.8)], w=2.0, step=6.0)
        for z in maze_z:
            P.path([(cx - 11.8, z), (cx + 11.8, z)], w=1.0, step=6.0)
    for x in car_x:
        P.path([(x, FZ), (x, BB)], w=3.0, step=6.0)
    for d in DOORS_N:
        out = P.node(d, ZN - 3.5 - 2.5)
        P.edge(P.node(d, FZ), out, 3.5)
        P.door(out)
    # --- through the openings into the Atrium
    rows = [-30.0, -9.0, 10.0, 32.6]
    for x in open_x:
        P.path([(x, BZ if x < 0 else BB), (x, rows[0])], w=4.0, step=6.0)
    # --- Atrium lanes, and the cross lanes
    cross = [-104.0, -80.0, -45.0, -15.0, 15.0, 45.0, 58.0]
    for z in rows:
        P.path([(x, z) for x in sorted(set(cross + (open_x if z == rows[0] else [])))], w=4.0, step=7.0)
    for x in cross:
        P.path([(x, z) for z in rows], w=3.0, step=7.0)
    # --- the MARTA room
    P.path([(-104.0, -9.0), (-112.0, 0.0), (-150.0, 0.0)], w=4.0, step=7.0)
    P.path([(-104.0, 10.0), (-112.0, 0.0)], w=4.0)
    P.path([(-150.0, 0.0), (-150.0, -26.0), (-118.0, -26.0), (-112.0, 0.0)], w=3.0, step=7.0)
    P.path([(-150.0, 0.0), (-150.0, 26.0), (-118.0, 26.0), (-112.0, 0.0)], w=3.0, step=7.0)
    m = P.node(XW - 2.6, 0.0)
    P.edge(P.node(-150.0, 0.0), m, 4.0)
    P.door(m)
    # --- security: the maze, the podiums, through each lane
    P.path([(60.5, c) for c in LANES], w=3.0, step=5.0)
    for z in rows[:3]:
        P.edge(P.node(58.0, z), P.node(60.5, min(LANES, key=lambda c: abs(c - z))), 3.0)
    for c in LANES:
        P.path([(60.5, c), (78.0, c), (84.0, c), (X_ARCH, c), (91.5, c), (95.6, c)], w=1.0, step=6.0)
    P.path([(95.6, c) for c in LANES], w=3.0, step=5.0)
    # --- post-security: lanes round the well to the seam, door nodes facing Concourse T's
    PZ = [-33.0, -24.0, -15.0, 0.0, 6.0, 15.0, 24.0, 34.0]
    for c in (LANES[0], LANES[-1]):
        P.path([(95.6, c), (100.0, c)], w=3.0)
    P.path([(100.0, z) for z in sorted(PZ + [LANES[0], LANES[-1]])], w=4.0, step=7.0)
    for z in (-33.0, -15.0, 6.0, 15.0, 34.0):
        P.path([(100.0, z), (XSEAM - 1.0, z)], w=4.0, step=7.0)
    P.path([(XSEAM - 1.0, z) for z in PZ], w=3.0, step=7.0)
    for z in (-24.0, 0.0, 24.0):
        P.door(P.node(XSEAM - 1.0, z))


def scenarios(plan, sc):
    for typ, x, z, yaw, cap in sc:
        plan.scenario(typ, x, z, yaw, cap)


# ---------------------------------------------------------------------------------------------- levels
def lod0():
    l = lm.Lod(0)
    plan = it.Plan()
    sc = []
    walls(l, plan)
    curb_face(l, plan, ZN, X_NOTCH_N, XE_N, OUT_N, DOORS_N, True, True, 3)
    curb_face(l, plan, ZS, X_NOTCH_S, XE_S, OUT_S, DOORS_S, False, True, 4)
    block_walls(l, True)
    atrium_roof(l, True)
    floors(l)
    ceilings(l)
    ticketing(l, plan, sc)
    baggage(l, plan, sc)
    atrium(l, plan, sc)
    security(l, plan, sc)
    post_security(l, plan, sc)
    marta_room(l, plan)
    north_columns(l, plan)
    walk(plan, sc)
    scenarios(plan, sc)
    return l, plan


def lod1():
    l = lm.Lod(1)
    curb_face(l, None, ZN, X_NOTCH_N, XE_N, OUT_N, DOORS_N, True, False, 3)
    curb_face(l, None, ZS, X_NOTCH_S, XE_S, OUT_S, DOORS_S, False, False, 4)
    block_walls(l, False)
    atrium_roof(l, False)
    return l


def lod2():
    l = lm.Lod(2)
    nring = [(XW, ZAN), (XW, Z_NOTCH_N), (X_NOTCH_N, Z_NOTCH_N), (X_NOTCH_N, ZN), (XE_N, ZN), (XE_N, ZAN)]
    sring = [(XW, ZAS), (XE_S, ZAS), (XE_S, ZS), (X_NOTCH_S, ZS), (X_NOTCH_S, Z_NOTCH_S), (XW, Z_NOTCH_S)]
    for r in (nring, sring):
        l.ring_walls('bld_wall', r, 0.0, H_BLOCK, PRECAST, lm.K_CIVIC, floor_h=4.25, fid=9)
        l.cap('bld_roof', r, H_BLOCK, ROOF)
    facade(l, 'bld_wall', (XW, ZAN), (XW, ZAS), 0.0, H_BLOCK, PRECAST, 0.0, 4, OUT_W, 9)
    l.cap('bld_roof', [(XW, ZAN), (XM, ZAN), (XM, ZAS), (XW, ZAS)], H_BLOCK, ROOF)
    l.cap('bld_roof', [(XA_E, ZAN), (XSEAM, ZAN), (XSEAM, ZAS), (XA_E, ZAS)], H_BLOCK, ROOF)
    g = srgb(0x7e98a6)
    for z, o in ((ZAN, OUT_N), (ZAS, OUT_S)):
        vquad(l, 'lm_glass', (XM, z), (XA_E, z), H_BLOCK, H_CLER, g, o)
    l.quad('lm_glass', (XM, H_CLER, ZAN), (XA_E, H_CLER, ZAN), (XA_E, H_RIDGE, Z_RIDGE), (XM, H_RIDGE, Z_RIDGE), g, hint=(0, 1, -0.3))
    l.quad('lm_glass', (XM, H_RIDGE, Z_RIDGE), (XA_E, H_RIDGE, Z_RIDGE), (XA_E, H_CLER, ZAS), (XM, H_CLER, ZAS), g, hint=(0, 1, 0.3))
    for x, o in ((XM, OUT_W), (XA_E, OUT_E)):
        l.poly('lm_glass', [(x, H_BLOCK, ZAN), (x, H_BLOCK, ZAS), (x, H_CLER, ZAS), (x, H_RIDGE, Z_RIDGE), (x, H_CLER, ZAN)], g, hint=(o[0], 0, o[1]))
    for z, sz in ((ZN, -1), (ZS, 1)):
        hquad(l, 'lm_stone', X_NOTCH_N + 6, min(z, z + sz * 14), XE_S - 4, max(z, z + sz * 14), 7.6, CANOPY)
        hquad(l, 'lm_stone', X_NOTCH_N + 6, min(z, z + sz * 14), XE_S - 4, max(z, z + sz * 14), 7.2, shade(CANOPY, 0.8), up=False)
        vquad(l, 'lm_stone', (X_NOTCH_N + 6, z + sz * 14), (XE_S - 4, z + sz * 14), 7.0, 8.0, CANOPY, (0, sz))
        vquad(l, 'lm_stone', (X_NOTCH_N, z + sz * 0.05), (XE_S, z + sz * 0.05), 0.0, H_GLAZE, GLASS_X, (0, sz))
        for k in range(8):
            x = X_NOTCH_N + 10 + k * 38.0
            l.box('lm_stone', (x, 3.6, z + sz * 12.8), (0.8, 7.2, 0.8), CANOPY, skip=('-y', '+y'))
        l.box('lm_stone', (10.0, H_BLOCK + 0.5, z + sz * -20.0), (200.0, 1.0, 3.0), shade(CANOPY, 0.9), skip=('-y',))
    for x, z in ((-120, -58), (-20, -62), (95, -60), (-118, 58), (0, 62), (110, 60)):
        l.box('lm_stone', (x, H_BLOCK + 1.5, z), (14.0, 3.0, 6.0), PLANT, skip=('-y',))
    return l


def outline():
    return [(XW, ZAN), (XW, Z_NOTCH_N), (X_NOTCH_N, Z_NOTCH_N), (X_NOTCH_N, ZN), (XE_N, ZN), (XE_N, ZAN), (XSEAM, ZAN), (XSEAM, ZAS),
            (XE_S, ZAS), (XE_S, ZS), (X_NOTCH_S, ZS), (X_NOTCH_S, Z_NOTCH_S), (XW, Z_NOTCH_S)]


def build(asset):
    apt.start()
    l0, plan = lod0()
    plan.check(ID)
    plan.prune()
    plan.check(ID + ' pruned')
    # names and indoor zones
    plan.place('Ticketing', -80.0, -58.0, 58.0)
    plan.place('Baggage Claim', 78.0, -58.0, 66.0)
    plan.place('Atrium', -30.0, 3.0, 82.0)
    plan.place('Security Checkpoint', 82.0, 0.0, 24.0)
    plan.place('Plane Train', (WELL[0] + WELL[2]) / 2, (WELL[1] + WELL[3]) / 2, 15.0)
    plan.zone([(-150.0, ZN + T), (XE_N - T, ZN + T), (XE_N - T, ZAN), (-150.0, ZAN)], H_HALL)
    plan.zone([(XM, ZAN), (XA_E, ZAN), (XA_E, ZAS), (XM, ZAS)], 19.0)
    plan.zone([(XA_E, ZAN), (XSEAM, ZAN), (XSEAM, ZAS), (XA_E, ZAS)], H_HALL)
    plan.zone([(XW, ZAN), (XM, ZAN), (XM, ZAS), (XW, ZAS)], H_MARTA)
    lods = [l0, lod1(), lod2()]
    for l in lods:
        it.clean(l)
    # the MARTA room for the rail layer: its centre in game coordinates, its long axis (z: yaw 0), its size
    h = apt.hero(ID)
    cx, cz = (XW + XM) / 2, (ZAN + ZAS) / 2
    hooks = {'transitStation': {
        'x': round(h['anchor']['x'] + cx, 2), 'z': round(h['anchor']['z'] + cz, 2), 'yaw': 0.0,
        'length': round(ZAS - ZAN - T, 1), 'width': round(XM - XW - T / 2, 1), 'floorY': 0.0,
        'note': 'The MARTA Airport station room at the Domestic Terminal\'s west end: an empty hall, ceiling 12 m, its west face (x = %.1f model) open full width '
                'below 12 m, its east wall (x = %.1f) opening %d m wide (z %.0f..%.0f model) and 9 m high into the Atrium. Floor drawn at y 0.02; no rails, platform '
                'or furniture: the rail layer builds the station inside it.' % (XW, XM, MARTA_OPEN[1] - MARTA_OPEN[0], MARTA_OPEN[0], MARTA_OPEN[1]),
    }}
    flat = [(apt.offset([tuple(p) for p in r], 2.0), 25.0) for r in h['rings']]
    from . import interior_preview as ip
    ip.install({
        'aerial': dict(cam=(330.0, 230.0, -330.0), at=(0.0, 0.0, 0.0), lens=30, samples=16),
        'aerial_sw': dict(cam=(-300.0, 160.0, 260.0), at=(0.0, 5.0, 0.0), lens=32, samples=16),
        'curb': dict(cam=(-40.0, 1.7, -96.0), at=(-10.0, 5.0, -78.0), lens=22, samples=16),
        'ticketing': dict(cam=(-62.0, 1.8, -73.0), at=(-82.0, 2.0, -58.0), lens=18, samples=20),
        'baggage': dict(cam=(40.0, 1.8, -73.0), at=(55.0, 1.5, -52.0), lens=18, samples=20),
        'atrium': dict(cam=(-100.0, 2.0, 30.0), at=(0.0, 9.0, -8.0), lens=16, samples=20),
        'atrium_up': dict(cam=(-20.0, 1.8, 20.0), at=(10.0, 18.0, -15.0), lens=14, samples=20),
        'security': dict(cam=(66.0, 3.2, 28.0), at=(88.0, 1.0, 0.0), lens=18, samples=20),
        'planetrain': dict(cam=(100.0, 2.0, 14.0), at=(122.0, -2.0, -4.0), lens=18, samples=20),
        'marta': dict(cam=(-104.0, 2.0, 12.0), at=(-150.0, 4.0, -5.0), lens=18, samples=20),
        'cutaway': dict(cam=(0.0, 400.0, 0.1), at=(0.0, 0.0, 0.0), ortho=330.0, clip=(392.0, 500.0), samples=8, size=(1400, 760)),
        'lod1': dict(cam=(330.0, 230.0, -330.0), at=(0.0, 0.0, 0.0), lens=30, samples=12, show=lambda n: n.startswith('lod1')),
        'lod2': dict(cam=(330.0, 230.0, -330.0), at=(0.0, 0.0, 0.0), lens=30, samples=12, show=lambda n: n.startswith('lod2')),
    })
    return apt.report(asset, ID, lods, plan.hull, lod_from=[0, 900, 2000], cutout=outline(), flatten=flat, interior=plan.interior(), hooks=hooks)
