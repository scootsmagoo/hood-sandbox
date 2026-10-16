"""Hartsfield-Jackson's Concourse T, walk-in: the long two-storey concourse on the Domestic Terminal's east end, its 21 gates (T1..T21)
on the apron side and round the north end, the jet bridges with their stairs and ground power units.

Inside, the whole length: a central corridor (terrazzo, a light trough with linear lights, moving walkways down its middle), the gates'
holdrooms on the east (apron) side (back-to-back seat rows, a gate podium and screen, floor-to-ceiling windows onto the parked aircraft
and the bridges), shops and restaurants on the west side (glazed fronts under blank sign panels), and the connector at z -110..+110
where the concourse widens west to meet the Domestic Terminal's post-security hall at the seam (model x -55.6, the terminal's
x 141.4): same floor, the walls continued, the walk networks joined by door nodes facing each other across it.

Model frame (apt.py): origin at the hero's anchor on the floor, +X east, +Y up, +Z south. The outline is the data's (airport.json ring),
squared off: the spine x 0.6..18.5 north of the connector, -2.5..19.3 south of it, the stepped north end, the connector's wings and the
east annex (drawn from outside, solid).
"""
import math

from landmarks import lm
from landmarks.lm import shade, srgb

from . import apt, interior as it
from .interior import (BLACK, BOARD, BRANDS, CARPET, CEIL, COUNTER, COUNTER_F, GLASS_W, LIGHT, SEAT, STEEL, STEEL_D, TERRAZZO,
                       TERRAZZO_D, TERRAZZO_L, WALL, WALL_D, WOOD, hquad, solid, vquad, wall)

ID = 'atl-concourse-t'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

# ---------------------------------------------------------------------------------------------- the plan's numbers
XSEAM = -55.6        # the Domestic Terminal's x 141.4
ZHN, ZHS = -36.6, 40.4   # the connector hall's north and south walls (the terminal's North and South blocks' faces)
XWING_N, XWING_S = -41.0, -41.5
XSHOP = 4.6          # the shopfronts' line (west edge of the corridor)
XHOLD = 11.6         # the corridor's east edge, where the holdrooms begin
XWB = -3.4           # the back wall of the wing shops
LANE_W, LANE_E = 5.9, 10.3
H_IN = 6.5           # the gate level's ceiling
H_TROUGH = 7.3
H_HALL = 7.0         # the connector hall's ceiling
H_GLAZE = 6.8        # the gate level's glazing, outside
H_ROOF = 14.0
H_CLER = 16.0
T = 0.4              # wall thickness (thin walls, exterior and interior)

RING = [(-28.9, -393.4), (18.5, -393.4), (18.5, -109.3), (19.6, -109.3), (19.6, -13.7), (44.4, -13.7), (44.5, -4.3), (65.4, -4.3),
        (65.3, 8.6), (52.1, 8.8), (46.4, 10.2), (42.0, 11.6), (36.2, 18.2), (27.6, 27.9), (19.3, 27.8), (19.3, 389.7), (6.3, 389.7),
        (6.3, 392.5), (-2.5, 392.5), (-2.5, 111.0), (-41.5, 79.4), (-41.5, ZHS), (XSEAM, ZHS), (XSEAM, ZHN), (-41.0, ZHN),
        (-41.0, -76.4), (0.6, -109.3), (0.6, -304.7), (-7.4, -304.7), (-7.4, -329.5), (-16.4, -329.5), (-16.4, -346.9),
        (-26.1, -346.9), (-26.1, -368.2), (-28.9, -368.2)]
ANNEX = RING[4:15]   # (19.6, -13.7) .. (19.3, 27.8): solid, outside only
# edges of RING drawn by the Domestic Terminal (shared walls) or open (the seam): no facade from here
SHARED = {(XSEAM, ZHS, XSEAM, ZHN), (-41.5, ZHS, XSEAM, ZHS), (XSEAM, ZHN, -41.0, ZHN), (-41.0, ZHN, -41.0, -76.4), (-41.5, 79.4, -41.5, ZHS)}

# colours
PANEL = srgb(0xc7c9c8)
PANEL_D = srgb(0x9ea3a6)
GLASS_X = srgb(0x3e5a6a)
ROOF = srgb(0x8e9194)
BRIDGE = srgb(0xc9cdd0)
BRIDGE_G = srgb(0x3a4a58)
BRIDGE_D = srgb(0x3b3f44)
GPU = srgb(0xd8b23a)


def xe_at(z):
    """The east (apron) wall of the spine at z."""
    return 18.5 if z < -109.3 else (19.6 if z < -13.7 else 19.3)


def xw_at(z):
    """The west wall of the spine (or the wing shops' back wall) at z."""
    if z < -304.7:
        return None
    if z <= -106.0:
        return 0.6
    if z < 108.0:
        return XWB
    return -2.5


def facade(l, mat, a, b, y0, y1, col, u0, floors, out, fid, kind=lm.K_CIVIC):
    d = (out[1], -out[0])
    if (b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1] < 0:
        a, b = b, a
    l.facade_quad(mat, (a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), col, u0, kind, floors, 0, 3, fid, True, hint=(out[0], 0, out[1]))
    return u0 + math.hypot(b[0] - a[0], b[1] - a[1])


def ring_edges():
    """The outline's edges with their outward normals (x, z) and whether this model draws them."""
    s = 1.0 if lm.area2(RING) > 0 else -1.0
    out = []
    n = len(RING)
    for i in range(n):
        a, b = RING[i], RING[(i + 1) % n]
        o = it.outward(a, b, s)
        key = (a[0], a[1], b[0], b[1])
        out.append((a, b, o, key not in SHARED and (b[0], b[1], a[0], a[1]) not in SHARED, RING.index(a) in range(4, 14)))
    return out


# ---------------------------------------------------------------------------------------------- gates and window runs
def gate_list():
    gs = []
    for g in apt.gates(ID):
        s = apt.snap_root(g, [RING])
        gs.append(s)
    return gs


class Run:
    """A window wall of holdrooms: from a to b (x, z), its outside `out`; s along it, d inward."""

    def __init__(self, a, b, out, name):
        self.a, self.b, self.out, self.name = a, b, out, name
        self.ln = math.hypot(b[0] - a[0], b[1] - a[1])
        self.u = ((b[0] - a[0]) / self.ln, (b[1] - a[1]) / self.ln)

    def p(self, s, d):
        return (self.a[0] + self.u[0] * s - self.out[0] * d, self.a[1] + self.u[1] * s - self.out[1] * d)

    def s_of(self, x, z):
        return (x - self.a[0]) * self.u[0] + (z - self.a[1]) * self.u[1]


def runs():
    return [
        Run((18.5, -393.0), (18.5, -109.3), (1, 0), 'east_n'),
        Run((19.6, -109.3), (19.6, -13.7), (1, 0), 'east_c'),
        Run((19.3, 27.8), (19.3, 389.7), (1, 0), 'east_s'),
        Run((-28.9, -393.4), (18.5, -393.4), (0, -1), 'north'),
        Run((-28.9, -368.2), (-28.9, -393.4), (-1, 0), 'w1'),
        Run((-26.1, -346.9), (-26.1, -368.2), (-1, 0), 'w2'),
        Run((-16.4, -329.5), (-16.4, -346.9), (-1, 0), 'w3'),
        Run((-7.4, -304.7), (-7.4, -329.5), (-1, 0), 'w4'),
        Run((-26.1, -368.2), (-28.9, -368.2), (0, 1), 's1'),
        Run((-16.4, -346.9), (-26.1, -346.9), (0, 1), 's2'),
        Run((-7.4, -329.5), (-16.4, -329.5), (0, 1), 's3'),
        Run((0.6, -304.7), (-7.4, -304.7), (0, 1), 's4'),
        Run((6.3, 389.7), (19.3, 389.7), (0, 1), 'south_e'),
        Run((-2.5, 392.5), (6.3, 392.5), (0, 1), 'south_w'),
        Run((6.3, 389.7), (6.3, 392.5), (1, 0), 'south_j'),
    ]


def windows(l, plan, run, doors, u0, fid):
    """The glazing of a run (inside: lm_window panes in mullions; outside: bld_glass), solid panels at the bridge doors. Returns the
    prisms' spans."""
    holes = sorted((max(0.0, s - 1.9), min(run.ln, s + 1.9)) for s in doors)
    spans = []
    t = 0.0
    for a, b in holes:
        if a > t:
            spans.append((t, a))
        t = max(t, b)
    if t < run.ln:
        spans.append((t, run.ln))
    o = run.out
    for s0, s1 in spans:
        if s1 - s0 < 0.2:
            continue
        a, b = run.p(s0, 0.05), run.p(s1, 0.05)
        it.window_wall(l, a, b, it.FLOOR_Y, H_IN, o, u0 + s0, floors=1, step=2.7, transoms=(3.2,), fid=fid, ext_col=GLASS_X, glass_out=False)
        # a sill and a head inside
        l.beam('lm_interior', (run.p(s0, 0.2)[0], 0.15, run.p(s0, 0.2)[1]), (run.p(s1, 0.2)[0], 0.15, run.p(s1, 0.2)[1]), 0.3, 0.3, WALL_D, caps=False)
    # outside: bld_glass for the gate level all along (the door panels behind it), the wall above
    a, b = run.p(0, -0.04), run.p(run.ln, -0.04)
    facade(l, 'bld_glass', a, b, 0.0, H_GLAZE, GLASS_X, u0, 2, o, fid)
    # the bridge doors' panels inside
    for s in doors:
        c = run.p(s, 0.25)
        rot = math.atan2(-run.u[1], run.u[0])
        l.box('lm_interior', (c[0], H_IN / 2, c[1]), (3.8, H_IN, 0.5), shade(WALL, 0.9), rot=rot, skip=('-y',))
        dp = run.p(s, 0.52)
        it.screen(l, dp[0], 1.2, dp[1], 1.5, 2.4, (-o[0], -o[1]), col=srgb(0x30363c), frame=STEEL_D, depth=0.04)
        it.screen(l, dp[0], 3.3, dp[1], 1.4, 0.5, (-o[0], -o[1]), col=srgb(0x2b5fb0), depth=0.05)
        plan.add(lm.rect(c[0], c[1], 3.8, 0.5, rot), H_IN)
    for s0, s1 in [(0.0, run.ln)]:
        plan.add(apt.seg_prism(run.p(s0, 0.15), run.p(s1, 0.15), 0.3), H_IN)
    return spans


def holdroom(l, plan, sc, run, s0, s1, doors, gate_ref, podium=True, rows_d=3.6):
    """Seats along a run between s0 and s1 (back-to-back pairs at d = rows_d, in stretches with aisles), avoiding the doors; a gate
    podium with its screen by the door. Returns the aisle positions (s) where people cross to the windows."""
    blocks = [(s - 6.5, s + 6.5) for s in doors]
    free = []
    t = s0
    for a, b in sorted(blocks):
        if b <= s0 or a >= s1:
            continue
        if a > t:
            free.append((t, a))
        t = max(t, b)
    if t < s1:
        free.append((t, s1))
    aisles = []
    for a, b in free:
        aisles += [a + 0.2, b - 0.2]
        a, b = a + 1.4, b - 1.4
        ln = b - a
        if ln < 3.0:
            continue
        n = max(1, int(math.ceil((ln + 2.5) / 11.5)))
        seg = (ln - 2.5 * (n - 1)) / n
        for k in range(n):
            u0 = a + k * (seg + 2.5)
            u1 = u0 + seg
            if k > 0:
                aisles.append(u0 - 1.25)
            nseat = max(4, int(seg / 0.62) // 2 * 2)
            pa, pb = run.p(u0, rows_d), run.p(u1, rows_d)
            pts = it.seat_row(l, plan, pa, pb, run.out, nseat, pair=True)
            # people sit facing the windows: every few seats of the window row, and one on the other side
            win = [p for p in pts if abs(p[2] - it.yaw_of(run.out[0], run.out[1])) < 0.01]
            inn = [p for p in pts if abs(p[2] - it.yaw_of(run.out[0], run.out[1])) >= 0.01]
            for p in win[1::max(1, len(win) // 3)][:3]:
                sc.append(('seat', p[0], p[1], p[2], 1))
            if inn:
                p = inn[len(inn) // 2]
                sc.append(('seat', p[0], p[1], p[2], 1))
    if podium:
        for s in doors:
            if not (s0 - 2 <= s <= s1 + 2):
                continue
            ps = s + 3.6 if s + 5 < s1 else s - 3.6
            c = run.p(ps, 5.5)
            rot = math.atan2(-run.u[1], run.u[0])
            solid(l, plan, 'lm_interior', c[0], c[1], 2.6, 0.8, 0.0, 1.1, COUNTER_F, rot=rot)
            l.box('lm_interior', (c[0], 1.12, c[1]), (2.8, 0.05, 0.95), COUNTER, rot=rot, skip=('-y',))
            sp = run.p(ps, 6.3)
            l.box('lm_metal', (sp[0], 1.2, sp[1]), (0.12, 2.4, 0.12), STEEL_D, rot=rot, skip=('-y',))
            it.screen(l, sp[0], 2.9, sp[1], 1.8, 1.0, (-run.out[0], -run.out[1]), col=srgb(0x2b5fb0), rows=3, depth=0.08)
            plan.add(lm.rect(sp[0], sp[1], 0.75, 0.75, rot), 2.4)
            q = run.p(ps, 7.4)
            sc.append(('corner', q[0], q[1], it.yaw_of(run.out[0], run.out[1]), 2))
            w = run.p(s + (2.8 if s + 5 < s1 else -2.8), 1.6)
            sc.append(('corner', w[0], w[1], it.yaw_of(run.out[0], run.out[1]), 2))
    out = []
    for a in sorted(aisles):
        if not out or a - out[-1] > 1.0:
            out.append(a)
    return out


# ---------------------------------------------------------------------------------------------- shops
KINDS = ['shop', 'eatery', 'shop', 'news', 'rest', 'shop', 'bar', 'shop', 'service']


def shop(l, plan, sc, z0, z1, xb, xf, k, face=1):
    """A unit along the corridor's west side between z0 and z1, from its back wall x = xb to its front x = xf (facing +x): a glazed
    shopfront with a door (or an open counter front), a blank sign panel over it, its own ceiling, goods or a counter inside.
    Returns the door's z (or None) and whether people browse there."""
    kind = KINDS[k % len(KINDS)]
    col = BRANDS[(k * 5 + 3) % len(BRANDS)]
    zc = (z0 + z1) / 2
    w = z1 - z0
    dz = 3.2 if kind != 'eatery' else 5.0
    door = (zc - dz / 2, zc + dz / 2)
    h_shop = 4.2
    # front wall: glass between piers, the bulkhead over it up to the ceiling
    gaps = [(door[0] - z0, door[1] - z0, None)]
    if kind in ('rest', 'service'):
        wall(l, plan, (xf, z0), (xf, z1), H_IN, 0.3, gaps if kind == 'rest' else [], sides={1: ('lm_interior', shade(WALL_D, 0.95))}, hull_h=H_IN)
    else:
        for a, b in ((z0 + 0.3, door[0]), (door[1], z1 - 0.3)):
            if b - a > 0.3:
                vquad(l, 'lm_window', (xf, a), (xf, b), 0.4, 3.6, GLASS_W, (1, 0))
                vquad(l, 'lm_interior', (xf, a), (xf, b), 0.0, 0.4, shade(col, 0.45), (1, 0))
                it.mullion_run(l, (xf + 0.1, a), (xf + 0.1, b), 0.4, 3.6, 1.6, (-1, 0), col=STEEL_D, w=0.06, d=0.1)
                plan.add(apt.seg_prism((xf, a), (xf, b), 0.3), H_IN)
        vquad(l, 'lm_interior', (xf, z0), (xf, z1), 3.6, h_shop, shade(WALL, 0.9), (1, 0))
        # piers at the unit's ends
        for z in (z0 + 0.15, z1 - 0.15):
            l.box('lm_interior', (xf + 0.05, 1.8, z), (0.4, 3.6, 0.3), WALL_D, skip=('-y',))
    vquad(l, 'lm_interior', (xf + 0.02, z0), (xf + 0.02, z1), h_shop, H_IN, shade(WALL, 0.97), (1, 0))
    if kind not in ('service',):
        it.screen(l, xf + 0.12, 5.0, zc, min(w - 1.2, 8.0), 0.8, (1, 0), col=col if kind != 'rest' else srgb(0x2b5fb0), depth=0.18)
    if kind in ('rest', 'service'):
        # closed behind: one prism for the unit (the walls are drawn)
        plan.add(it.rect_xz(xb, z0 + 0.2, xf - 0.4, z1 - 0.2), H_IN)
        return None, False
    # inside: floor, ceiling, the partitions and the back wall faces
    hquad(l, 'lm_floor', xb, z0, xf, z1, it.FLOOR_Y + 0.003, shade(TERRAZZO_L, 1.02))
    hquad(l, 'lm_interior', xb, z0, xf, z1, h_shop, CEIL, up=False)
    it.light_strip(l, xb + 0.8, zc - 0.25, xf - 0.8, zc + 0.25, h_shop - 0.02)
    vquad(l, 'lm_interior', (xb, z0), (xb, z1), 0.0, h_shop, shade(col, 0.35) if kind == 'eatery' else WALL, (1, 0))
    for z, o in ((z0, (0, 1)), (z1, (0, -1))):
        vquad(l, 'lm_interior', (xb, z), (xf, z), 0.0, h_shop, WALL_D, o)
    depth = xf - xb
    if kind in ('shop', 'news'):
        # shelves on the back wall and the sides, a till by the door
        l.box('lm_interior', (xb + 0.3, 1.1, zc), (0.6, 2.2, w - 1.0), shade(col, 0.7), skip=('-y', '-x'))
        for g in range(3):
            l.box('lm_screen', (xb + 0.62, 0.5 + 0.6 * g, zc), (0.02, 0.35, w - 1.6), shade(col, 0.9 - 0.15 * g), skip=('-y', '+y', '-z', '+z', '-x'))
        plan.add(it.rect_xz(xb, z0 + 0.4, xb + 0.75, z1 - 0.4), 2.2)
        if depth > 5.0:
            solid(l, plan, 'lm_interior', xb + depth * 0.55, zc, 1.2, w * 0.4, 0.0, 1.2, shade(col, 0.6))
        solid(l, plan, 'lm_interior', xf - 1.0, door[1] + 1.0, 0.7, 1.6, 0.0, 1.05, COUNTER_F)
        sc.append(('shopfront', xf + 1.1, zc - w * 0.25, it.yaw_of(-1, 0), 2))
        return zc, True
    # eatery or bar: a counter across the back, a menu board, tables
    solid(l, plan, 'lm_interior', xb + 1.4, zc, 0.8, w - 1.2, 0.0, 1.1, shade(col, 0.5))
    l.box('lm_interior', (xb + 1.4, 1.12, zc), (1.0, 0.05, w - 1.0), COUNTER, skip=('-y',))
    it.screen(l, xb + 0.05, 2.8, zc, w - 2.0, 1.0, (1, 0), col=shade(col, 0.5), rows=3, depth=0.04)
    sc.append(('eatery', xb + 2.6, zc, it.yaw_of(-1, 0), 2))
    if depth > 5.0:
        for q in range(2):
            tz = z0 + w * (0.25 + 0.5 * q)
            tx = xb + depth * 0.68
            l.lathe('lm_metal', [(0.25, 0.0), (0.05, 0.05), (0.05, 0.74), (0.42, 0.74), (0.42, 0.78)], 8, STEEL, cx=tx, cz=tz, smooth=False)
            for sz in (-1, 1):
                l.box('lm_interior', (tx, 0.45, tz + sz * 0.75), (0.42, 0.06, 0.42), WOOD, skip=('-y',))
                l.box('lm_interior', (tx, 0.7, tz + sz * 0.98), (0.42, 0.5, 0.05), shade(WOOD, 0.8))
            sc.append(('eatery', tx - 1.0, tz, it.yaw_of(1, 0), 2))
    else:
        sc.append(('eatery', xf + 1.1, zc, it.yaw_of(-1, 0), 2))
    return zc, False


def shop_row(l, plan, sc, z0, z1, xb_fn, xf, k0, width=11.0, face_lo=False, face_hi=False):
    """Units between z0 and z1 along the corridor; returns [(door z, browse)]."""
    n = max(1, int(round((z1 - z0) / width)))
    out = []
    for k in range(n):
        a = z0 + (z1 - z0) * k / n
        b = z0 + (z1 - z0) * (k + 1) / n
        xb = xb_fn((a + b) / 2) + 0.2
        door, _ = shop(l, plan, sc, a, b, xb, xf, k0 + k)
        # the partition at the unit's south end
        if k < n - 1:
            plan.add(apt.seg_prism((xb, b), (xf, b), 0.3), H_IN)
        if door is not None:
            out.append(door)
    plan.add(apt.seg_prism((xb_fn(z0 + 0.5) + 0.2, z0), (xf, z0), 0.3), H_IN)
    plan.add(apt.seg_prism((xb_fn(z1 - 0.5) + 0.2, z1), (xf, z1), 0.3), H_IN)
    for z, o, f in ((z0 - 0.15, (0, -1), face_lo), (z1 + 0.15, (0, 1), face_hi)):
        if f:
            vquad(l, 'lm_interior', (xb_fn(z) + 0.2, z), (xf, z), 0.0, H_IN, WALL, o)
    return out


def hall_shop(l, plan, sc, x0, x1, zf, zb, k):
    """A unit on the connector hall's north (zb < zf) or south edge, its front at zf facing the hall."""
    s = 1 if zb < zf else -1          # +1: the front faces +z
    col = BRANDS[(k * 3 + 2) % len(BRANDS)]
    xc = (x0 + x1) / 2
    w = x1 - x0
    door = (xc - 1.8, xc + 1.8)
    for a, b in ((x0 + 0.3, door[0]), (door[1], x1 - 0.3)):
        vquad(l, 'lm_window', (a, zf), (b, zf), 0.4, 3.6, GLASS_W, (0, s))
        vquad(l, 'lm_interior', (a, zf), (b, zf), 0.0, 0.4, shade(col, 0.45), (0, s))
        plan.add(apt.seg_prism((a, zf), (b, zf), 0.3), H_HALL)
    vquad(l, 'lm_interior', (x0, zf), (x1, zf), 3.6, H_HALL, shade(WALL, 0.92), (0, s))
    it.screen(l, xc, 4.6, zf + s * 0.12, w - 1.6, 0.9, (0, s), col=col, depth=0.18)
    for x in (x0 + 0.15, x1 - 0.15):
        l.box('lm_interior', (x, 1.8, zf + s * 0.05), (0.3, 3.6, 0.4), WALL_D, skip=('-y',))
    za, zz = min(zf, zb), max(zf, zb)
    hquad(l, 'lm_floor', x0, za, x1, zz, it.FLOOR_Y + 0.003, TERRAZZO_L)
    hquad(l, 'lm_interior', x0, za, x1, zz, 4.2, CEIL, up=False)
    vquad(l, 'lm_interior', (x0, zb), (x1, zb), 0.0, 4.2, shade(col, 0.4), (0, s))
    for x, o in ((x0, (1, 0)), (x1, (-1, 0))):
        vquad(l, 'lm_interior', (x, za), (x, zz), 0.0, 4.2, WALL_D, o)
        plan.add(apt.seg_prism((x, za), (x, zz), 0.3), H_HALL)
    kind = 'eatery' if k % 2 == 0 else 'shop'
    zm = (zf + zb) / 2
    if kind == 'eatery':
        solid(l, plan, 'lm_interior', xc, zb + s * 1.4, w - 1.2, 0.8, 0.0, 1.1, shade(col, 0.5))
        it.screen(l, xc, 2.8, zb + s * 0.06, w - 2.0, 1.0, (0, s), col=shade(col, 0.5), rows=3, depth=0.04)
        sc.append(('eatery', xc, zb + s * 2.6, it.yaw_of(0, -s), 2))
    else:
        l.box('lm_interior', (xc, 1.1, zb + s * 0.3), (w - 1.0, 2.2, 0.6), shade(col, 0.7), skip=('-y',))
        plan.add(it.rect_xz(x0 + 0.4, min(zb, zb + s * 0.75), x1 - 0.4, max(zb, zb + s * 0.75)), 2.2)
        solid(l, plan, 'lm_interior', xc, zm, w * 0.4, 1.2, 0.0, 1.2, shade(col, 0.6))
        sc.append(('shopfront', xc - w * 0.25, zf + s * 1.1, it.yaw_of(0, -s), 2))
    return xc


# ---------------------------------------------------------------------------------------------- exterior
def bridge_far(l, g):
    """A jet bridge for the far level: the link, the tunnel and the cab as three beams, the drive leg as one post."""
    rx, rz = g['root']
    tx, ty, tz = g['tip']
    dx, dz = tx - rx, tz - rz
    ln = math.hypot(dx, dz)
    ux, uz = dx / ln, dz / ln
    y0 = apt.ROOT_Y + apt.BRIDGE_H / 2
    rot = (rx + ux * 4.0, rz + uz * 4.0)
    cab = (tx - ux * 1.2, tz - uz * 1.2)
    l.beam('lm_metal', (rx, y0, rz), (rot[0], y0, rot[1]), apt.BRIDGE_W, apt.BRIDGE_H, BRIDGE)
    l.beam('lm_metal', (rot[0], y0, rot[1]), (cab[0], ty + apt.BRIDGE_H / 2, cab[1]), apt.BRIDGE_W, apt.BRIDGE_H, BRIDGE)
    leg = (rot[0] + (cab[0] - rot[0]) * 0.72, rot[1] + (cab[1] - rot[1]) * 0.72)
    l.box('lm_metal', (leg[0], (ty + apt.ROOT_Y) / 2 * 0.72, leg[1]), (0.5, (ty + apt.ROOT_Y) * 0.72, 1.8), BRIDGE_D, rot=math.atan2(ux, uz), skip=('-y', '+y'))


def exterior(l, plan, detail, gates):
    """Facades round the outline (the gate level glazed on the apron side, precast and metal above), the roof and its clerestory spine,
    the annex, the jet bridges with their stairs and ground power units."""
    u = 0.0
    for i, (a, b, o, drawn, annex) in enumerate(ring_edges()):
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        if not drawn or ln < 0.05:
            continue
        apron = (o[0] > 0.5 and not annex) or (o[1] < -0.5 and a[1] < -390) or (o[1] > 0.5 and a[1] > 380) or \
            (o[0] < -0.5 and a[1] < -304) or (o[1] > 0.5 and a[1] < -300)
        if annex:
            facade(l, 'bld_wall', a, b, 0.0, 12.0, PANEL_D, u, 3, o, 21)
        else:
            if not apron or not detail:
                facade(l, 'bld_glass' if apron else 'bld_wall', a, b, 0.0, H_GLAZE, GLASS_X if apron else PANEL_D, u, 2, o, 20)
            facade(l, 'bld_wall', a, b, H_GLAZE, H_ROOF, PANEL, u, 2, o, 20)
            # a sunshade ledge over the glazing, a parapet
            if apron:
                p0 = (a[0] + o[0] * 0.6, a[1] + o[1] * 0.6)
                p1 = (b[0] + o[0] * 0.6, b[1] + o[1] * 0.6)
                l.beam('lm_metal', (p0[0], H_GLAZE + 0.25, p0[1]), (p1[0], H_GLAZE + 0.25, p1[1]), 1.2, 0.35, PANEL_D)
            vquad(l, 'lm_stone', a, b, H_ROOF, H_ROOF + 0.9, PANEL_D, o)
            if ln > 3:
                p0 = (a[0] + o[0] * 0.25, a[1] + o[1] * 0.25)
                p1 = (b[0] + o[0] * 0.25, b[1] + o[1] * 0.25)
                l.beam('lm_metal', (p0[0], 10.6, p0[1]), (p1[0], 10.6, p1[1]), 0.5, 0.5, PANEL_D, caps=detail)
            if detail and apron and ln > 6:
                n = int(ln / 5.4)
                for k in range(1, n):
                    t = k / n
                    p = (a[0] + (b[0] - a[0]) * t + o[0] * 0.15, a[1] + (b[1] - a[1]) * t + o[1] * 0.15)
                    rot = math.atan2(-(b[1] - a[1]), b[0] - a[0])
                    l.box('lm_metal', (p[0], H_GLAZE / 2, p[1]), (0.12, H_GLAZE, 0.3), STEEL_D, rot=rot, skip=('-y', '+y'))
        u += ln
    # roofs: the concourse, the annex (lower)
    l.cap('bld_roof', [p for p in RING if p not in ANNEX[1:-1]], H_ROOF, ROOF)
    l.cap('bld_roof', ANNEX, 12.0, ROOF)
    # the clerestory spine over the corridor
    for z0, z1 in ((-388.0, -112.0), (-104.0, 104.0), (112.0, 386.0)):
        xa, xb = 5.6, 10.6
        for x, o in ((xa, (-1, 0)), (xb, (1, 0))):
            vquad(l, 'lm_glass', (x, z0), (x, z1), H_ROOF, H_CLER - 0.3, srgb(0x5a7a8c), o)
        l.box('lm_metal', ((xa + xb) / 2, H_CLER - 0.15, (z0 + z1) / 2), (xb - xa + 1.2, 0.3, z1 - z0 + 1.2), PANEL)
        for z, o in ((z0, (0, -1)), (z1, (0, 1))):
            vquad(l, 'lm_metal', (xa, z), (xb, z), H_ROOF, H_CLER - 0.3, PANEL_D, o)
    # rooftop plant
    for k, (x, z) in enumerate([(-20.0, -60.0), (-25.0, 60.0), (-35.0, 0.0), (2.5, -250.0), (14.0, -200.0), (14.0, 300.0), (2.0, 200.0), (14.0, 150.0), (40.0, 0.0)]):
        if not detail and k % 2:
            continue
        hb = H_ROOF if x < 20 else 12.0
        l.box('lm_metal', (x, hb + 1.3, z), (5.0 if x > 0 else 9.0, 2.6, 8.0), shade(PANEL_D, 0.95 + 0.03 * (k % 3)), skip=('-y',))
    # jet bridges
    hull = []
    for g in gates:
        hull += apt.jet_bridge(l, g, BRIDGE, BRIDGE_G, BRIDGE_D)
        if not detail:
            continue
        rx, rz = g['root']
        tx, ty, tz = g['tip']
        dx, dz = tx - rx, tz - rz
        ln = math.hypot(dx, dz)
        ux, uz = dx / ln, dz / ln
        rot = (rx + ux * 4.0, rz + uz * 4.0)
        # service stair from the rotunda down to the apron (to the side), with a landing
        nx, nz = -uz, ux
        # the side away from the next bridge: the stair runs along the wall, 4 m out
        sg = 1.0 if (nx + nz) >= 0 else -1.0
        top = (rot[0] + nx * sg * 2.4, rot[1] + nz * sg * 2.4)
        bot = (top[0] + nx * sg * 5.5, top[1] + nz * sg * 5.5)
        l.box('lm_metal', (top[0], apt.ROOT_Y - 0.1, top[1]), (1.6, 0.15, 1.6), BRIDGE_D)
        for sgn in (-1, 1):
            o = (ux * sgn * 0.5, uz * sgn * 0.5)
            l.beam('lm_metal', (top[0] + o[0], apt.ROOT_Y - 0.1, top[1] + o[1]), (bot[0] + o[0], 0.0, bot[1] + o[1]), 0.08, 0.3, BRIDGE_D, caps=False)
            l.beam('lm_metal', (top[0] + o[0], apt.ROOT_Y + 0.9, top[1] + o[1]), (bot[0] + o[0], 1.0, bot[1] + o[1]), 0.05, 0.05, GPU, caps=False)
        for k in range(8):
            t = (k + 0.5) / 8
            p = (top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t)
            y = apt.ROOT_Y - 0.1 - (apt.ROOT_Y - 0.1) * t
            l.box('lm_metal', (p[0], y, p[1]), (0.95, 0.05, 0.3), BRIDGE_D, rot=math.atan2(ux, uz), skip=('-y',))
        l.box('lm_metal', (top[0], apt.ROOT_Y / 2, top[1]), (0.15, apt.ROOT_Y, 0.15), BRIDGE_D, skip=('-y', '+y'))
        hull.append((lm.rect(bot[0], bot[1], 1.4, 1.4), 1.0))
        # ground power unit hung under the cab, and its cable reel
        cab = (tx - ux * 2.2, tz - uz * 2.2)
        l.box('lm_metal', (cab[0] - ux * 1.5, ty - 0.55, cab[1] - uz * 1.5), (1.2, 0.8, 1.6), GPU, rot=math.atan2(ux, uz))
        l.box('lm_dark', (cab[0] - ux * 1.5 + nx * 0.62, ty - 0.55, cab[1] - uz * 1.5 + nz * 0.62), (0.05, 0.4, 1.0), BLACK, rot=math.atan2(ux, uz))
    return hull


# ---------------------------------------------------------------------------------------------- interior: shell
def shell(l, plan):
    """Floors, ceilings, the light trough and the interior faces of the outer walls that are not windows; the wall prisms."""
    fy = it.FLOOR_Y
    # corridor terrazzo: a dark band down the middle (the walkways), light either side, bands across every 9 m
    zs = [-392.8 + 9.0 * k for k in range(88)] + [389.4]
    zs = sorted(set(z for z in zs if z <= 389.4))
    for i in range(len(zs) - 1):
        a, b = zs[i], zs[i + 1]
        c = TERRAZZO if i % 2 == 0 else TERRAZZO_L
        hquad(l, 'lm_floor', XSHOP, a, 7.2, b, fy, c)
        hquad(l, 'lm_floor', 7.2, a, 9.0, b, fy, TERRAZZO_D)
        hquad(l, 'lm_floor', 9.0, a, XHOLD, b, fy, c)
    # holdroom carpet along the east side
    for z0, z1 in ((-393.0, -109.3), (-109.3, -13.7), (-13.7, 27.8), (27.8, 389.4)):
        hquad(l, 'lm_floor', XHOLD, z0, xe_at((z0 + z1) / 2) - 0.2, z1, fy, CARPET if not (-13.7 <= z0 < 27.7) else TERRAZZO)
    # the north end west of the corridor, stepped
    for x0, z0, z1 in ((-28.7, -393.0, -368.2), (-25.9, -368.2, -346.9), (-16.2, -346.9, -329.5), (-7.2, -329.5, -304.7)):
        hquad(l, 'lm_floor', x0, z0, XSHOP, z1, fy, CARPET)
    # the south end west of the corridor (by the windows of the south face): carpet too
    hquad(l, 'lm_floor', -2.3, 382.0, XSHOP, 392.3, fy, CARPET)
    # the connector hall
    for i in range(6):
        x0 = XSEAM + (XSHOP - XSEAM) * i / 6
        x1 = XSEAM + (XSHOP - XSEAM) * (i + 1) / 6
        for j in range(6):
            z0 = ZHN + 0.3 + (ZHS - ZHN - 0.6) * j / 6
            z1 = ZHN + 0.3 + (ZHS - ZHN - 0.6) * (j + 1) / 6
            hquad(l, 'lm_floor', x0, z0, x1, z1, fy, TERRAZZO_L if (i + j) % 2 == 0 else TERRAZZO)
    # ceilings: the gate level at 6.5, the trough raised to 7.3 over the corridor's middle, the hall at 7
    for z0, z1 in ((-393.0, -109.3), (-109.3, ZHN), (ZHN, ZHS), (ZHS, 389.4)):
        hquad(l, 'lm_interior', 9.6, z0, xe_at((z0 + z1) / 2), z1, H_IN, CEIL, up=False)
        hquad(l, 'lm_interior', XSHOP, z0, 6.6, z1, H_IN, CEIL, up=False)
    for z0, z1 in ((-393.0, -36.6), (-36.6, 40.4), (40.4, 389.4)):
        hquad(l, 'lm_interior', 6.6, z0, 9.6, z1, H_TROUGH, CEIL, up=False)
        for x, o in ((6.6, (1, 0)), (9.6, (-1, 0))):
            vquad(l, 'lm_interior', (x, z0), (x, z1), H_IN, H_TROUGH, shade(CEIL, 0.9), o)
        it.light_strip(l, 7.0, z0 + 0.5, 7.25, z1 - 0.5, H_TROUGH - 0.02)
        it.light_strip(l, 8.95, z0 + 0.5, 9.2, z1 - 0.5, H_TROUGH - 0.02)
        # holdroom downlight lines
        it.light_strip(l, 14.5, z0 + 0.5, 14.7, z1 - 0.5, H_IN - 0.02)
    # the north end and the hall
    for x0, z0, z1 in ((-28.7, -393.0, -368.2), (-25.9, -368.2, -346.9), (-16.2, -346.9, -329.5), (-7.2, -329.5, -304.7)):
        hquad(l, 'lm_interior', x0, z0, XSHOP, z1, H_IN, CEIL, up=False)
        it.light_strip(l, x0 + 1.0, (z0 + z1) / 2 - 0.2, XSHOP - 1.0, (z0 + z1) / 2 + 0.2, H_IN - 0.02)
    hquad(l, 'lm_interior', -2.3, 382.0, XSHOP, 392.3, H_IN, CEIL, up=False)
    hquad(l, 'lm_interior', XSEAM, ZHN, XSHOP, ZHS, H_HALL, CEIL, up=False)
    for k in range(7):
        x = XSEAM + 4.0 + 8.4 * k
        it.light_strip(l, x, ZHN + 1.0, x + 0.5, ZHS - 1.0, H_HALL - 0.02)
    vquad(l, 'lm_interior', (XSHOP, ZHN), (XSHOP, ZHS), H_IN, H_HALL, CEIL, (-1, 0))
    # outer wall faces inside where there are no windows: the annex's wall (restrooms, service), the hall's long walls
    vquad(l, 'lm_interior', (19.6 - 0.2, -13.7), (19.3 - 0.2, 27.8), 0.0, H_IN, WALL, (-1, 0))
    plan.add(apt.seg_prism((19.45, -13.7), (19.15, 27.8), 0.4), H_ROOF)
    # the annex (outside only): solid; the east wall's jog at the connector's north end
    plan.add(ANNEX, 12.0)
    plan.add(apt.seg_prism((18.2, -109.5), (19.75, -109.5), 0.4), H_ROOF)
    for z, o in ((ZHN + T / 2, (0, 1)), (ZHS - T / 2, (0, -1))):
        vquad(l, 'lm_interior', (XSEAM, z), (XWING_N if o[1] > 0 else XWING_S, z), 0.0, H_HALL, WALL, o)
        plan.add(apt.seg_prism((XSEAM, z), ((XWING_N if o[1] > 0 else XWING_S) + 0.2, z), T), H_ROOF)
    # wing back walls (behind the shops): the wings beyond are back of house
    plan.add(apt.seg_prism((XWB, -106.0), (XWB, ZHN - 8.0), 0.3), H_IN)
    plan.add(apt.seg_prism((XWB, ZHS + 8.0), (XWB, 108.0), 0.3), H_IN)
    plan.add(apt.seg_prism((XWING_N, ZHN - 8.0), (XWB, ZHN - 8.0), 0.3), H_IN)
    plan.add(apt.seg_prism((XWING_S, ZHS + 8.0), (XWB, ZHS + 8.0), 0.3), H_IN)
    # the exterior west walls of the spine (the shops' backs) and the diagonal wing walls
    for a, b in (((0.6, -304.7), (0.6, -109.3)), ((0.6, -109.3), (-41.0, -76.4)), ((-41.5, 79.4), (-2.5, 111.0)), ((-2.5, 111.0), (-2.5, 392.5)),
                 ((-41.0, -76.4), (-41.0, ZHN)), ((-41.5, ZHS), (-41.5, 79.4))):
        plan.add(apt.seg_prism(a, b, T), H_ROOF)


def walkways(l):
    """Moving walkways down the corridor's middle: a dark belt, steel skirts and comb plates, low glass balustrades with handrails.
    Visual only (people cross at the gaps)."""
    spans = [(-296.0, -246.0), (-232.0, -186.0), (-166.0, -118.0), (118.0, 160.0), (186.0, 232.0), (252.0, 302.0), (322.0, 372.0)]
    x0, x1 = 7.35, 8.85
    for z0, z1 in spans:
        hquad(l, 'lm_dark', x0 + 0.15, z0 + 0.6, x1 - 0.15, z1 - 0.6, 0.1, BLACK)
        for z, o in ((z0, (0, -1)), (z1, (0, 1))):
            l.box('lm_metal', ((x0 + x1) / 2, 0.06, z + o[1] * -0.3), (x1 - x0, 0.12, 0.6), STEEL, skip=('-y',))
        for x, o in ((x0, (-1, 0)), (x1, (1, 0))):
            vquad(l, 'lm_metal', (x, z0), (x, z1), 0.0, 0.18, STEEL_D, o)
            vquad(l, 'lm_window', (x + o[0] * -0.08, z0 + 0.3), (x + o[0] * -0.08, z1 - 0.3), 0.18, 0.98, GLASS_W, o)
            l.beam('lm_dark', (x - o[0] * 0.08, 1.0, z0 + 0.3), (x - o[0] * 0.08, 1.0, z1 - 0.3), 0.1, 0.06, BLACK, caps=False)
            for z in (z0 + 0.3, z1 - 0.3):
                l.box('lm_metal', (x - o[0] * 0.08, 0.55, z), (0.14, 1.0, 0.3), STEEL_D, skip=('-y',))
    return spans


def signs(l, gates, gate_run, rs):
    """Blank hanging panels across the corridor (yellow wayfinding, every 60 m or so), and a gate panel over each holdroom."""
    for k in range(13):
        z = -360.0 + 60.0 * k
        if -40.0 < z < 44.0:
            continue
        for o in ((0, -1), (0, 1)):
            it.screen(l, 8.1, 4.9, z + o[1] * 0.07, 6.2, 0.8, o, col=srgb(0xe2b33c), depth=0.08)
        for x in (5.6, 10.6):
            l.box('lm_metal', (x, 6.0, z), (0.05, 1.0, 0.05), STEEL_D, skip=('-y', '+y'))
    for g in gates:
        name, sg = gate_run[g['ref']]
        if not name.startswith('east'):
            continue
        r = rs[name]
        p = r.p(sg + (3.6 if sg + 5 < r.ln else -3.6), 6.95)
        it.screen(l, p[0] - 0.05, 5.5, p[1], 2.6, 0.7, (-1, 0), col=srgb(0x1d2f5c), depth=0.1)


def columns(l, plan, avoid=()):
    """Columns down the corridor's east edge every 18 m, and a grid in the connector hall, where they stand clear."""
    for k in range(45):
        z = -384.0 + 18.0 * k
        if z > 385:
            break
        if -36.0 < z < 40.0:
            continue
        if plan.clearance((XHOLD, z), reach=2.5) < 1.8 or any(abs(z - a) < 1.8 for a in avoid):
            continue
        it.column(l, plan, XHOLD, z, 0.4, H_IN, col=WALL, n=8)
    for x in (-44.0, -28.0, -12.0):
        for z in (-18.0, 2.0, 22.0):
            it.column(l, plan, x, z, 0.5, H_HALL, col=WALL, n=10)


# ---------------------------------------------------------------------------------------------- the build
def lod0(gates):
    l = lm.Lod(0)
    plan = it.Plan()
    sc = []
    holds = {}
    rs = {r.name: r for r in runs()}
    door_s = {name: [] for name in rs}
    gate_run = {}
    for g in gates:
        rx, rz = g['root']
        best = None
        for r in rs.values():
            s = r.s_of(rx, rz)
            p = r.p(s, 0)
            d = math.hypot(p[0] - rx, p[1] - rz)
            if -0.5 <= s <= r.ln + 0.5 and (best is None or d < best[0]):
                best = (d, r.name, s)
        gate_run[g['ref']] = (best[1], best[2])
        door_s[best[1]].append(best[2])
    # exterior first (its facades share the window runs' u)
    hull = exterior(l, plan, True, gates)
    plan.add_many(hull)
    shell(l, plan)
    # window runs and the outer walls' prisms
    for name, r in rs.items():
        windows(l, plan, r, sorted(door_s[name]), 0.0, 22)
    # shops on the west side of the corridor, in the wings and on the hall's edges
    shop_doors = []
    shop_doors += [(z, 'w') for z in shop_row(l, plan, sc, -304.4, -106.0, xw_at, XSHOP, 0, 11.5, face_lo=True)]
    shop_doors += [(z, 'w') for z in shop_row(l, plan, sc, -106.0, ZHN, lambda z: XWB, XSHOP, 3, 11.5, face_hi=True)]
    shop_doors += [(z, 'w') for z in shop_row(l, plan, sc, ZHS, 108.0, lambda z: XWB, XSHOP, 7, 11.5, face_lo=True)]
    shop_doors += [(z, 'w') for z in shop_row(l, plan, sc, 108.0, 381.5, xw_at, XSHOP, 11, 11.5, face_hi=True)]
    hall_doors = []
    for k, (x0, x1) in enumerate(((-41.0, -28.6), (-28.6, -16.0), (-16.0, XWB))):
        hall_doors.append((hall_shop(l, plan, sc, x0, x1, ZHN, ZHN - 8.0, k), ZHN, 1))
    for k, (x0, x1) in enumerate(((-41.5, -28.8), (-28.8, -16.0), (-16.0, XWB))):
        hall_doors.append((hall_shop(l, plan, sc, x0, x1, ZHS, ZHS + 8.0, k + 3), ZHS, -1))
    # the south end, west of the corridor: a holdroom corner by the south windows
    walkspans = walkways(l)
    # holdrooms
    aisles = {}
    gz = {g['ref']: g for g in gates}
    order = sorted(gates, key=lambda g: (gate_run[g['ref']][0], gate_run[g['ref']][1]))
    for name, r in rs.items():
        ss = sorted(door_s[name])
        if name.startswith('east'):
            lo, hi = 0.5, r.ln - 0.5
            if name == 'east_n':
                lo = 4.5
            spans = []
            for k, s in enumerate(ss):
                a = lo if k == 0 else (ss[k - 1] + s) / 2 + 1.25
                b = hi if k == len(ss) - 1 else (s + ss[k + 1]) / 2 - 1.25
                spans.append((max(lo, a, s - 26.0), min(hi, b, s + 26.0)))
            al = []
            for (a, b), s in zip(spans, ss):
                al += holdroom(l, plan, sc, r, a, b, [s], None)
            aisles[name] = al
        elif name == 'north':
            al = holdroom(l, plan, sc, r, 1.5, 31.0, ss, None)
            aisles[name] = al
        elif name in ('w2', 'w3', 'w4'):
            aisles[name] = holdroom(l, plan, sc, r, 1.5, r.ln - 1.5, [], None, podium=False, rows_d=4.2)
        else:
            aisles[name] = []
    avoid = [rs[n].p(a, 0)[1] for n in ('east_n', 'east_c', 'east_s') for a in aisles.get(n, [])]
    columns(l, plan, avoid)
    # the hall: planters, benches, a departures pylon
    for k, (x, z) in enumerate(((-36.0, -8.0), (-20.0, 12.0), (-36.0, 30.0), (-20.0, -26.0))):
        it.planter(l, plan, x, z, 4.0, 2.6, trees=1, tree_h=5.6, seed=k + 3)
        for sz in (-1, 1):
            solid(l, plan, 'lm_interior', x, z + sz * 2.6, 3.0, 0.55, 0.0, 0.45, WOOD)
            sc.append(('plaza', x + 1.2, z + sz * 3.8, it.yaw_of(0, -sz), 2))
    solid(l, plan, 'lm_stone', -4.0, 2.0, 1.2, 10.0, 0.0, 5.6, srgb(0x6b7075))
    for sx in (-1, 1):
        it.screen(l, -4.0 + sx * 0.62, 3.4, 2.0, 8.6, 3.6, (sx, 0), col=BOARD, rows=10, depth=0.05)
        sc.append(('plaza', -4.0 + sx * 3.8, 2.0, it.yaw_of(-sx, 0), 3))
    for x in (-48.0, -14.0):
        for z in (-12.0, 16.0):
            sc.append(('plaza', x, z, it.yaw_of(1, 0), 2))
    # restroom and service doors in the annex wall (closed), lit signs
    for z in (-6.0, 6.0, 18.0):
        vquad(l, 'lm_dark', (19.05, z - 0.8), (19.05, z + 0.8), 0.0, 2.3, srgb(0x3a4048), (-1, 0))
        it.screen(l, 19.1, 2.9, z, 1.4, 0.4, (-1, 0), col=srgb(0x2b5fb0), depth=0.04)
    signs(l, gates, gate_run, rs)
    # more seats across the north fan, facing the north windows
    for zr in (-381.0, -373.5):
        for xa, xb in ((-24.5, -14.5), (-12.0, -2.0)):
            pts = it.seat_row(l, plan, (xa, zr), (xb, zr), (0, -1), 16, pair=True)
            for p in [q for q in pts if abs(q[2] - it.yaw_of(0, -1)) < 0.01][1::3][:3]:
                sc.append(('seat', p[0], p[1], p[2], 1))
    # the south end's corner by the south windows: a row of seats facing them
    pts = it.seat_row(l, plan, (-1.6, 388.6), (3.6, 388.6), (0, 1), 8, pair=True)
    for p in [q for q in pts if abs(q[2] - it.yaw_of(0, 1)) < 0.01][::2][:3]:
        sc.append(('seat', p[0], p[1], p[2], 1))
    walk(plan, sc, rs, aisles, door_s, shop_doors, hall_doors, walkspans)
    plan.path([(LANE_W, 384.0), (1.0, 384.0), (-1.0, 386.0)], w=2.5, step=5.0)
    for j in plan.nearest(LANE_W, 384.0, maxd=5.0, k=2, skip=(plan.node(LANE_W, 384.0),)):
        plan.edge(plan.node(LANE_W, 384.0), j, 3.0)
    for typ, x, z, yaw, cap in sc:
        plan.scenario(typ, x, z, yaw, cap)
    return l, plan, gate_run


def lattice(plan, x0, z0, x1, z1, step, inside, w=2.5, clear=1.0):
    """A grid of nodes over a region (where `inside(x, z)` and clear of the hull), joined to their neighbours where the line is clear."""
    nx = int(round((x1 - x0) / step))
    nz = int(round((z1 - z0) / step))
    ids = {}
    for i in range(nx + 1):
        for j in range(nz + 1):
            x = x0 + (x1 - x0) * i / nx
            z = z0 + (z1 - z0) * j / nz
            if inside(x, z) and plan.clearance((x, z), reach=1.5) >= clear:
                ids[(i, j)] = plan.node(x, z)
    for (i, j), a in sorted(ids.items()):
        for di, dj in ((1, 0), (0, 1)):
            b = ids.get((i + di, j + dj))
            if b is not None and plan.clear(plan.nodes[a], plan.nodes[b]):
                plan.edge(a, b, w)
    return ids


def walk(plan, sc, rs, aisles, door_s, shop_doors, hall_doors, walkspans):
    P = plan
    # corridor lanes: waypoints at every shop door (west lane), every holdroom aisle (east lane), every walkway gap
    gaps = [-388.0, 385.0]
    for k in range(len(walkspans) - 1):
        gaps.append((walkspans[k][1] + walkspans[k + 1][0]) / 2)
    gaps += [walkspans[0][0] - 4, walkspans[-1][1] + 4]
    wz = sorted(set([round(z, 2) for z, _ in shop_doors] + gaps + [ZHN + 4.0, ZHS - 4.0, -20.0, 0.0, 20.0, -106.0, 108.0]))
    hold_z = []
    for name in ('east_n', 'east_c', 'east_s'):
        r = rs[name]
        for s in aisles.get(name, []):
            hold_z.append(round(r.p(s, 0)[1], 2))
    ez = sorted(set(hold_z + gaps + [ZHN + 4.0, ZHS - 4.0, 0.0]))
    P.path([(LANE_W, z) for z in wz if -390.0 <= z <= 386.0], w=3.5, step=7.0)
    P.path([(LANE_E, z) for z in ez if -390.0 <= z <= 386.0], w=3.5, step=7.0)
    for z in gaps + [ZHN + 4.0, ZHS - 4.0, 0.0]:
        if -390.0 <= z <= 386.0:
            P.edge(P.node(LANE_W, z), P.node(LANE_E, z), 3.0)
    # into the shops
    for z, _ in shop_doors:
        xb = xw_at(z)
        inner = max(xb + 2.7, XSHOP - 2.0)
        P.edge(P.node(LANE_W, round(z, 2)), P.node(inner, round(z, 2)), 2.0)
    # into the holdrooms: from the east lane through each aisle to the window aisle, which runs along the windows
    for name in ('east_n', 'east_c', 'east_s'):
        r = rs[name]
        win = []
        for s in aisles.get(name, []):
            p_in = r.p(s, 1.5)
            P.edge(P.node(LANE_E, round(r.p(s, 0)[1], 2)), P.node(*p_in), 2.5)
            win.append(p_in)
        win.sort(key=lambda p: p[1])
        for a, b in zip(win, win[1:]):
            if abs(b[1] - a[1]) < 60 and P.clear(a, b):
                P.edge(P.node(*a), P.node(*b), 2.0)
    # the north end: a lattice over the fan of holdrooms, joined to the corridor's end
    def north_in(x, z):
        return apt.inside(RING, x, z) and z < -305.5 and x < XHOLD + 0.1 and not (XSHOP - 0.5 < x and z > -388.0 and x < XHOLD) and x > -28.0
    lattice(P, -26.5, -391.0, XHOLD + 5.0, -306.5, 3.0, lambda x, z: apt.inside(RING, x, z) and z < -305.5 and (x < XSHOP or z < -386.0 or x > XHOLD - 0.1), w=2.5)
    for z in (-389.0, -383.0, -377.0, -371.0, -365.0, -359.0, -350.0, -340.0, -330.0, -320.0, -310.0):
        for x in (LANE_W, LANE_E):
            i = P.node(x, z) if (round(x * 5), round(z * 5)) in P._nk else None
            if i is None:
                i = P.spur(x, z, w=3.0, maxd=8.0)
            for j in P.nearest(x, z, maxd=4.5, k=3, skip=(i,)):
                P.edge(i, j, 2.5)
    # the connector hall: a lattice, the shops on its edges, the seam's door nodes facing the terminal's
    lattice(P, XSEAM + 1.5, ZHN + 2.0, XSHOP - 1.0, ZHS - 2.0, 4.0, lambda x, z: True, w=3.0)
    for z in (ZHN + 4.0, -20.0, 0.0, 20.0, ZHS - 4.0):
        i = P.node(LANE_W, z) if (round(LANE_W * 5), round(z * 5)) in P._nk else P.spur(LANE_W, z, w=3.0)
        for j in P.nearest(LANE_W, z, maxd=6.0, k=2, skip=(i,)):
            P.edge(i, j, 3.0)
    for xc, zf, s in hall_doors:
        o = P.node(xc, zf + s * 2.0)
        inside = P.node(xc, zf - s * 2.6)
        P.edge(o, inside, 2.0)
        for j in P.nearest(xc, zf + s * 2.0, maxd=6.0, k=2, skip=(o, inside)):
            P.edge(o, j, 2.5)
    for zd in (-24.0, 0.0, 24.0):
        z = zd + 1.0          # the terminal's z + 1
        d = P.node(XSEAM + 1.0, z)
        for j in P.nearest(XSEAM + 1.0, z, maxd=6.0, k=2, skip=(d,)):
            P.edge(d, j, 3.0)
        P.door(d)


def lod1(gates):
    l = lm.Lod(1)
    exterior(l, None, False, gates)
    return l


def lod2(gates):
    l = lm.Lod(2)
    main = [p for p in RING if p not in ANNEX[1:-1]]
    l.ring_walls('bld_wall', main, 0.0, H_ROOF, PANEL, lm.K_CIVIC, floor_h=3.5, fid=23)
    l.cap('bld_roof', main, H_ROOF, ROOF)
    l.ring_walls('bld_wall', ANNEX, 0.0, 12.0, PANEL_D, lm.K_CIVIC, floor_h=4.0, fid=24)
    l.cap('bld_roof', ANNEX, 12.0, ROOF)
    l.box('lm_glass', (8.1, H_ROOF + 0.8, 0.0), (5.0, 1.6, 770.0), srgb(0x5a7a8c), skip=('-y',))
    for g in gates:
        # one open beam from the wall to the door
        rx, rz = g['root']
        tx, ty, tz = g['tip']
        l.beam('lm_metal', (rx, apt.ROOT_Y + 1.4, rz), (tx, ty + 1.4, tz), apt.BRIDGE_W, apt.BRIDGE_H, BRIDGE, caps=False)
    return l


def build(asset):
    apt.start()
    gates = gate_list()
    l0, plan, gate_run = lod0(gates)
    plan.check(ID)
    plan.prune()
    plan.check(ID + ' pruned')
    plan.place('Concourse T', -22.0, 2.0, 42.0)
    rs = {r.name: r for r in runs()}
    for g in gates:
        name, s = gate_run[g['ref']]
        r = rs[name]
        p = r.p(s, 4.0)
        plan.place('Gate ' + g['ref'], p[0], p[1], 16.0)
    # indoor zones
    plan.zone([(0.6, -393.0), (18.5, -393.0), (18.5, -109.3), (0.6, -109.3)], H_IN)
    plan.zone([(-28.9, -393.4), (0.6, -393.4), (0.6, -304.7), (-7.4, -304.7), (-7.4, -329.5), (-16.4, -329.5), (-16.4, -346.9), (-26.1, -346.9),
               (-26.1, -368.2), (-28.9, -368.2)], H_IN)
    plan.zone([(XWB, -109.3), (19.6, -109.3), (19.6, 108.0), (XWB, 108.0)], H_IN)
    plan.zone([(XSEAM, ZHN), (XWB, ZHN), (XWB, ZHS), (XSEAM, ZHS)], H_HALL)
    plan.zone([(-2.5, 108.0), (19.3, 108.0), (19.3, 392.5), (-2.5, 392.5)], H_IN)
    plan.zone([(XWING_N, ZHN - 8.0), (XWB, ZHN - 8.0), (XWB, ZHN), (XWING_N, ZHN)], 4.2)
    plan.zone([(XWING_S, ZHS), (XWB, ZHS), (XWB, ZHS + 8.0), (XWING_S, ZHS + 8.0)], 4.2)
    lods = [l0, lod1(gates), lod2(gates)]
    for l in lods:
        it.clean(l)
    flat = [(apt.offset(RING, 2.0), 25.0)]
    from . import interior_preview as ip
    t4 = next(g for g in gates if g['ref'] == 'T4')
    t5 = next(g for g in gates if g['ref'] == 'T5')
    t13 = next(g for g in gates if g['ref'] == 'T13')
    planes = [(g['stand'], g['yaw']) for g in gates if g['ref'] in ('T3', 'T4', 'T5', 'T6', 'T12', 'T13', 'T19')]
    ip.install({
        'aerial': dict(cam=(260.0, 200.0, -150.0), at=(0.0, 0.0, 30.0), lens=24, samples=16),
        'aerial_n': dict(cam=(140.0, 90.0, -470.0), at=(0.0, 4.0, -330.0), lens=28, samples=16),
        'apron': dict(cam=(62.0, 9.0, 160.0), at=(19.0, 4.0, 205.0), lens=24, samples=16),
        'corridor': dict(cam=(8.1, 1.8, 140.0), at=(8.1, 2.0, 260.0), lens=20, samples=20),
        'corridor_n': dict(cam=(8.1, 1.8, -120.0), at=(9.0, 2.0, -260.0), lens=20, samples=20),
        'holdroom': dict(cam=(12.5, 1.7, 214.0), at=(30.0, 3.0, 226.0), lens=16, samples=20),
        'holdroom2': dict(cam=(16.0, 1.7, -165.0), at=(14.0, 1.5, -190.0), lens=18, samples=20),
        'hall': dict(cam=(-50.0, 1.8, 30.0), at=(5.0, 2.5, -10.0), lens=18, samples=20),
        'northend': dict(cam=(9.0, 1.8, -340.0), at=(-14.0, 2.0, -390.0), lens=18, samples=20),
        'cutaway_c': dict(cam=(-15.0, 400.0, 0.1), at=(-15.0, 0.0, 0.0), ortho=120.0, clip=(394.2, 500.0), samples=8, size=(900, 1000)),
        'cutaway_n': dict(cam=(-5.0, 400.0, -350.0 + 0.1), at=(-5.0, 0.0, -350.0), ortho=100.0, clip=(394.2, 500.0), samples=8, size=(900, 1000)),
        'lod1': dict(cam=(260.0, 200.0, -150.0), at=(0.0, 0.0, 30.0), lens=24, samples=12, show=lambda n: n.startswith('lod1')),
        'lod2': dict(cam=(260.0, 200.0, -150.0), at=(0.0, 0.0, 30.0), lens=24, samples=12, show=lambda n: n.startswith('lod2')),
    }, setup=ip.placeholders(planes))
    return apt.report(asset, ID, lods, plan.hull, lod_from=[0, 1000, 2000], cutout=RING, flatten=flat, interior=plan.interior())
