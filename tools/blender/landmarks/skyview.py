"""SkyView Atlanta ("Skyhigh Wheel" in the game): a 61 m observation wheel in Centennial Olympic Park, an A-frame on each
side holding the hub, a lit rim and spokes, 42 enclosed gondolas hung from it. The wheel turns in the vertical plane that
runs along the data's footprint (a 50 m sliver, north-west to south-east).
Night: the rim and the spokes are lit.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'skyview-atlanta'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

WHITE = srgb(0xe9ecee)
STEEL = srgb(0xaab0b6)
R_RIM = 27.0
HUB_Y = 33.5
NG = 42


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = fp['ring']
    # the wheel plane: along the long axis of the sliver
    cx, cz, ang, L, W = lm.min_obb(ring)
    # u along the plane (L = 2.3 across, W = 50 along in the frame returned: the long side is v)
    ea = lm.to_world(0.0, 1.0, 0.0, 0.0, ang)   # the long axis as a unit vector
    en = (-ea[1], ea[0])                        # across the wheel
    P = lambda u, y, w: (cx + ea[0] * u + en[0] * w, y, cz + ea[1] * u + en[1] * w)
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        ns = 24 if lod == 0 else 12
        for side in (-1.0, 1.0):
            w = side * 1.6
            # the rim: a tube round the wheel
            path = [P(R_RIM * math.cos(2 * math.pi * k / ns), HUB_Y + R_RIM * math.sin(2 * math.pi * k / ns), w) for k in range(ns)]
            path.append(path[0])
            l.tube('lm_metal', path, [0.28] * len(path), 5 if lod == 0 else 4, WHITE, caps=False)
            if lod == 0:
                l.tube('lm_glow', [P((R_RIM + 0.3) * math.cos(2 * math.pi * k / 48), HUB_Y + (R_RIM + 0.3) * math.sin(2 * math.pi * k / 48), w) for k in range(49)], [0.12] * 49, 4, srgb(0xb7d4ff), caps=False)
            # spokes
            nsp = 14 if lod == 0 else 6
            for k in range(nsp):
                a = 2 * math.pi * k / nsp
                l.beam('lm_metal', P(0, HUB_Y, w), P(R_RIM * math.cos(a), HUB_Y + R_RIM * math.sin(a), w), 0.12, 0.12, STEEL)
        # the hub and axle
        l.beam('lm_metal', P(0, HUB_Y, -3.2), P(0, HUB_Y, 3.2), 1.6, 1.6, STEEL)
        # cross braces between the two rims
        if lod == 0:
            for k in range(NG):
                a = 2 * math.pi * k / NG
                px, py = R_RIM * math.cos(a), HUB_Y + R_RIM * math.sin(a)
                l.beam('lm_metal', P(px, py, -1.6), P(px, py, 1.6), 0.15, 0.15, STEEL)
        # gondolas: each hangs from the rim, upright
        for k in range(NG):
            a = 2 * math.pi * k / NG
            px, py = R_RIM * math.cos(a), HUB_Y + R_RIM * math.sin(a)
            gy = py - 1.7
            if lod == 0:
                # body (glass with a white roof and floor)
                g = P(px, gy, 0)
                l.box('lm_glass', (g[0], gy, g[2]), (2.2, 2.0, 2.2), srgb(0x7fa4be))
                l.box('lm_stone', (g[0], gy + 1.15, g[2]), (2.5, 0.3, 2.5), WHITE)
                l.box('lm_stone', (g[0], gy - 1.1, g[2]), (2.4, 0.2, 2.4), STEEL)
            else:
                g = P(px, gy, 0)
                l.box('lm_glass', (g[0], gy, g[2]), (2.4, 2.2, 2.4), srgb(0x7fa4be))
        # the A-frames: two slanted legs on each side, to the hub
        for side in (-1.0, 1.0):
            w = side * 3.4
            for sgn in (-1.0, 1.0):
                l.beam('lm_metal', P(sgn * 17.0, 0.0, w * 1.6), P(0, HUB_Y, w), 1.1, 0.9, WHITE)
        # the base platform
        base = [P(-24, 0.6, -6), P(24, 0.6, -6), P(24, 0.6, 6), P(-24, 0.6, 6)]
        l.poly('lm_stone', base, srgb(0x9a9c9e), hint=(0, 1, 0))
        l.box('lm_stone', P(-1.0, 1.4, 0.0), (6.0, 2.4, 5.0), srgb(0xd8dadc), rot=-math.atan2(ea[1], ea[0]))
        lods.append(l)
    # the legs and the platform are solid; the wheel is over it. The hull is the platform.
    hull = [([(p[0], p[2]) for p in base], 3.0)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 420], cutout=[[p[0], p[2]] for p in base])
