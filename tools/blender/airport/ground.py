"""The airside vehicles (ac-ground.glb): each a top-level node at the origin holding `<name>_lod0` and `<name>_lod1`, sized to
src/shared/data/aircraft.json `ground`. Generic interpretations, no makers' marks or lettering.

Frame: metres, +X the vehicle's left, +Y up, +Z forward; origin on the ground at the middle of the rear axle.

  tug             a low towbarless pushback tractor: a deck, two front pods with the nose-wheel cradle between them, the
                  operator's cab at the left rear; `tug_hitch` (an empty under `tug`) is the cradle, z = aircraft.json hitchZ
  baggageTractor  a small tug with a hood, an open seat under a canopy roof and a pin hitch at the back
  baggageCart     an open-sided dolly with a canopy roof on four posts and a drawbar at the front
  beltLoader      a chassis carrying the inclined conveyor (low end at the back, high end at the front), its handrails,
                  the driver's seat on the left

Materials as the aircraft (ac_kit.py): the body is `ac_paint` region 0 (the game tints it per operator), frames `ac_grey`,
`ac_metal`, tyres and rubber `ac_dark`, cab glass `ac_window`, beacons `ac_light` (amber, COLOR_0).
"""
import json
import math
import os

from hoodlib import scene
from . import ac_kit as K
from .ac_kit import Geo, bake_ao, box, emit, hexa, lathe, paint, srgb, tube

VERTEX_COLOR = 'ACTIVE'

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DATA = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'aircraft.json')))
GD = DATA['ground']
PARTS = ['tug', 'baggageTractor', 'baggageCart', 'beltLoader']

BODY = paint('crown')
GREY = srgb(0x8f9399)
GREY_DK = srgb(0x55595e)
METAL = srgb(0xb8bcc1)
RUBBER = srgb(0x1c1c1e)
TYRE = srgb(0x1b1b1d)
HUB = srgb(0x9a9ea4)
GLASS = srgb(0x10161c)
SEAT = srgb(0x2a2b2e)
BELT = srgb(0x202122)
AMBER = srgb(0xffa010)
WHITE = (1.0, 1.0, 1.0)


def wheel(g, c, r, w, lod, side=1):
    """A wheel on an axle along X at c."""
    n = 10 if lod == 0 else 6
    hw = w / 2
    if lod == 0:
        prof = [(0.0, -hw * 0.75), (r * 0.6, -hw * 0.75), (r, -hw * 0.55), (r, hw * 0.55), (r * 0.6, hw * 0.75), (0.0, hw * 0.75)]
        mats = [('ac_metal', HUB), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_dark', TYRE), ('ac_metal', HUB)]
    else:
        prof = [(0.0, -hw), (r, -hw), (r, hw), (0.0, hw)]
        mats = [('ac_dark', TYRE)] * 3
    lathe(g, c, (1.0, 0.0, 0.0), prof, n, mats, crease=30.0, phase=-math.pi / 2)


def beacon(g, p, lod):
    if lod == 0:
        lathe(g, p, (0.0, 1.0, 0.0), [(0.0, 0.0), (0.07, 0.0), (0.07, 0.065), (0.045, 0.11), (0.0, 0.12)], 6, [('ac_dark', RUBBER), ('ac_light', AMBER), ('ac_light', AMBER), ('ac_light', AMBER)])
    else:
        box(g, 'ac_light', (p[0] - 0.06, p[1], p[2] - 0.06), (p[0] + 0.06, p[1] + 0.12, p[2] + 0.06), AMBER)


def wedge_box(g, mat, x0, x1, profile, col):
    """A side profile of (z, y) points (a closed polygon) extruded across x0..x1 (cabs, hoods)."""
    n = len(profile)
    a = 0.0
    for i in range(n):
        (z0, y0), (z1, y1) = profile[i], profile[(i + 1) % n]
        a += z0 * y1 - z1 * y0
    s = 1.0 if a > 0 else -1.0
    for i in range(n):
        (z0, y0), (z1, y1) = profile[i], profile[(i + 1) % n]
        out = (0.0, -(z1 - z0) * s, (y1 - y0) * s)
        g.poly(mat, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)], col, hint=out)
    g.poly(mat, [(x0, y, z) for z, y in profile], col, hint=(-1.0, 0.0, 0.0))
    g.poly(mat, [(x1, y, z) for z, y in profile], col, hint=(1.0, 0.0, 0.0))


# ------------------------------------------------------------------------------------------- the vehicles
def tug(lod):
    d = GD['tug']
    L, W, H, hz = d['length'], d['width'], d['height'], d['hitchZ']
    g = Geo()
    hw = W / 2
    z0, z1 = -1.2, L - 1.2            # rear and front faces
    r = 0.4
    zf = 3.95                          # front axle
    slot = 0.62                        # half width of the cradle slot between the front pods
    deck = 0.98
    lo_w = hw - 0.5                    # the lower hull runs between the wheels
    # rear deck (full width over the wheels, a narrower hull under it) up to the slot, and the two front pods either side of it
    box(g, 'ac_paint', (-hw, 0.84, z0 + 0.12), (hw, deck, 2.55), BODY)
    box(g, 'ac_paint', (-lo_w, 0.3, z0 + 0.12), (lo_w, 0.84, 2.55), BODY, skip=('+y',))
    for s in (1, -1):
        xa, xb = sorted((s * slot, s * hw))
        box(g, 'ac_paint', (xa, 0.84, 2.55), (xb, deck, z1 - 0.12), BODY, skip=('-z',))
        xa, xb = sorted((s * slot, s * lo_w))
        box(g, 'ac_paint', (xa, 0.3, 2.55), (xb, 0.84, z1 - 0.12), BODY, skip=('-z', '+y'))
        # wheel arches: dark boxes behind the wheels
        for zc in (0.0, zf):
            xa, xb = sorted((s * lo_w, s * (hw - 0.04)))
            box(g, 'ac_dark', (xa, 0.83, zc - 0.5), (xb, 0.845, zc + 0.5), RUBBER, skip=('+y',))
    # bumpers (rubber) at both ends
    box(g, 'ac_dark', (-hw + 0.05, 0.36, z0), (hw - 0.05, 0.7, z0 + 0.12), RUBBER)
    for s in (1, -1):
        xa, xb = sorted((s * (slot + 0.04), s * (hw - 0.05)))
        box(g, 'ac_dark', (xa, 0.36, z1 - 0.12), (xb, 0.7, z1), RUBBER)
    # the cradle in the slot: a low dark platform and its clamp arms
    box(g, 'ac_grey', (-slot, 0.12, hz - 0.75), (slot, 0.3, z1 - 0.3), GREY_DK)
    if lod == 0:
        for s in (1, -1):
            box(g, 'ac_metal', (s * slot - (0.08 if s > 0 else -0.0), 0.3, hz - 0.15), (s * slot + (0.0 if s > 0 else 0.08), 0.75, hz + 0.15), METAL)
        box(g, 'ac_metal', (-slot, 0.3, hz - 0.85), (slot, 0.62, hz - 0.65), METAL)
    # the cab: left rear, a sloped glass front
    cx0, cx1 = 0.15, hw - 0.08
    Hc = H - 0.12
    prof = [(z0 + 0.3, deck), (0.95, deck), (0.85, Hc - 0.12), (0.6, Hc), (z0 + 0.45, Hc), (z0 + 0.3, Hc - 0.1)]
    wedge_box(g, 'ac_paint', cx0, cx1, prof, BODY)
    if lod == 0:
        # glass on the cab's front and sides, just proud of its faces
        g.poly('ac_window', [(cx0 + 0.08, deck + 0.2, 0.946), (cx1 - 0.08, deck + 0.2, 0.946), (cx1 - 0.08, Hc - 0.16, 0.852), (cx0 + 0.08, Hc - 0.16, 0.852)], GLASS, hint=(0.0, 0.3, 1.0))
        for x, h in ((cx1 + 0.006, 1.0), (cx0 - 0.006, -1.0)):
            g.poly('ac_window', [(x, deck + 0.2, z0 + 0.6), (x, deck + 0.2, 0.8), (x, Hc - 0.16, 0.66), (x, Hc - 0.16, z0 + 0.6)], GLASS, hint=(h, 0.0, 0.0))
        # the engine cover's grille and a step
        box(g, 'ac_dark', (-hw + 0.25, deck, z0 + 0.35), (-0.15, deck + 0.04, 0.9), GREY_DK)
    beacon(g, ((cx0 + cx1) / 2, Hc, (z0 + 0.45 + 0.6) / 2), lod)
    # wheels: rear pair and the front pair in the pods
    for s in (1, -1):
        for zc in (0.0, zf):
            wheel(g, (s * (hw - 0.25), r, zc), r, 0.38, lod)
    return g


def baggage_tractor(lod):
    d = GD['baggageTractor']
    L, W, H = d['length'], d['width'], d['height']
    g = Geo()
    hw = W / 2
    z0, z1 = -0.42, L - 0.42
    r = 0.3
    zf = 1.75
    # chassis and the hood over the engine at the front
    box(g, 'ac_grey', (-hw + 0.12, 0.22, z0 + 0.05), (hw - 0.12, 0.42, z1 - 0.05), GREY_DK)
    wedge_box(g, 'ac_paint', -hw + 0.04, hw - 0.04, [(1.05, 0.42), (z1, 0.42), (z1, 0.88), (z1 - 0.15, 1.0), (1.05, 1.06)], BODY)
    # the rear body under the seat, with the fenders
    box(g, 'ac_paint', (-hw + 0.04, 0.42, z0), (hw - 0.04, 0.78, 1.05), BODY)
    # seat, steering column and wheel, the dash
    box(g, 'ac_dark', (-0.42, 0.78, 0.05), (0.42, 0.9, 0.55), SEAT)
    box(g, 'ac_dark', (-0.42, 0.9, 0.0), (0.42, 1.35, 0.1), SEAT)
    tube(g, 'ac_metal', (0.0, 1.0, 1.05), (0.0, 1.3, 0.85), 0.025, 5, METAL)
    if lod == 0:
        lathe(g, (0.0, 1.31, 0.84), (0.0, 0.83, -0.55), [(0.0, 0.0), (0.17, 0.0), (0.17, 0.03), (0.0, 0.03)], 8, [('ac_dark', RUBBER)] * 3)
        box(g, 'ac_dark', (-hw + 0.1, 1.06, 1.05), (hw - 0.1, 1.12, 1.12), RUBBER)
        # headlamps and the pin hitch at the back
        for s in (1, -1):
            box(g, 'ac_light', (s * 0.45 - 0.07, 0.78, z1 - 0.01), (s * 0.45 + 0.07, 0.86, z1 + 0.01), WHITE)
    box(g, 'ac_metal', (-0.1, 0.32, z0 - 0.16), (0.1, 0.4, z0), METAL)
    box(g, 'ac_dark', (-hw + 0.05, 0.28, z0 - 0.06), (hw - 0.05, 0.5, z0), RUBBER)
    # canopy: four posts and a roof
    posts = [(hw - 0.08, -0.4), (-hw + 0.08, -0.4), (hw - 0.08, 1.0), (-hw + 0.08, 1.0)]
    for x, z in posts:
        box(g, 'ac_grey', (x - 0.03, 0.78 if z < 0 else 1.0, z - 0.03), (x + 0.03, H - 0.18, z + 0.03), GREY_DK)
    box(g, 'ac_paint', (-hw + 0.02, H - 0.18, -0.48), (hw - 0.02, H - 0.12, 1.08), BODY)
    beacon(g, (0.0, H - 0.12, 0.3), lod)
    for s in (1, -1):
        for zc in (0.0, zf):
            wheel(g, (s * (hw - 0.17), r, zc), r, 0.24, lod)
    return g


def baggage_cart(lod):
    d = GD['baggageCart']
    L, W, H = d['length'], d['width'], d['height']
    g = Geo()
    hw = W / 2
    r = 0.2
    zb0, zb1 = -0.45, 2.15          # the bed
    zf = 1.7                         # front axle (on its turntable)
    deck = 0.5
    # bed: a frame and the deck
    box(g, 'ac_grey', (-hw + 0.05, deck - 0.12, zb0), (hw - 0.05, deck, zb1), GREY)
    box(g, 'ac_dark', (-0.25, r + 0.02, zf - 0.25), (0.25, deck - 0.12, zf + 0.25), RUBBER)
    # end frames (the back closed, the front open with a rail), corner posts and the canopy roof
    box(g, 'ac_paint', (-hw + 0.05, deck, zb0), (hw - 0.05, H - 0.15, zb0 + 0.05), BODY)
    for x in (hw - 0.05, -hw + 0.05):
        for z in (zb0 + 0.02, zb1 - 0.02):
            box(g, 'ac_paint', (x - 0.03, deck, z - 0.03), (x + 0.03, H - 0.1, z + 0.03), BODY)
    if lod == 0:
        box(g, 'ac_paint', (-hw + 0.05, deck + 0.35, zb1 - 0.05), (hw - 0.05, deck + 0.42, zb1), BODY)
        # side rails at mid height
        for x in (hw - 0.05, -hw + 0.05):
            box(g, 'ac_metal', (x - 0.02, deck + 0.38, zb0), (x + 0.02, deck + 0.42, zb1), METAL)
    roof = [(zb0 - 0.05, H - 0.1), (zb1 + 0.05, H - 0.1), (zb1 + 0.05, H - 0.04), ((zb0 + zb1) / 2, H), (zb0 - 0.05, H - 0.04)]
    wedge_box(g, 'ac_paint', -hw, hw, roof, BODY)
    # drawbar to the front
    zd = L - 0.45
    tube(g, 'ac_metal', (0.0, r + 0.08, zb1 - 0.3), (0.0, 0.35, zd), 0.035, 5, METAL)
    box(g, 'ac_metal', (-0.08, 0.3, zd - 0.06), (0.08, 0.4, zd), METAL)
    for s in (1, -1):
        for zc in (0.0, zf):
            wheel(g, (s * (hw - 0.22), r, zc), r, 0.14, lod)
    return g


def belt_loader(lod):
    d = GD['beltLoader']
    L, W, H = d['length'], d['width'], d['height']
    g = Geo()
    hw = W / 2
    z0, z1 = -1.1, L - 1.1
    r = 0.32
    zf = 4.6
    # chassis
    box(g, 'ac_paint', (-hw + 0.25, 0.3, z0 + 0.6), (hw - 0.25, 0.6, zf + 0.6), BODY)
    # the driver's position on the left, clear of the conveyor: seat, console
    box(g, 'ac_paint', (0.55, 0.6, 1.6), (hw - 0.02, 0.9, 2.7), BODY)
    box(g, 'ac_dark', (0.62, 0.9, 1.8), (hw - 0.1, 1.0, 2.25), SEAT)
    box(g, 'ac_dark', (0.62, 1.0, 1.75), (hw - 0.1, 1.38, 1.84), SEAT)
    box(g, 'ac_grey', (0.65, 0.9, 2.45), (hw - 0.1, 1.2, 2.62), GREY_DK)
    if lod == 0:
        tube(g, 'ac_metal', (0.85, 1.2, 2.5), (0.85, 1.32, 2.35), 0.02, 5, METAL)
    # the conveyor: a frame from the low back end to the high front end, the belt on top, handrails each side
    a = (z0, 0.86)
    b = (z1, H - 0.5)
    cw = 0.42                        # half width of the frame
    t = 0.2                          # frame depth
    ln = math.hypot(b[0] - a[0], b[1] - a[1])
    uz, uy = (b[0] - a[0]) / ln, (b[1] - a[1]) / ln
    nz, ny = -uy, uz
    # frame as a hexahedron (bottom ring then top ring along X)
    A0, A1, B0, B1 = (a[0], a[1]), (a[0] + nz * -t, a[1] + ny * -t), (b[0], b[1]), (b[0] + nz * -t, b[1] + ny * -t)
    c8 = [(-cw, A1[1], A1[0]), (cw, A1[1], A1[0]), (cw, B1[1], B1[0]), (-cw, B1[1], B1[0]),
          (-cw, A0[1], A0[0]), (cw, A0[1], A0[0]), (cw, B0[1], B0[0]), (-cw, B0[1], B0[0])]
    hexa(g, 'ac_paint', c8, BODY)
    # the belt, a dark band just over the frame's top, and its end rollers
    e = 0.012
    bw = cw - 0.06
    g.poly('ac_dark', [(-bw, a[1] + ny * e, a[0] + nz * e), (bw, a[1] + ny * e, a[0] + nz * e), (bw, b[1] + ny * e, b[0] + nz * e), (-bw, b[1] + ny * e, b[0] + nz * e)], BELT, hint=(0.0, ny, nz))
    # the boom's support under the front, the rear ramp foot
    box(g, 'ac_grey', (-0.18, 0.68, zf - 0.2), (0.18, (a[1] + (b[1] - a[1]) * ((zf - a[0]) / (b[0] - a[0]))) - 0.15, zf + 0.2), GREY_DK)
    box(g, 'ac_grey', (-0.15, 0.3, z0 + 0.2), (0.15, 0.6, z0 + 0.6), GREY_DK)
    # handrails: posts and a top rail each side
    np_ = 5 if lod == 0 else 2
    for s in (1, -1):
        x = s * (cw + 0.03)
        pts = []
        for k in range(np_):
            u = 0.12 + 0.8 * k / (np_ - 1)
            zz, yy = a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u
            top = (x, yy + 0.48, zz)
            box(g, 'ac_metal', (x - 0.02, yy, zz - 0.02), (x + 0.02, yy + 0.48, zz + 0.02), METAL, skip=('+y', '-y'))
            pts.append(top)
        tube(g, 'ac_metal', pts[0], pts[-1], 0.025, 5 if lod == 0 else 4, METAL)
    # bumper and the front rubber pad that meets the aircraft
    box(g, 'ac_dark', (-cw, b[1] - 0.25, z1 - 0.06), (cw, b[1] - 0.05, z1 + 0.02), RUBBER)
    box(g, 'ac_dark', (-hw + 0.25, 0.32, z0 + 0.5), (hw - 0.25, 0.55, z0 + 0.6), RUBBER)
    beacon(g, (hw - 0.2, 0.9, 2.66), lod)
    for s in (1, -1):
        for zc in (0.0, zf):
            wheel(g, (s * (hw - 0.22), r, zc), r, 0.26, lod)
    return g


BUILDERS = {'tug': tug, 'baggageTractor': baggage_tractor, 'baggageCart': baggage_cart, 'beltLoader': belt_loader}


def build(asset):
    scene.reset()
    parts = {}
    totals = [0, 0]
    warnings = []
    for name in PARTS:
        node = scene.empty(name)
        node['asset'] = asset
        geos = [BUILDERS[name](lod) for lod in (0, 1)]
        for lod, g in enumerate(geos):
            bake_ao([g], dist=0.8, rays=16 if lod == 0 else 8, floor=0.3)
            emit(f'{name}_lod{lod}', g, node)
            totals[lod] += g.tris()
        lo, hi = K.bounds(geos[:1])
        tris = [g.tris() for g in geos]
        if not 300 <= tris[0] <= 1200:
            warnings.append(f'{name}_lod0 has {tris[0]} triangles (300..1200)')
        if tris[1] >= 300:
            warnings.append(f'{name}_lod1 has {tris[1]} triangles (under 300)')
        d = GD[name]
        parts[name] = {
            'tris': tris,
            'dims': {k: d[k] for k in ('length', 'width', 'height')},
            'min': [round(v, 3) for v in lo],
            'max': [round(v, 3) for v in hi],
        }
        if name == 'tug':
            hz = GD['tug']['hitchZ']
            scene.empty('tug_hitch', (0.0, 0.35, hz), node)
            parts[name]['hitch'] = [0.0, 0.35, hz]
    from . import aircraft_preview
    lay = {'tug': (0.0, 0.0, 0.0), 'baggageTractor': (-4.5, 0.0, 1.0), 'baggageCart': (-7.5, 0.0, 1.0), 'beltLoader': (5.0, 0.0, -1.0)}
    l0 = lambda n: n.endswith('_lod0')
    l1 = lambda n: n.endswith('_lod1')
    aircraft_preview.install({
        'overview': dict(cam=(4.0, 7.0, 14.0), at=(-1.0, 0.6, 1.5), lens=28, show=l0, move=lay),
        'back': dict(cam=(-6.0, 4.5, -9.0), at=(-1.0, 0.6, 1.5), lens=28, show=l0, move=lay),
        'tug': dict(cam=(4.5, 2.6, 8.5), at=(0.0, 0.6, 2.0), lens=30, show=lambda n: n.startswith('tug') and n.endswith('_lod0')),
        'belt': dict(cam=(-4.0, 2.6, 6.0), at=(0.0, 0.9, 2.5), lens=30, show=lambda n: n.startswith('beltLoader') and n.endswith('_lod0')),
        'lod1': dict(cam=(4.0, 7.0, 14.0), at=(-1.0, 0.6, 1.5), lens=28, show=l1, move=lay),
    }, default_show=l0, livery=aircraft_preview.GROUND_LIVERY)
    sidecar = {'kind': 'ground', 'parts': parts, 'materials': K.MATERIALS, 'regions': K.REGIONS}
    return {'asset': asset, 'tris': totals, 'sidecar': sidecar, 'warnings': warnings}
