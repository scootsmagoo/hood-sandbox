"""Fountain of Rings, Centennial Olympic Park: a paved plaza with a shallow basin and five interlocking rings of jets, 3 and 2.
Not a building: a flat model with no collision. The rings are shown as pale stone inlays and white water jets, all one
colour (the rings' marks are not copied).
Night: the inlays glow cool white.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'fountain-of-rings'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

R = 6.2
CENTRES = [(-11.5, -4.0), (0.0, -4.0), (11.5, -4.0), (-5.75, 2.4), (5.75, 2.4)]


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        # the paving and a low kerb round the plaza; the model is a decal 14 cm above the ground (the ground here is flat)
        l.cap('lm_stone', ring, 0.2, srgb(0xb8b2a4), up=True)
        # a terrace: the plaza is level at the ground's highest point, with a stone retaining wall down to the lower side
        parts.band(l, ring, -6.0, 0.42, 0.15, srgb(0xcdc7b8))
        n = 36 if lod == 0 else 16
        for (cx, cz) in CENTRES:
            # the inlay: a pale ring in the paving, and the jets round it
            for k in range(n):
                a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
                r0, r1 = R - 0.35, R + 0.35
                pts = [(cx + r0 * math.cos(a0), 0.27, cz + r0 * math.sin(a0)), (cx + r1 * math.cos(a0), 0.27, cz + r1 * math.sin(a0)),
                       (cx + r1 * math.cos(a1), 0.27, cz + r1 * math.sin(a1)), (cx + r0 * math.cos(a1), 0.27, cz + r0 * math.sin(a1))]
                l.poly('lm_glow', pts, srgb(0xd6e8f2), hint=(0, 1, 0))
            if lod == 0:
                for k in range(0, n, 2):
                    a = 2 * math.pi * k / n
                    x, z = cx + R * math.cos(a), cz + R * math.sin(a)
                    l.lathe('lm_glass', [(0.12, 0.27), (0.08, 1.3), (0.0, 1.8)], 5, srgb(0xe9f4ff), cx=x, cz=z, smooth=False)
        lods.append(l)
    return common.report(asset, ID, lods, hull=[], lod_from=[0, 260], replaces={'overture': [], 'also': [], 'overlap': 2.0}, clear=[ring], extra={'datum': 'max'})
