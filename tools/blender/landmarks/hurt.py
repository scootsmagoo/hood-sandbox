"""The Hurt Building (1913): an 18-storey wedge of cream terra cotta at the point of Hurt Park, a marble colonnade along its
base and a deep cornice. The plan is the data's wedge.
Night: the cornice is lit.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'hurt-building'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CREAM = srgb(0xe3d8c0)
MARBLE = srgb(0xeee9dd)
H = 82.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    # the wedge: the big straight edges of the data (the rounded corner on the south-west is left to the walls)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, 14.0, shade(CREAM, 0.9), lm.K_CIVIC, floor_h=7.0, fid=161, era=1)
        parts.band(l, ring, 14.0, 15.2, 0.6, MARBLE, 'lm_flood')
        l.ring_walls('bld_wall', ring, 15.2, H - 5.0, CREAM, lm.K_CIVIC, floor_h=3.75, fid=162, era=1)
        parts.band(l, ring, H - 5.0, H - 2.5, 0.6, shade(CREAM, 1.05), 'lm_flood')
        parts.band(l, ring, H - 2.5, H, 1.8, CREAM, 'lm_flood')
        l.cap('bld_roof', ring, H, srgb(0x6a6a68))
        if lod == 0:
            parts.band(l, ring, H - 2.8, H - 2.4, 1.7, srgb(0xffe0b0), 'lm_glow', top=False)
            # a marble colonnade along the longest edge
            best = max(range(len(ring)), key=lambda i: math.hypot(ring[(i + 1) % len(ring)][0] - ring[i][0], ring[(i + 1) % len(ring)][1] - ring[i][1]))
            a, b = ring[best], ring[(best + 1) % len(ring)]
            out = parts.outward(ring, best)
            ol = math.hypot(out[0], out[2])
            ox, oz = out[0] / ol, out[2] / ol
            ln = math.hypot(b[0] - a[0], b[1] - a[1])
            n = int(ln // 4.2)
            for j in range(n + 1):
                t = j / n
                x, z = a[0] + (b[0] - a[0]) * t + ox * 3.2, a[1] + (b[1] - a[1]) * t + oz * 3.2
                parts.column(l, x, z, 0.55, 0.0, 12.0, 10, MARBLE, 'lm_flood')
            c0 = (a[0] + ox * 3.2, a[1] + oz * 3.2)
            c1 = (b[0] + ox * 3.2, b[1] + oz * 3.2)
            beam_y = 12.6
            l.beam('lm_flood', (c0[0], beam_y, c0[1]), (c1[0], beam_y, c1[1]), 1.6, 1.2, MARBLE)
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, H)], lod_from=[0, 560])
