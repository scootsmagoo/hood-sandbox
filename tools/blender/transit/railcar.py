"""The Peach Rapid Transit railcar: a 75 ft heavy-rail metro car in the manner of the Atlanta fleet's Breda/Hitachi-era cars
(fluted stainless sides, a livery band below the windows, a black-masked cab at one end), built to src/shared/data/railcar.json,
the file the sim reads. No logos, no lettering: the destination signs are blank faces the game draws on.

Frame: the car's (the sim's): +X the car's left, +Y up, +Z forward (the cab end); origin on the track centre, at the top of the
rail, in the middle of the car.

  railcar                          root; extras: asset, lod_tris, lod_from, leafTravel
    lod0                           near: exterior and a full interior (the camera rides inside)
      lod0_body                    the shell, cab front, underframe, couplers, lamps, sign faces
      lod0_interior                floor, linings, ceiling and light strips, seats, poles, rails, screens, bulkheads, the cab
      lod0_bogie_F / _R            empties on the bogie pivots (0, 0, +-bogieZ), the bogie under each (`_mesh`)
      lod0_door_L0_a ... _R2_b     empties at each door leaf's closed centre, the leaf under each (`_mesh`); L = +X side,
                                   R = -X, index in doors.z order, a = the -Z leaf (opens towards -Z), b = the +Z leaf
    lod1                           mid: exterior only, glass in front of a dark box, the same doors and bogies
    lod2                           far: a shell with the band and the windows as materials, doors and bogies merged
    anchors
      anchor_door_L0..2, anchor_door_R0..2    floor level at each door centre, on the body side (x = +-halfWidth)
      anchor_cam_window                       a seated eye by a left-side window (extras: yaw, seat)
      anchor_headlight                        between the headlights (extras: spread)
      anchor_coupler_F / _R                   the coupler faces

Materials (the game replaces each by name): tr_steel, tr_band, tr_cab, tr_glass, tr_dark, tr_interior, tr_floor, tr_light,
tr_head, tr_tail, tr_sign (the destination sign faces: 0..1 UVs across each face, u to the viewer's right, v up).
COLOR_0: linear albedo, alpha the baked ambient occlusion.
"""
import json
import math
import os

from hoodlib import scene
from . import tk
from .tk import Geo, box, hexa, mix, prism_x, revolve, shade, sign_quad, srgb, tube

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
D = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'railcar.json')))
VERTEX_COLOR = 'ACTIVE'

# ------------------------------------------------------------------------------------------- the numbers (railcar.json)
HL = D['length'] / 2
HW = D['halfWidth']
FLOOR = D['floorY']
ROOF = D['roofY']
SKIRT = D['skirtY']
BOGIE_Z = D['bogieZ']
WR = D['wheelR']
DOOR_Z = list(D['doors']['z'])
DHW = D['doors']['width'] / 2
DOOR_TOP = FLOOR + D['doors']['height']
TRAVEL = D['doors']['leafTravel']
CAB_Z0 = D['cab']['z0']
WS = D['cab']['windscreenY']
BAND = D['bandY']
WIN = D['windowY']
LOD_FROM = [0, 60, 220]

# ------------------------------------------------------------------------------------------- derived shape
SOLE = 0.92                    # the bottom of the body sides (the underframe hangs below, to skirtY)
SIDE_TOP = 3.10                # where the sides turn into the cant rail and roof
CROWN = ROOF - 0.07            # the roof's crown; the roof units reach roofY
WALL_IN = 1.47                 # the inside face of the side linings
LEAF_IN, LEAF_OUT = 1.5275, 1.5625   # a door leaf's faces (it slides in the cavity between lining and skin)
SLOT = (1.52, 1.57)            # the slot in the door jambs the leaves slide through
NOSE = 0.014                   # the rubber nose on a leaf's meeting edge
R_REAR, R_CAB = 0.14, 0.32     # plan radius of the body's corners at the gangway end and the cab end
CEIL = 3.28
END_IN = -HL + 0.23            # the gangway end wall, inside
BULK = (CAB_Z0 - 0.05, CAB_Z0 + 0.05)   # the cab bulkhead's two faces
CAB_FRONT_IN = HL - 0.13       # the cab's inner front wall
PIN = (BAND[0] - 0.045, BAND[0] - 0.02)  # the navy pinstripe under the band
FLUTE = (0.98, 1.48)           # the fluted lower sides
SIGN_SIDE = (8.55, 9.75, 2.81, 3.01)     # side destination sign: z0, z1, y0, y1 (both sides, near the cab)
SIGN_FRONT = (0.70, 3.13, 3.35)          # front sign: half width, y0, y1
WS_PANES = [(-1.12, -0.035), (0.035, 1.12)]
END_DOOR = (0.36, 3.0)         # gangway end door: half width, top
CAB_DOOR = (0.10, 0.80, 3.0)   # cab bulkhead door: x0, x1, top
HEAD_Y = 1.25

# side windows (z0, z1): clear of the door pockets (a leaf slides 0.64 m into the wall beside its opening)
WINDOWS = [(-10.95, -9.70), (-9.58, -8.35), (-5.45, -3.51), (-3.39, -1.45), (1.45, 3.39), (3.51, 5.45), (8.35, 9.95), (10.40, 11.0)]
for _z0, _z1 in WINDOWS:
    for _c in DOOR_Z:
        assert _z1 < _c - DHW - TRAVEL - 0.1 or _z0 > _c + DHW + TRAVEL + 0.1, ('window over a door pocket', _z0, _z1, _c)

# roof cross-section (half): (inset from the side, share of the rise from SIDE_TOP to CROWN)
ROOF_PROFILE = {
    0: [(0.0, 0.0), (0.015, 0.27), (0.055, 0.5), (0.13, 0.683), (0.27, 0.817), (0.5, 0.908), (0.85, 0.962), (1.22, 0.99), (HW, 1.0)],
    1: [(0.0, 0.0), (0.055, 0.5), (0.27, 0.817), (0.85, 0.962), (HW, 1.0)],
    2: [(0.0, 0.0), (0.13, 0.683), (0.85, 0.962), (HW, 1.0)],
}
CORNER_SEGS = {0: 4, 1: 2, 2: 1}

# ------------------------------------------------------------------------------------------- colours (linear)
STEEL = srgb(0xbcc0c3)
STEEL_DK = srgb(0x8d8f8f)
ROOF_C = srgb(0x9a9c9c)
PEACH = srgb(0xee8a4e)
NAVY = srgb(0x1d2b4f)
CAB_BLACK = srgb(0x151617)
RUBBER = srgb(0x232425)
UNDER = srgb(0x33312e)
BOGIE_C = srgb(0x2e2c29)
WHEEL_C = srgb(0x55524d)
LINING = srgb(0xe4dccb)
DADO = srgb(0x8a7660)
COVE = srgb(0xd8d0bf)
CEILING = srgb(0xefece4)
DIFFUSER = srgb(0xa9aaa6)
FABRIC = srgb(0xb0522b)
FABRIC_DK = srgb(0x8a3c1f)
SHELL = srgb(0x6b5a4a)
POLE = srgb(0xc8ccce)
FLOOR_C = srgb(0x6f655a)
FLOOR_VEST = srgb(0x5d5750)
EDGE_Y = srgb(0xd9b13a)
CAB_INT = srgb(0x45474a)
CONSOLE = srgb(0x2f3133)
ADS = [srgb(h) for h in (0xd9c39b, 0x8fb0c6, 0xe0aa94, 0xb4c49a, 0xd3cbbd, 0xbfa3c6, 0xe8d27a, 0x9ec2b6)]
WHITE = (1.0, 1.0, 1.0)
HEAD_C = srgb(0xfff2d8)
TAIL_C = srgb(0xff2a12)


def steel(p):
    """Stainless with road grime toward the bottom."""
    return mix(STEEL_DK, STEEL, min(1.0, max(0.0, (p[1] - 0.9) / 0.9)))


def in_door(z, pad=0.0):
    return any(abs(z - c) < DHW + pad for c in DOOR_Z)


def in_window(z):
    return any(z0 < z < z1 for z0, z1 in WINDOWS)


def uniq(xs):
    out = []
    for x in sorted(xs):
        if not out or x - out[-1] > 1e-6:
            out.append(x)
    return out


def seat_rows():
    """The seat rows of railcar.json: (back plane z, facing (+1 = +Z), hip y, [hip x...])."""
    rows = {}
    for x, y, z, yaw in D['seats']:
        f = 1 if math.cos(yaw) > 0 else -1
        key = (round(z, 3), f)
        rows.setdefault(key, (y, []))[1].append(x)
    out = []
    for (z, f), (y, xs) in sorted(rows.items()):
        out.append((z - f * 0.17, f, y, sorted(xs)))
    return out


# ------------------------------------------------------------------------------------------- plan outline and roof
def stations(lod):
    """Roof loft stations along the car: (z, half width at SIDE_TOP, roof rise factor, plan angle, end sign)."""
    n = CORNER_SEGS[lod]
    out = []
    for k in range(n, -1, -1):          # rear corner: from the end face round to the side
        t = math.pi / 2 * k / n
        out.append((-(HL - R_REAR) - R_REAR * math.sin(t), HW - R_REAR + R_REAR * math.cos(t), 1.0, t, -1))
    for k in range(0, n + 1):           # cab corner: from the side round to the front, the roof dropping a little
        t = math.pi / 2 * k / n
        out.append(((HL - R_CAB) + R_CAB * math.sin(t), HW - R_CAB + R_CAB * math.cos(t), 1.0 - 0.18 * math.sin(t) ** 2, t, 1))
    return out


def roof_half(lod, w, ky):
    """The roof's half section at a station: (x, y) from the side (x = w) to the crown (x = 0)."""
    return [((HW - dx) * w / HW, SIDE_TOP + (CROWN - SIDE_TOP) * f * ky) for dx, f in ROOF_PROFILE[lod]]


def roof_normals(lod):
    pts = [(HW - dx, SIDE_TOP + (CROWN - SIDE_TOP) * f) for dx, f in ROOF_PROFILE[lod]]
    out = []
    for i in range(len(pts)):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]   # dx < 0: from the side toward the crown
        ln = math.hypot(dx, dy)
        out.append((dy / ln, -dx / ln))     # outward on the +X side
    return out


def roof(g, lod):
    st = stations(lod)
    nrm = roof_normals(lod)
    m = len(ROOF_PROFILE[lod])
    rings, norms = [], []
    for z, w, ky, t, sg in st:
        half = roof_half(lod, w, ky)
        ring = [(x, y, z) for x, y in half] + [(-x, y, z) for x, y in reversed(half[:-1])]
        nh = [(nx * math.cos(t), ny, nx * math.sin(t) * sg) for nx, ny in nrm]
        nn = nh + [(-n[0], n[1], n[2]) for n in reversed(nh[:-1])]
        rings.append(ring)
        norms.append([tk.vnorm(n) for n in nn])
    for i in range(len(rings) - 1):
        for j in range(len(rings[i]) - 1):
            a, b, c, d = rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]
            na, nb, nc, nd = norms[i][j], norms[i][j + 1], norms[i + 1][j + 1], norms[i + 1][j]
            mid = tk.vnorm(tk.vadd(tk.vadd(na, nb), tk.vadd(nc, nd)))
            if tk.vsub(a, d) == (0.0, 0.0, 0.0):
                continue
            g.poly('tr_steel', [a, b, c, d], lambda p: mix(ROOF_C, STEEL, 0.25 * min(1.0, abs(p[0]) / HW)), hint=mid, normals=[na, nb, nc, nd])
    if lod <= 1:
        # two low roof units (the cooling sets): their tops are roofY
        for zc in (-5.2, 5.2):
            lo = [(0.74, CROWN - 0.04, zc - 1.35), (-0.74, CROWN - 0.04, zc - 1.35), (-0.74, CROWN - 0.04, zc + 1.35), (0.74, CROWN - 0.04, zc + 1.35)]
            hi = [(0.62, ROOF, zc - 1.22), (-0.62, ROOF, zc - 1.22), (-0.62, ROOF, zc + 1.22), (0.62, ROOF, zc + 1.22)]
            hexa(g, 'tr_steel', lo + hi, lambda p: shade(ROOF_C, 0.9 if p[1] > ROOF - 0.01 else 1.0), skip=('-y',))
            if lod == 0:
                for k in range(4):
                    z0 = zc - 0.95 + k * 0.5
                    box(g, 'tr_dark', (-0.5, ROOF - 0.002, z0), (0.5, ROOF + 0.0, z0 + 0.3), shade(RUBBER, 1.4), skip=('-y', '+x', '-x', '+z', '-z'))
    # the rain gutters along the cant rails, and the drips over the doors
    for s in (1, -1):
        if lod <= 1:
            x0, x1 = sorted((s * (HW - 0.002), s * (HW + 0.014)))
            box(g, 'tr_steel', (x0, SIDE_TOP - 0.005, -(HL - R_REAR)), (x1, SIDE_TOP + 0.02, HL - R_CAB), STEEL_DK, skip=('-z', '+z'))
        if lod == 0:
            for c in DOOR_Z:
                x0, x1 = sorted((s * HW, s * (HW + 0.018)))
                box(g, 'tr_steel', (x0, DOOR_TOP + 0.01, c - DHW - 0.08), (x1, DOOR_TOP + 0.03, c + DHW + 0.08), STEEL)


# ------------------------------------------------------------------------------------------- sides
def row_cell(ym, s_col=steel):
    """Material and colour of a side cell by height: steel, the pinstripe, the band."""
    if PIN[0] < ym < PIN[1]:
        return ('tr_band', NAVY)
    if BAND[0] < ym < BAND[1]:
        return ('tr_band', PEACH)
    return ('tr_steel', s_col)


def side_wall(g, s, lod):
    z0, z1 = -(HL - R_REAR), HL - R_CAB
    zs = [z0, z1]
    for c in DOOR_Z:
        zs += [c - DHW, c + DHW]
    if lod <= 1:
        for a, b in WINDOWS:
            zs += [a, b]
    if lod == 0:
        zs += [SIGN_SIDE[0], SIGN_SIDE[1]]
    zs = uniq(zs)
    if lod == 0:
        ys = [SOLE, FLUTE[0], FLOOR, FLUTE[1], PIN[0], PIN[1], BAND[0], BAND[1], WIN[1], SIGN_SIDE[2], SIGN_SIDE[3], DOOR_TOP, SIDE_TOP]
    elif lod == 1:
        ys = [SOLE, FLOOR, PIN[0], PIN[1], BAND[0], BAND[1], WIN[1], SIGN_SIDE[2], SIGN_SIDE[3], DOOR_TOP, SIDE_TOP]
    else:
        ys = [SOLE, PIN[0], PIN[1], BAND[0], BAND[1], WIN[1], SIDE_TOP]
    ys = uniq(ys)
    x = s * HW

    def cell(i, j, u0, u1, v0, v1):
        zm, ym = (u0 + u1) / 2, (v0 + v1) / 2
        door = in_door(zm)
        if lod <= 1 and door and FLOOR < ym < DOOR_TOP:
            return None
        if lod == 0 and not door and FLUTE[0] < ym < FLUTE[1]:
            return None
        if lod <= 1 and WIN[0] < ym < WIN[1] and in_window(zm):
            return None
        if lod <= 1 and SIGN_SIDE[0] < zm < SIGN_SIDE[1] and SIGN_SIDE[2] < ym < SIGN_SIDE[3]:
            return None
        if lod == 2:
            if WIN[0] < ym < WIN[1] and -HL + 0.5 < zm < CAB_Z0 + 0.8:
                return ('tr_glass', WHITE)
            if door:
                m, c = row_cell(ym)
                return (m, (lambda p: shade(steel(p), 0.82)) if m == 'tr_steel' else shade(c, 0.85))
        return row_cell(ym)

    tk.grid(g, lambda u, v: (x, v, u), zs, ys, cell, hint=(s, 0, 0))
    if lod == 0:
        flutes(g, s, zs)


def flutes(g, s, zs):
    """The fluted lower sides: horizontal ribs between the doors."""
    segs = []
    za = zs[0]
    for c in DOOR_Z:
        segs.append((za, c - DHW))
        za = c + DHW
    segs.append((za, zs[-1]))
    n = 8
    pitch = (FLUTE[1] - FLUTE[0]) / n
    rib = 0.010
    prof = [(0.0, 0.0), (rib, 0.14), (rib, 0.80), (0.0, 0.94), (0.0, 1.0)]
    for za, zb in segs:
        for k in range(n):
            y0 = FLUTE[0] + k * pitch
            pts = [(s * (HW + dx), y0 + f * pitch) for dx, f in prof]
            for a, b in zip(pts, pts[1:]):
                dx, dy = b[0] - a[0], b[1] - a[1]
                out = (dy * s, -dx * s, 0.0)
                g.poly('tr_steel', [(a[0], a[1], za), (a[0], a[1], zb), (b[0], b[1], zb), (b[0], b[1], za)], steel, hint=out)
            cap = [(s * HW, y0 + pitch * 0.0, 0), (s * (HW + rib), y0 + pitch * 0.14, 0), (s * (HW + rib), y0 + pitch * 0.80, 0), (s * HW, y0 + pitch * 0.94, 0)]
            for z, hz in ((za, -1), (zb, 1)):
                g.poly('tr_steel', [(p[0], p[1], z) for p in cap], steel, hint=(0, 0, hz))


def window_details(g, s, lod):
    """Glass, reveals and gaskets of the side windows (and the side sign's recess)."""
    for z0, z1 in WINDOWS:
        y0, y1 = WIN
        cab = z0 > CAB_Z0
        if lod == 0:
            lin = CAB_INT if cab else LINING
            for xa, xb, mat, col in ((WALL_IN, 1.585, 'tr_interior', lin), (1.585, HW, 'tr_dark', RUBBER)):
                xa, xb = s * xa, s * xb
                g.poly(mat, [(xa, y0, z0), (xb, y0, z0), (xb, y0, z1), (xa, y0, z1)], col, hint=(0, 1, 0))
                g.poly(mat, [(xa, y1, z0), (xb, y1, z0), (xb, y1, z1), (xa, y1, z1)], col, hint=(0, -1, 0))
                g.poly(mat, [(xa, y0, z0), (xb, y0, z0), (xb, y1, z0), (xa, y1, z0)], col, hint=(0, 0, 1))
                g.poly(mat, [(xa, y0, z1), (xb, y0, z1), (xb, y1, z1), (xa, y1, z1)], col, hint=(0, 0, -1))
            gx = s * 1.585
            # the gasket on the skin
            e, xg = 0.03, s * (HW + 0.004)
            for a, b, c, d in (((z0 - e, y0 - e), (z1 + e, y0 - e), (z1 + e, y0), (z0 - e, y0)), ((z0 - e, y1), (z1 + e, y1), (z1 + e, y1 + e), (z0 - e, y1 + e)),
                               ((z0 - e, y0), (z0, y0), (z0, y1), (z0 - e, y1)), ((z1, y0), (z1 + e, y0), (z1 + e, y1), (z1, y1))):
                g.poly('tr_dark', [(xg, a[1], a[0]), (xg, b[1], b[0]), (xg, c[1], c[0]), (xg, d[1], d[0])], RUBBER, hint=(s, 0, 0))
        else:
            gx = s * (HW - 0.008)
            if lod == 1:
                for za, zb, ya, yb, h in ((z0, z1, y0, y0, (0, 1, 0)), (z0, z1, y1, y1, (0, -1, 0))):
                    g.poly('tr_dark', [(gx, ya, za), (s * HW, ya, za), (s * HW, yb, zb), (gx, yb, zb)], RUBBER, hint=h)
                for zz, h in ((z0, (0, 0, 1)), (z1, (0, 0, -1))):
                    g.poly('tr_dark', [(gx, y0, zz), (s * HW, y0, zz), (s * HW, y1, zz), (gx, y1, zz)], RUBBER, hint=h)
        g.poly('tr_glass', [(gx, y0, z0), (gx, y0, z1), (gx, y1, z1), (gx, y1, z0)], WHITE, hint=(s, 0, 0))
    # the side destination sign: a shallow recess with the face in it
    z0, z1, y0, y1 = SIGN_SIDE
    d = 0.03
    xa, xb = s * (HW - d), s * HW
    if lod == 0:
        g.poly('tr_dark', [(xa, y0, z0), (xb, y0, z0), (xb, y0, z1), (xa, y0, z1)], RUBBER, hint=(0, 1, 0))
        g.poly('tr_dark', [(xa, y1, z0), (xb, y1, z0), (xb, y1, z1), (xa, y1, z1)], RUBBER, hint=(0, -1, 0))
        g.poly('tr_dark', [(xa, y0, z0), (xb, y0, z0), (xb, y1, z0), (xa, y1, z0)], RUBBER, hint=(0, 0, 1))
        g.poly('tr_dark', [(xa, y0, z1), (xb, y0, z1), (xb, y1, z1), (xa, y1, z1)], RUBBER, hint=(0, 0, -1))
    else:
        xa = s * (HW - 0.004)
    if lod <= 1:
        sign_quad(g, 'tr_sign', (xa, (y0 + y1) / 2, (z0 + z1) / 2), (0, 0, -s), (0, 1, 0), z1 - z0, y1 - y0)


def door_openings(g, s):
    """Jambs (with the slot the leaves slide through), header and threshold of each side door (LOD0)."""
    for c in DOOR_Z:
        za, zb = c - DHW, c + DHW
        for z, h in ((za, 1), (zb, -1)):
            for xa, xb, mat, col in ((WALL_IN, SLOT[0], 'tr_interior', LINING), (SLOT[1], HW, 'tr_steel', STEEL)):
                g.poly(mat, [(s * xa, FLOOR, z), (s * xb, FLOOR, z), (s * xb, DOOR_TOP, z), (s * xa, DOOR_TOP, z)], col, hint=(0, 0, h))
        g.poly('tr_interior', [(s * WALL_IN, DOOR_TOP, za), (s * HW, DOOR_TOP, za), (s * HW, DOOR_TOP, zb), (s * WALL_IN, DOOR_TOP, zb)], LINING, hint=(0, -1, 0))
        g.poly('tr_floor', [(s * WALL_IN, FLOOR, za), (s * HW, FLOOR, za), (s * HW, FLOOR, zb), (s * WALL_IN, FLOOR, zb)], EDGE_Y, hint=(0, 1, 0))


def corners(g, lod):
    """The rounded vertical corners of the body in plan (both ends, both sides)."""
    n = CORNER_SEGS[lod]
    ys = [SOLE, PIN[0], PIN[1], BAND[0], BAND[1], SIDE_TOP]
    for end, r in ((-1, R_REAR), (1, R_CAB)):
        for s in (1, -1):
            for k in range(n):
                t0, t1 = math.pi / 2 * k / n, math.pi / 2 * (k + 1) / n
                pts = []
                for t in (t0, t1):
                    pts.append((s * (HW - r + r * math.cos(t)), end * ((HL - r) + r * math.sin(t)), (s * math.cos(t), 0.0, end * math.sin(t))))
                for j in range(len(ys) - 1):
                    y0, y1 = ys[j], ys[j + 1]
                    ym = (y0 + y1) / 2
                    mat, col = row_cell(ym)
                    if end == 1 and ym > BAND[1]:
                        mat, col = 'tr_cab', CAB_BLACK
                    a, b = pts
                    quad = [(a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1])]
                    nm = [a[2], b[2], b[2], a[2]]
                    mid = tk.vnorm(tk.vadd(a[2], b[2]))
                    g.poly(mat, quad, col, hint=mid, normals=nm)


def underside(g, lod):
    """The floor of the body (y = SOLE) over the plan outline, facing down."""
    st = stations(lod)
    ring = [(w, z) for z, w, _, _, _ in st] + [(-w, z) for z, w, _, _, _ in reversed(st)]
    g.poly('tr_dark', [(x, SOLE, z) for x, z in ring], UNDER, hint=(0, -1, 0))


# ------------------------------------------------------------------------------------------- the ends
def end_face(g, lod, end):
    """The cab front (end = 1) or the gangway end (end = -1): a flat face at z = +-HL under the roof's end section."""
    r = R_CAB if end == 1 else R_REAR
    st = stations(lod)
    z, w, ky, _, _ = st[-1] if end == 1 else st[0]
    half = roof_half(lod, w, ky)
    zf = end * HL
    xs = [-w, w]
    ys = [SOLE, PIN[0], PIN[1], BAND[0], BAND[1], SIDE_TOP] + [y for _, y in half]
    if end == 1:
        if lod <= 1:
            for a, b in WS_PANES:
                xs += [a, b]
            ys += [WS[0], WS[1]]
            xs += [-SIGN_FRONT[0], SIGN_FRONT[0]]
            ys += [SIGN_FRONT[1], SIGN_FRONT[2]]
        else:
            xs += [WS_PANES[0][0], WS_PANES[1][1]]
            ys += [WS[0], WS[1]]
    else:
        xs += [-END_DOOR[0], END_DOOR[0]]
        ys += [FLOOR, END_DOOR[1]]
        if lod == 2:
            xs, ys = [-w, w], [y for y in ys if y not in (FLOOR, END_DOOR[1])]
    xs, ys = uniq(xs), uniq(ys)

    def cell(i, j, u0, u1, v0, v1):
        xm, ym = (u0 + u1) / 2, (v0 + v1) / 2
        if end == 1:
            if WS[0] < ym < WS[1] and any(a < xm < b for a, b in WS_PANES):
                return None if lod <= 1 else ('tr_glass', WHITE)
            if lod == 2 and WS[0] < ym < WS[1] and WS_PANES[0][0] < xm < WS_PANES[1][1]:
                return ('tr_glass', WHITE)
            if lod <= 1 and SIGN_FRONT[1] < ym < SIGN_FRONT[2] and abs(xm) < SIGN_FRONT[0]:
                return None
            if ym > BAND[1]:
                return ('tr_cab', CAB_BLACK)
            return row_cell(ym)
        if lod <= 1 and abs(xm) < END_DOOR[0] and FLOOR < ym < END_DOOR[1]:
            return None
        return row_cell(ym)

    # rows above SIDE_TOP narrow with the roof: use only the breakpoints inside them
    lo_rows = [y for y in ys if y <= SIDE_TOP + 1e-9]
    tk.grid(g, lambda u, v: (u, v, zf), xs, lo_rows, cell, hint=(0, 0, end))
    hi = [y for y in ys if y >= SIDE_TOP - 1e-9]
    for j in range(len(hi) - 1):
        v0, v1 = hi[j], hi[j + 1]
        lim = _half_at(half, v1)
        inner = [x for x in xs[1:-1] if abs(x) < lim - 0.02]
        tk.grid(g, lambda u, v: (u, v, zf), [-9.0] + inner + [9.0], [v0, v1], cell, hint=(0, 0, end),
                umin=lambda v: -_half_at(half, v), umax=lambda v: _half_at(half, v))
    if end == 1:
        cab_front_details(g, lod)
    else:
        gangway_details(g, lod)


def _half_at(half, y):
    """The half width of a roof section at height y (half runs from the side up to the crown)."""
    if y <= half[0][1]:
        return half[0][0]
    for (x0, y0), (x1, y1) in zip(half, half[1:]):
        if y0 - 1e-9 <= y <= y1 + 1e-9:
            return x0 + (x1 - x0) * (0.0 if y1 == y0 else (y - y0) / (y1 - y0))
    return 0.0


def cab_front_details(g, lod):
    zf = HL
    # windscreen: reveals back to the cab's inner wall, glass, wipers
    for a, b in WS_PANES:
        y0, y1 = WS
        if lod <= 1:
            depth = [(zf, zf - 0.04, 'tr_cab', CAB_BLACK)] + ([(zf - 0.04, CAB_FRONT_IN, 'tr_interior', CAB_INT)] if lod == 0 else [])
            for za, zb, mat, col in depth:
                g.poly(mat, [(a, y0, za), (b, y0, za), (b, y0, zb), (a, y0, zb)], col, hint=(0, 1, 0))
                g.poly(mat, [(a, y1, za), (b, y1, za), (b, y1, zb), (a, y1, zb)], col, hint=(0, -1, 0))
                g.poly(mat, [(a, y0, za), (a, y1, za), (a, y1, zb), (a, y0, zb)], col, hint=(1, 0, 0))
                g.poly(mat, [(b, y0, za), (b, y1, za), (b, y1, zb), (b, y0, zb)], col, hint=(-1, 0, 0))
            gz = zf - 0.03
            g.poly('tr_glass', [(a, y0, gz), (b, y0, gz), (b, y1, gz), (a, y1, gz)], WHITE, hint=(0, 0, 1))
            if lod == 1:
                g.poly('tr_dark', [(a, y0, zf - 0.04), (b, y0, zf - 0.04), (b, y1, zf - 0.04), (a, y1, zf - 0.04)], shade(CAB_INT, 0.5), hint=(0, 0, 1))
        if lod == 0:
            xw = a + 0.18 if a < 0 else a + 0.12
            g.beam('tr_dark', (xw, y0 + 0.04, zf + 0.006), (xw + 0.34, y0 + 0.62, zf + 0.006), 0.022, 0.01, RUBBER)
    if lod <= 1:
        # the destination sign: a recess over the windscreen, the face at its back
        hw, y0, y1 = SIGN_FRONT
        d = 0.05
        if lod == 0:
            for (pa, pb, h) in (((-hw, y0), (hw, y0), (0, 1, 0)), ((-hw, y1), (hw, y1), (0, -1, 0))):
                g.poly('tr_dark', [(pa[0], pa[1], zf), (pb[0], pb[1], zf), (pb[0], pb[1], zf - d), (pa[0], pa[1], zf - d)], RUBBER, hint=h)
            for x, h in ((-hw, (1, 0, 0)), (hw, (-1, 0, 0))):
                g.poly('tr_dark', [(x, y0, zf), (x, y1, zf), (x, y1, zf - d), (x, y0, zf - d)], RUBBER, hint=h)
        else:
            d = 0.004
        sign_quad(g, 'tr_sign', (0.0, (y0 + y1) / 2, zf - d), (1, 0, 0), (0, 1, 0), 2 * hw, y1 - y0)
    # lamp clusters: a black housing, the headlight inboard, the red marker outboard; small red markers up top
    for s in (1, -1):
        cx = s * 0.86
        if lod <= 1:
            box(g, 'tr_dark', (cx - 0.22, HEAD_Y - 0.09, zf), (cx + 0.22, HEAD_Y + 0.09, zf + 0.025), RUBBER, skip=('-z',))
            if lod == 0:
                revolve(g, 'tr_head', (s * 0.76, HEAD_Y, zf + 0.025), (0, 0, 1), [(0.0, 0.0), (0.07, 0.0), (0.065, 0.012), (0.0, 0.016)], 12, HEAD_C)
                revolve(g, 'tr_tail', (s * 1.0, HEAD_Y, zf + 0.025), (0, 0, 1), [(0.0, 0.0), (0.05, 0.0), (0.046, 0.01), (0.0, 0.013)], 10, TAIL_C)
                box(g, 'tr_tail', (s * 1.0 - 0.07, 3.17, zf), (s * 1.0 + 0.07, 3.23, zf + 0.012), TAIL_C, skip=('-z',))
            else:
                g.poly('tr_head', [(s * 0.76 - 0.07, HEAD_Y - 0.07, zf + 0.027), (s * 0.76 + 0.07, HEAD_Y - 0.07, zf + 0.027), (s * 0.76 + 0.07, HEAD_Y + 0.07, zf + 0.027), (s * 0.76 - 0.07, HEAD_Y + 0.07, zf + 0.027)], HEAD_C, hint=(0, 0, 1))
                g.poly('tr_tail', [(s * 1.0 - 0.05, HEAD_Y - 0.05, zf + 0.027), (s * 1.0 + 0.05, HEAD_Y - 0.05, zf + 0.027), (s * 1.0 + 0.05, HEAD_Y + 0.05, zf + 0.027), (s * 1.0 - 0.05, HEAD_Y + 0.05, zf + 0.027)], TAIL_C, hint=(0, 0, 1))
        else:
            g.poly('tr_head', [(s * 0.76 - 0.08, HEAD_Y - 0.07, zf + 0.004), (s * 0.76 + 0.08, HEAD_Y - 0.07, zf + 0.004), (s * 0.76 + 0.08, HEAD_Y + 0.07, zf + 0.004), (s * 0.76 - 0.08, HEAD_Y + 0.07, zf + 0.004)], HEAD_C, hint=(0, 0, 1))
            g.poly('tr_tail', [(s * 1.0 - 0.05, HEAD_Y - 0.05, zf + 0.004), (s * 1.0 + 0.05, HEAD_Y - 0.05, zf + 0.004), (s * 1.0 + 0.05, HEAD_Y + 0.05, zf + 0.004), (s * 1.0 - 0.05, HEAD_Y + 0.05, zf + 0.004)], TAIL_C, hint=(0, 0, 1))
    if lod <= 1:
        # the anticlimber: a ribbed steel beam across the bottom of the front
        box(g, 'tr_steel', (-1.12, SOLE - 0.02, zf), (1.12, SOLE + 0.11, zf + 0.07), STEEL_DK, skip=('-z',))
        if lod == 0:
            for k in range(3):
                y = SOLE + 0.0 + k * 0.04
                box(g, 'tr_dark', (-1.1, y, zf + 0.07), (1.1, y + 0.015, zf + 0.085), UNDER, skip=('-z',))


def gangway_details(g, lod):
    zf = -HL
    hw, top = END_DOOR
    if lod == 0:
        # the end door: a slab with a window, set in its doorway (jambs back to the end wall inside)
        z_out, z_in = -HL + 0.03, -HL + 0.07
        wx, wy0, wy1 = 0.22, WIN[0], WIN[1] - 0.1
        for zz, h, mat, col in ((z_out, -1, 'tr_steel', steel), (z_in, 1, 'tr_interior', LINING)):
            tk.grid(g, lambda u, v, zz=zz: (u, v, zz), [-hw, -wx, wx, hw], [FLOOR, wy0, wy1, top],
                    lambda i, j, u0, u1, v0, v1, mat=mat, col=col: None if (i == 1 and j == 1) else (mat, col), hint=(0, 0, h))
        for (pa, pb, hh) in (((-wx, wy0), (wx, wy0), (0, 1, 0)), ((-wx, wy1), (wx, wy1), (0, -1, 0))):
            g.poly('tr_dark', [(pa[0], pa[1], z_out), (pb[0], pb[1], z_out), (pb[0], pb[1], z_in), (pa[0], pa[1], z_in)], RUBBER, hint=hh)
        for x, hh in ((-wx, (1, 0, 0)), (wx, (-1, 0, 0))):
            g.poly('tr_dark', [(x, wy0, z_out), (x, wy1, z_out), (x, wy1, z_in), (x, wy0, z_in)], RUBBER, hint=hh)
        gz = (z_out + z_in) / 2
        g.poly('tr_glass', [(-wx, wy0, gz), (wx, wy0, gz), (wx, wy1, gz), (-wx, wy1, gz)], WHITE, hint=(0, 0, -1))
        # doorway: jambs, header and threshold from the end face to the end wall inside
        for x, hh in ((-hw, (1, 0, 0)), (hw, (-1, 0, 0))):
            g.poly('tr_steel', [(x, FLOOR, zf), (x, top, zf), (x, top, END_IN), (x, FLOOR, END_IN)], STEEL, hint=hh)
        g.poly('tr_steel', [(-hw, top, zf), (hw, top, zf), (hw, top, END_IN), (-hw, top, END_IN)], STEEL, hint=(0, -1, 0))
        g.poly('tr_floor', [(-hw, FLOOR, zf), (hw, FLOOR, zf), (hw, FLOOR, END_IN), (-hw, FLOOR, END_IN)], EDGE_Y, hint=(0, 1, 0))
        # rubber buffer strips beside the door, grab handles, a step plate under it
        for s in (1, -1):
            x0, x1 = sorted((s * 0.48, s * 0.55))
            box(g, 'tr_dark', (x0, FLOOR + 0.05, zf - 0.04), (x1, top - 0.05, zf), RUBBER, skip=('+z',))
            gx = s * 0.66
            tk.polyline_tube(g, 'tr_steel', [(gx, 1.5, zf), (gx, 1.5, zf - 0.045), (gx, 2.4, zf - 0.045), (gx, 2.4, zf)], 0.014, 6, STEEL)
        box(g, 'tr_dark', (-0.45, FLOOR - 0.08, zf - 0.16), (0.45, FLOOR - 0.04, zf), UNDER)
    elif lod == 1:
        g.poly('tr_steel', [(-hw, FLOOR, zf + 0.04), (hw, FLOOR, zf + 0.04), (hw, top, zf + 0.04), (-hw, top, zf + 0.04)], lambda p: shade(steel(p), 0.85), hint=(0, 0, -1))
        g.poly('tr_glass', [(-0.22, WIN[0], zf + 0.035), (0.22, WIN[0], zf + 0.035), (0.22, WIN[1] - 0.1, zf + 0.035), (-0.22, WIN[1] - 0.1, zf + 0.035)], WHITE, hint=(0, 0, -1))
        for x, hh in ((-hw, (1, 0, 0)), (hw, (-1, 0, 0))):
            g.poly('tr_steel', [(x, FLOOR, zf), (x, top, zf), (x, top, zf + 0.04), (x, FLOOR, zf + 0.04)], STEEL, hint=hh)
        g.poly('tr_steel', [(-hw, top, zf), (hw, top, zf), (hw, top, zf + 0.04), (-hw, top, zf + 0.04)], STEEL, hint=(0, -1, 0))


# ------------------------------------------------------------------------------------------- underframe, couplers, bogies
EQUIPMENT = [  # (side, z0, z1, bottom y, inner x, outer x, shade)
    (1, -6.25, -4.45, SKIRT, 0.35, 1.36, 1.0), (1, -4.25, -2.95, 0.66, 0.5, 1.33, 1.25), (1, -2.7, -0.35, 0.58, 0.3, 1.40, 0.9),
    (1, 0.25, 1.65, 0.68, 0.6, 1.30, 1.15), (1, 1.9, 3.95, 0.57, 0.25, 1.38, 1.0), (1, 4.2, 6.25, 0.62, 0.4, 1.35, 1.3),
    (-1, -6.25, -5.05, 0.64, 0.45, 1.32, 1.2), (-1, -4.85, -2.35, SKIRT + 0.01, 0.3, 1.40, 0.95), (-1, -2.1, -0.85, 0.7, 0.55, 1.28, 1.35),
    (-1, -0.6, 1.95, 0.6, 0.35, 1.38, 1.05), (-1, 2.2, 3.4, 0.67, 0.5, 1.32, 1.2), (-1, 3.65, 6.25, 0.58, 0.3, 1.39, 0.9),
]


def underframe(g, lod):
    if lod == 2:
        box(g, 'tr_dark', (-1.38, SKIRT, -6.2), (1.38, SOLE, 6.2), UNDER, skip=('+y',))
        return
    for s, z0, z1, yb, xi, xo, k in EQUIPMENT:
        if lod == 1 and (z1 - z0) < 1.5:
            continue
        x0, x1 = sorted((s * xi, s * xo))
        col = lambda p, k=k: shade(UNDER, k * (0.8 if p[1] < yb + 0.02 else 1.0))
        box(g, 'tr_dark', (x0, yb, z0), (x1, SOLE, z1), col, skip=('+y',))
        if lod == 0:
            # louvres on the outer face: darker slats
            xs = s * (xo + 0.004)
            for q in range(3):
                za = z0 + 0.15 + q * (z1 - z0 - 0.3) / 3
                zb = za + (z1 - z0 - 0.3) / 3 - 0.08
                g.poly('tr_dark', [(xs, yb + 0.08, za), (xs, yb + 0.08, zb), (xs, SOLE - 0.06, zb), (xs, SOLE - 0.06, za)], shade(UNDER, 0.55), hint=(s, 0, 0))
    if lod == 0:
        # the centre sill and a pair of air pipes along the car
        box(g, 'tr_dark', (-0.18, SOLE - 0.16, -HL + 0.3), (0.18, SOLE, HL - 0.3), shade(UNDER, 0.85), skip=('+y',))
        for x in (0.25, -0.22):
            tube(g, 'tr_dark', (x, SOLE - 0.05, -BOGIE_Z + 1.7), (x, SOLE - 0.05, BOGIE_Z - 1.7), 0.03, 6, shade(UNDER, 1.4), caps=False)


def couplers(g, lod):
    for end in (1, -1):
        zf = end * HL
        if lod <= 1:
            za, zb = sorted((end * (HL - 0.7), zf))
            box(g, 'tr_dark', (-0.24, 0.66, za), (0.24, SOLE, zb), UNDER, skip=('+y',))
            tube(g, 'tr_dark', (0, 0.80, zf - end * 0.1), (0, 0.80, zf + end * 0.31), 0.07, 8 if lod == 0 else 6, shade(UNDER, 1.2))
        za, zb = sorted((zf + end * 0.30, zf + end * (D['gap'] / 2 - 0.01)))
        box(g, 'tr_dark', (-0.17, 0.69, za), (0.17, 0.91, zb), shade(UNDER, 1.3))
        if lod == 0:
            # the coupler head's face plate, lighter, and its gathering horn
            zc = zb if end == 1 else za
            box(g, 'tr_dark', (-0.12, 0.72, zc - 0.005), (0.12, 0.88, zc + 0.005), shade(UNDER, 2.0))


def bogie(lod, zc):
    g = Geo(lod)
    WB = 1.1   # half the wheelbase
    sides = 12 if lod == 0 else 6
    for s in (1, -1):
        # side frame outside the wheels: deeper between the axles
        prof = [(-1.45, 0.58), (-1.45, 0.72), (-0.55, 0.72), (-0.35, 0.64), (0.35, 0.64), (0.55, 0.72), (1.45, 0.72), (1.45, 0.58), (0.9, 0.52), (0.5, 0.40), (-0.5, 0.40), (-0.9, 0.52)]
        if lod == 1:
            prof = [(-1.45, 0.58), (-1.45, 0.72), (1.45, 0.72), (1.45, 0.58), (0.5, 0.42), (-0.5, 0.42)]
        x0, x1 = sorted((s * 0.90, s * 1.06))
        prism_x(g, 'tr_dark', [(zc + z, y) for z, y in prof], x0, x1, BOGIE_C)
        for a in (-WB, WB):
            # axle box and primary spring
            xa, xb = sorted((s * 0.84, s * 1.0))
            box(g, 'tr_dark', (xa, WR - 0.11, zc + a - 0.13), (xb, WR + 0.08, zc + a + 0.13), shade(BOGIE_C, 1.3))
            if lod == 0:
                tube(g, 'tr_dark', (s * 0.96, WR + 0.08, zc + a + 0.2 * (1 if a > 0 else -1)), (s * 0.96, 0.62, zc + a + 0.2 * (1 if a > 0 else -1)), 0.06, 8, shade(BOGIE_C, 1.6))
                # third-rail collector shoe on a beam off the axle box
                if a > 0:
                    xa, xb = sorted((s * 1.0, s * 1.32))
                    box(g, 'tr_dark', (xa, 0.24, zc + a - 0.05), (xb, 0.32, zc + a + 0.05), shade(BOGIE_C, 1.1))
                    xa, xb = sorted((s * 1.18, s * 1.34))
                    box(g, 'tr_dark', (xa, 0.13, zc + a - 0.16), (xb, 0.17, zc + a + 0.16), shade(WHEEL_C, 1.2))
            # the wheel: tread, flange inside, a dished face
            prof_w = [(0.0, -0.068), (WR + 0.028, -0.068), (WR + 0.028, -0.048), (WR, -0.032), (WR, 0.0675), (0.31, 0.0675), (0.24, 0.04), (0.0, 0.04)]
            if lod == 1:
                prof_w = [(0.0, -0.068), (WR + 0.025, -0.068), (WR, -0.032), (WR, 0.0675), (0.0, 0.0675)]
            revolve(g, 'tr_dark', (s * 0.75, WR, zc + a), (s, 0, 0), prof_w, sides, lambda k: shade(WHEEL_C, 1.5 if k in (3, 4) else 1.0))
        if lod == 0:
            # air spring on the bolster end
            revolve(g, 'tr_dark', (s * 0.95, 0.76, zc), (0, 1, 0), [(0.0, 0.0), (0.15, 0.0), (0.18, 0.06), (0.15, 0.15), (0.0, 0.15)], 10, shade(RUBBER, 1.1))
            # brake units between the wheels
            xa, xb = sorted((s * 0.62, s * 0.86))
            box(g, 'tr_dark', (xa, 0.48, zc - 0.25), (xb, 0.64, zc + 0.25), shade(BOGIE_C, 1.2))
    # axles, bolster, traction motors
    for a in (-WB, WB):
        tube(g, 'tr_dark', (-0.84, WR, zc + a), (0.84, WR, zc + a), 0.075, 6 if lod == 0 else 4, shade(WHEEL_C, 0.8), caps=False)
    box(g, 'tr_dark', (-0.92, 0.58, zc - 0.22), (0.92, 0.78, zc + 0.22), shade(BOGIE_C, 0.95))
    if lod == 0:
        for a in (-WB, WB):
            zm = zc + a * 0.45
            box(g, 'tr_dark', (-0.5, 0.26, zm - 0.24), (0.5, 0.62, zm + 0.24), shade(BOGIE_C, 1.15))
            tube(g, 'tr_dark', (-0.55, WR, zc + a), (-0.42, WR, zc + a), 0.17, 10, shade(BOGIE_C, 1.25))
    return g


# ------------------------------------------------------------------------------------------- doors
def leaf(lod, s, c, half):
    """One door leaf, closed, in the car frame."""
    g = Geo(lod)
    if half == 'a':
        z0, z1 = c - DHW, c - NOSE
        nz = (c - NOSE, c)
        wz = (z0 + 0.10, z1 - 0.05)
    else:
        z0, z1 = c + NOSE, c + DHW
        nz = (c, c + NOSE)
        wz = (z0 + 0.05, z1 - 0.10)
    xo, xi = s * LEAF_OUT, s * LEAF_IN
    if lod == 0:
        ys = uniq([FLOOR, PIN[0], PIN[1], BAND[0], BAND[1], WIN[0], WIN[1], DOOR_TOP])
        for x, h, inside in ((xo, s, False), (xi, -s, True)):
            def cell(i, j, u0, u1, v0, v1, inside=inside):
                zm, ym = (u0 + u1) / 2, (v0 + v1) / 2
                if i == 1 and WIN[0] < ym < WIN[1]:
                    return None
                if inside:
                    return ('tr_interior', DADO if ym < FLOOR + 0.2 else LINING)
                return row_cell(ym)
            tk.grid(g, lambda u, v, x=x: (x, v, u), [z0, wz[0], wz[1], z1], ys if not inside else uniq([FLOOR, FLOOR + 0.2, WIN[0], WIN[1], DOOR_TOP]), cell, hint=(h, 0, 0))
        # window reveal and glass
        y0, y1 = WIN
        g.poly('tr_dark', [(xi, y0, wz[0]), (xo, y0, wz[0]), (xo, y0, wz[1]), (xi, y0, wz[1])], RUBBER, hint=(0, 1, 0))
        g.poly('tr_dark', [(xi, y1, wz[0]), (xo, y1, wz[0]), (xo, y1, wz[1]), (xi, y1, wz[1])], RUBBER, hint=(0, -1, 0))
        g.poly('tr_dark', [(xi, y0, wz[0]), (xo, y0, wz[0]), (xo, y1, wz[0]), (xi, y1, wz[0])], RUBBER, hint=(0, 0, 1))
        g.poly('tr_dark', [(xi, y0, wz[1]), (xo, y0, wz[1]), (xo, y1, wz[1]), (xi, y1, wz[1])], RUBBER, hint=(0, 0, -1))
        gx = s * (LEAF_IN + LEAF_OUT) / 2
        g.poly('tr_glass', [(gx, y0, wz[0]), (gx, y0, wz[1]), (gx, y1, wz[1]), (gx, y1, wz[0])], WHITE, hint=(s, 0, 0))
    else:
        for ya, yb, mat, col in ((FLOOR, BAND[0], 'tr_steel', steel), (BAND[0], BAND[1], 'tr_band', PEACH), (WIN[1], DOOR_TOP, 'tr_steel', steel)):
            g.poly(mat, [(xo, ya, z0), (xo, ya, z1), (xo, yb, z1), (xo, yb, z0)], col, hint=(s, 0, 0))
        g.poly('tr_steel', [(xo, WIN[0], z0), (xo, WIN[0], wz[0]), (xo, WIN[1], wz[0]), (xo, WIN[1], z0)], steel, hint=(s, 0, 0))
        g.poly('tr_steel', [(xo, WIN[0], wz[1]), (xo, WIN[0], z1), (xo, WIN[1], z1), (xo, WIN[1], wz[1])], steel, hint=(s, 0, 0))
        g.poly('tr_glass', [(xo, WIN[0], wz[0]), (xo, WIN[0], wz[1]), (xo, WIN[1], wz[1]), (xo, WIN[1], wz[0])], WHITE, hint=(s, 0, 0))
        g.poly('tr_dark', [(xi, FLOOR, z0), (xi, FLOOR, z1), (xi, DOOR_TOP, z1), (xi, DOOR_TOP, z0)], shade(CAB_INT, 0.4), hint=(-s, 0, 0))
    # edges
    g.poly('tr_steel', [(xi, DOOR_TOP, z0), (xo, DOOR_TOP, z0), (xo, DOOR_TOP, z1), (xi, DOOR_TOP, z1)], STEEL_DK, hint=(0, 1, 0))
    g.poly('tr_steel', [(xi, FLOOR, z0), (xo, FLOOR, z0), (xo, FLOOR, z1), (xi, FLOOR, z1)], STEEL_DK, hint=(0, -1, 0))
    zo, ho = (z0, -1) if half == 'a' else (z1, 1)
    g.poly('tr_steel', [(xi, FLOOR, zo), (xo, FLOOR, zo), (xo, DOOR_TOP, zo), (xi, DOOR_TOP, zo)], STEEL_DK, hint=(0, 0, ho))
    # the rubber nose on the meeting edge
    xa, xb = sorted((s * (LEAF_IN - 0.004), s * (LEAF_OUT + 0.004)))
    box(g, 'tr_dark', (xa, FLOOR, nz[0]), (xb, DOOR_TOP, nz[1]), RUBBER, skip=(('-z',) if half == 'a' else ('+z',)) if lod == 0 else ())
    return g


def leaf_centre(s, c, half):
    return (s * (LEAF_IN + LEAF_OUT) / 2, (FLOOR + DOOR_TOP) / 2, c - DHW / 2 if half == 'a' else c + DHW / 2)


def door_names(lod):
    out = []
    for side, s in (('L', 1), ('R', -1)):
        for i in range(len(DOOR_Z)):
            for half in ('a', 'b'):
                out.append((f'lod{lod}_door_{side}{i}_{half}', s, DOOR_Z[i], half, side, i))
    return out


# ------------------------------------------------------------------------------------------- interior (LOD0)
def interior():
    g = Geo(0)
    # side linings, with the window and door openings
    for s in (1, -1):
        zs = [END_IN, BULK[0], BULK[1], CAB_FRONT_IN]
        for c in DOOR_Z:
            zs += [c - DHW, c + DHW]
        for a, b in WINDOWS:
            zs += [a, b]
        zs = uniq(zs)
        ys = [FLOOR, FLOOR + 0.2, WIN[0], WIN[1], DOOR_TOP]

        def cell(i, j, u0, u1, v0, v1):
            zm, ym = (u0 + u1) / 2, (v0 + v1) / 2
            if BULK[0] < zm < BULK[1]:
                return None
            if in_door(zm) and ym < DOOR_TOP:
                return None
            if WIN[0] < ym < WIN[1] and in_window(zm):
                return None
            if zm > BULK[1]:
                return ('tr_interior', CAB_INT)
            return ('tr_interior', DADO if ym < FLOOR + 0.2 else LINING)
        tk.grid(g, lambda u, v, s=s: (s * WALL_IN, v, u), zs, ys, cell, hint=(-s, 0, 0))
        door_openings(g, s)
    # floor: a grid (so the baked occlusion has vertices to darken under the seats), vestibules and door edges in their colours
    xs = [-WALL_IN, -1.3, -0.9, -0.47, 0.0, 0.47, 0.9, 1.3, WALL_IN]
    zs = [END_IN, BULK[0]]
    z = END_IN
    while z < BULK[0] - 0.6:
        z += 0.6
        zs.append(z)
    for c in DOOR_Z:
        zs += [c - DHW, c + DHW, c - 0.85, c + 0.85]
    zs = uniq([v for v in zs if END_IN <= v <= BULK[0]])

    def fcell(i, j, u0, u1, v0, v1):
        xm, zm = (u0 + u1) / 2, (v0 + v1) / 2
        if in_door(zm) and abs(xm) > 1.3:
            return ('tr_floor', EDGE_Y)
        if in_door(zm, 0.2):
            return ('tr_floor', FLOOR_VEST)
        return ('tr_floor', FLOOR_C)
    tk.grid(g, lambda u, v: (u, FLOOR, v), xs, zs, fcell, hint=(0, 1, 0))
    g.poly('tr_floor', [(-WALL_IN, FLOOR, BULK[1]), (WALL_IN, FLOOR, BULK[1]), (WALL_IN, FLOOR, CAB_FRONT_IN), (-WALL_IN, FLOOR, CAB_FRONT_IN)], shade(FLOOR_C, 0.6), hint=(0, 1, 0))
    ceiling(g)
    end_walls(g)
    seats(g)
    poles_and_screens(g)
    cab(g)
    return g


CEIL_HALF = [(WALL_IN, DOOR_TOP), (1.42, 3.15), (1.31, 3.225), (1.18, 3.255), (0.86, 3.272), (0.86, CEIL), (0.14, CEIL), (0.0, CEIL)]


def ceiling(g):
    sect = CEIL_HALF + [(-x, y) for x, y in reversed(CEIL_HALF[:-1])]
    zs = [END_IN, BULK[0]]
    for c in DOOR_Z:
        zs += [c - 0.85, c + 0.85]
    bays = uniq(zs)
    zs = list(bays)
    for a, b in zip(bays, bays[1:]):
        if in_door((a + b) / 2):
            continue
        n = max(1, int(round((b - a) / 0.92)))
        zs += [a + (b - a) * k / n for k in range(1, n)]
    zs = uniq(zs)
    for k in range(len(zs) - 1):
        z0, z1 = zs[k], zs[k + 1]
        zm = (z0 + z1) / 2
        vest = in_door(zm, 0.2)
        for j in range(len(sect) - 1):
            (xa, ya), (xb, yb) = sect[j], sect[j + 1]
            if abs(xa - xb) < 1e-9 and abs(ya - yb) < 1e-9:
                continue
            mat, col = 'tr_interior', COVE
            if {round(abs(xa), 3), round(abs(xb), 3)} == {1.18, 0.86} and abs(ya - yb) < 0.05:
                mat, col = 'tr_light', WHITE
            elif {round(abs(xa), 3), round(abs(xb), 3)} == {1.42, 1.31}:
                col = COVE if vest else ADS[(k * 3 + (0 if xa > 0 else 5)) % len(ADS)]
            elif abs(ya - CEIL) < 1e-6 and abs(yb - CEIL) < 1e-6:
                col = DIFFUSER if max(abs(xa), abs(xb)) <= 0.14 + 1e-6 else CEILING
            mx, my = (xa + xb) / 2, (ya + yb) / 2
            g.poly(mat, [(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)], col, hint=(-mx, 2.2 - my, 0.0))
    # the cab's ceiling
    g.poly('tr_interior', [(-WALL_IN, DOOR_TOP, BULK[1]), (WALL_IN, DOOR_TOP, BULK[1]), (WALL_IN, DOOR_TOP, CAB_FRONT_IN), (-WALL_IN, DOOR_TOP, CAB_FRONT_IN)], shade(CAB_INT, 0.8), hint=(0, -1, 0))


def _ceil_at(y):
    if y <= DOOR_TOP:
        return WALL_IN
    for (x0, y0), (x1, y1) in zip(CEIL_HALF, CEIL_HALF[1:]):
        if y0 - 1e-9 <= y <= y1 + 1e-9 and y1 > y0:
            return x0 + (x1 - x0) * (y - y0) / (y1 - y0)
    return 0.86


def end_walls(g):
    ys_c = [y for _, y in CEIL_HALF[:6]]
    # gangway end wall (faces +Z) with the end doorway; cab bulkhead (faces -Z) with the cab door
    for zf, h, xs_door, top in ((END_IN, 1, (-END_DOOR[0], END_DOOR[0]), END_DOOR[1]), (BULK[0], -1, (CAB_DOOR[0], CAB_DOOR[1]), CAB_DOOR[2])):
        xs = uniq([-WALL_IN, xs_door[0], xs_door[1], WALL_IN])
        ys = uniq([FLOOR, FLOOR + 0.2, top] + ys_c)

        def cell(i, j, u0, u1, v0, v1, xs_door=xs_door, top=top):
            xm, ym = (u0 + u1) / 2, (v0 + v1) / 2
            if xs_door[0] < xm < xs_door[1] and ym < top:
                return None
            return ('tr_interior', DADO if ym < FLOOR + 0.2 else LINING)
        lo = [y for y in ys if y <= DOOR_TOP + 1e-9]
        tk.grid(g, lambda u, v, zf=zf: (u, v, zf), xs, lo, cell, hint=(0, 0, h))
        hi = [y for y in ys if y >= DOOR_TOP - 1e-9]
        tk.grid(g, lambda u, v, zf=zf: (u, v, zf), [-1.0, 1.0], hi, cell, hint=(0, 0, h), umin=lambda v: -_ceil_at(v), umax=lambda v: _ceil_at(v))
    # the bulkhead's cab side, and the cab doorway
    x0, x1, top = CAB_DOOR
    tk.grid(g, lambda u, v: (u, v, BULK[1]), [-WALL_IN, x0, x1, WALL_IN], [FLOOR, top, DOOR_TOP],
            lambda i, j, u0, u1, v0, v1: None if (i == 1 and j == 0) else ('tr_interior', CAB_INT), hint=(0, 0, 1))
    for x, hh in ((x0, (1, 0, 0)), (x1, (-1, 0, 0))):
        g.poly('tr_interior', [(x, FLOOR, BULK[0]), (x, top, BULK[0]), (x, top, BULK[1]), (x, FLOOR, BULK[1])], LINING, hint=hh)
    g.poly('tr_interior', [(x0, top, BULK[0]), (x1, top, BULK[0]), (x1, top, BULK[1]), (x0, top, BULK[1])], LINING, hint=(0, -1, 0))
    # the cab door: a slab with a small window, closed
    zp, zc = BULK[0] + 0.03, BULK[1] - 0.03
    wx0, wx1, wy0, wy1 = 0.28, 0.62, 2.05, 2.6
    for zz, h, col in ((zp, -1, shade(DADO, 1.15)), (zc, 1, CAB_INT)):
        tk.grid(g, lambda u, v, zz=zz: (u, v, zz), [x0, wx0, wx1, x1], [FLOOR, wy0, wy1, top],
                lambda i, j, u0, u1, v0, v1, col=col: None if (i == 1 and j == 1) else ('tr_interior', col), hint=(0, 0, h))
    for (pa, pb, hh) in (((wx0, wy0), (wx1, wy0), (0, 1, 0)), ((wx0, wy1), (wx1, wy1), (0, -1, 0))):
        g.poly('tr_dark', [(pa[0], pa[1], zp), (pb[0], pb[1], zp), (pb[0], pb[1], zc), (pa[0], pa[1], zc)], RUBBER, hint=hh)
    for x, hh in ((wx0, (1, 0, 0)), (wx1, (-1, 0, 0))):
        g.poly('tr_dark', [(x, wy0, zp), (x, wy1, zp), (x, wy1, zc), (x, wy0, zc)], RUBBER, hint=hh)
    g.poly('tr_glass', [(wx0, wy0, CAB_Z0), (wx1, wy0, CAB_Z0), (wx1, wy1, CAB_Z0), (wx0, wy1, CAB_Z0)], WHITE, hint=(0, 0, -1))
    box(g, 'tr_interior', (x0 + 0.05, 1.95, zp - 0.05), (x0 + 0.09, 2.05, zp), POLE)
    # the cab's inner front wall, with the windscreen openings
    xs = uniq([-WALL_IN, WALL_IN] + [v for ab in WS_PANES for v in ab])
    tk.grid(g, lambda u, v: (u, v, CAB_FRONT_IN), xs, [FLOOR, WS[0], WS[1], DOOR_TOP],
            lambda i, j, u0, u1, v0, v1: None if (j == 1 and any(a < (u0 + u1) / 2 < b for a, b in WS_PANES)) else ('tr_interior', CAB_INT), hint=(0, 0, -1))


def seat(g, zb, f, hip_y, x0, x1):
    """One seat place: the moulded shell and cushion as one profile, x0..x1 across, the back plane at zb, facing f."""
    prof = [(-0.10, 0.67), (-0.04, 0.70), (0.03, 0.67), (0.035, 0.17), (0.07, 0.05), (0.13, 0.015), (0.42, 0.015), (0.47, -0.005), (0.47, -0.08), (0.42, -0.11), (0.06, -0.11), (-0.035, -0.05), (-0.075, 0.17)]
    fabric = {2, 3, 4, 5, 6}
    pts = [(zb + f * d, hip_y + dy) for d, dy in prof]
    prism_x(g, 'tr_interior', pts, x0, x1, SHELL, side_col=lambda i: (FABRIC if i in (4, 5) else FABRIC_DK) if i in fabric else SHELL)


def seats(g):
    for zb, f, hy, xs in seat_rows():
        for s in (1, -1):
            hips = sorted(abs(x) for x in xs if (x > 0) == (s > 0))
            if not hips:
                continue
            for hx in hips:
                a, b = sorted((s * (hx - 0.225), s * (hx + 0.225)))
                seat(g, zb, f, hy, a + 0.005, b - 0.005)
            inner = hips[0] - 0.225
            # pedestal under the aisle end, and the grab handle on the back's aisle corner
            a, b = sorted((s * (inner + 0.04), s * (inner + 0.10)))
            za, zz = sorted((zb + f * 0.08, zb + f * 0.38))
            box(g, 'tr_interior', (a, FLOOR, za), (b, hy - 0.11, zz), SHELL, skip=('-y', '+y'))
            top = hy + 0.70
            hxa, hxb = s * (inner + 0.02), s * (inner + 0.22)
            zh = zb - f * 0.03
            tk.polyline_tube(g, 'tr_interior', [(hxa, top - 0.03, zh), (hxa, top + 0.07, zh), (hxb, top + 0.07, zh), (hxb, top - 0.03, zh)], 0.012, 6, POLE)


def back_to_back():
    """z of the aisle poles: between seat rows that stand back to back."""
    rows = seat_rows()
    out = []
    for (za, fa, _, _), (zb, fb, _, _) in zip(rows, rows[1:]):
        if fa < 0 < fb and abs(zb - za) < 0.2:
            out.append((za + zb) / 2)
    return out


def poles_and_screens(g):
    pole = lambda x, z: tube(g, 'tr_interior', (x, FLOOR, z), (x, CEIL, z), 0.019, 8, POLE, caps=False)
    for c in DOOR_Z:
        for zs in (c - 0.85, c + 0.85):
            for s in (1, -1):
                pole(s * 0.82, zs)
                # the draft screen: a solid lower panel and glass above, in a tube frame
                xa, xb = sorted((s * 0.84, s * WALL_IN))
                box(g, 'tr_interior', (xa, FLOOR + 0.15, zs - 0.015), (xb, 1.95, zs + 0.015), shade(LINING, 0.9))
                g.poly('tr_glass', [(xa, 1.95, zs), (xb, 1.95, zs), (xb, 2.4, zs), (xa, 2.4, zs)], WHITE, hint=(0, 0, 1))
                tube(g, 'tr_interior', (s * 0.82, 2.4, zs), (s * WALL_IN, 2.4, zs), 0.016, 6, POLE, caps=False)
    for z in back_to_back():
        for s in (1, -1):
            pole(s * 0.47, z)
    # horizontal grab rails over the aisle edges, bay by bay, hung from the ceiling
    bays = [(END_IN + 0.15, DOOR_Z[0] - 0.95)] + [(DOOR_Z[i] + 0.95, DOOR_Z[i + 1] - 0.95) for i in range(len(DOOR_Z) - 1)] + [(DOOR_Z[-1] + 0.95, BULK[0] - 0.15)]
    for z0, z1 in bays:
        for s in (1, -1):
            x = s * 0.5
            tube(g, 'tr_interior', (x, 3.0, z0), (x, 3.0, z1), 0.016, 6, POLE)
            n = max(1, int(math.ceil((z1 - z0) / 1.8)))
            for k in range(n + 1):
                z = z0 + 0.1 + (z1 - z0 - 0.2) * k / n
                tube(g, 'tr_interior', (x, 3.0, z), (x, CEIL, z), 0.011, 5, POLE, caps=False)


def cab(g):
    # the console under the windscreen, sloping toward the operator, and the operator's seat (on the right, -X)
    lo = [(-1.42, FLOOR, 10.92), (0.25, FLOOR, 10.92), (0.25, FLOOR, CAB_FRONT_IN), (-1.42, FLOOR, CAB_FRONT_IN)]
    hi = [(-1.42, 1.88, 11.06), (0.25, 1.88, 11.06), (0.25, 1.88, CAB_FRONT_IN), (-1.42, 1.88, CAB_FRONT_IN)]
    hexa(g, 'tr_interior', lo + hi, lambda p: shade(CONSOLE, 1.35 if p[1] > 1.8 else 1.0), skip=('-y',))
    box(g, 'tr_interior', (-0.9, 1.6, 10.9), (-0.6, 1.66, 10.98), shade(CONSOLE, 2.2))
    box(g, 'tr_interior', (-0.82, FLOOR, 10.45), (-0.68, 1.5, 10.6), CONSOLE, skip=('-y',))
    box(g, 'tr_interior', (-1.0, 1.5, 10.35), (-0.5, 1.6, 10.82), shade(CONSOLE, 1.4))
    box(g, 'tr_interior', (-1.0, 1.6, 10.3), (-0.5, 2.25, 10.38), shade(CONSOLE, 1.4))


# ------------------------------------------------------------------------------------------- assembly
def body(lod):
    g = Geo(lod)
    for s in (1, -1):
        side_wall(g, s, lod)
        window_details(g, s, lod)
    roof(g, lod)
    corners(g, lod)
    underside(g, lod)
    end_face(g, lod, 1)
    end_face(g, lod, -1)
    underframe(g, lod)
    if lod <= 1:
        couplers(g, lod)
    if lod == 1:
        # the dark box behind the glass, and dark door pockets behind the leaves
        for s in (1, -1):
            x = s * 1.5
            g.poly('tr_dark', [(x, FLOOR, -HL + 0.2), (x, FLOOR, HL - 0.3), (x, DOOR_TOP, HL - 0.3), (x, DOOR_TOP, -HL + 0.2)], shade(CAB_INT, 0.35), hint=(s, 0, 0))
        g.poly('tr_dark', [(-1.5, FLOOR, -HL + 0.2), (1.5, FLOOR, -HL + 0.2), (1.5, DOOR_TOP, -HL + 0.2), (-1.5, DOOR_TOP, -HL + 0.2)], shade(CAB_INT, 0.35), hint=(0, 0, -1))
        g.poly('tr_dark', [(-1.5, DOOR_TOP, -HL + 0.2), (1.5, DOOR_TOP, -HL + 0.2), (1.5, DOOR_TOP, HL - 0.3), (-1.5, DOOR_TOP, HL - 0.3)], shade(CAB_INT, 0.3), hint=(0, -1, 0))
        g.poly('tr_floor', [(-1.5, FLOOR, -HL + 0.2), (1.5, FLOOR, -HL + 0.2), (1.5, FLOOR, HL - 0.3), (-1.5, FLOOR, HL - 0.3)], shade(FLOOR_C, 0.5), hint=(0, 1, 0))
        for s in (1, -1):
            for c in DOOR_Z:
                for z, h in ((c - DHW, 1), (c + DHW, -1)):
                    g.poly('tr_steel', [(s * 1.5, FLOOR, z), (s * HW, FLOOR, z), (s * HW, DOOR_TOP, z), (s * 1.5, DOOR_TOP, z)], STEEL_DK, hint=(0, 0, h))
                g.poly('tr_steel', [(s * 1.5, DOOR_TOP, c - DHW), (s * HW, DOOR_TOP, c - DHW), (s * HW, DOOR_TOP, c + DHW), (s * 1.5, DOOR_TOP, c + DHW)], STEEL_DK, hint=(0, -1, 0))
    if lod == 2:
        # a dark box behind the window band, so the far car is not see-through
        for s in (1, -1):
            x = s * 1.45
            g.poly('tr_dark', [(x, WIN[0] - 0.05, -HL + 0.3), (x, WIN[0] - 0.05, HL - 0.15), (x, WIN[1] + 0.05, HL - 0.15), (x, WIN[1] + 0.05, -HL + 0.3)], shade(CAB_INT, 0.3), hint=(s, 0, 0))
        g.poly('tr_dark', [(-1.45, WS[0] - 0.05, HL - 0.15), (1.45, WS[0] - 0.05, HL - 0.15), (1.45, WS[1] + 0.05, HL - 0.15), (-1.45, WS[1] + 0.05, HL - 0.15)], shade(CAB_INT, 0.3), hint=(0, 0, 1))
        for zc in (-BOGIE_Z, BOGIE_Z):
            for s in (1, -1):
                xa, xb = sorted((s * 0.62, s * 1.06))
                box(g, 'tr_dark', (xa, 0.0, zc - 1.5), (xb, 0.74, zc + 1.5), BOGIE_C, skip=('-y',))
    return g


GROUND = [((-30.0, -0.15, -30.0), (30.0, -0.15, -30.0), (30.0, -0.15, 30.0)), ((-30.0, -0.15, -30.0), (30.0, -0.15, 30.0), (-30.0, -0.15, 30.0))]


def build(asset):
    scene.reset()
    root = scene.empty('railcar', props={'asset': asset, 'lod_from': LOD_FROM, 'leafTravel': TRAVEL})
    counts = []
    leaves = []
    for lod in (0, 1, 2):
        grp = scene.empty(f'lod{lod}', parent=root)
        pieces = []
        b = body(lod)
        pieces.append((f'lod{lod}_body', b, (0.0, 0.0, 0.0), False, None))
        if lod == 0:
            pieces.append(('lod0_interior', interior(), (0.0, 0.0, 0.0), False, None))
        if lod <= 1:
            for tag, zc in (('F', BOGIE_Z), ('R', -BOGIE_Z)):
                pieces.append((f'lod{lod}_bogie_{tag}', bogie(lod, zc), (0.0, 0.0, zc), True, None))
            for name, s, c, half, side, i in door_names(lod):
                ctr = leaf_centre(s, c, half)
                dz = -TRAVEL if half == 'a' else TRAVEL
                pieces.append((name, leaf(lod, s, c, half), ctr, True, {'slide': [0.0, 0.0, dz]}))
                if lod == 0:
                    leaves.append({'name': name.replace('lod0_', ''), 'side': side, 'index': i, 'leaf': half,
                                   'closed': [round(v, 4) for v in ctr], 'open': [round(ctr[0], 4), round(ctr[1], 4), round(ctr[2] + dz, 4)]})
        if lod <= 1:
            tk.bake_ao([p[1] for p in pieces], dist=0.7 if lod == 0 else 0.9, rays=20 if lod == 0 else 12, extra=GROUND, strength=1.1)
        else:
            for part in b.parts.values():
                for i, p in enumerate(part.p):
                    c = part.c[i]
                    part.c[i] = (c[0], c[1], c[2], 0.55 if p[1] < SOLE + 0.01 else 1.0)
        for name, g, pivot, wrap, props in pieces:
            tk.emit(name, g, grp, pivot=pivot, wrap=wrap, props=props)
        counts.append(sum(tk.tris(p[1]) for p in pieces))
        if lod == 0:
            lo, hi = tk.bounds([p[1] for p in pieces])
    root['lod_tris'] = counts
    anchors = scene.empty('anchors', parent=root)
    an = {}
    for side, s in (('L', 1), ('R', -1)):
        for i, c in enumerate(DOOR_Z):
            an[f'anchor_door_{side}{i}'] = ((s * HW, FLOOR, c), None)
    # a forward-facing window seat on the left (+X), the one most nearly centred on its window: eye height, looking out (+X)
    best = None
    for idx, (x, y, z, yaw) in enumerate(D['seats']):
        if x < 1.0 or math.cos(yaw) < 0.5:
            continue
        for a, b in WINDOWS[:-1]:
            off = abs(z - (a + b) / 2)
            if a < z < b and (best is None or off < best[0] - 1e-6):
                best = (off, idx, x, y, z)
    _, idx, sx, sy, sz = best
    an['anchor_cam_window'] = ((sx - 0.05, sy + 0.75, sz), {'yaw': round(math.pi / 2, 4), 'seat': idx})
    an['anchor_headlight'] = ((0.0, HEAD_Y, HL + 0.03), {'spread': 1.52})
    an['anchor_coupler_F'] = ((0.0, 0.80, HL + D['gap'] / 2 - 0.01), None)
    an['anchor_coupler_R'] = ((0.0, 0.80, -(HL + D['gap'] / 2 - 0.01)), None)
    for name in sorted(an):
        pos, props = an[name]
        scene.empty(name, pos, anchors, props=props)

    from . import preview
    preview.install({
        'cab': dict(cam=(9.0, 3.2, 21.0), at=(0.0, 1.9, 6.0), lens=32),
        'side': dict(cam=(26.0, 2.4, 0.0), at=(0.0, 2.0, 0.0), lens=30),
        'rear': dict(cam=(-7.0, 3.4, -19.0), at=(0.0, 1.8, -7.0), lens=32),
        'front': dict(cam=(2.2, 2.2, 15.5), at=(0.0, 1.9, 11.0), lens=30),
        'bogie': dict(cam=(4.2, 0.9, 11.5), at=(0.0, 0.7, 8.1), lens=30),
        'interior': dict(cam=(0.15, 2.25, -10.6), at=(0.0, 2.05, 4.0), lens=16, samples=48, sun=2.0, show=lambda n: n.startswith('lod0')),
        'window': dict(cam=an['anchor_cam_window'][0], at=(4.0, 1.95, sz + 4.5), lens=15, samples=48, show=lambda n: n.startswith('lod0')),
        'cabin': dict(cam=(-0.3, 2.5, 6.0), at=(0.2, 2.1, 11.0), lens=18, samples=48, show=lambda n: n.startswith('lod0')),
        'lod1': dict(cam=(9.0, 3.2, 21.0), at=(0.0, 1.9, 6.0), lens=32, show=lambda n: n.startswith('lod1')),
        'lod2': dict(cam=(9.0, 3.2, 21.0), at=(0.0, 1.9, 6.0), lens=32, show=lambda n: n.startswith('lod2')),
    }, size=(960, 540), default_show=lambda n: n.startswith('lod0'))

    sidecar = {
        'asset': asset,
        'dims': {k: D[k] for k in ('length', 'gap', 'halfWidth', 'floorY', 'roofY', 'skirtY', 'bogieZ', 'wheelR', 'doors', 'cab', 'bandY', 'windowY')},
        'bounds': {'min': [round(v, 3) for v in lo], 'max': [round(v, 3) for v in hi]},
        'lods': [{'tris': c, 'from': LOD_FROM[i]} for i, c in enumerate(counts)],
        'doors': {'travel': TRAVEL, 'nodes': {f'lod{lod}': [n[0] for n in door_names(lod)] for lod in (0, 1)}, 'leaves': leaves},
        'bogies': {f'lod{lod}': [f'lod{lod}_bogie_F', f'lod{lod}_bogie_R'] for lod in (0, 1)},
        'anchors': {name: [round(v, 4) for v in an[name][0]] for name in sorted(an)},
        'materials': tk.CAR_MATERIALS,
        'signs': {'front': [round(2 * SIGN_FRONT[0], 3), round(SIGN_FRONT[2] - SIGN_FRONT[1], 3)], 'side': [round(SIGN_SIDE[1] - SIGN_SIDE[0], 3), round(SIGN_SIDE[3] - SIGN_SIDE[2], 3)]},
    }
    return {'asset': asset, 'tris': counts, 'sidecar': sidecar}
