"""The parametric body: torso and neck, arms, hands, legs and feet as lofted tubes, shaped by a
`Build` (shoulders, waist, hips, bust, belly, limb thickness). Sizes are for a 1.74 m figure; the
game scales a whole person for height. Clothing is passed in as layers per tube (see outfits.py).
"""
import math
from dataclasses import dataclass, field

from mathutils import Vector

from .shapes import BONE_INDEX, Curve, Layer, Tube, Weighter, add_weighted, lerp, mkvert, quad, sstep
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


def palm_curve(b: Build):
    """The palm of the full hand: the hand tube ends in a rounded knuckle line, the fingers come out of it."""
    k = b.limb ** 0.5
    rows = [
        (-0.03, 0.025, 0.026, 0, 0, 2.0),
        (0.0, 0.0245, 0.029, 0, 0, 2.2),
        (0.05, 0.020 * k, 0.040 * k, 0, 0.0, 2.4),
        (0.095, 0.0195 * k, 0.043 * k, 0.002, 0.0, 2.5),
        (0.107, 0.0165 * k, 0.040 * k, 0.005, 0.0, 2.5),
        (0.115, 0.0105 * k, 0.030 * k, 0.007, 0.0, 2.4),
        (0.12, 0.0, 0.0, 0.008, 0.0, 2.0),
    ]
    return Curve(rows)


def dense(t0, t1, step, extra=()):
    n = max(1, round((t1 - t0) / step))
    return [t0 + (t1 - t0) * i / n for i in range(n + 1)] + list(extra)


# ---- levels of detail: radial counts and station spacing ----
LODS = [
    dict(torso_n=16, limb_n=12, hand_n=8, foot_n=8, head_cols=19, step=0.05, name='lod0'),
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
    if lod == 0:
        # a palm with four fingers and a thumb of their own (fingers.py), skinned to the finger bones
        from .fingers import build_fingers
        h = Tube(mesh, wr, A, (0, 0, 1), palm_curve(b), [-0.03, 0.0, 0.05, 0.095, 0.107, 0.115, 0.12], n, 'skin', layers, w, side)
        build_fingers(mesh, side)
        return h
    ts = [-0.03, 0.05, 0.13, 0.19, 0.206]
    return Tube(mesh, wr, A, (0, 0, 1), hand_curve(b), ts, n, 'skin', layers, w, side)


def make_leg(mesh, b, lod, side, layers=(), masks=(), deform=None):
    L = LODS[lod]
    nm = 'L' if side == 1 else 'R'
    w = Weighter(['pelvis', f'thigh_{nm}', f'shin_{nm}', f'foot_{nm}'], scale={'pelvis': 0.8})
    O = Vector((side * 0.090, 0.98, 0.0))
    return Tube(mesh, O, (0, -1, 0), (0, 0, 1), leg_curve(b), leg_stations(lod), L['limb_n'], 'skin', layers, w, side, masks, deform)


# ---- shoes ----
# A shoe is its upper (a lofted section from the heel to the toe: width and height by length), a sole slab (thicker under the
# heel, turned up at the toe, a little wider than the upper), and for the full level of detail a few details. t runs from the
# heel (0) to the toe (0.312); y is the height above the floor. The leg ends inside the upper at the ankle.
SHOE_STYLES = {
    # width: half width by t; top: height of the upper's top by t; the numbers after are the sole
    'sneaker': dict(
        width=[(0.0, 0.030), (0.012, 0.038), (0.05, 0.044), (0.10, 0.045), (0.15, 0.048), (0.20, 0.053), (0.25, 0.051), (0.285, 0.043), (0.305, 0.028), (0.312, 0.0)],
        top=[(0.0, 0.068), (0.03, 0.086), (0.085, 0.094), (0.13, 0.088), (0.17, 0.080), (0.22, 0.069), (0.27, 0.055), (0.312, 0.037)],
        sole=0.022, out=0.004, heel=0.004, spring=0.020, expo=2.7, laces=True, tongue=True, toecap=True),
    'boot': dict(
        width=[(0.0, 0.032), (0.012, 0.040), (0.05, 0.046), (0.10, 0.047), (0.15, 0.050), (0.20, 0.055), (0.25, 0.053), (0.288, 0.044), (0.306, 0.028), (0.312, 0.0)],
        top=[(0.0, 0.080), (0.03, 0.096), (0.085, 0.100), (0.13, 0.092), (0.17, 0.084), (0.22, 0.074), (0.27, 0.062), (0.312, 0.046)],
        sole=0.026, out=0.005, heel=0.014, spring=0.012, expo=2.9, laces=False, tongue=True, toecap=True),
    'dress': dict(
        width=[(0.0, 0.026), (0.012, 0.034), (0.05, 0.039), (0.10, 0.040), (0.15, 0.041), (0.20, 0.042), (0.245, 0.038), (0.28, 0.027), (0.303, 0.013), (0.314, 0.0)],
        top=[(0.0, 0.062), (0.03, 0.074), (0.085, 0.080), (0.13, 0.074), (0.17, 0.066), (0.22, 0.056), (0.27, 0.043), (0.314, 0.030)],
        sole=0.013, out=0.003, heel=0.016, spring=0.012, expo=2.5, laces=False, tongue=False, toecap=False),
}
SHOE_LEN = 0.312
SHOE_Z0 = -0.075


def _interp(rows, t):
    return Curve([(r[0], r[1]) for r in rows])(t)[0]


def make_shoe(mesh, lod, side, style='sneaker', upper='shoe', sole='sole', size=1.0, extra_masks=()):
    L = LODS[lod]
    nm = 'L' if side == 1 else 'R'
    S = SHOE_STYLES.get(style, SHOE_STYLES['sneaker'])
    w = Weighter([f'shin_{nm}', f'foot_{nm}', f'toe_{nm}'], scale={f'shin_{nm}': 0.5})
    n = L['foot_n']
    k = size
    W = Curve([(r[0], r[1] * k, 0, 0, 0, 0) for r in S['width']])
    T = Curve([(r[0], r[1]) for r in S['top']])
    h0, out, heel, spring = S['sole'], S['out'], S['heel'], S['spring']

    def sole_h(t):
        return h0 + heel * (1 - sstep(0.05, 0.13, t))

    def lift(t):
        return spring * sstep(0.18, 0.312, t) ** 1.6

    if lod == 0:
        ts = [0.0, 0.03, 0.09, 0.15, 0.21, 0.26, 0.29, 0.312]
    elif lod == 1:
        ts = [0.0, 0.05, 0.13, 0.20, 0.27, 0.312]
    else:
        ts = [0.012, 0.14, 0.29, 0.312]
    O = Vector((side * 0.09, 0.0, SHOE_Z0))
    # the upper: from just inside the sole's top to the top line (at the lower levels of detail it reaches the floor and its underside is the sole)
    rows = []
    for t in ts:
        yb = (sole_h(t) + lift(t) - 0.004) if lod == 0 else lift(t) * 0.5
        yt = max(yb + 0.012, T(t)[0] + lift(t) * 0.6)
        rows.append((t, W(t)[0] + (0.0 if lod == 0 else out * 0.6) if t < SHOE_LEN - 1e-6 else 0.0, (yt - yb) / 2, 0.0, (yt + yb) / 2, S['expo']))
    prof = Curve(rows)
    lim = 2.05 if lod < 2 else 1.9
    masks = ()
    if lod > 0:
        masks = (lambda t, th, mat, layer: sole if abs(th) > lim else None,)
    up = Tube(mesh, O, (0, 0, 1), (0, 1, 0), prof, ts, n, upper, (), w, side, masks)
    up.seal(upper, 0)
    if lod == 0:
        srows = []
        for t in ts:
            hh = sole_h(t)
            wd = W(t)[0] + out if t < SHOE_LEN - 1e-6 else 0.0
            srows.append((t, wd, hh / 2 + 0.001, 0.0, hh / 2 + lift(t), 3.4))
        Tube(mesh, O, (0, 0, 1), (0, 1, 0), Curve(srows), ts, 8, sole, (), w, side, ()).seal(sole, 0)
    if lod == 0:
        z = lambda t: SHOE_Z0 + t
        x0 = side * 0.09
        if S['laces']:
            # the lace panel: a strip along the instep from the throat toward the toe
            t0, t1 = 0.085, 0.205
            y0, y1 = T(t0)[0] + 0.001, T(t1)[0] + 0.001
            L_ = math.hypot(t1 - t0, y1 - y0)
            ang = math.atan2(y0 - y1, t1 - t0)
            add_weighted(mesh, w, lambda: mesh.box((x0, (y0 + y1) / 2 + 0.002, z((t0 + t1) / 2)), (0.026 * k, 0.006, L_), sole, rot=(ang, 0, 0)))
        if S['tongue']:
            add_weighted(mesh, w, lambda: mesh.box((x0, T(0.075)[0] + 0.004, z(0.066)), (0.04 * k, 0.012, 0.03), sole, rot=(-0.5, 0, 0)))
        if S['toecap']:
            add_weighted(mesh, w, lambda: mesh.box((x0, T(0.255)[0] - 0.012 + lift(0.255) * 0.6, z(0.262)), (0.082 * k, 0.012, 0.062), sole, rot=(0.3, 0, 0)))
    return up


