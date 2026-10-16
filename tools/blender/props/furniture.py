"""Street furniture: the three street lamps (cobra-head arm, pedestrian post-top, highway mast),
a fire hydrant, a waste bin and a bollard. One .glb, one root per model:

  lamp_cobra / lamp_post / lamp_mast / hydrant / bin / bollard      root; extras: refH, r (propDims.json)
    <root>_mesh        the model: albedo in COLOR_0 (linear), smooth normals, no UVs that matter
    <root>_anchor      (lamps only) the lamp head: where the game puts the sodium glow, and the
                       point whose ground projection is the centre of the light pool

Every model stands on its origin and faces +Z (a lamp's arm reaches along +Z). The body radius
over the heights in propDims.json is the radius the sim's collider uses (src/shared/props.ts).
"""
import json
import math
import os

import bpy
from mathutils import Vector

from hoodlib import scene
from .geo import Geo, mix, scale, srgb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DIMS = json.load(open(os.path.join(ROOT, 'src', 'shared', 'data', 'propDims.json')))
VERTEX_COLOR = 'ACTIVE'

ARM = 2.4  # a cobra-head lamp's reach, m (src/client/render/look/lamps.ts used the same)
GALV = srgb(0x74777a)
DARK = srgb(0x2b2d2f)
GREEN = srgb(0x1f2b25)
LENS = srgb(0xb9bdb2)
GLASS = srgb(0xcfd0c4)


def _pole(g, profile, sides, colour, wind=0.0):
    """A lathe from (radius, y) points with one colour (or a function of the ring)."""
    col = colour if callable(colour) else (lambda k: colour)
    g.lathe(profile, sides, col, wind=lambda y: wind)


def cobra(d):
    H, r = d['refH'], d['r']
    g = Geo()
    prof = [(0.19, 0.0), (0.19, 0.12), (0.14, 0.17), (r + 0.01, 0.45), (r, 1.0), (0.1, 4.0), (0.075, H - 1.0), (0.065, H - 0.3), (0.0, H - 0.3)]
    g.lathe(prof, 8, lambda k: scale(GALV, 0.8 if k < 3 else 0.95 + 0.04 * k / 8))
    # the base collar
    g.lathe([(0.2, 0.3), (0.2, 0.36), (0.15, 0.4)], 8, lambda k: scale(GALV, 0.7))
    # the arm: a curved tube that rises a little toward the head, with a brace under it
    path = [Vector((0, H - 0.6, 0)), Vector((0, H - 0.3, 0.7)), Vector((0, H - 0.08, 1.6)), Vector((0, H - 0.0, ARM - 0.2))]
    g.tube(path, [0.06, 0.05, 0.045, 0.04], 6, lambda i, a: scale(GALV, 0.95))
    brace = [Vector((0, H - 1.5, 0)), Vector((0, H - 0.9, 0.9)), Vector((0, H - 0.25, 1.65))]
    g.tube(brace, [0.03, 0.028, 0.025], 4, lambda i, a: scale(GALV, 0.85))
    # the cobra head: a tapered housing, darker, with a pale lens underneath
    zc = ARM + 0.1
    hb = H - 0.06
    g.box((0, hb + 0.04, zc - 0.05), (0.3, 0.13, 0.82), scale(DARK, 1.0))
    g.box((0, hb - 0.0, zc + 0.52), (0.22, 0.1, 0.3), scale(DARK, 0.9))
    g.box((0, hb + 0.06, zc - 0.5), (0.2, 0.14, 0.2), scale(DARK, 1.1))
    g.box((0, hb - 0.035, zc + 0.02), (0.27, 0.02, 0.9), LENS)
    return g, (0, hb - 0.06, zc)


def post(d):
    H, r = d['refH'], d['r']
    g = Geo()
    dk = GREEN
    prof = [(0.22, 0.0), (0.22, 0.14), (0.17, 0.2), (0.15, 0.45), (r, 1.0), (0.095, 2.5), (0.085, 3.7), (0.13, 3.74), (0.13, 3.8), (0.0, 3.8)]
    g.lathe(prof, 8, lambda k: scale(dk, 1.0 + 0.05 * (k % 2)))
    g.lathe([(0.2, 0.55), (0.2, 0.62), (0.14, 0.66)], 8, lambda k: scale(dk, 0.8))
    # the lantern: a cap, an opal globe, a finial
    g.lathe([(0.17, 3.8), (0.2, 3.9), (0.22, 4.1), (0.2, 4.28), (0.14, 4.36)], 10, lambda k: GLASS)
    g.lathe([(0.24, 4.28), (0.24, 4.32), (0.12, 4.42), (0.03, 4.5), (0.0, 4.5)], 10, lambda k: scale(dk, 1.2))
    return g, (0, 4.1, 0)


def mast(d):
    H, r = d['refH'], d['r']
    g = Geo()
    prof = [(0.32, 0.0), (0.32, 0.18), (0.24, 0.3), (r, 1.0), (0.14, H * 0.5), (0.1, H - 0.4), (0.1, H - 0.2), (0.0, H - 0.2)]
    g.lathe(prof, 10, lambda k: scale(GALV, 0.85 if k < 3 else 1.0))
    g.lathe([(0.34, 0.25), (0.34, 0.34), (0.25, 0.4)], 10, lambda k: scale(GALV, 0.7))
    # a cross bar with a head at each end, reaching forward
    g.box((0, H - 0.45, 0.2), (1.9, 0.12, 0.12), scale(GALV, 0.9))
    for sx in (-0.85, 0.85):
        path = [Vector((sx, H - 0.45, 0.2)), Vector((sx, H - 0.36, 0.9)), Vector((sx, H - 0.3, 1.7))]
        g.tube(path, [0.05, 0.045, 0.04], 5, lambda i, a: scale(GALV, 0.9))
        g.box((sx, H - 0.3, 1.9), (0.34, 0.16, 0.95), scale(DARK, 1.0))
        g.box((sx, H - 0.385, 1.92), (0.3, 0.02, 0.9), LENS)
    return g, (0, H - 0.4, 1.9)


def hydrant(d):
    r = d['r']
    g = Geo()
    red = srgb(0x8f2a22)
    cap = srgb(0xa9a79c)
    prof = [(0.2, 0.0), (0.2, 0.05), (r, 0.1), (r, 0.2), (r, 0.5), (0.2, 0.54), (0.2, 0.6), (r - 0.02, 0.63), (r - 0.04, 0.7), (0.1, 0.76), (0.0, 0.78)]
    g.lathe(prof, 12, lambda k: red if k < 7 else mix(red, cap, 0.35))
    g.lathe([(0.07, 0.76), (0.07, 0.82), (0.0, 0.83)], 6, lambda k: cap)
    for sx in (-1, 1):
        g.tube([Vector((sx * 0.12, 0.46, 0)), Vector((sx * 0.25, 0.46, 0))], [0.065, 0.065], 8, lambda i, a: red, cap_end=True, cap_color=cap)
    g.tube([Vector((0, 0.4, 0.12)), Vector((0, 0.4, 0.27))], [0.085, 0.085], 8, lambda i, a: red, cap_end=True, cap_color=cap)
    return g, None


def bin_(d):
    r = d['r']
    g = Geo()
    col = srgb(0x2c3a32)
    rim = srgb(0x1b1f1d)
    prof = [(0.26, 0.0), (r, 0.12), (r, 0.5), (r, 0.76), (r + 0.02, 0.8), (r - 0.03, 0.84), (r - 0.05, 0.9), (0.14, 0.92), (0.0, 0.92)]
    g.lathe(prof, 10, lambda k: rim if k in (0, 7) else scale(col, 1.0 + 0.08 * (k % 2)))
    for y in (0.3, 0.55):
        g.lathe([(r + 0.012, y), (r + 0.012, y + 0.04)], 10, lambda k: rim)
    return g, None


def bollard(d):
    r = d['r']
    g = Geo()
    col = srgb(0x3b3e41)
    band = srgb(0xc8b24a)
    prof = [(r + 0.02, 0.0), (r + 0.02, 0.06), (r, 0.1), (r, 0.5), (r, 0.7), (r, 0.76), (r, 0.86), (r - 0.025, 0.92), (r - 0.07, 0.95), (0.0, 0.95)]
    g.lathe(prof, 10, lambda k: band if k in (5, 6) else scale(col, 1.0))
    return g, None


MODELS = [
    ('lamp_cobra', cobra, DIMS['lamps'][0], True),
    ('lamp_post', post, DIMS['lamps'][1], True),
    ('lamp_mast', mast, DIMS['lamps'][2], True),
    ('hydrant', hydrant, DIMS['hydrant'], False),
    ('bin', bin_, DIMS['bin'], False),
    ('bollard', bollard, DIMS['bollard'], False),
]


def build(asset):
    scene.reset()
    mat = bpy.data.materials.new('furniture')
    mat.use_nodes = True
    tris = []
    names = []
    for name, fn, d, lamp in MODELS:
        g, anchor = fn(d)
        extras = {'r': d['r']}
        if 'refH' in d:
            extras['refH'] = d['refH']
        root = scene.empty(name, props=extras)
        g.to_object(f'{name}_mesh', parent=root, material=mat)
        if anchor is not None:
            scene.empty(f'{name}_anchor', pos=anchor, parent=root)
        tris.append(g.tris())
        names.append(name)
    return {'asset': asset, 'tris': tris, 'models': names}
