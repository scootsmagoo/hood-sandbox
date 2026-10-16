"""World of Coca-Cola ("World of Fizzpop" in the game): a white museum block of folded panels with a red band, a tall glass
atrium front and a glass rotunda at its curved corner. The plan is the data's. No script lettering, no bottle or contour
mark: the real building's signs are left off.
Night: the red band and the rotunda glow.
"""
import math

from . import common, lm, parts
from .lm import circle, shade, srgb

ID = 'world-of-coca-cola'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

WHITE = srgb(0xe6e1d6)
RED = srgb(0xb3241c)
GLASS = srgb(0x587c92)
H = 13.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', ring, 0, H, WHITE, srgb(0x8d8f90), lm.K_VENUE, floor_h=6.5, fid=61)
        parts.band(l, ring, H - 3.2, H - 2.2, 0.45, RED)
        # the atrium front: a tall glass volume on the south-east side
        l.prism('bld_glass', [(-6.0, -46.0), (34.0, -46.0), (34.0, -26.0), (-6.0, -26.0)], 0, 21.0, GLASS, srgb(0xd8d4c8), lm.K_GLASS, floor_h=7.0, fid=63)
        # the rotunda at the curved west corner
        l.prism('bld_glass', circle(11.0, 24 if lod == 0 else 10, -44.0, -2.0), 0, 18.0, GLASS, srgb(0xd8d4c8), lm.K_GLASS, floor_h=6.0, fid=64)
        l.lathe('lm_glow', [(11.2, 17.2), (11.2, 17.9)], 24 if lod == 0 else 10, srgb(0xff5a46), cx=-44.0, cz=-2.0, smooth=False)
        # a canopy and rooftop plant
        l.box('lm_stone', (-6.0, H + 1.8, 14.0), (28.0, 3.6, 18.0), srgb(0xb4b6b6))
        l.box('lm_stone', (24.0, 7.0, -46.0), (36.0, 0.7, 7.0), WHITE)
        lods.append(l)
    hull = [(ring, H), ([(-6.0, -46.0), (34.0, -46.0), (34.0, -26.0), (-6.0, -26.0)], 21.0)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 500])
