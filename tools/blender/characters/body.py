"""The parametric body: torso and neck, arms, hands, legs and feet as lofted tubes, shaped by a
`Build` (shoulders, waist, hips, bust, belly, limb thickness). Sizes are for a 1.74 m figure; the
game scales a whole person for height. Clothing is passed in as layers per tube (see outfits.py).
"""
import math
from dataclasses import dataclass, field

from mathutils import Vector

from .shapes import BONE_INDEX, Curve, Layer, Tube, Weighter, lerp, mkvert, quad, sstep
from .skeleton import ARM, BONES, LEG


@dataclass
class Build:
    """Body shape. 1.0 is the average man; the others scale from it."""
    shoulder: float = 1.0   # width of the shoulders and upper chest
    chest: float = 1.0      # chest width and depth
    waist: float = 1.0
    hip: float = 1.0
    bust: float = 0.0       # metres of forward bulge
    belly: float = 0.0      # metres of forward bulge at the navel
    glute: float = 0.006
    limb: float = 1.0       # arm and leg thickness
    neck: float = 1.0
    depth: float = 1.0      # front-to-back scale of the torso
    calf: float = 1.0
    sex: str = 'm'


MALE_LEAN = Build(shoulder=0.98, chest=0.95, waist=0.93, hip=0.97, limb=0.93, neck=0.97, calf=1.0)
MALE_AVG = Build()
MALE_HEAVY = Build(shoulder=1.04, chest=1.12, waist=1.2, hip=1.08, belly=0.04, limb=1.14, neck=1.14, depth=1.12, glute=0.01)
MALE_STOCKY = Build(shoulder=1.04, chest=1.07, waist=1.1, hip=1.05, belly=0.02, limb=1.08, neck=1.08, depth=1.06)
FEM_SLIM = Build(shoulder=0.83, chest=0.84, waist=0.8, hip=1.0, bust=0.016, limb=0.84, neck=0.82, depth=0.92, glute=0.012, sex='f', calf=0.9)
FEM_AVG = Build(shoulder=0.86, chest=0.88, waist=0.88, hip=1.07, bust=0.024, limb=0.9, neck=0.84, depth=0.95, glute=0.014, sex='f', calf=0.93)
FEM_FULL = Build(shoulder=0.9, chest=0.96, waist=1.04, hip=1.17, bust=0.034, belly=0.012, limb=1.0, neck=0.9, depth=1.02, glute=0.02, sex='f', calf=1.0)


def gauss(x, s):
    return math.exp(-0.5 * (x / s) ** 2)


def torso_curve(b: Build):
    sw, ch, wa, hp, dp = b.shoulder, b.chest, b.waist, b.hip, b.depth
    f = b.sex == 'f'
    # (y, rx, rz, ox, oz, exponent)
    rows = [
        (0.82, 0.112 * hp, 0.070 * dp, 0, 0.0, 2.2),
        (0.87, 0.160 * hp, 0.098 * dp, 0, 0.0, 2.2),
        (0.93, 0.200 * hp, 0.114 * dp, 0, -0.004, 2.2),
        (1.00, 0.198 * hp, 0.114 * dp, 0, -0.006, 2.2),
        (1.06, 0.164 * lerp(hp, wa, 0.5), 0.105 * dp, 0, -0.003, 2.2),
        (1.12, 0.148 * wa, 0.096 * dp * lerp(1, wa, 0.7), 0, 0.0, 2.2),
        (1.19, 0.150 * wa, 0.098 * dp * lerp(1, wa, 0.6), 0, 0.0, 2.2),
        (1.26, 0.160 * ch, 0.106 * dp * lerp(1, ch, 0.5), 0, 0.002, 2.3),
        (1.33, 0.170 * ch, 0.113 * dp * lerp(1, ch, 0.5), 0, 0.005, 2.4),
        (1.395, 0.176 * lerp(ch, sw, 0.6), 0.108 * dp, 0, 0.0, 2.5),
        (1.43, 0.196 * sw, 0.095 * dp, 0, -0.004, 2.5),
        (1.455, 0.178 * sw, 0.084 * dp, 0, -0.008, 2.4),
        (1.478, 0.128 * sw, 0.070, 0, -0.008, 2.2),
        (1.50, 0.066 * b.neck, 0.064 * b.neck, 0, -0.004, 2.1),
        (1.53, 0.056 * b.neck, 0.057 * b.neck, 0, 0.0, 2.0),
        (1.56, 0.054 * b.neck, 0.056 * b.neck, 0, 0.006, 2.0),
    ]
    c = Curve([(r[0], r[1], r[2], r[3], r[4], r[5]) for r in rows])
    return c


def torso_deform(b: Build):
    def d(t, theta, p, layer):
        z = p.z
        y = p.y
        x = p.x
        add = 0.0
        # bust: two lobes on the chest
        if b.bust and y > 1.2 and y < 1.42 and z > 0.02:
            for sx in (-1, 1):
                add += b.bust * gauss(x - sx * 0.082, 0.06) * gauss(y - 1.325, 0.05)
        elif b.sex == 'm' and y > 1.25 and y < 1.42 and z > 0.02:
            for sx in (-1, 1):
                add += 0.006 * gauss(x - sx * 0.08, 0.06) * gauss(y - 1.33, 0.05)
        if b.belly and z > 0.0:
            add += b.belly * gauss(x, 0.11) * gauss(y - 1.08, 0.09)
        if z < -0.02 and 0.88 < y < 1.06:
            add -= b.glute * gauss(abs(x) - 0.085, 0.06) * gauss(y - 0.96, 0.06) * 1.0
        if add:
            p = p.copy()
            p.z += add * (1 if add > 0 else 1)
        return p
    return d


def leg_curve(b: Build):
    k, c = b.limb, b.calf
    rows = [
        (0.0, 0.078 * k, 0.080 * k, 0, 0.0, 2.1),     # t = distance down from y = 0.98 (the top is tucked inside the pelvis)
        (0.04, 0.086 * k, 0.092 * k, 0, 0.0, 2.1),
        (0.09, 0.092 * k, 0.101 * k, 0, 0.0, 2.1),
        (0.18, 0.086 * k, 0.095 * k, 0, 0.002, 2.1),
        (0.28, 0.080 * k, 0.086 * k, 0, 0.002, 2.1),
        (0.38, 0.069 * k, 0.074 * k, 0, 0.004, 2.1),
        (0.46, 0.057 * k, 0.065 * k, 0, 0.006, 2.1),
        (0.49, 0.053 * k, 0.061 * k, 0, 0.010, 2.1),
        (0.54, 0.054 * k, 0.059 * k, 0, 0.004, 2.1),
        (0.60, 0.057 * k * c, 0.066 * k * c, 0, -0.008, 2.1),
        (0.68, 0.054 * k * c, 0.060 * k * c, 0, -0.008, 2.1),
        (0.78, 0.043 * k, 0.047 * k, 0, -0.003, 2.1),
        (0.86, 0.035 * k, 0.038 * k, 0, 0.0, 2.1),
        (0.895, 0.032 * k, 0.034 * k, 0, 0.0, 2.1),
        (0.93, 0.031 * k, 0.033 * k, 0, 0.0, 2.1),
    ]
    return Curve(rows)


def arm_curve(b: Build, side=1):
    k = b.limb
    sw = b.shoulder
    rows = [
        (0.0, 0.004, 0.004, 0, 0.0, 2.0),
        (0.012, 0.031 * k, 0.031 * k, 0, 0.0, 2.0),
        (0.03, 0.049 * k, 0.050 * k, 0, 0.0, 2.0),
        (0.055, 0.056 * k, 0.057 * k, 0, 0.0, 2.0),
        (0.10, 0.052 * k, 0.054 * k, 0, 0.0, 2.0),
        (0.16, 0.049 * k, 0.052 * k, 0, 0.002, 2.0),
        (0.22, 0.043 * k, 0.045 * k, 0, 0.0, 2.0),
        (0.285, 0.040 * k, 0.041 * k, 0, 0.0, 2.0),
        (0.34, 0.042 * k, 0.043 * k, 0, 0.0, 2.0),
        (0.43, 0.034 * k, 0.034 * k, 0, 0.0, 2.0),
        (0.50, 0.027 * k, 0.025 * k, 0, 0.0, 2.0),
        (0.54, 0.025 * k, 0.022 * k, 0, 0.0, 2.0),
        (0.57, 0.025 * k, 0.022 * k, 0, 0.0, 2.0),
    ]
    return Curve(rows)


def hand_curve(b: Build):
    k = b.limb ** 0.5
    rows = [
        (-0.03, 0.025, 0.026, 0, 0, 2.0),
        (0.0, 0.0245, 0.029, 0, 0, 2.2),
        (0.05, 0.020 * k, 0.040 * k, 0, 0.0, 2.4),
        (0.095, 0.019 * k, 0.043 * k, 0.002, 0.0, 2.5),
        (0.13, 0.016 * k, 0.040 * k, 0.012, 0.0, 2.5),
        (0.165, 0.0135 * k, 0.036 * k, 0.026, 0.0, 2.5),
        (0.188, 0.0105 * k, 0.030 * k, 0.037, 0.0, 2.4),
        (0.2, 0.006 * k, 0.020 * k, 0.043, 0.0, 2.2),
        (0.206, 0.0, 0.0, 0.045, 0.0, 2.0),
    ]
    return Curve(rows)


def foot_curve(style='sneaker', size=1.0):
    # t from the heel; (rx half width, rz half height, ox, oz = centre height, exponent)
    s = size
    if style == 'dress':
        rows = [
            (0.0, 0.012, 0.02, 0, 0.03, 2.2),
            (0.012, 0.034, 0.032, 0, 0.034, 2.4),
            (0.045, 0.041, 0.040, 0, 0.041, 2.5),
            (0.095, 0.042, 0.042, 0, 0.043, 2.5),
            (0.145, 0.043, 0.032, 0, 0.033, 2.5),
            (0.20, 0.046 * s, 0.026, 0, 0.027, 2.6),
            (0.25, 0.042 * s, 0.021, 0, 0.022, 2.6),
            (0.29, 0.030, 0.017, 0, 0.018, 2.3),
            (0.312, 0.012, 0.012, 0, 0.015, 2.1),
            (0.318, 0.0, 0.0, 0, 0.015, 2.0),
        ]
    elif style == 'boot':
        rows = [
            (0.0, 0.012, 0.02, 0, 0.03, 2.2),
            (0.012, 0.037, 0.034, 0, 0.037, 2.4),
            (0.045, 0.046, 0.042, 0, 0.043, 2.6),
            (0.095, 0.047, 0.046, 0, 0.046, 2.6),
            (0.15, 0.049, 0.039, 0, 0.039, 2.6),
            (0.20, 0.054 * s, 0.033, 0, 0.033, 2.7),
            (0.25, 0.050 * s, 0.028, 0, 0.028, 2.7),
            (0.285, 0.040, 0.024, 0, 0.024, 2.4),
            (0.305, 0.024, 0.018, 0, 0.020, 2.2),
            (0.312, 0.0, 0.0, 0, 0.02, 2.0),
        ]
    else:
        rows = [
            (0.0, 0.012, 0.02, 0, 0.03, 2.2),
            (0.012, 0.036, 0.033, 0, 0.036, 2.4),
            (0.045, 0.043, 0.041, 0, 0.042, 2.5),
            (0.095, 0.044, 0.043, 0, 0.044, 2.5),
            (0.145, 0.047, 0.036, 0, 0.037, 2.5),
            (0.20, 0.052 * s, 0.030, 0, 0.031, 2.6),
            (0.25, 0.049 * s, 0.025, 0, 0.026, 2.6),
            (0.285, 0.039, 0.021, 0, 0.022, 2.3),
            (0.303, 0.022, 0.016, 0, 0.019, 2.2),
            (0.31, 0.0, 0.0, 0, 0.019, 2.0),
        ]
    return Curve(rows)


def dense(t0, t1, step, extra=()):
    n = max(1, round((t1 - t0) / step))
    return [t0 + (t1 - t0) * i / n for i in range(n + 1)] + list(extra)


# ---- levels of detail: radial counts and station spacing ----
LODS = [
    dict(torso_n=16, limb_n=12, hand_n=8, foot_n=10, head_cols=19, step=0.05, name='lod0'),
    dict(torso_n=10, limb_n=7, hand_n=6, foot_n=6, head_cols=11, step=0.12, name='lod1'),
    dict(torso_n=7, limb_n=5, hand_n=0, foot_n=5, head_cols=7, step=0.3, name='lod2'),
]


def torso_stations(lod, extra=()):
    if lod == 0:
        ts = [0.82, 0.87, 0.93, 1.0, 1.06, 1.12, 1.19, 1.26, 1.33, 1.395, 1.43, 1.455, 1.478, 1.50, 1.53, 1.56]
    elif lod == 1:
        ts = [0.82, 1.0, 1.12, 1.26, 1.36, 1.43, 1.47, 1.50, 1.56]
    else:
        ts = [0.82, 1.1, 1.38, 1.46, 1.56]
    return ts + list(extra)


def leg_stations(lod, extra=()):
    if lod == 0:
        ts = [0.0, 0.04, 0.09, 0.18, 0.28, 0.38, 0.46, 0.49, 0.54, 0.60, 0.68, 0.78, 0.86, 0.895, 0.93]
    elif lod == 1:
        ts = [0.0, 0.2, 0.4, 0.49, 0.6, 0.78, 0.93]
    else:
        ts = [0.0, 0.3, 0.49, 0.93]
    return ts + list(extra)


def arm_stations(lod, extra=()):
    if lod == 0:
        ts = [0.0, 0.012, 0.03, 0.055, 0.10, 0.16, 0.22, 0.285, 0.34, 0.43, 0.50, 0.54, 0.57]
    elif lod == 1:
        ts = [0.0, 0.015, 0.055, 0.16, 0.285, 0.43, 0.57]
    else:
        ts = [0.0, 0.05, 0.285, 0.57]
    return ts + list(extra)


def arm_axis(side):
    sh, el, wr, tip = ARM[side]
    return Vector(sh), (Vector(wr) - Vector(sh)).normalized()


def make_arm(mesh, b, lod, side, layers=(), masks=(), deform=None):
    L = LODS[lod]
    O, A = arm_axis(side)
    n = L['limb_n']
    nm = 'L' if side == 1 else 'R'
    w = Weighter(['chest', f'clavicle_{nm}', f'upperarm_{nm}', f'forearm_{nm}', f'hand_{nm}'], scale={'chest': 0.7})
    t = Tube(mesh, O, A, (0, 0, 1), arm_curve(b, side), arm_stations(lod), n, 'skin', layers, w, side, masks, deform)
    first = t.stations[0][1]
    t.seal(first.mat if first else 'skin', end=0)
    return t


def make_hand(mesh, b, lod, side, layers=(), thumb=True):
    L = LODS[lod]
    nm = 'L' if side == 1 else 'R'
    sh, el, wr, tip = ARM[side]
    wr, tip = Vector(wr), Vector(tip)
    A = (tip - wr).normalized()
    w = Weighter([f'forearm_{nm}', f'hand_{nm}'])
    n = L['hand_n']
    if n == 0:
        return None
    ts = [-0.03, 0.0, 0.05, 0.095, 0.13, 0.165, 0.188, 0.2, 0.206] if lod == 0 else [-0.03, 0.05, 0.13, 0.19, 0.206]
    h = Tube(mesh, wr, A, (0, 0, 1), hand_curve(b), ts, n, 'skin', layers, w, side)
    if thumb and lod == 0:
        Fv = Vector((0, 0, 1))
        o = wr + A * 0.035 + Fv * 0.028 + Vector((-side * 0.004, 0, 0))
        ax = (A + Fv * 0.55 + Vector((-side * 0.1, 0, 0))).normalized()
        thc = Curve([(0.0, 0.013, 0.014, 0, 0, 2.0), (0.03, 0.0125, 0.013, 0, 0, 2.0), (0.06, 0.010, 0.011, 0, 0, 2.0), (0.08, 0.006, 0.007, 0, 0, 2.0), (0.088, 0.0, 0.0, 0, 0, 2.0)])
        Tube(mesh, o, ax, (1, 0, 0), thc, [0.0, 0.03, 0.06, 0.08, 0.088], 6, 'skin', (), w, side)
    return h


def make_leg(mesh, b, lod, side, layers=(), masks=(), deform=None):
    L = LODS[lod]
    nm = 'L' if side == 1 else 'R'
    w = Weighter(['pelvis', f'thigh_{nm}', f'shin_{nm}', f'foot_{nm}'], scale={'pelvis': 0.8})
    O = Vector((side * 0.090, 0.98, 0.0))
    return Tube(mesh, O, (0, -1, 0), (0, 0, 1), leg_curve(b), leg_stations(lod), L['limb_n'], 'skin', layers, w, side, masks, deform)


def make_shoe(mesh, lod, side, style='sneaker', upper='shoe', sole='sole', size=1.0, extra_masks=()):
    L = LODS[lod]
    nm = 'L' if side == 1 else 'R'
    w = Weighter([f'shin_{nm}', f'foot_{nm}', f'toe_{nm}'], scale={f'shin_{nm}': 0.5})
    n = L['foot_n']
    c = foot_curve(style, size)
    ts = [r[0] for r in c.rows] if lod == 0 else [c.rows[0][0], c.rows[2][0], c.rows[3][0], c.rows[5][0], c.rows[-3][0], c.rows[-1][0]] if lod == 1 else [c.rows[1][0], c.rows[4][0], c.rows[-2][0], c.rows[-1][0]]
    # ring angle 0 is straight up; the bottom 3 sectors are the sole
    lim = 2.05 if lod < 2 else 1.9

    def mask(t, th, mat, layer):
        if abs(th) > lim:
            return sole
        return None
    z0 = -0.075
    t = Tube(mesh, Vector((side * 0.09, 0.0, z0)), (0, 0, 1), (0, 1, 0), c, ts, n, upper, (), w, side, (mask,) + tuple(extra_masks))
    return t
