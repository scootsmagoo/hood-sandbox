"""The Flatiron Building (English-American Building, 1897), Atlanta: an 11-storey brick wedge at the point of Peachtree
and Poplar, rounded at its narrow end, with a heavy bracketed cornice. The plan is the data's.
Night: the cornice is lit.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'flatiron-building-atlanta'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

BRICK = srgb(0x93503c)
STONE = srgb(0xcfc6b2)
H = 49.8


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, H, BRICK, lm.K_BRICK, floor_h=4.4, era=1, fid=101)
        # the stone base and the string courses
        parts.band(l, ring, 0.0, 6.0, 0.35, shade(STONE, 0.95), top=True)
        parts.band(l, ring, 6.0, 6.6, 0.55, STONE)
        if lod == 0:
            parts.band(l, ring, 22.0, 22.5, 0.35, STONE)
            parts.band(l, ring, 36.0, 36.5, 0.35, STONE)
        # the cornice: a deep bracketed band
        parts.band(l, ring, H - 3.4, H - 1.6, 0.5, shade(STONE, 1.05), 'lm_flood')
        parts.band(l, ring, H - 1.6, H + 0.6, 1.5, STONE, 'lm_flood')
        l.cap('bld_roof', ring, H + 0.6, srgb(0x6a6a68))
        if lod == 0:
            parts.band(l, ring, H - 1.9, H - 1.5, 1.4, srgb(0xffe0b0), 'lm_glow', top=False)
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, H)], lod_from=[0, 420])
