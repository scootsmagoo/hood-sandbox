"""The archetypes: a body build, a head, and the clothes as layers on the tubes (see shapes.py), plus
extras (collars, pockets, bags, belts, hats) built straight into the figure. Each is one body the game
paints with a person's palette (src/client/render/chars/outfits.ts has the outfits that use them).

Heights (m) for reference: crotch 0.82, hip 0.93, waist 1.12, chest 1.33, shoulder 1.45, neck 1.50.
On an arm, t runs from the shoulder: elbow 0.285, wrist 0.54. On a leg, t runs down from y = 0.98:
knee 0.49, ankle 0.895.
"""
import math
from dataclasses import dataclass, field
from typing import Callable

from mathutils import Vector

from hoodlib.frame import from_bl

from . import body as B
from .head import HeadSpec, hair_curtain, hat_shell, strand
from .shapes import Curve, Layer, Tube, Weighter, add_weighted, lathe_ring, lerp, mkvert, quad, sstep


@dataclass
class Arch:
    name: str
    build: B.Build
    head: HeadSpec
    torso_layers: Callable = lambda b: []
    arm_layers: Callable = lambda b, side: []
    hand_layers: Callable = lambda b, side: []
    leg_layers: Callable = lambda b, side: []
    torso_masks: tuple = ()
    arm_masks: tuple = ()
    leg_masks: tuple = ()
    shoe: dict = field(default_factory=dict)
    extras: tuple = ()
    note: str = ''
    palette: dict = field(default_factory=dict)


ARCHETYPES = {}


def reg(a):
    ARCHETYPES[a.name] = a
    return a


W_CHEST = Weighter(['pelvis', 'spine', 'chest', 'clavicle_L', 'clavicle_R'], scale={'pelvis': 0.5, 'clavicle_L': 0.5, 'clavicle_R': 0.5})
W_PELVIS = Weighter(['pelvis', 'spine', 'thigh_L', 'thigh_R'], scale={'thigh_L': 0.4, 'thigh_R': 0.4})
W_NECK = Weighter(['chest', 'neck', 'head'], scale={'head': 0.5})


# ---------------------------------------------------------------- pieces
def sleeve(ctx, side, t0, t1, mat, thick, name):
    """A garment on part of a leg that is its own tube (a boot shaft over the jeans' hem)."""
    nm = 'L' if side == 1 else 'R'
    lod = ctx['lod']
    L = B.LODS[lod]
    w = Weighter(['pelvis', f'thigh_{nm}', f'shin_{nm}', f'foot_{nm}'], scale={'pelvis': 0.8})
    ts = [t0, t1] if lod > 0 else [t0, 0.5 * (t0 + t1), t1]
    lay = Layer(t0, t1, mat, thick, hem0=False, hem1=False)
    return Tube(ctx['mesh'], Vector((side * 0.090, 0.98, 0.0)), (0, -1, 0), (0, 0, 1), B.leg_curve(ctx['build']), ts, L['limb_n'], 'skin', [lay], w, side)


def boots(ctx, top=0.70, mat='shoe'):
    for side in (1, -1):
        sleeve(ctx, side, top, 0.93, mat, 0.0075, 'boot')


def skirt_weights(y0, drop):
    """Skin weights of a skirt: the waist follows the pelvis and spine; lower down the front and the sides follow the thighs
    (so a seated or crouching figure's knees lift the cloth instead of poking through it) while the back hangs from the pelvis."""
    from .shapes import BONE_INDEX
    ip, isp, il, ir = BONE_INDEX['pelvis'], BONE_INDEX['spine'], BONE_INDEX['thigh_L'], BONE_INDEX['thigh_R']

    def f(p):
        x, y, z = p[0], p[1], p[2]
        v = min(1.0, max(0.0, (y0 - y) / drop))
        front = 0.2 + 0.8 * sstep(-0.15, 0.04, z)
        k = sstep(0.02, 0.5, v) * front
        side = sstep(-0.07, 0.07, x)
        out = {ip: (1 - k) * (0.85 if v > 0.02 else 0.6), isp: (1 - k) * (0.15 if v > 0.02 else 0.4), il: k * side, ir: k * (1 - side)}
        return {i: w for i, w in out.items() if w > 0.01}
    return f


def skirt(ctx, y0=1.09, t_hem=0.5, hip=0.0, hem_rx=0.2, hem_rz=0.17, mat='bottom', waist=0.0, knee_pinch=0.0, thick=0.0):
    """A skirt: a tube round both legs from the waist (y0) down to a hem `t_hem` below the hip line."""
    b = ctx['build']
    lod = ctx['lod']
    n = {0: 16, 1: 10, 2: 7}[lod]
    y1 = 0.98 - t_hem
    w = skirt_weights(y0, y0 - y1)
    tc = B.torso_curve(b)
    # the top follows the body (waist, then hips), the hem flares from there
    rows = []
    for dy in (0.0, 0.05, 0.12):
        r = tc(y0 - dy)
        rows.append((dy, r[0] + thick + 0.006, r[1] + thick + 0.006, 0, r[3] - 0.002, 2.2))
    drop = y0 - y1
    rows.append((drop, hem_rx * b.hip + thick, hem_rz * b.depth + thick, 0, -0.004, 2.2))
    c = Curve(rows)
    ts = [r[0] for r in rows] if lod == 0 else [0.0, 0.12, drop]
    if lod == 0:
        ts = sorted(set(ts + [0.5 * (0.12 + drop)]))
    Tube(ctx['mesh'], Vector((0, y0, 0)), (0, -1, 0), (0, 0, 1), c, ts, n, mat, (), w, 1)


def backpack(ctx, size=(0.3, 0.38, 0.15), y=1.27, mat='gear', straps=True, pocket=True):
    m = ctx['mesh']
    if ctx['lod'] == 2:
        add_weighted(m, W_CHEST, lambda: m.box((0, y, -0.18), size, mat))
        return
    add_weighted(m, W_CHEST, lambda: m.box((0, y, -0.175), size, mat, bevel=0.035, segments=1))
    if ctx['lod'] == 0 and pocket:
        add_weighted(m, W_CHEST, lambda: m.box((0, y - size[1] * 0.18, -0.175 - size[2] / 2 - 0.02), (size[0] * 0.8, size[1] * 0.4, 0.05), mat, bevel=0.02))
    if straps and ctx['lod'] <= 1:
        for sx in (-1, 1):
            add_weighted(m, W_CHEST, lambda sx=sx: m.box((sx * 0.085, 1.30, 0.128), (0.045, 0.34, 0.016), mat))
            add_weighted(m, W_CHEST, lambda sx=sx: m.box((sx * 0.085, 1.475, -0.04), (0.045, 0.016, 0.26), mat, rot=(0.1, 0, 0)))


def belt(ctx, y=1.075, mat='belt', th=0.012, buckle=True):
    """A belt round the waist, over whatever is there."""
    b = ctx['build']
    w = W_PELVIS
    n = {0: 16, 1: 10, 2: 7}[ctx['lod']]
    c = B.torso_curve(b)
    lay = None
    rx, rz = c(y)[0], c(y)[1]
    extra = 0.027 if ctx.get('jacket') else 0.012
    rows = [(-0.014, rx + extra, rz + extra), (0.014, rx + extra, rz + extra)]
    add_weighted(ctx['mesh'], w, lambda: lathe_ring(ctx['mesh'], Vector((0, y, 0)), (0, 1, 0), [(-0.016, rx + extra + th, rz + extra + th, 0, 0), (0.016, rx + extra + th, rz + extra + th, 0, 0)], n, mat, w))


def pocket_flaps(ctx, ys, mat, size=(0.07, 0.055, 0.007)):
    if ctx['lod'] > 0:
        return
    m = ctx['mesh']
    b = ctx['build']
    for sx in (-1, 1):
        for y, kind in ys:
            if kind == 'chest':
                add_weighted(m, W_CHEST, lambda sx=sx, y=y: m.box((sx * 0.082, y, 0.123 * b.depth + 0.017), size, mat, bevel=0.003))


def jacket_thick(chest=0.013, hem=0.009, hem_y=1.12, y_hi=1.3):
    return lambda t: chest + hem * sstep(hem_y, hem_y - 0.2, t) + 0.003 * sstep(y_hi, y_hi + 0.1, t)


def pants_torso(y_hi=0.90, thick=0.011, mat='bottom'):
    return Layer(0.82, y_hi, mat, thick, hem0=False)


def jeans(b, side, hem_t=0.90, flare=0.012, thick=0.010, mat='bottom'):
    return [Layer(0.0, hem_t, mat, lambda t: thick + flare * sstep(hem_t - 0.3, hem_t, t), hem0=False)]


def tee_sleeves(length=0.16, thick=0.011, mat='top'):
    return lambda b, side: [Layer(0.0, length, mat, lambda t: thick + 0.004 * sstep(0.1, length, t), hem0=False)]


def long_sleeves(thick=0.012, cuff=None, cuff_mat='top2', end=0.525):
    def f(b, side):
        out = [Layer(0.0, end, 'top', lambda t: thick + 0.004 * sstep(0.2, 0.3, t), hem0=False)]
        if cuff:
            out.append(Layer(end, 0.575, cuff_mat, cuff, hem0=True, hem1=False))
        return out
    return f


def v_neck(mat, y_hi=1.495, y_lo=1.29, spread=2.1, base=0.2):
    def f(t, th, m, layer):
        if layer is not None and layer.mat == 'top' and y_lo < t < y_hi and abs(th) < base + spread * (t - y_lo) * 0.9:
            return mat
        return None
    return f


def tie(t, th, m, layer):
    if layer is not None and layer.mat == 'top' and 1.16 < t < 1.49 and abs(th) < 0.2:
        return 'trim'
    return None


def stripes(bands, mat='top2', verticals=None):
    def f(t, th, m, layer):
        if layer is None:
            return None
        for lo, hi in bands:
            if lo < t < hi:
                return mat
        if verticals and verticals[0] < abs(th) < verticals[1] and 0.95 < t < 1.47:
            return mat
        return None
    return f


# ---------------------------------------------------------------- hats
def cap_extra(ctx, kind='cap', mat='hat'):
    spec = ctx['arch'].head
    lod = ctx['lod']
    m = ctx['mesh']
    if kind == 'cap':
        edge = lambda th: 1.676 - 0.044 * sstep(0.5, 2.4, abs(th)) - 0.012 * (abs(th) > 2.8)
        hat_shell(m, spec, lod, edge, thick=0.026, rim=0.01, brim=dict(kind='peak', reach=0.085, droop=0.22, arc=1.1))
    elif kind == 'beanie':
        edge = lambda th: 1.655 - 0.03 * sstep(0.6, 2.4, abs(th))
        hat_shell(m, spec, lod, edge, thick=0.030, rim=0.014)
    elif kind == 'hardhat':
        edge = lambda th: 1.665 - 0.02 * sstep(0.8, 2.6, abs(th))
        hat_shell(m, spec, lod, edge, thick=0.035, rim=0.014, brim=dict(kind='ring', reach=0.04, droop=0.1, arc=3.2))
    elif kind == 'police':
        edge = lambda th: 1.672 - 0.012 * sstep(0.5, 2.4, abs(th))
        hat_shell(m, spec, lod, edge, thick=0.032, rim=0.016, brim=dict(kind='peak', reach=0.06, droop=0.06, arc=1.0))


def long_hair(ctx, y_end=1.40, spread=1.0, sway=0.0):
    hair_curtain(ctx['mesh'], ctx['arch'].head, ctx['lod'], y_end, spread=spread, sway=sway)


def _tie(ctx, c, axis, r, w):
    lathe_ring(ctx['mesh'], c, axis, [(-0.01, r, r, 0, 0), (0.01, r, r, 0, 0)], 7 if ctx['lod'] == 0 else 5, 'gear', w)


def ponytail(ctx, length=0.25, thick=0.034, high=1.69, swing=0.06):
    """A ponytail gathered at the back of the head, swinging out and down in a curve, with a tie."""
    from .fingers import polytube
    if ctx['lod'] == 2:
        return
    w = Weighter(['head', 'neck', 'chest'], soft=0.03, scale={'chest': 0.4})
    lod = ctx['lod']
    root = Vector((0.0, high, -0.086))
    pts = [root + Vector((0, 0.004, -0.004)), root + Vector((0, -0.012, -0.045)), root + Vector((0, -0.05 - length * 0.15, -0.075 - swing)),
           root + Vector((0.0, -0.1 - length * 0.5, -0.082 - swing * 1.2)), root + Vector((0.006, -0.1 - length * 0.9, -0.07 - swing)), root + Vector((0.01, -0.1 - length, -0.062 - swing * 0.8))]
    radii = [thick * 0.62, thick * 0.78, thick, thick * 0.9, thick * 0.62, thick * 0.2]
    polytube(ctx['mesh'], pts, [(r, r) for r in radii], Vector((1, 0, 0)), 8 if lod == 0 else 5, 'hair', w)
    _tie(ctx, root + Vector((0, -0.006, -0.02)), Vector((0, -0.25, -1.0)).normalized(), thick * 0.82, w)


def bun(ctx, y=1.70, z=-0.075, r=0.045):
    """A bun (a knot of hair) on the head, a ring round its base."""
    if ctx['lod'] == 2:
        return
    w = Weighter(['head', 'neck'], soft=0.03)
    rows = [(-r, 0.004, 0.004, 0, 0), (-r * 0.8, r * 0.75, r * 0.7, 0, 0), (-r * 0.35, r * 1.0, r * 0.95, 0, 0), (r * 0.25, r * 0.98, r * 0.92, 0, 0), (r * 0.8, r * 0.7, r * 0.62, 0, 0), (r, 0.004, 0.004, 0, 0)]
    lathe_ring(ctx['mesh'], Vector((0, y, z)), (0, 1, 0), rows, 9 if ctx['lod'] == 0 else 6, 'hair', w)


def low_bun(ctx, r=0.05):
    """A bun at the nape of the neck."""
    if ctx['lod'] == 2:
        return
    w = Weighter(['head', 'neck'], soft=0.03)
    rows = [(-r, 0.004, 0.004, 0, 0), (-r * 0.75, r * 0.8, r * 0.72, 0, 0), (-r * 0.2, r * 1.0, r * 0.95, 0, 0), (r * 0.45, r * 0.9, r * 0.8, 0, 0), (r, 0.004, 0.004, 0, 0)]
    lathe_ring(ctx['mesh'], Vector((0, 1.585, -0.1)), Vector((0, 0.2, -1.0)).normalized(), rows, 9 if ctx['lod'] == 0 else 6, 'hair', w, fwd=(0, 1, 0))


def locs_bundle(ctx):
    """Kudzu's locs, tied back: a thick bundle from the crown down the back of the head, and a few loose at the nape and the sides."""
    if ctx['lod'] == 2:
        return
    w = Weighter(['head', 'neck'], soft=0.03)
    lod = ctx['lod']
    n = 6 if lod == 0 else 5
    count = 5 if lod == 0 else 3
    for k in range(count):
        a = (k - (count - 1) / 2) * 0.55
        x = math.sin(a) * 0.034
        r = 0.0125
        L = 0.17 + 0.03 * ((k * 3) % 3)
        O = Vector((x, 1.70, -0.085 - 0.012 * math.cos(a)))
        A = Vector((x * 0.9, -0.55, -0.83)).normalized()
        rows = [(0.0, r * 0.9, r * 0.9, 0, 0), (0.02, r, r, 0, 0), (L * 0.6, r * 0.95, r * 0.95, 0, -0.01), (L * 0.97, r * 0.8, r * 0.8, 0, -0.02), (L, 0.003, 0.003, 0, -0.025)]
        lathe_ring(ctx['mesh'], O, A, rows, n, 'hair', w)
    # the tie
    rows = [(-0.012, 0.043, 0.043, 0, 0), (0.012, 0.043, 0.043, 0, 0)]
    O = Vector((0, 1.69, -0.1))
    A = Vector((0, -0.55, -0.83)).normalized()
    lathe_ring(ctx['mesh'], O, A, rows, 8 if lod == 0 else 6, 'trim', w)
    # loose locs below the tie and round the ears, of different lengths
    spec = ctx['arch'].head
    for th, y0, L, push in ((2.9, 1.64, 0.2, 0.034), (-2.9, 1.64, 0.17, 0.03), (2.45, 1.65, 0.15, 0.03), (-2.45, 1.65, 0.19, 0.034), (3.1416, 1.62, 0.15, 0.028), (1.95, 1.66, 0.09, 0.02), (-1.95, 1.66, 0.11, 0.02)):
        if lod == 1 and abs(th) < 2.0:
            continue
        strand(ctx['mesh'], spec, lod, y0, th, L, 0.0105, push=push, taper=0.55, hold=0.5)


def braids(ctx, count=9, length=0.3, radius=0.0085, y0=1.665, arc=(1.5, 3.0), push=0.036, sway=0.0):
    """Box braids: ropes of hair from the crown's back half, hanging to the shoulders."""
    if ctx['lod'] == 2:
        return
    spec = ctx['arch'].head
    n = count if ctx['lod'] == 0 else 2
    lo, hi = arc
    for i in range(n):
        f = 0.5 if n == 1 else i / (n - 1)
        th = lo + (hi - lo) * f
        for sgn in ((1, -1) if th < 3.1 else (1,)):
            y = y0 + 0.02 * (1 - abs(f - 0.5) * 2)
            L = length * (0.78 + 0.22 * (((i * 5) % 3) / 2.0))
            strand(ctx['mesh'], spec, ctx['lod'], y, sgn * th, L, radius, push=push + 0.012 * (i % 2), taper=0.5, hold=0.5, wave=0.004 * (1 if i % 2 else -1), sway=sway * (1 if sgn > 0 else -1))


def pigtail_braids(ctx, length=0.34, radius=0.017):
    """Two thick plaits, one each side of the neck, tied at the ends."""
    spec = ctx['arch'].head
    for sgn in (1, -1):
        strand(ctx['mesh'], spec, ctx['lod'], 1.672, sgn * 1.95, length, radius, push=0.062, taper=0.4, hold=0.3, wave=0.012 * sgn, sides=7 if ctx['lod'] == 0 else 5, sway=0.015 * sgn)


# ================================================================ the archetypes
# ---- Keon "Kudzu" Mabry: a canvas work jacket, jeans, work boots, locs tied back ----
def _kudzu_torso(b):
    return [pants_torso(0.885, 0.011), Layer(0.885, 1.495, 'top', jacket_thick(0.012, 0.009, 1.12, 1.3)), Layer(1.495, 1.565, 'top2', 0.012, hem1=False)]


def _kudzu_extras(ctx):
    boots(ctx)
    locs_bundle(ctx)
    ctx['jacket'] = True


kudzu = reg(Arch(
    'kudzu', B.MALE_LEAN,
    HeadSpec(hair='locs', hair_th=0.013, hair_fade=0.62, fade_cover=0.75, beard=0.006, beard_zone='full', jaw=1.02),
    torso_layers=_kudzu_torso, arm_layers=long_sleeves(0.012, 0.011), leg_layers=lambda b, s: jeans(b, s, 0.9, 0.012),
    shoe=dict(style='boot'), extras=(_kudzu_extras,),
    palette=dict(skin=0x5e3b27, hair=0x120d0a, top=0x7a5f3c, top2=0x3b2e22, bottom=0x2a3446, shoe=0x5a3d22, sole=0x2a2520, trim=0x888878, stubble=0x2a1e17),
))


# ---- business: a suit, shirt and tie ----
def _suit_torso(b):
    return [pants_torso(0.93, 0.010), Layer(0.93, 1.495, 'top', jacket_thick(0.016, 0.004, 1.12)), Layer(1.495, 1.56, 'top2', 0.010, hem1=False)]


suit_m = reg(Arch(
    'suit_m', B.MALE_AVG, HeadSpec(hair='short', hair_th=0.012, hair_fade=0.8, fade_cover=0.6, quiff=0.007, beard=0.0),
    torso_layers=_suit_torso, arm_layers=long_sleeves(0.014, 0.010), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.004, 0.009),
    torso_masks=(v_neck('top2', 1.495, 1.27, 2.0, 0.22), tie), shoe=dict(style='dress', upper='shoe', sole='shoe'),
    extras=(lambda ctx: ctx.update(jacket=True),),
    palette=dict(skin=0x8a5d3e, hair=0x15110e, top=0x1f2a3d, top2=0xdfe3e8, bottom=0x1f2a3d, shoe=0x16120f, trim=0x7a1e2c),
))


def _office_torso(b):
    return [Layer(0.99, 1.495, 'top', jacket_thick(0.012, 0.0, 1.12)), Layer(1.495, 1.56, 'top2', 0.008, hem1=False)]


def _office_extras(ctx):
    skirt(ctx, 1.07, 0.52, hip=0.0, hem_rx=0.2, hem_rz=0.165, thick=0.008)
    low_bun(ctx)


office_f = reg(Arch(
    'office_f', B.FEM_AVG, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.5, beard=0.0, brow=True),
    torso_layers=_office_torso, arm_layers=long_sleeves(0.011, 0.007), leg_layers=lambda b, s: [],
    torso_masks=(v_neck('top2', 1.495, 1.30, 1.6, 0.2),), shoe=dict(style='dress', upper='shoe', sole='shoe'),
    extras=(_office_extras,),
    palette=dict(skin=0xa06f4a, hair=0x2a1c12, top=0x3a3d45, top2=0xe8e2d8, bottom=0x3a3d45, shoe=0x241a16),
))


# ---- casual ----
def _tee_torso(b, hem=0.90, thick=0.009):
    return [pants_torso(hem, 0.010), Layer(hem, 1.495, 'top', lambda t: thick + 0.003 * sstep(1.2, 1.35, t), hem0=True), Layer(1.495, 1.53, 'top2', 0.005, hem1=False)]


def _casual_m_extras(cap=None):
    def f(ctx):
        if cap:
            cap_extra(ctx, cap)
    return f


casual_m = reg(Arch(
    'casual_m', B.MALE_AVG, HeadSpec(hair='short', hair_th=0.014, hair_fade=0.82, fade_cover=0.55, beard=0.006, quiff=0.004),
    torso_layers=_tee_torso, arm_layers=tee_sleeves(0.17), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.006, 0.010),
    shoe=dict(style='sneaker'), extras=(),
    palette=dict(skin=0x8a5d3e, hair=0x15110e, top=0x9c3b30, top2=0xe9e5dc, bottom=0x38414f, shoe=0xd8d4cc),
))
casual_m_cap = reg(Arch(
    'casual_m_cap', B.MALE_AVG, HeadSpec(hair='short', hair_th=0.010, hair_fade=0.4, beard=0.0),
    torso_layers=_tee_torso, arm_layers=tee_sleeves(0.17), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.006, 0.010),
    shoe=dict(style='sneaker'), extras=(_casual_m_extras('cap'),),
    palette=dict(skin=0x8a5d3e, hair=0x15110e, top=0x9c3b30, top2=0xe9e5dc, bottom=0x38414f, shoe=0xd8d4cc),
))


def _fem_tee(b):
    return [pants_torso(0.93, 0.007), Layer(0.93, 1.495, 'top', lambda t: 0.006 + 0.002 * sstep(1.2, 1.35, t), hem0=True), Layer(1.495, 1.53, 'top2', 0.004, hem1=False)]


casual_f = reg(Arch(
    'casual_f', B.FEM_AVG, HeadSpec(hair='short', hair_th=0.012, hair_fade=0.3, beard=0.0),
    torso_layers=_fem_tee, arm_layers=tee_sleeves(0.15, 0.008), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.0, 0.006),
    shoe=dict(style='sneaker', size=0.93), extras=(lambda ctx: long_hair(ctx, 1.38, 1.0, 0.0),),
    palette=dict(skin=0xb98560, hair=0x2a1c12, top=0x4f7d6a, top2=0xe4ddd0, bottom=0x2c3644, shoe=0x2a2724),
))


def _hoodie_torso(b):
    return [pants_torso(0.88, 0.011), Layer(0.88, 0.925, 'top2', 0.020, hem0=True), Layer(0.925, 1.497, 'top', lambda t: 0.021 + 0.004 * sstep(1.25, 1.4, t), hem0=True), Layer(1.497, 1.53, 'top2', 0.008, hem1=False)]


def _hood(ctx):
    m = ctx['mesh']
    w = W_NECK
    if ctx['lod'] == 2:
        return
    rows = [(0.0, 0.074, 0.058, 0, -0.04), (0.03, 0.098, 0.085, 0, -0.045), (0.06, 0.090, 0.08, 0, -0.05), (0.095, 0.06, 0.055, 0, -0.04)]
    lathe_ring(m, Vector((0, 1.43, 0)), (0, 1, 0), rows, 10 if ctx['lod'] == 0 else 7, 'top', w)


def _hoodie_extras(cap=None):
    def f(ctx):
        _hood(ctx)
        ctx['jacket'] = True
        if cap:
            cap_extra(ctx, cap)
    return f


hoodie_m = reg(Arch(
    'hoodie_m', B.MALE_LEAN, HeadSpec(hair='short', hair_th=0.03, hair_fade=0.86, fade_cover=0.7, flat=1.79, crown=0.012, beard=0.0, jaw=1.0),
    torso_layers=_hoodie_torso, arm_layers=long_sleeves(0.020, 0.012), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.004, 0.012),
    shoe=dict(style='sneaker'), extras=(_hoodie_extras(None),),
    palette=dict(skin=0x6f4630, hair=0x15110e, top=0x555b66, top2=0x3c4048, bottom=0x2c3140, shoe=0xe8e6e0),
))
hoodie_m_beanie = reg(Arch(
    'hoodie_m_beanie', B.MALE_LEAN, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.5, beard=0.0, jaw=1.0),
    torso_layers=_hoodie_torso, arm_layers=long_sleeves(0.020, 0.012), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.004, 0.012),
    shoe=dict(style='sneaker'), extras=(_hoodie_extras('beanie'),),
    palette=dict(skin=0x6f4630, hair=0x15110e, top=0x555b66, top2=0x3c4048, bottom=0x2c3140, shoe=0xe8e6e0, hat=0x2b3a55),
))


# ---- dresses and sweatshirts ----
def _dress_torso(b):
    return [Layer(0.92, 1.405, 'top', lambda t: 0.005, hem0=False, hem1=True)]


def _dress_extras(ctx):
    skirt(ctx, 1.06, 0.40, hip=0.0, hem_rx=0.235, hem_rz=0.20, thick=0.005)
    # straps
    if ctx['lod'] <= 1:
        for sx in (-1, 1):
            add_weighted(ctx['mesh'], W_CHEST, lambda sx=sx: ctx['mesh'].box((sx * 0.062, 1.44, 0.0), (0.028, 0.07, 0.19), 'top', bevel=0.004))


dress_f = reg(Arch(
    'dress_f', B.FEM_SLIM, HeadSpec(hair='afro', hair_th=0.03, crown=0.034, back=0.012),
    torso_layers=_dress_torso, arm_layers=lambda b, s: [], leg_layers=lambda b, s: [],
    shoe=dict(style='dress', upper='shoe', sole='shoe'), extras=(_dress_extras,),
    palette=dict(skin=0x6f4630, hair=0x15110e, top=0x7b1f3c, top2=0xd9c5a8, bottom=0x7b1f3c, shoe=0x17120f),
))


def _student_torso(b):
    return [pants_torso(0.93, 0.005), Layer(0.93, 1.495, 'top', lambda t: 0.018 + 0.004 * sstep(1.25, 1.4, t), hem0=True), Layer(1.495, 1.54, 'top2', 0.010, hem1=False)]


student_f = reg(Arch(
    'student_f', B.FEM_SLIM, HeadSpec(hair='short', hair_th=0.014, hair_fade=0.2),
    torso_layers=_student_torso, arm_layers=long_sleeves(0.016, 0.009), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.0, 0.004),
    shoe=dict(style='sneaker', size=0.93), extras=(lambda ctx: (backpack(ctx, (0.27, 0.34, 0.13), 1.28), pigtail_braids(ctx, 0.3, 0.016)),),
    palette=dict(skin=0x84583a, hair=0x15110e, top=0x8a3b4d, top2=0xe6d9cc, bottom=0x2d3646, shoe=0xf0eee8, gear=0x2f5d6a),
))


# ---- work and travel ----
def _worker_torso(b):
    return [pants_torso(0.93, 0.013), Layer(0.93, 1.495, 'trim', lambda t: 0.020 + 0.004 * sstep(1.25, 1.4, t), hem0=True), Layer(1.495, 1.54, 'top', 0.008, hem1=False)]


worker_m = reg(Arch(
    'worker_m', B.MALE_STOCKY, HeadSpec(hair='short', hair_th=0.010, hair_fade=0.6, beard=0.0),
    torso_layers=_worker_torso, arm_layers=long_sleeves(0.014, 0.010, 'top'), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.004, 0.014),
    torso_masks=(stripes([(1.10, 1.135), (1.285, 1.32)], 'top2', (0.3, 0.62)),),
    shoe=dict(style='boot'), extras=(lambda ctx: (boots(ctx, 0.70), cap_extra(ctx, 'hardhat'), ctx.update(jacket=True)),),
    palette=dict(skin=0xa06f4a, hair=0x2a1c12, top=0x3d4a38, top2=0xc9ccd0, bottom=0x4a4235, shoe=0x4c3a24, trim=0xd6e04a, hat=0xe8e4dc),
))


def _tourist_torso(b):
    return [pants_torso(0.92, 0.010), Layer(0.92, 1.495, 'top', lambda t: 0.011 + 0.004 * sstep(1.2, 1.4, t), hem0=True), Layer(1.495, 1.535, 'top2', 0.006, hem1=False)]


tourist_m = reg(Arch(
    'tourist_m', B.MALE_STOCKY, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.4, beard=0.0),
    torso_layers=_tourist_torso, arm_layers=tee_sleeves(0.18, 0.012), leg_layers=lambda b, s: [Layer(0.0, 0.44, 'bottom', lambda t: 0.012 + 0.012 * sstep(0.2, 0.44, t), hem0=False)],
    shoe=dict(style='sneaker'), extras=(lambda ctx: (cap_extra(ctx, 'cap'), backpack(ctx, (0.26, 0.30, 0.12), 1.26, pocket=False), ctx.update(jacket=True)),),
    palette=dict(skin=0xe3b794, hair=0x4a3020, top=0x4a86a8, top2=0xe9e4d6, bottom=0xb8a98a, shoe=0xe4e2dc, hat=0xd9d4c4, gear=0x30343a),
))


# ---- layers: warm clothes worn one over the other, a pack, a hat ----
def _layers_m_torso(b):
    return [pants_torso(0.84, 0.020), Layer(0.84, 0.90, 'top2', 0.024, hem0=True), Layer(0.90, 1.497, 'top', lambda t: 0.028 + 0.006 * sstep(1.25, 1.4, t), hem0=True), Layer(1.497, 1.545, 'top2', 0.014, hem1=False)]


layers_m = reg(Arch(
    'layers_m', B.MALE_AVG, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.4, beard=0.016, beard_zone='full'),
    torso_layers=_layers_m_torso, arm_layers=long_sleeves(0.024, 0.014), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.012, 0.016),
    shoe=dict(style='sneaker'), extras=(lambda ctx: (_hood(ctx), cap_extra(ctx, 'beanie'), backpack(ctx, (0.34, 0.46, 0.17), 1.25), ctx.update(jacket=True)),),
    palette=dict(skin=0x6f4630, hair=0x2a1c12, top=0x4c5a47, top2=0x6a6258, bottom=0x4a4a42, shoe=0x3a3630, hat=0x2a2f38, gear=0x35402e),
))


def _coat_torso(b):
    return [Layer(0.99, 1.497, 'top', lambda t: 0.022 + 0.004 * sstep(1.25, 1.4, t), hem0=True), Layer(1.497, 1.56, 'top2', 0.016, hem1=False)]


def _layers_f_extras(ctx):
    skirt(ctx, 1.06, 0.50, hip=0.0, hem_rx=0.215, hem_rz=0.17, thick=0.020)
    cap_extra(ctx, 'beanie')
    m = ctx['mesh']
    if ctx['lod'] <= 1:
        add_weighted(m, W_PELVIS, lambda: m.box((-0.215, 0.92, 0.0), (0.07, 0.30, 0.26), 'gear', bevel=0.03))
        add_weighted(m, W_CHEST, lambda: m.box((0.055, 1.30, 0.0), (0.03, 0.04, 0.20), 'gear', rot=(0.0, 0.0, 0.0)))


layers_f = reg(Arch(
    'layers_f', B.FEM_AVG, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.3),
    torso_layers=_coat_torso, arm_layers=long_sleeves(0.020, 0.012), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.0, 0.008),
    shoe=dict(style='boot'), extras=(_layers_f_extras, lambda ctx: boots(ctx, 0.74), lambda ctx: braids(ctx, 4, 0.26, 0.009, 1.62, (1.9, 3.0), 0.04)),
    palette=dict(skin=0xb98560, hair=0x4a3020, top=0x6a5a4a, top2=0x8a7d70, bottom=0x2f333a, shoe=0x3a342e, hat=0x5a4a6a, gear=0x6a4a3a),
))


# ---- the law ----
def _officer_torso(b):
    return [pants_torso(0.97, 0.012, 'bottom'), Layer(0.97, 1.497, 'top', lambda t: 0.012 + 0.003 * sstep(1.25, 1.4, t), hem0=True), Layer(1.497, 1.54, 'top', 0.008, hem1=False)]


def _officer_extras(ctx):
    boots(ctx, 0.72)
    m = ctx['mesh']
    ctx['jacket'] = True
    belt(ctx, 1.005, 'belt', 0.014)
    b = ctx['build']
    if ctx['lod'] <= 1:
        add_weighted(m, W_PELVIS, lambda: m.box((-0.165, 0.97, 0.03), (0.06, 0.20, 0.10), 'gear', bevel=0.012))      # holster
        add_weighted(m, W_PELVIS, lambda: m.box((0.165, 0.99, 0.0), (0.055, 0.14, 0.04), 'gear', bevel=0.008))      # radio, cuffs
        add_weighted(m, W_CHEST, lambda: m.box((0.07, 1.285, 0.128 * b.depth + 0.02), (0.045, 0.055, 0.010), 'trim', bevel=0.003))   # badge
        add_weighted(m, W_CHEST, lambda: m.box((-0.08, 1.38, 0.125 * b.depth + 0.02), (0.05, 0.12, 0.05), 'gear', bevel=0.008))     # radio
    cap_extra(ctx, 'police')


officer_m = reg(Arch(
    'officer_m', B.MALE_AVG, HeadSpec(hair='short', hair_th=0.010, hair_fade=0.6, beard=0.0),
    torso_layers=_officer_torso, arm_layers=long_sleeves(0.012, 0.0, 'top'), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.004, 0.010),
    shoe=dict(style='boot'), extras=(_officer_extras,),
    palette=dict(skin=0x8a5d3e, hair=0x15110e, top=0x2d4a7a, top2=0x24324f, bottom=0x1d2a45, shoe=0x14120f, hat=0x1d2a45, gear=0x111214, trim=0xb9b27a),
))
officer_f = reg(Arch(
    'officer_f', B.FEM_AVG, HeadSpec(hair='short', hair_th=0.011, hair_fade=0.3, beard=0.0),
    torso_layers=_officer_torso, arm_layers=long_sleeves(0.011, 0.0, 'top'), leg_layers=lambda b, s: jeans(b, s, 0.915, 0.0, 0.008),
    shoe=dict(style='boot', size=0.95), extras=(_officer_extras, lambda ctx: bun(ctx, 1.665, -0.095, 0.04)),
    palette=dict(skin=0xb98560, hair=0x2a1c12, top=0x2d4a7a, top2=0x24324f, bottom=0x1d2a45, shoe=0x14120f, hat=0x1d2a45, gear=0x111214, trim=0xb9b27a),
))
