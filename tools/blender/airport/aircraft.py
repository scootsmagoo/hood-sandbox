"""The AI airliners of the airport: one parametric builder for the three classes of src/shared/data/aircraft.json (the file the
sim's kinematics and colliders and the jet bridges read), built to its numbers:

  ac-narrowbody   single-aisle twinjet, A320 class: low wing with sharklets, two underwing turbofans, twin-wheel mains
  ac-widebody     twin-aisle twinjet, 777 class: big turbofans, raked wingtips, six-wheel main bogies
  ac-regional     regional jet, CRJ900 class: two rear-fuselage engines on stub pylons, a T-tail, small winglets, low-slung

Script-built interpretations: no real airline marks, logos or lettering. The livery is the game's: the painted skin carries a
region code per vertex and the game colours each region from aircraft.json `liveries`.

Frame: metres, +X the aircraft's LEFT, +Y up, +Z forward (the nose); origin on the ground (tyre bottoms, gear down) at the centre
of the main gear; the nose gear at z = +wheelbase.

  aircraft                     root; extras: asset, type, lod_tris, lod_from [0, 220, 1100]
    lod0 / lod1 / lod2         one group per level of detail
      lodN_body                everything but the gear (one mesh, one primitive per material)
      lodN_gear                nose and main gear with their doors and wells, hidden by the game when retracted (LOD0, LOD1)
    anchors                    anchor_doorL1, anchor_navLeft/Right, anchor_tail, anchor_beaconTop/Bottom, anchor_landing,
                               anchor_strobeLeft/Right (aircraft.json), anchor_noseGear (0, 0, wheelbase), anchor_tow (the nose
                               gear axle: the tug's cradle takes the nose wheels there)

Materials (ac_kit.py): ac_paint (COLOR_0.r = region k/7: 0 crown, 1 belly, 2 fin, 3 engine, 4 stripe, 5 accent; g = 1; a = AO),
ac_grey, ac_metal, ac_dark, ac_window, ac_light (COLOR_0 = albedo or lamp colour, a = AO).
"""
import json
import math
import os

from hoodlib.curves import Profile
from . import ac_kit as K
from .ac_kit import (Geo, bake_ao, box, emit, empty, flat_ao, grid_normals, hexa, lathe, obox, paint, pwl, sheet, smoothstep, srgb,
                     strip, tube, vadd, vcross, vdot, vlen, vmul, vnorm, vsub)

VERTEX_COLOR = 'ACTIVE'

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DATA = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'aircraft.json')))
LOD_FROM = [0, 220, 1100]
ASSETS = {'ac-narrowbody': 'narrowbody', 'ac-widebody': 'widebody', 'ac-regional': 'regional'}

# ------------------------------------------------------------------------------------------- colours (linear albedo)
GREY = srgb(0xbfc3c8)          # wing and tailplane skin
GREY_DK = srgb(0x8d9298)       # walkway, core cowls
GREY_IN = srgb(0x6f747a)       # inside the intake
METAL = srgb(0xc9ccd1)         # leading edges, intake lips
STRUT = srgb(0xb4b8bd)         # gear legs (light grey paint over chrome)
METAL_DK = srgb(0x6a6d72)      # exhaust plug, brakes
TYRE = srgb(0x1b1b1d)
HUB = srgb(0x9ea2a8)
FAN = srgb(0x1f2125)
WELL = srgb(0x2c2d30)
GAP = srgb(0x1a1b1d)
APU = srgb(0x121214)
GLASS = srgb(0x10161c)
LAMP_RED = srgb(0xff2414)
LAMP_GREEN = srgb(0x18ff52)
LAMP_WHITE = (1.0, 1.0, 1.0)

CROWN, BELLY, FIN, ENGINE, STRIPE, ACCENT = (paint(k) for k in ('crown', 'belly', 'fin', 'engine', 'stripe', 'accent'))

# ------------------------------------------------------------------------------------------- the classes' shapes
# Everything below is a proportion or a position read against the class's aircraft.json numbers: nose and tail profiles are
# (distance from the tip in metres, value in fuselage radii about the fuselage centre line); angles are degrees round the section
# from the crown (0) to the keel (180) on the left side.
STYLE = {
    'narrowbody': dict(
        nose=dict(length=6.2,
                  crown=[(0, -0.22), (0.15, 0.0), (0.5, 0.18), (1.0, 0.32), (1.6, 0.43), (2.15, 0.52), (3.0, 0.77), (3.9, 0.92), (5.0, 0.985), (6.2, 1.0)],
                  keel=[(0, -0.22), (0.15, -0.47), (0.5, -0.65), (1.0, -0.77), (2.0, -0.89), (3.5, -0.975), (5.2, -0.998), (6.2, -1.0)],
                  half=[(0, 0.0), (0.15, 0.30), (0.5, 0.52), (1.0, 0.67), (2.0, 0.83), (3.0, 0.92), (4.5, 0.985), (6.2, 1.0)],
                  mid=[(0, -0.22), (1.0, -0.15), (3.0, -0.05), (5.5, 0.0), (6.2, 0.0)]),
        tail=dict(length=11.5,
                  crown=[(0, 0.80), (1.5, 0.86), (4.0, 0.935), (7.0, 0.99), (9.5, 1.0), (11.5, 1.0)],
                  keel=[(0, 0.56), (1.0, 0.44), (2.5, 0.22), (5.0, -0.26), (7.5, -0.68), (9.5, -0.92), (11.5, -1.0)],
                  half=[(0, 0.12), (1.5, 0.26), (4.0, 0.50), (7.0, 0.78), (9.5, 0.95), (11.5, 1.0)],
                  mid=[(0, 0.68), (3.0, 0.50), (6.0, 0.28), (9.0, 0.06), (11.5, 0.0)]),
        cockpit=dict(ws=(2.15, 3.0), sides=[(3.08, 3.78), (3.86, 4.42)], post=5.0, ws_corner=52.0, side_top=32.0, side_bot=61.0),
        windows=dict(y=4.45, h=0.33, w=0.235, pitch=0.533, front=10.45, rear=-8.45, chamfer=0.06),
        stripe=(0.40, 0.66),          # below the window bottom (m): the cheatline's top and bottom
        doors=[('L', 11.4, 0.81, 3.40, 5.25), ('R', 11.4, 0.81, 3.40, 5.25), ('L', -9.25, 0.81, 3.40, 5.25), ('R', -9.25, 0.81, 3.40, 5.25)],
        exits=[1.05, 0.25], exit_size=(0.52, 1.0),
        cargo=[('R', 6.6, 8.4, 1.95, 3.15), ('R', -5.9, -4.2, 1.95, 3.15)],
        wing=dict(root_in=0.70, kink=0.30, tc=(0.15, 0.12, 0.10), camber=0.02, tip='sharklet', tip_x=17.12,
                  device=dict(rb=0.45, cant=10.0, h=2.2, sweep=1.9, chord=0.55, tc=0.085)),
        flaptracks=[0.12, 0.40, 0.57, 0.74],
        tailplane=dict(y=4.40, sweep=30.0, taper=0.36, dihedral=6.0, tc=0.10),
        fin=dict(sweep=33.0, tc=0.11, fillet=(1.35, 0.75)),
        engine=dict(kind='long', pylon_w=0.19),
        fairing=dict(front=0.32, rear=0.45, width=1.13, bottom=-0.03, top=-0.10),
        gear=dict(main_r=0.585, main_w=0.37, main_dx=0.26, nose_r=0.38, nose_w=0.22, nose_dx=0.19, bogie=False),
        ao=2.0,
    ),
    'widebody': dict(
        # the narrowbody's nose drawn 1.5 times longer (in radii it is the same shape), a little fuller at the chin
        nose=dict(length=9.3,
                  crown=[(0, -0.24), (0.22, -0.02), (0.75, 0.17), (1.5, 0.31), (2.4, 0.42), (3.25, 0.51), (4.5, 0.765), (5.85, 0.92), (7.5, 0.985), (9.3, 1.0)],
                  keel=[(0, -0.24), (0.22, -0.49), (0.75, -0.66), (1.5, -0.78), (3.0, -0.89), (5.25, -0.975), (7.8, -0.998), (9.3, -1.0)],
                  half=[(0, 0.0), (0.22, 0.30), (0.75, 0.52), (1.5, 0.67), (3.0, 0.83), (4.5, 0.92), (6.75, 0.985), (9.3, 1.0)],
                  mid=[(0, -0.24), (1.5, -0.16), (4.5, -0.05), (8.2, 0.0), (9.3, 0.0)]),
        tail=dict(length=16.0,
                  crown=[(0, 0.80), (2.0, 0.86), (5.0, 0.93), (9.0, 0.985), (13.0, 1.0), (16.0, 1.0)],
                  keel=[(0, 0.52), (1.5, 0.38), (3.5, 0.15), (7.0, -0.30), (10.5, -0.70), (13.5, -0.93), (16.0, -1.0)],
                  half=[(0, 0.07), (1.5, 0.20), (4.0, 0.42), (8.0, 0.72), (12.0, 0.93), (16.0, 1.0)],
                  mid=[(0, 0.66), (4.0, 0.50), (8.0, 0.27), (12.0, 0.07), (16.0, 0.0)]),
        cockpit=dict(ws=(3.25, 4.5), sides=[(4.62, 5.68), (5.80, 6.62)], post=4.0, ws_corner=52.0, side_top=33.0, side_bot=60.0),
        windows=dict(y=5.95, h=0.40, w=0.27, pitch=0.533, front=22.55, rear=-18.3, chamfer=0.075),
        stripe=(0.26, 0.58),
        doors=[(s, z, 1.07, 4.80, 6.68) for z in (23.6, 10.8, -6.6, -17.4) for s in ('L', 'R')],
        exits=[], exit_size=(0.5, 1.0),
        cargo=[('R', 14.9, 17.6, 2.85, 4.55), ('R', -9.8, -7.5, 2.85, 4.55)],
        wing=dict(root_in=0.72, kink=0.30, tc=(0.145, 0.115, 0.095), camber=0.02, tip='raked', tip_x=None, rake=0.85, rake_sweep=34.0),
        flaptracks=[0.13, 0.42, 0.57, 0.71],
        tailplane=dict(y=7.25, sweep=29.0, taper=0.32, dihedral=7.0, tc=0.10),
        fin=dict(sweep=None, tc=0.10, fillet=(1.8, 1.1)),
        engine=dict(kind='short', pylon_w=0.32),
        fairing=dict(front=0.30, rear=0.42, width=1.12, bottom=-0.03, top=-0.10),
        gear=dict(main_r=0.62, main_w=0.48, main_dx=0.66, nose_r=0.53, nose_w=0.30, nose_dx=0.30, bogie=True, axle=1.45),
        ao=3.0,
        q={0: dict(fill=dict(belly=5), tail_n=8, ft_sides=5), 1: dict(fill=dict(belly=2))},
    ),
    'regional': dict(
        nose=dict(length=5.6,
                  crown=[(0, -0.38), (0.12, -0.16), (0.45, 0.04), (1.0, 0.22), (1.85, 0.42), (2.45, 0.66), (3.2, 0.86), (4.2, 0.97), (5.0, 0.995), (5.6, 1.0)],
                  keel=[(0, -0.38), (0.12, -0.55), (0.45, -0.70), (1.0, -0.80), (2.2, -0.91), (3.8, -0.975), (5.0, -0.998), (5.6, -1.0)],
                  half=[(0, 0.0), (0.12, 0.24), (0.45, 0.42), (1.0, 0.58), (2.0, 0.76), (3.0, 0.88), (4.2, 0.97), (5.6, 1.0)],
                  mid=[(0, -0.38), (1.0, -0.28), (3.0, -0.10), (5.0, 0.0), (5.6, 0.0)]),
        tail=dict(length=8.5, tip_z=-15.25,
                  crown=[(0, 0.58), (1.0, 0.70), (3.0, 0.88), (5.5, 0.98), (8.0, 1.0), (8.5, 1.0)],
                  keel=[(0, 0.34), (0.8, 0.20), (2.0, -0.05), (4.0, -0.45), (6.0, -0.80), (7.5, -0.96), (8.5, -1.0)],
                  half=[(0, 0.10), (1.0, 0.25), (3.0, 0.52), (5.5, 0.82), (7.5, 0.97), (8.5, 1.0)],
                  mid=[(0, 0.46), (3.0, 0.35), (5.5, 0.15), (8.0, 0.02), (8.5, 0.0)]),
        cockpit=dict(ws=(1.85, 2.45), sides=[(2.52, 2.98), (3.04, 3.42)], post=5.0, ws_corner=53.0, side_top=32.0, side_bot=62.0),
        windows=dict(y=2.62, h=0.33, w=0.235, pitch=0.62, front=15.45, rear=-6.55, chamfer=0.06),
        stripe=(0.14, 0.30),
        doors=[('L', 16.4, 0.86, 1.75, 3.08), ('R', 16.4, 0.70, 1.95, 3.0), ('R', -6.3, 0.62, 1.95, 2.95)],
        exits=[0.45, -0.25], exit_size=(0.5, 0.92),
        cargo=[('L', -6.7, -5.75, 1.6, 2.55), ('R', 11.3, 12.3, 0.95, 1.75)],
        wing=dict(root_in=0.62, kink=0.33, tc=(0.14, 0.12, 0.10), camber=0.02, tip='winglet', tip_x=11.8,
                  device=dict(rb=0.30, cant=24.0, h=1.0, sweep=0.75, chord=0.55, tc=0.09)),
        flaptracks=[0.30, 0.56, 0.76],
        tailplane=dict(y=7.0, sweep=None, taper=0.42, dihedral=0.0, tc=0.10),
        fin=dict(sweep=None, tc=0.12, fillet=(0.9, 0.5)),
        engine=dict(kind='rear', pylon_w=None),
        fairing=dict(front=0.28, rear=0.40, width=1.10, bottom=-0.03, top=-0.12),
        gear=dict(main_r=0.43, main_w=0.27, main_dx=0.19, nose_r=0.32, nose_w=0.18, nose_dx=0.15, bogie=False),
        ao=1.5,
        q={0: dict(fill=dict(belly=4), nac=16, dev_st=3)},
    ),
}

# per level of detail: rows round each half of the fuselage, loft resolution, wing chord points, lathe sides
Q = {
    0: dict(fill=dict(post=0, kp=1, wt=1, belly=6, top=1), chamfer=True, windows='cells', nose_d=[0, 0.03, 0.1, 0.22, 0.4, 0.65, 0.95, 1.3, 1.75],
            tail_n=10, cabin_step=4.0, xcs=[1.0, 0.86, 0.745, 0.725, 0.6, 0.42, 0.25, 0.12, 0.05, 0.015, 0.0], nac=20, wheel=10,
            ft_sides=6, pylon=True, dev_st=4),
    1: dict(fill=dict(post=0, kp=0, wt=0, belly=3, top=0), chamfer=False, windows='strip', nose_d=[0, 0.1, 0.35, 0.8, 1.4],
            tail_n=5, cabin_step=9.0, xcs=[1.0, 0.7, 0.35, 0.1, 0.02, 0.0], nac=12, wheel=8, ft_sides=0, pylon=True, dev_st=2),
    2: dict(fill=None, chamfer=False, windows=None, nose_d=[0, 0.4, 1.4], tail_n=3, cabin_step=99.0,
            xcs=[1.0, 0.4, 0.06, 0.0], nac=8, wheel=0, ft_sides=0, pylon=False, dev_st=1),
}

RAD = math.pi / 180.0
_CUR = {'typ': None}   # the class being built: its STYLE['q'] overrides the levels' resolution


def qx(lod):
    q = dict(Q[lod])
    for k, v in STYLE.get(_CUR['typ'], {}).get('q', {}).get(lod, {}).items():
        q[k] = dict(q[k], **v) if isinstance(v, dict) and isinstance(q.get(k), dict) else v
    return q


def _flat_end(points, end, value):
    pts = sorted(points)
    if pts[-1][0] < end - 1e-9:
        pts.append((end, value))
    pts.append((end + 0.5 * end, value))   # a flat extension: the profile meets the cabin with zero slope
    return pts


class Fuselage:
    """The fuselage surface: sections at every z, a piecewise ellipse (upper and lower halves) from four profiles (crown, keel,
    half width, the height of the widest line), the nose profiles in sqrt(distance from the tip) so the tip is round."""

    def __init__(self, T, sty):
        f = T['fuselage']
        self.R, self.cy = f['radius'], f['centreY']
        self.nose = T['noseZ']
        self.tailtip = sty['tail'].get('tip_z', T['tailZ'])
        n, t = sty['nose'], sty['tail']
        self.nl, self.tl = n['length'], t['length']
        cab = {'crown': 1.0, 'keel': -1.0, 'half': 1.0, 'mid': 0.0}
        self.cab = cab
        self.np = {k: Profile(_flat_end([(math.sqrt(d), v) for d, v in n[k]], math.sqrt(self.nl), cab[k])) for k in cab}
        self.tp = {k: Profile(_flat_end(list(t[k]), self.tl, cab[k])) for k in cab}

    def val(self, k, z):
        d = self.nose - z
        e = z - self.tailtip
        if d < self.nl:
            return self.np[k](math.sqrt(max(0.0, d)))
        if e < self.tl:
            return self.tp[k](max(0.0, e))
        return self.cab[k]

    def dims(self, z):
        R, cy = self.R, self.cy
        return cy + R * self.val('crown', z), cy + R * self.val('keel', z), R * self.val('half', z), cy + R * self.val('mid', z)

    def at(self, z, th):
        c, k, h, m = self.dims(z)
        ct, st = math.cos(th), math.sin(th)
        y = m + (c - m) * ct if ct >= 0 else m + (m - k) * ct
        return (h * st, y, z)

    def normal(self, z, th):
        if z >= self.nose - 1e-5:
            return (0.0, 0.0, 1.0)
        e = 1e-3
        za, zb = max(self.tailtip, z - e), min(self.nose, z + e)
        dz = vsub(self.at(zb, th), self.at(za, th))
        dt = vsub(self.at(z, th + e), self.at(z, th - e))
        n = vcross(dz, dt)
        if vlen(n) < 1e-12:
            return (0.0, 0.0, 1.0 if z > 0 else -1.0)
        n = vnorm(n)
        p = self.at(z, th)
        _, _, _, m = self.dims(z)
        if vdot(n, (p[0], p[1] - m, 0.0)) < 0:
            n = (-n[0], -n[1], -n[2])
        return n

    def theta_y(self, z, y, side=1):
        """The section angle at which the surface is at height y (left side)."""
        c, k, _, m = self.dims(z)
        if y >= m:
            ct = (y - m) / max(1e-6, c - m)
        else:
            ct = (y - m) / max(1e-6, m - k)
        return math.acos(max(-1.0, min(1.0, ct)))

    def surface(self, z, y, side=1):
        """The surface point and normal at height y on a side (1 left, -1 right)."""
        th = self.theta_y(z, y)
        p, n = self.at(z, th), self.normal(z, th)
        if side < 0:
            p, n = (-p[0], p[1], p[2]), (-n[0], n[1], n[2])
        return p, n


def uniq_sorted(zs, tol=1e-4):
    out = []
    for z in sorted(zs):
        if not out or z - out[-1] > tol:
            out.append(z)
    return out


# ------------------------------------------------------------------------------------------- the fuselage skin
def windows_of(T, sty):
    """The cabin windows' (z0, z1) on each side: a row at the class's pitch, clear of the doors."""
    w = sty['windows']
    out = []
    z = w['front']
    doors = [(d[1] - d[2] / 2 - 0.16, d[1] + d[2] / 2 + 0.16) for d in sty['doors']]
    while z >= w['rear'] - 1e-6:
        z0, z1 = z - w['w'] / 2, z + w['w'] / 2
        if not any(a < z1 and z0 < b for a, b in doors):
            out.append((round(z0, 4), round(z1, 4)))
        z -= w['pitch']
    return sorted(out)


def fuselage_lines(fus, T, sty, q):
    """The angle lines round the left half (crown 0 to keel pi), each a function of z, with their names, for one level."""
    R, cy = fus.R, fus.cy
    ck = sty['cockpit']
    w = sty['windows']
    nose = fus.nose
    th = lambda y: math.acos(max(-1.0, min(1.0, (y - cy) / R)))
    wt, wb = th(w['y'] + w['h'] / 2), th(w['y'] - w['h'] / 2)
    s0, s1 = th(w['y'] - w['h'] / 2 - sty['stripe'][0]), th(w['y'] - w['h'] / 2 - sty['stripe'][1])
    side_end = ck['sides'][-1][1]
    first_win_d = nose - w['front'] - w['w'] / 2
    d_of = lambda z: nose - z

    def key(points):
        pts = sorted((d, a * RAD) for d, a in points)
        return lambda z: pwl(pts, d_of(z))

    post = key([(0, ck['post']), (side_end, ck['post']), (fus.nl, 16.0)])
    kp = key([(0, ck['ws_corner']), (ck['ws'][0], ck['ws_corner']), (ck['ws'][1], ck['side_top']), (side_end + 0.3, ck['side_top']), (side_end + 1.6, 30.0)])
    lift = ck['side_bot'] * RAD - wt     # how far the window line rises in the cockpit
    rise = lambda z: lift * (1.0 - smoothstep(side_end + 0.15, max(side_end + 0.5, first_win_d - 0.35), d_of(z)))
    chw = (w['chamfer'] / (R * math.sin(wt)))
    if q is None:
        # the far level: crown, a line under the stripe, belly
        return [('crown', lambda z: 0.0), ('a', lambda z: 48 * RAD), ('sbot', lambda z: s1), ('b', lambda z: 125 * RAD), ('keel', lambda z: math.pi)]
    keys = [('crown', lambda z: 0.0), ('post', post), ('kp', kp), ('wtop', lambda z: wt + rise(z))]
    if q['chamfer']:
        keys += [('wtc', lambda z: wt + chw + rise(z)), ('wbc', lambda z: wb - chw + rise(z))]
    keys += [('wbot', lambda z: wb + rise(z)), ('stop', lambda z: s0), ('sbot', lambda z: s1), ('keel', lambda z: math.pi)]
    fill = q['fill']
    gaps = {'crown': fill['top'], 'post': fill['kp'], 'kp': fill['wt'], 'sbot': fill['belly']}
    lines = []
    for i, (name, f) in enumerate(keys):
        lines.append((name, f))
        if i + 1 < len(keys):
            n = gaps.get(name, 0)
            g = keys[i + 1][1]
            for k in range(n):
                t = (k + 1) / (n + 1)
                lines.append((f'{name}+{k}', (lambda f, g, t: lambda z: f(z) + (g(z) - f(z)) * t)(f, g, t)))
    return lines


def fuselage_skin(fus, T, sty, lod):
    """The left half of the skin as rows between the angle lines, each row with its own z stations (the window band has every
    window edge; the rows next to it take those points on the shared line), then mirrored. Returns the Geo and the stations."""
    q = qx(lod)
    lines = fuselage_lines(fus, T, sty, q if lod < 2 else None)
    names = [n for n, _ in lines]
    idx = {n: i for i, n in enumerate(names)}
    ck = sty['cockpit']
    nose, tail = fus.nose, fus.tailtip
    wins = windows_of(T, sty) if q['windows'] else []
    w = sty['windows']
    # coarse stations
    ds = list(q['nose_d'])
    if lod <= 1:
        ds += [ck['ws'][0], ck['ws'][1]]
        if lod == 0:
            ds += [(ck['ws'][0] + ck['ws'][1]) / 2]
            for a, b in ck['sides']:
                ds += [a, b]
        else:
            ds += [ck['sides'][0][0], ck['sides'][-1][1]]
    d_last = max(ds)
    n_more = max(1, int(math.ceil((fus.nl - d_last) / (0.75 if lod == 0 else 1.6 if lod == 1 else 3.0))))
    ds += [d_last + (fus.nl - d_last) * k / n_more for k in range(1, n_more + 1)]
    zs = [nose - d for d in ds]
    nt = q['tail_n']
    zs += [tail + fus.tl * (k / nt) ** 1.35 for k in range(nt + 1)]
    zc0, zc1 = tail + fus.tl, nose - fus.nl
    n_cab = max(1, int(math.ceil((zc1 - zc0) / q['cabin_step'])))
    zs += [zc0 + (zc1 - zc0) * k / n_cab for k in range(n_cab + 1)]

    # windows: keep coarse stations out of them (onto the nearest pier centre)
    def clear(z):
        for a, b in wins:
            if a - 0.02 < z < b + 0.02:
                left = a - (w['pitch'] - w['w']) / 2
                right = b + (w['pitch'] - w['w']) / 2
                return left if z - left < right - z else right
        return z
    coarse = uniq_sorted([clear(z) for z in zs], tol=0.03)
    coarse[0], coarse[-1] = tail, nose
    coarse = uniq_sorted(coarse)
    band_names = ('wtop', 'wtc', 'wbc') if q['chamfer'] else ('wtop',)
    band_rows = [idx[n] for n in band_names if n in idx]
    c = w['chamfer']
    if q['windows'] == 'cells':
        extra = []
        for a, b in wins:
            extra += [a, a + c, b - c, b] if q['chamfer'] else [a, b]
    elif q['windows'] == 'strip':
        # runs of windows between the doors
        runs = []
        for a, b in wins:
            if runs and a - runs[-1][1] < w['pitch'] * 1.05:
                runs[-1][1] = b
            else:
                runs.append([a, b])
        extra = [v for r in runs for v in r]
    else:
        extra = []
    band = uniq_sorted(coarse + extra)
    nrows = len(lines) - 1
    row_st = [band if i in band_rows else coarse for i in range(nrows)]
    line_st = []
    for j in range(len(lines)):
        s = []
        if j > 0:
            s += row_st[j - 1]
        if j < nrows:
            s += row_st[j]
        line_st.append(uniq_sorted(s))

    ws_z = (nose - ck['ws'][1], nose - ck['ws'][0])
    side_z = [(nose - b, nose - a) for a, b in ck['sides']] if lod == 0 else [(nose - ck['sides'][-1][1], nose - ck['sides'][0][0])]

    def region(i):
        if i >= idx['sbot']:
            return BELLY
        if 'stop' in idx and i >= idx['stop']:
            return STRIPE
        return CROWN

    def cell(i, a, b):
        col = region(i)
        if lod <= 1:
            # cockpit: the windscreen between the centre post and kp, the side windows between kp and the window line
            if idx['post'] <= i < idx['kp'] and ws_z[0] - 1e-6 <= a and b <= ws_z[1] + 1e-6:
                return [('ac_window', GLASS, None)]
            if idx['kp'] <= i < idx['wtop'] and any(s0 - 1e-6 <= a and b <= s1 + 1e-6 for s0, s1 in side_z):
                return [('ac_window', GLASS, None)]
        if q['windows'] and i in band_rows:
            for z0, z1 in (wins if q['windows'] == 'cells' else [(extra[k], extra[k + 1]) for k in range(0, len(extra), 2)]):
                if z0 - 1e-6 <= a and b <= z1 + 1e-6:
                    if q['chamfer'] and names[i] in ('wtop', 'wbc'):
                        top = names[i] == 'wtop'
                        if abs(a - z0) < 1e-5 and abs(b - (z0 + c)) < 1e-4:
                            return [('diag', 'A' if top else 'D')]
                        if abs(b - z1) < 1e-5 and abs(a - (z1 - c)) < 1e-4:
                            return [('diag', 'B' if top else 'C')]
                    return [('ac_window', GLASS, None)]
        return [('ac_paint', col, None)]

    g = Geo()
    L = [f for _, f in lines]
    for i in range(nrows):
        st = row_st[i]
        for k in range(len(st) - 1):
            a, b = st[k], st[k + 1]
            up = [z for z in line_st[i] if a - 1e-7 <= z <= b + 1e-7]
            lo = [z for z in line_st[i + 1] if a - 1e-7 <= z <= b + 1e-7]
            ptsu = [(fus.at(z, L[i](z)), fus.normal(z, L[i](z))) for z in up]
            ptsl = [(fus.at(z, L[i + 1](z)), fus.normal(z, L[i + 1](z))) for z in lo]
            got = cell(i, a, b)
            zc = (a + b) / 2
            thc = (L[i](zc) + L[i + 1](zc)) / 2
            hint = fus.normal(zc, thc)
            if got[0][0] == 'diag':
                # a window corner: the skin keeps the corner named (A upper-aft, B upper-fore, C lower-fore, D lower-aft)
                A, B, C, D = ptsu[0], ptsu[-1], ptsl[-1], ptsl[0]
                quad = {'A': A, 'B': B, 'C': C, 'D': D}
                order = ['A', 'B', 'C', 'D']
                kk = order.index(got[0][1])
                X, nx, opp, pv = quad[order[kk]], quad[order[(kk + 1) % 4]], quad[order[(kk + 2) % 4]], quad[order[(kk - 1) % 4]]
                g.poly('ac_paint', [pv[0], X[0], nx[0]], CROWN, normals=[pv[1], X[1], nx[1]], hint=hint)
                g.poly('ac_window', [nx[0], opp[0], pv[0]], GLASS, normals=[nx[1], opp[1], pv[1]], hint=hint)
                continue
            mat, col, _ = got[0]
            pts = ptsu + list(reversed(ptsl))
            g.poly(mat, [p for p, _ in pts], col, normals=[n for _, n in pts], hint=hint)
    full = g.both()
    # the APU exhaust in the tail cone's open end
    ring_l = [fus.at(tail, f(tail)) for f in L]
    ring = ring_l + [(-p[0], p[1], p[2]) for p in reversed(ring_l[1:-1])]
    cen = K.centroid(ring)
    inner = [vadd(cen, vmul(vsub(p, cen), 0.78)) for p in ring]
    inner = [(p[0], p[1], p[2] + 0.12) for p in inner]
    m = len(ring)
    for j in range(m):
        j2 = (j + 1) % m
        full.poly('ac_dark', [ring[j], ring[j2], inner[j2], inner[j]], APU, hint=vsub(cen, K.centroid([ring[j], ring[j2]])))
    full.poly('ac_dark', inner, APU, hint=(0.0, 0.0, -1.0))
    return full, coarse


def door_outlines(g, fus, T, sty, lod):
    """Door, exit and cargo door outlines: thin dark bands just off the skin (LOD0 only)."""
    width, lift = 0.035, 0.016
    items = []
    for side, z, wd, y0, y1 in sty['doors']:
        items.append((1 if side == 'L' else -1, z - wd / 2, z + wd / 2, y0, y1, 0.14))
    w = sty['windows']
    wins = windows_of(T, sty)
    ew, eh = sty['exit_size']
    for ze in sty['exits']:
        zc = min(((a + b) / 2 for a, b in wins), key=lambda v: abs(v - ze))
        for s in (1, -1):
            items.append((s, zc - ew / 2, zc + ew / 2, w['y'] - eh * 0.55, w['y'] + eh * 0.45, 0.1))
    for side, z0, z1, y0, y1 in sty['cargo']:
        items.append((1 if side == 'L' else -1, z0, z1, y0, y1, 0.12))
    for s, z0, z1, y0, y1, r in items:
        loop = []
        corners = [(z1 - r, y1 - r, 0.0), (z0 + r, y1 - r, 0.5), (z0 + r, y0 + r, 1.0), (z1 - r, y0 + r, 1.5)]
        for cz, cy, a0 in corners:
            for k in range(4):
                a = (a0 + k / 3 * 0.5) * math.pi
                loop.append((cz + r * math.cos(a), cy + r * math.sin(a)))
        # long straight edges get intermediate points so the band follows the skin's curve
        dense = []
        for k in range(len(loop)):
            p, qq = loop[k], loop[(k + 1) % len(loop)]
            n = max(1, int(math.ceil(abs(qq[1] - p[1]) / 0.16)))
            for t in range(n):
                dense.append((p[0] + (qq[0] - p[0]) * t / n, p[1] + (qq[1] - p[1]) * t / n))
        dense.append(dense[0])
        pts, nrm = [], []
        for z, y in dense:
            p, n = fus.surface(z, y, s)
            pts.append(p)
            nrm.append(n)
        strip(g, 'ac_dark', pts, nrm, width, lift, GAP)


# ------------------------------------------------------------------------------------------- lifting surfaces
def gap(xa, xb, a, b):
    """The cell between chord stations a and b (a hinge line)."""
    return abs(xa - a) < 1e-6 and abs(xb - b) < 1e-6


def naca(xc, t):
    return 5 * t * (0.2969 * math.sqrt(max(0.0, xc)) - 0.1260 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)


def camber(xc, m, p=0.4):
    if m == 0:
        return 0.0
    return m / p ** 2 * (2 * p * xc - xc ** 2) if xc < p else m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * xc - xc ** 2)


def section_loop(xcs, tc, m):
    """Airfoil points from the trailing edge over the upper surface to the leading edge and back under: (xc, offset)."""
    up = [(x, camber(x, m) + naca(x, tc)) for x in xcs]
    lo = [(x, camber(x, m) - naca(x, tc)) for x in reversed(xcs[:-1])]
    return up + lo


def lifting(g, stations, xcs, cellmat, caps=(False, True)):
    """A lofted lifting surface. Each station: dict(le=(x, y, z), T=span direction, c=chord, tc, m=camber, D=chord direction
    (default -Z)). `cellmat(i, j, xc_a, xc_b, upper)` gives (material, colour) of the cell between stations i, i+1 and loop points
    j, j+1. caps: close the first / last station with a flat cap (the cap takes cellmat(i, -1, ...))."""
    P = []
    meta = None
    for s in stations:
        T = vnorm(s['T'])
        D = vnorm(s.get('D', (0.0, 0.0, -1.0)))
        N = vnorm(vcross(T, D))
        loop = section_loop(xcs, s['tc'], s.get('m', 0.0))
        meta = loop
        row = [vadd(vadd(s['le'], vmul(D, s['c'] * x)), vmul(N, s['c'] * o)) for x, o in loop]
        P.append(row)
    N = grid_normals(P)
    # orient: a normal on the upper surface points along the station's N
    s0 = stations[0]
    n_ref = vnorm(vcross(vnorm(s0['T']), vnorm(s0.get('D', (0.0, 0.0, -1.0)))))
    mid = len(meta) // 4
    if vdot(N[0][mid], n_ref) < 0:
        N = [[(-n[0], -n[1], -n[2]) for n in row] for row in N]
    nup = len(xcs)

    def cell(i, j):
        xa, xb = meta[j][0], meta[j + 1][0]
        return cellmat(i, j, min(xa, xb), max(xa, xb), j < nup - 1)
    sheet(g, P, N, cell)
    for end, use in ((0, caps[0]), (len(P) - 1, caps[1])):
        if not use:
            continue
        T = vnorm(stations[end]['T'])
        ring = P[end][:-1]
        got = cellmat(end, -1, 0.0, 1.0, True)
        if got:
            g.poly(got[0], ring, got[1], hint=T if end else vmul(T, -1.0))
    return P


class Wing:
    """The left wing's planform and surface: the leading edge from the root (at the fuselage side, aircraft.json) to the tip,
    a trailing edge unswept inboard of the kink, dihedral from the root height."""

    def __init__(self, T, sty, fus):
        w = T['wing']
        ws = sty['wing']
        self.ws = ws
        self.xr = fus.R
        self.semi = T['span'] / 2
        self.x_tip = ws['tip_x'] if ws.get('tip_x') else self.semi
        self.x_in = fus.R * ws['root_in']
        self.le_r, self.c_r = w['rootLeZ'], w['rootChord']
        self.le_t, self.c_t = w['tipLeZ'], w['tipChord']
        self.y_r = w['rootY']
        self.dih = w['dihedralDeg'] * RAD
        self.te_r = self.le_r - self.c_r
        self.te_t = self.le_t - self.c_t
        self.xk = self.xr + ws['kink'] * (self.x_tip - self.xr)
        self.rake = None
        if ws['tip'] == 'raked':
            xr_ = self.xr + ws['rake'] * (self.x_tip - self.xr)
            zr_ = self.le_r - (xr_ - self.xr) * math.tan(ws['rake_sweep'] * RAD)
            self.rake = (xr_, zr_)

    def le(self, x):
        if self.rake and x > self.rake[0]:
            return pwl([self.rake, (self.x_tip, self.le_t)], x)
        if self.rake:
            return pwl([(self.xr, self.le_r), self.rake], x) if x >= self.xr else self.le_r + (self.xr - x) * math.tan(self.ws['rake_sweep'] * RAD)
        s = (self.le_t - self.le_r) / (self.x_tip - self.xr)
        return self.le_r + (x - self.xr) * s

    def te(self, x):
        if x <= self.xk:
            return self.te_r
        return self.te_r + (self.te_t - self.te_r) * (x - self.xk) / (self.x_tip - self.xk)

    def y(self, x):
        return self.y_r + (x - self.xr) * math.tan(self.dih)

    def tc(self, x):
        a, b, c = self.ws['tc']
        return pwl([(self.xr, a), (self.xk, b), (self.x_tip, c)], x)

    def surf_y(self, x, z, upper):
        c = self.le(x) - self.te(x)
        xc = max(0.0, min(1.0, (self.le(x) - z) / c))
        o = camber(xc, self.ws['camber']) + (1 if upper else -1) * naca(xc, self.tc(x))
        return self.y(x) + c * o

    def tip_le(self):
        return (self.x_tip, self.y(self.x_tip), self.le(self.x_tip))

    def stations(self, lod):
        xs = [self.x_in, self.xr]
        if lod == 0:
            xs += [self.xr + 0.5 * (self.xk - self.xr), self.xk, self.xk + 0.36 * (self.x_tip - self.xk), self.xk + 0.7 * (self.x_tip - self.xk)]
            if self.rake:
                xs += [self.rake[0], self.rake[0] + 0.5 * (self.x_tip - self.rake[0])]
        elif lod == 1:
            xs += [self.xk]
            if self.rake:
                xs += [self.rake[0]]
        else:
            xs = [self.x_in]
        xs = uniq_sorted(xs + [self.x_tip])
        T0 = (math.cos(self.dih), math.sin(self.dih), 0.0)
        out = []
        for x in xs:
            out.append(dict(le=(x, self.y(x), self.le(x)), T=T0, c=self.le(x) - self.te(x), tc=self.tc(x), m=self.ws['camber']))
        return out

    def device(self, lod):
        """Stations of the sharklet or winglet, continuing the wing's surface: a blend arc turning the span up, then the blade."""
        dv = self.ws.get('device')
        if not dv:
            return []
        n = qx(lod)['dev_st']
        x0, y0, z0 = self.tip_le()
        c0 = self.c_t
        rb, cant = dv['rb'], dv['cant'] * RAD
        ph0, ph1 = self.dih, math.pi / 2 - cant
        cx, cy = x0 - rb * math.sin(ph0), y0 + rb * math.cos(ph0)
        pts = []
        na = max(1, n - 1)
        arc = rb * (ph1 - ph0)
        total = arc + dv['h']
        for k in range(1, na + 1):
            ph = ph0 + (ph1 - ph0) * k / na
            pts.append(((cx + rb * math.sin(ph), cy - rb * math.cos(ph)), (math.cos(ph), math.sin(ph)), rb * (ph - ph0)))
        ex, ey = pts[-1][0]
        pts.append(((ex + dv['h'] * math.cos(ph1), ey + dv['h'] * math.sin(ph1)), (math.cos(ph1), math.sin(ph1)), total))
        if lod == 2:
            pts = pts[-1:]
        out = []
        for (x, y), (tx, ty), s in pts:
            u = s / total
            z = z0 - dv['sweep'] * u ** 1.25
            c = c0 + (dv['chord'] - c0) * min(1.0, u * 1.15) ** 0.8
            tc = self.tc(self.x_tip) + (dv['tc'] - self.tc(self.x_tip)) * min(1.0, u * 2)
            out.append(dict(le=(x, y, z), T=(tx, ty, 0.0), c=c, tc=tc, m=self.ws['camber'] * (1 - u)))
        return out


def wing_geo(T, sty, fus, wing, lod):
    """The left wing (with its tip device and flap-track fairings)."""
    q = qx(lod)
    g = Geo()
    st = wing.stations(lod)
    dev = wing.device(lod)
    xcs = q['xcs']
    n_wing = len(st)

    def cm(i, j, xa, xb, upper):
        if j < 0:
            return ('ac_paint', ACCENT) if dev else ('ac_grey', GREY)
        if i >= n_wing - 1:
            return ('ac_paint', ACCENT)
        if lod == 0 and upper and gap(xa, xb, 0.725, 0.745):
            return ('ac_dark', GAP)
        if xb <= 0.051 + 1e-9 and lod <= 1:
            return ('ac_metal', METAL)
        return ('ac_grey', GREY)
    lifting(g, st + dev, xcs, cm, caps=(False, True))
    if q['ft_sides']:
        for f in sty['flaptracks']:
            flap_track(g, wing, wing.xr + f * (wing.x_tip - wing.xr), q['ft_sides'])
    return g


def flap_track(g, wing, x, sides):
    """A canoe fairing under the wing, from mid-chord to past the trailing edge."""
    le, te = wing.le(x), wing.te(x)
    c = le - te
    za, zb = le - 0.5 * c, te - 0.30 * c - 0.35
    r = max(0.09, 0.045 * c)
    ya = wing.surf_y(x, za, False) - 0.25 * r
    yb = wing.surf_y(x, te, False) - 0.2 * r
    a = (x, ya, za)
    b = (x, yb - 0.05, zb)
    L = vlen(vsub(b, a))
    prof = [(0.0, 0.0), (0.7 * r, 0.07 * L), (r, 0.3 * L), (0.88 * r, 0.65 * L), (0.4 * r, 0.93 * L), (0.0, L)]
    lathe(g, a, vsub(b, a), prof, sides, [('ac_grey', GREY)] * 5, phase=math.pi / sides)


def tailplane_geo(T, sty, fus, lod):
    q = qx(lod)
    tp = T['tailplane']
    ts = sty['tailplane']
    g = Geo()
    semi = tp['span'] / 2
    y0 = ts['y']
    le0, c0 = tp['rootLeZ'], tp['rootChord']
    ct = c0 * ts['taper']
    if ts['sweep'] is None:
        # keep the tip's trailing edge at the aircraft's aft end (aircraft.json tailZ)
        le_t = T['tailZ'] + 0.05 + ct
    else:
        le_t = le0 - semi * math.tan(ts['sweep'] * RAD)
        le_t = max(le_t, T['tailZ'] + 0.1 + ct)
    dih = ts['dihedral'] * RAD
    xs = [0.0, semi] if lod >= 1 else [0.0, 0.45 * semi, semi]
    st = []
    for x in xs:
        t = x / semi
        st.append(dict(le=(x, y0 + x * math.tan(dih), le0 + (le_t - le0) * t), T=(math.cos(dih), math.sin(dih), 0.0), c=c0 + (ct - c0) * t, tc=ts['tc'], m=0.0))

    def cm(i, j, xa, xb, upper):
        if lod == 0 and gap(xa, xb, 0.725, 0.745):
            return ('ac_dark', GAP)
        if xb <= 0.051 and lod <= 1:
            return ('ac_metal', METAL)
        return ('ac_grey', GREY)
    lifting(g, st, q['xcs'], cm, caps=(False, True))
    return g, le_t


def fin_geo(T, sty, fus, lod, typ):
    """The fin and rudder (one surface across x = 0), with a dorsal fillet."""
    q = qx(lod)
    fn = T['fin']
    fs = sty['fin']
    g = Geo()
    y_base = T['height'] - fn['height']
    top = T['height']
    le0, c0, ct = fn['rootLeZ'], fn['rootChord'], fn['topChord']
    if typ == 'regional':
        top = sty['tailplane']['y'] + 0.05
    if fs['sweep'] is None:
        le_top = T['tailZ'] + ct + 0.02
        if typ == 'regional':
            le_top = T['tailZ'] + 0.3 + ct
    else:
        le_top = le0 - (top - y_base) * math.tan(fs['sweep'] * RAD)
        le_top = max(le_top, T['tailZ'] + ct)
    slope = (le_top - le0) / (top - y_base)
    y_in = y_base - 0.6 * fus.R / 1.98 - 0.25
    fl, fh = fs['fillet']
    ys = [y_in, y_base]
    if lod == 0:
        ys += [y_base + fh + 0.45 * (top - y_base - fh)]
    accent_y = top - 0.07 * (top - y_base)
    if lod == 0 and typ != 'regional':
        ys += [accent_y]
    ys = uniq_sorted(ys + [top])
    st = []
    for y in ys:
        le = le0 + slope * (y - y_base)
        c = c0 + (ct - c0) * max(0.0, (y - y_base) / (top - y_base))
        if y < y_base:
            c = c0
        st.append(dict(le=(0.0, y, le), T=(0.0, 1.0, 0.0), c=c, tc=fs['tc'], m=0.0))

    def cm(i, j, xa, xb, upper):
        if j < 0:
            return ('ac_paint', ACCENT if typ != 'regional' else FIN)
        if lod == 0 and gap(xa, xb, 0.675, 0.70):
            return ('ac_dark', GAP)
        if lod == 0 and typ != 'regional' and st[i]['le'][1] >= accent_y - 1e-6:
            return ('ac_paint', ACCENT)
        return ('ac_paint', FIN)
    xcs = q['xcs'] if lod < 2 else [1.0, 0.5, 0.08, 0.0]
    if lod == 0:
        xcs = [1.0, 0.86, 0.70, 0.675, 0.5, 0.3, 0.14, 0.05, 0.012, 0.0]
    lifting(g, st, xcs, cm, caps=(False, True))
    if lod <= 1:
        # the dorsal fillet: a strake in front of the fin's root, its trailing edge and top buried in the fin
        fst = []
        for y, ext in ((y_in, fl), (y_base, fl), (y_base + fh, 0.03)):
            le = le0 + slope * (y - y_base)
            c = c0 if y <= y_base else c0 + (ct - c0) * (y - y_base) / (top - y_base)
            cf = ext + 0.3 * c
            fst.append(dict(le=(0.0, y, le + ext - 0.02 * (ext < 0.05)), T=(0.0, 1.0, 0.0), c=cf - 0.02 * (ext < 0.05), tc=0.083 * c / cf, m=0.0))
        lifting(g, fst, [1.0, 0.6, 0.3, 0.1, 0.0] if lod == 0 else [1.0, 0.4, 0.0], lambda i, j, xa, xb, up: ('ac_paint', FIN), caps=(False, False))
    return g, (le_top, top, ct)


# ------------------------------------------------------------------------------------------- engines
def nacelle_profile(kind):
    """(r, t) in nacelle radii and lengths from the intake plane backwards, traced spinner tip -> fan face -> intake -> lip ->
    cowl -> nozzle -> core -> plug, with each segment's (material, colour)."""
    if kind == 'long':
        p = [(0.0, 0.055), (0.20, 0.125), (0.76, 0.125), (0.79, 0.04), (0.82, 0.006), (0.87, 0.0), (0.93, 0.012), (0.98, 0.05), (1.0, 0.15),
             (0.99, 0.38), (0.94, 0.58), (0.82, 0.76), (0.70, 0.86), (0.62, 0.86), (0.50, 0.91), (0.12, 1.0), (0.0, 1.0)]
        mats = [('ac_metal', METAL_DK), ('ac_dark', FAN), ('ac_grey', GREY_IN), ('ac_grey', GREY_IN), ('ac_metal', METAL), ('ac_metal', METAL),
                ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE),
                ('ac_dark', FAN), ('ac_metal', METAL_DK), ('ac_metal', METAL_DK), ('ac_dark', APU)]
    elif kind == 'short':
        p = [(0.0, 0.05), (0.20, 0.12), (0.80, 0.12), (0.82, 0.035), (0.85, 0.005), (0.89, 0.0), (0.945, 0.012), (0.985, 0.05), (1.0, 0.14),
             (0.99, 0.30), (0.95, 0.45), (0.86, 0.565), (0.80, 0.57), (0.62, 0.57), (0.58, 0.64), (0.47, 0.80), (0.36, 0.82), (0.30, 0.83),
             (0.14, 0.97), (0.0, 1.0)]
        mats = [('ac_metal', METAL_DK), ('ac_dark', FAN), ('ac_grey', GREY_IN), ('ac_grey', GREY_IN), ('ac_metal', METAL), ('ac_metal', METAL),
                ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_dark', FAN),
                ('ac_grey', GREY_DK), ('ac_grey', GREY_DK), ('ac_grey', GREY_DK), ('ac_dark', APU), ('ac_metal', METAL_DK), ('ac_metal', METAL_DK),
                ('ac_metal', METAL_DK)]
    else:  # rear-mounted, a CF34-like nacelle with a short core plug
        p = [(0.0, 0.07), (0.22, 0.14), (0.78, 0.14), (0.81, 0.04), (0.84, 0.006), (0.89, 0.0), (0.95, 0.015), (0.99, 0.06), (1.0, 0.18),
             (0.98, 0.45), (0.92, 0.66), (0.80, 0.84), (0.72, 0.86), (0.60, 0.86), (0.52, 0.90), (0.18, 0.99), (0.0, 1.0)]
        mats = [('ac_metal', METAL_DK), ('ac_dark', FAN), ('ac_grey', GREY_IN), ('ac_grey', GREY_IN), ('ac_metal', METAL), ('ac_metal', METAL),
                ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE), ('ac_paint', ENGINE),
                ('ac_dark', FAN), ('ac_metal', METAL_DK), ('ac_metal', METAL_DK), ('ac_dark', APU)]
    return p, mats


NAC_KEEP = {
    'long': {1: [0, 2, 4, 5, 7, 9, 11, 12, 13, 15, 16], 2: [0, 2, 5, 9, 12, 16]},
    'short': {1: [0, 2, 4, 5, 7, 9, 11, 13, 15, 16, 18, 19], 2: [0, 2, 5, 9, 11, 15, 19]},
    'rear': {1: [0, 2, 4, 5, 7, 9, 11, 12, 13, 15, 16], 2: [0, 2, 5, 9, 12, 16]},
}


def nacelle(g, e, kind, lod):
    q = qx(lod)
    R, L = e['radius'], e['length']
    p, mats = nacelle_profile(kind)
    keep = NAC_KEEP[kind].get(lod)
    if keep:
        # a coarser outline: each kept span takes the material of its longest original segment
        m2 = []
        for a, b in zip(keep[:-1], keep[1:]):
            best = max(range(a, b), key=lambda k: math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]))
            m2.append(mats[best])
        p, mats = [p[k] for k in keep], m2
    prof = [(r * R, t * L) for r, t in p]
    front = (e['x'], e['y'], e['z'] + L / 2)
    lathe(g, front, (0.0, 0.0, -1.0), prof, q['nac'], mats, phase=math.pi / 2, crease=34.0)


def nacelle_outer(e, kind, z):
    """The nacelle's outer radius at z (0 outside its cowl)."""
    p, _ = nacelle_profile(kind)
    t = (e['z'] + e['length'] / 2 - z) / e['length']
    outer = [pt for k, pt in enumerate(p) if k >= 5 and p[k][0] >= 0.6 and all(q[0] >= 0.6 for q in p[5:k + 1])]
    if not outer or t < outer[0][1] or t > outer[-1][1]:
        return 0.0
    return e['radius'] * pwl([(q[1], q[0]) for q in outer], t)


def pylon_geo(g, T, sty, wing, e, lod):
    """The underwing pylon: a slab over the top of the nacelle flowing into the wing's leading edge, with its aft fairing
    curving up under the wing."""
    L = e['length']
    kind = sty['engine']['kind']
    x, yc, zc = e['x'], e['y'], e['z']
    w = sty['engine']['pylon_w']
    z_front = zc + 0.2 * L
    le, te = wing.le(x), wing.te(x)
    c = le - te
    z_end = le - 0.6 * c
    p, _ = nacelle_profile(kind)
    exit_t = max(q[1] for q in p if q[0] >= 0.6)
    z_exit = zc + L / 2 - exit_t * L
    y_nac = lambda z: yc + nacelle_outer(e, kind, z)
    y_top_f = y_nac(z_front) + 0.05
    y_le = wing.y(x)
    nz = 10 if lod == 0 else 5
    zs = [z_front + (z_end - z_front) * (k / (nz - 1)) for k in range(nz)]
    rows = []
    for k, z in enumerate(zs):
        t = k / (nz - 1)
        if z > le:
            s_ = smoothstep(z_front, le, z)
            yt = y_top_f + (y_le - y_top_f) * s_
            yt = max(yt, y_nac(z) + 0.04)
        else:
            yt = wing.y(x) + 0.02
        if z > z_exit + 0.05:
            yb = y_nac(z) - 0.12
        else:
            y0 = y_nac(z_exit + 0.05) - 0.12
            u = (z_exit + 0.05 - z) / max(1e-6, z_exit + 0.05 - z_end)
            yb = y0 + (wing.surf_y(x, min(z, le - 0.05), False) - 0.03 - y0) * (u ** 1.5)
        if yb > yt - 0.06:
            yb = yt - 0.06
        ww = w * (0.6 + 0.4 * smoothstep(0.0, 0.2, t)) * (1.0 - 0.55 * smoothstep(0.7, 1.0, t))
        h = yt - yb
        sec = [(0.0, yt), (-ww * 0.6, yt), (-ww, yt - 0.12 * h), (-ww, yb + 0.3 * h), (-ww * 0.55, yb + 0.03 * h), (0.0, yb),
               (ww * 0.55, yb + 0.03 * h), (ww, yb + 0.3 * h), (ww, yt - 0.12 * h), (ww * 0.6, yt)]
        rows.append([(x + sx, sy, z) for sx, sy in sec])
    N = grid_normals(rows, closed_v=True)
    if vdot(N[nz // 2][2], (-1.0, 0.0, 0.0)) < 0:
        N = [[(-n[0], -n[1], -n[2]) for n in row] for row in N]
    sheet(g, rows, N, lambda i, j: ('ac_grey', GREY), closed_v=True)
    g.poly('ac_grey', rows[0], GREY, hint=(0.0, 0.0, 1.0))
    g.poly('ac_grey', rows[-1], GREY, hint=(0.0, 0.0, -1.0))


def rear_engine(g, T, sty, fus, e, lod):
    """A rear-fuselage engine on its stub pylon (left side)."""
    nacelle(g, e, 'rear', lod)
    R, L = e['radius'], e['length']
    if lod == 2:
        box(g, 'ac_grey', (fus.R * 0.5, e['y'] - 0.12, e['z'] - 0.35 * L), (e['x'] - R * 0.5, e['y'] + 0.12, e['z'] + 0.15 * L), GREY)
        return
    c = 0.55 * L
    le = e['z'] + 0.2 * L
    xs = [fus.R * 0.45, e['x'] - 0.2 * R]
    st = [dict(le=(x, e['y'] - 0.04, le - 0.15 * (x - xs[0])), T=(1.0, 0.04, 0.0), c=c - 0.2 * (x - xs[0]), tc=0.16, m=0.0) for x in xs]
    xcs = qx(lod)['xcs'] if lod == 1 else [1.0, 0.8, 0.55, 0.3, 0.12, 0.03, 0.0]
    lifting(g, st, xcs, lambda i, j, xa, xb, up: ('ac_grey', GREY), caps=(False, False))


# ------------------------------------------------------------------------------------------- fairings
class Fairing:
    """The wing-body fairing: a flattened box round the lower fuselage at the wing root, from the skin's side above the wing
    root, fading into the skin at both ends (and 2.5 cm inside it where it fades, so the two meet in a clean line)."""

    EX = 3.2

    def __init__(self, T, sty, fus, wing):
        fs = sty['fairing']
        self.fus = fus
        R = fus.R
        c = wing.c_r
        self.z1 = wing.le_r + fs['front'] * c
        self.z0 = wing.te_r - fs['rear'] * c
        self.fade = 0.3 * (self.z1 - self.z0)
        self.y_top = wing.surf_y(wing.xr, wing.le_r - 0.3 * c, True) + 0.18 * R / 1.98
        self.A = R * fs['width']
        self.bottom = fs['bottom']

    def edge(self, z):
        return self.fus.theta_y(z, self.y_top)

    def at(self, z, th):
        fus = self.fus
        f = smoothstep(self.z0, self.z0 + self.fade, z) * (1 - smoothstep(self.z1 - self.fade * 0.8, self.z1, z))
        f = f ** 0.7
        keel = fus.dims(z)[1]
        th_e = self.edge(z)
        p = fus.at(z, th)
        n = fus.normal(z, th)
        pin = vsub(p, vmul(n, 0.025))
        yb = keel + self.bottom
        st, ct = math.sin(th), math.cos(th)
        bx = self.A * math.copysign(abs(st) ** (2 / self.EX), st)
        by = (self.y_top + yb) / 2 + (self.y_top - yb) / 2 * math.copysign(abs(ct) ** (2 / self.EX), ct)
        wedge = smoothstep(0.0, 0.42, min(th - th_e, 2 * math.pi - th_e - th))
        k = f * wedge
        return (pin[0] + (bx - pin[0]) * k, pin[1] + (by - pin[1]) * k, z)

    def theta_x(self, x):
        """The angle (left side, lower half) at which the full box is at x."""
        return math.pi - math.asin(min(1.0, max(0.0, x / self.A)) ** (self.EX / 2))

    def patch(self, g, mat, col, z0, z1, x0, x1, lift=0.012, nz=3, nx=3):
        """A dark patch lying on the fairing's underside (a gear well), left side."""
        rows = []
        for i in range(nz):
            z = z0 + (z1 - z0) * i / (nz - 1)
            rows.append([self.at(z, self.theta_x(x0 + (x1 - x0) * j / (nx - 1))) for j in range(nx)])
        N = grid_normals(rows)
        if vdot(N[nz // 2][nx // 2], (0.0, -1.0, 0.0)) < 0:
            N = [[(-n[0], -n[1], -n[2]) for n in row] for row in N]
        P = [[vadd(p, vmul(N[i][j], lift)) for j, p in enumerate(row)] for i, row in enumerate(rows)]
        sheet(g, P, N, lambda i, j: (mat, col))


def belly_fairing(g, T, sty, fus, wing, lod):
    fr = Fairing(T, sty, fus, wing)
    nz = {0: 12, 1: 6}[lod]
    nth = {0: 14, 1: 8}[lod]
    rows = []
    for k in range(nz):
        z = fr.z0 + (fr.z1 - fr.z0) * (k / (nz - 1))
        th_e = fr.edge(z)
        rows.append([fr.at(z, th_e + (2 * math.pi - 2 * th_e) * j / nth) for j in range(nth + 1)])
    N = grid_normals(rows)
    if vdot(N[nz // 2][nth // 2], (0.0, -1.0, 0.0)) < 0:
        N = [[(-n[0], -n[1], -n[2]) for n in row] for row in N]
    sheet(g, rows, N, lambda i, j: ('ac_paint', BELLY))
    return fr


# ------------------------------------------------------------------------------------------- gear
def wheel(g, centre, r, w, sides, lod, hub=True):
    """A tyre on its axle along X: hub discs, sidewalls and tread (80 triangles at 10 sides)."""
    if sides <= 0:
        return
    rh = r * 0.56
    hw = w / 2
    if lod == 0:
        prof = [(0.0, -hw * 0.8), (rh, -hw * 0.8), (r * 0.93, -hw), (r, -hw * 0.55), (r, hw * 0.55), (r * 0.93, hw), (rh, hw * 0.8), (0.0, hw * 0.8)]
        mats = [('ac_metal', HUB), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_metal', HUB)]
        prof = [prof[0], prof[1], prof[3], prof[4], prof[6], prof[7]]
        mats = [mats[0], mats[1], mats[3], mats[5], mats[6]]
    else:
        prof = [(0.0, -hw), (r, -hw), (r, hw), (0.0, hw)]
        mats = [('ac_dark', TYRE)] * 3
    lathe(g, centre, (1.0, 0.0, 0.0), prof, sides, mats, crease=30.0, phase=-math.pi / 2)


def gear_geo(T, sty, fus, wing, lod, fair):
    """Nose and main gear (the left main mirrored), with the doors and wells that show only when the gear is down."""
    q = qx(lod)
    gs = sty['gear']
    g = Geo()
    if lod >= 2:
        return g
    sides = q['wheel']
    nt = 8 if lod == 0 else 5
    wb = T['wheelbase']
    # ---- main gear (left)
    m = Geo()
    xg = T['mainGearHalfTrack']
    r, w, dx = gs['main_r'], gs['main_w'], gs['main_dx']
    y_att = wing.surf_y(xg, 0.0, False) + 0.15 if wing.le(xg) > 0.2 else fus.dims(0.0)[1] + 0.2
    if gs['bogie']:
        ax = gs['axle']
        yb = r + 0.12
        for zc in (-ax, 0.0, ax):
            for s in (-1, 1):
                wheel(m, (xg + s * dx, r, zc), r, w, sides, lod)
            tube(m, 'ac_metal', (xg - dx + w * 0.4, r, zc), (xg + dx - w * 0.4, r, zc), 0.07, 6 if lod == 0 else 4, STRUT, caps=False)
        beam_h = 0.16
        box(m, 'ac_metal', (xg - 0.13, yb - beam_h / 2, -ax - 0.35), (xg + 0.13, yb + beam_h / 2, ax + 0.35), STRUT)
        tube(m, 'ac_metal', (xg, yb, 0.0), (xg, y_att, 0.25), 0.2, nt, STRUT)
        tube(m, 'ac_metal', (xg, yb + 0.2, 0.0), (xg, yb + 1.3, 0.05), 0.15, nt, STRUT, caps=False)
        if lod == 0:
            K.beam(m, 'ac_metal', (xg, yb + 1.6, 0.05), (fus.R * 0.55, fair.at(0.3, fair.theta_x(fus.R * 0.55))[1] + 0.1, 0.3), 0.12, 0.12, STRUT)
            K.beam(m, 'ac_metal', (xg + 0.05, yb + 0.25, 0.22), (xg + 0.05, yb + 0.6, 0.42), 0.06, 0.1, STRUT)
            K.beam(m, 'ac_metal', (xg + 0.05, yb + 0.6, 0.42), (xg + 0.05, yb + 0.95, 0.24), 0.06, 0.1, STRUT)
            # the leg door
            obox(m, 'ac_grey', (xg + 0.32, (yb + 1.2 + y_att) / 2, 0.15), (0.03, 0.0, 0.0), (0.0, (y_att - yb - 1.2) / 2, 0.0), (0.0, 0.0, 0.62), GREY)
        well = (fus.R * 0.18, xg - 0.6, -2.0, 2.0)
    else:
        for s in (-1, 1):
            wheel(m, (xg + s * dx, r, 0.0), r, w, sides, lod)
        tube(m, 'ac_metal', (xg - dx + w * 0.4, r, 0.0), (xg + dx - w * 0.4, r, 0.0), 0.065, 6 if lod == 0 else 4, STRUT, caps=False)
        top = (xg - 0.18, y_att, 0.1)
        rs = 0.13 * r / 0.585
        tube(m, 'ac_metal', (xg, r, 0.0), (xg, r + 0.95 * (y_att - r) * 0.45, 0.0), rs * 0.72, nt, STRUT)
        tube(m, 'ac_metal', (xg, r + 0.38 * (y_att - r), 0.0), top, rs, nt, STRUT)
        if lod == 0:
            K.beam(m, 'ac_metal', (xg - 0.05, r + 0.6 * (y_att - r), 0.0), (fus.R * 0.62, fair.at(-0.1, fair.theta_x(fus.R * 0.62))[1] + 0.1, -0.1), 0.09, 0.09, STRUT)
            yl = r + 0.12
            K.beam(m, 'ac_metal', (xg, yl, 0.1), (xg, yl + 0.22, 0.24), 0.05, 0.07, STRUT)
            K.beam(m, 'ac_metal', (xg, yl + 0.22, 0.24), (xg, yl + 0.45, 0.1), 0.05, 0.07, STRUT)
            obox(m, 'ac_grey', (xg + 0.22, (r + 0.5 + y_att) / 2, -0.02), (0.025, 0.0, 0.0), (0.0, (y_att - r - 0.5) / 2, 0.0), (0.0, 0.0, 0.42), GREY)
        well = (fus.R * 0.2, xg - 0.45, -0.95, 0.95)
    if lod == 0:
        # the wells: the wheel bay in the fairing's underside, the leg's recess under the wing root
        x0, x1, z0, z1 = well
        xf = min(x1, fair.A * 0.9)
        fair.patch(m, 'ac_dark', WELL, z0, z1, x0, xf)
        xa, xb = xf, xg - 0.05
        if xb > xa + 0.1:
            P, N = [], []
            for z in (-0.28, 0.34):
                P.append([(x, wing.surf_y(x, z, False) - 0.012, z) for x in (xa, (xa + xb) / 2, xb)])
            N = [[(0.0, -1.0, 0.0)] * 3 for _ in P]
            sheet(m, P, N, lambda i, j: ('ac_dark', WELL))
    g.add(m.both())
    # ---- nose gear
    rn, wn, dxn = gs['nose_r'], gs['nose_w'], gs['nose_dx']
    keel = fus.dims(wb)[1]
    for s in (-1, 1):
        wheel(g, (s * dxn, rn, wb), rn, wn, sides, lod)
    tube(g, 'ac_metal', (-dxn + wn * 0.4, rn, wb), (dxn - wn * 0.4, rn, wb), 0.045, 6 if lod == 0 else 4, STRUT, caps=False)
    rs = 0.085 * rn / 0.38
    tube(g, 'ac_metal', (0.0, rn, wb), (0.0, rn + 0.5 * (keel - rn), wb - 0.03), rs * 0.75, nt, STRUT)
    tube(g, 'ac_metal', (0.0, rn + 0.35 * (keel - rn), wb - 0.03), (0.0, keel + 0.25, wb - 0.12), rs, nt, STRUT)
    if lod == 0:
        yl = rn + 0.1
        K.beam(g, 'ac_metal', (0.0, yl, wb + 0.07), (0.0, yl + 0.18, wb + 0.2), 0.045, 0.06, STRUT)
        K.beam(g, 'ac_metal', (0.0, yl + 0.18, wb + 0.2), (0.0, yl + 0.36, wb + 0.06), 0.045, 0.06, STRUT)
        K.beam(g, 'ac_metal', (0.0, rn + 0.6 * (keel - rn), wb - 0.05), (0.0, keel + 0.1, wb - 0.95), 0.07, 0.07, STRUT)
    # landing / taxi lamp on the leg (aircraft.json lights.landing)
    lp = T['lights']['landing']
    tube(g, 'ac_metal', (0.0, lp[1], wb - 0.03), (lp[0], lp[1], lp[2] - 0.04), 0.035, 5, STRUT, caps=False)
    box(g, 'ac_light', (lp[0] - 0.09, lp[1] - 0.05, lp[2] - 0.05), (lp[0] + 0.09, lp[1] + 0.05, lp[2] + 0.02), LAMP_WHITE)
    # nose gear doors (open) and the well
    k = fus.R / 1.98
    dz0, dz1 = wb - 0.3 * k, wb + 1.05 * k
    hw = max(dxn + wn / 2 + 0.06, 0.4 * k)
    dd0, dd1 = wb - 0.25 * k, wb + 0.45 * k        # the aft doors, which stay open with the gear down
    for s in (-1, 1):
        drop = min(0.42 * k, 0.55 * (keel - 2 * rn))
        t = 0.02
        hexa(g, 'ac_paint', [(s * hw, keel + 0.05, dd0), (s * hw, keel + 0.05, dd1), (s * hw, keel + 0.05 - drop, dd1 - 0.1 * k), (s * hw, keel + 0.05 - drop, dd0 + 0.04),
                             (s * (hw + t), keel + 0.05, dd0), (s * (hw + t), keel + 0.05, dd1), (s * (hw + t), keel + 0.05 - drop, dd1 - 0.1 * k),
                             (s * (hw + t), keel + 0.05 - drop, dd0 + 0.04)], BELLY)
    if lod == 0:
        rows = []
        for z in (dz0, (dz0 + dz1) / 2, dz1):
            row = []
            for xx in (-hw + 0.01, 0.0, hw - 0.01):
                th = math.pi - math.asin(max(-1.0, min(1.0, xx / max(1e-6, fus.dims(z)[2])))) if xx >= 0 else math.pi + math.asin(min(1.0, -xx / max(1e-6, fus.dims(z)[2])))
                row.append(vadd(fus.at(z, th), vmul(fus.normal(z, th), 0.01)))
            rows.append(row)
        N = grid_normals(rows)
        if vdot(N[1][1], (0.0, -1.0, 0.0)) < 0:
            N = [[(-n[0], -n[1], -n[2]) for n in row] for row in N]
        sheet(g, rows, N, lambda i, j: ('ac_dark', WELL))
    return g


# ------------------------------------------------------------------------------------------- lamps
def lamp(g, p, col, kind, out=(0.0, 1.0, 0.0)):
    """A small lens at an anchor: a dome (beacons) or a block (wing tips, tail, strobes)."""
    if kind == 'dome':
        lathe(g, vsub(p, vmul(out, 0.06)), out, [(0.0, 0.0), (0.11, 0.0), (0.08, 0.07), (0.0, 0.1)], 6, [('ac_light', col)] * 3)
    else:
        box(g, 'ac_light', (p[0] - 0.07, p[1] - 0.045, p[2] - 0.09), (p[0] + 0.07, p[1] + 0.045, p[2] + 0.09), col)


def lamps(g, T, lod):
    L = T['lights']
    lamp(g, L['navLeft'], LAMP_RED, 'block')
    lamp(g, L['navRight'], LAMP_GREEN, 'block')
    lamp(g, L['strobeLeft'], LAMP_WHITE, 'block')
    lamp(g, L['strobeRight'], LAMP_WHITE, 'block')
    lamp(g, L['tail'], LAMP_WHITE, 'block')
    lamp(g, L['beaconTop'], LAMP_RED, 'dome', (0.0, 1.0, 0.0))
    lamp(g, L['beaconBottom'], LAMP_RED, 'dome', (0.0, -1.0, 0.0))


# ------------------------------------------------------------------------------------------- assembly
def body_geo(T, sty, typ, lod):
    _CUR['typ'] = typ
    fus = Fuselage(T, sty)
    wing = Wing(T, sty, fus)
    skin, _ = fuselage_skin(fus, T, sty, lod)
    g = Geo()
    g.add(skin)
    if lod == 0:
        door_outlines(g, fus, T, sty, lod)
    wl = wing_geo(T, sty, fus, wing, lod)
    eng = Geo()
    e = T['engines'][0]
    if sty['engine']['kind'] == 'rear':
        rear_engine(eng, T, sty, fus, e, lod)
    else:
        nacelle(eng, e, sty['engine']['kind'], lod)
        if qx(lod)['pylon']:
            pylon_geo(eng, T, sty, wing, e, lod)
        else:
            box(eng, 'ac_grey', (e['x'] - 0.12, e['y'] + e['radius'] * 0.7, e['z'] - 0.3 * e['length']), (e['x'] + 0.12, wing.y(e['x']), e['z'] + 0.1 * e['length']), GREY)
    tp, _ = tailplane_geo(T, sty, fus, lod)
    left = Geo()
    left.add(wl)
    left.add(eng)
    left.add(tp)
    g.add(left.both())
    fin, fin_top = fin_geo(T, sty, fus, lod, typ)
    g.add(fin)
    if lod <= 1:
        belly_fairing(g, T, sty, fus, wing, lod)
    if typ == 'regional':
        bullet(g, T, sty, fin_top, lod)
    if lod == 0:
        lamps(g, T, lod)
    return g, fus, wing


def bullet(g, T, sty, fin_top, lod):
    """The T-tail's bullet fairing at the fin-tailplane junction (it sets the aircraft's height)."""
    le_top = fin_top[0]
    y = T['height'] - 0.3
    z1 = le_top + 0.75
    z0 = T['tailZ'] + 0.04
    L = z1 - z0
    prof = [(0.0, 0.0), (0.12, 0.05 * L), (0.24, 0.2 * L), (0.3, 0.45 * L), (0.28, 0.75 * L), (0.16, 0.95 * L), (0.0, L)]
    if lod == 2:
        prof = [prof[0], prof[2], prof[4], prof[6]]
    n = 12 if lod == 0 else 8 if lod == 1 else 5
    lathe(g, (0.0, y, z1), (0.0, 0.0, -1.0), prof, n, [('ac_paint', FIN)] * (len(prof) - 1), phase=math.pi / 2)


def anchors_of(T):
    L = T['lights']
    d = T['doorL1']
    return {
        'anchor_doorL1': (d['x'], d['y'], d['z']),
        'anchor_navLeft': tuple(L['navLeft']),
        'anchor_navRight': tuple(L['navRight']),
        'anchor_tail': tuple(L['tail']),
        'anchor_beaconTop': tuple(L['beaconTop']),
        'anchor_beaconBottom': tuple(L['beaconBottom']),
        'anchor_landing': tuple(L['landing']),
        'anchor_strobeLeft': tuple(L['strobeLeft']),
        'anchor_strobeRight': tuple(L['strobeRight']),
        'anchor_noseGear': (0.0, 0.0, T['wheelbase']),
    }


def build(asset):
    from hoodlib import scene
    typ = ASSETS[asset]
    T = DATA['types'][typ]
    sty = STYLE[typ]
    scene.reset()
    root = empty('aircraft', props={'asset': asset, 'type': typ, 'lod_from': LOD_FROM})
    counts = []
    warnings = []
    lo = hi = None
    for lod in (0, 1, 2):
        grp = empty(f'lod{lod}', parent=root)
        body, fus, wing = body_geo(T, sty, typ, lod)
        gear = gear_geo(T, sty, fus, wing, lod, Fairing(T, sty, fus, wing))
        if lod <= 1:
            bake_ao([body, gear], dist=sty['ao'] * (1.0 if lod == 0 else 1.3), rays=16 if lod == 0 else 8, floor=0.3)
        else:
            flat_ao([body], lambda p, n: 0.62 + 0.38 * smoothstep(-0.9, 0.6, n[1]))
        emit(f'lod{lod}_body', body, grp)
        if gear.tris():
            emit(f'lod{lod}_gear', gear, grp)
        counts.append(body.tris() + gear.tris())
        if lod == 0:
            lo, hi = K.bounds([body, gear])
    root['lod_tris'] = counts
    anc = empty('anchors', parent=root)
    an = anchors_of(T)
    an['anchor_tow'] = (0.0, STYLE[typ]['gear']['nose_r'], T['wheelbase'])
    for name in sorted(an):
        empty(name, an[name], anc)
    budgets = {'narrowbody': (6000, 10000), 'widebody': (8000, 13000), 'regional': (5000, 9000)}[typ]
    for i, (a, b) in enumerate([budgets, (1200, 2600), (150, 450)]):
        if not a <= counts[i] <= b:
            warnings.append(f'lod{i} has {counts[i]} triangles (budget {a}..{b})')
    from . import aircraft_preview
    aircraft_preview.install_aircraft(T, typ)
    sidecar = {
        'kind': 'aircraft',
        'type': typ,
        'dims': {'length': T['length'], 'span': T['span'], 'height': T['height']},
        'bounds': {'min': [round(v, 3) for v in lo], 'max': [round(v, 3) for v in hi]},
        'lods': [{'tris': c, 'from': LOD_FROM[i]} for i, c in enumerate(counts)],
        'anchors': {k: [round(v, 4) for v in an[k]] for k in sorted(an)},
        'colliders': T['colliders'],
        'materials': K.MATERIALS,
        'regions': K.REGIONS,
        'nodes': {f'lod{i}': [f'lod{i}_body'] + ([f'lod{i}_gear'] if i < 2 else []) for i in range(3)},
    }
    return {'asset': asset, 'tris': counts, 'sidecar': sidecar, 'warnings': warnings}
