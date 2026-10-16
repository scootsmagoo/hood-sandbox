"""The Candler Building (1906), Atlanta: a 17-storey Beaux-Arts tower in cream terracotta and stone, a heavy base of
three storeys, a shaft, and a bracketed cornice under a copper-green crown. The plan is the data's.
Night: the cornice is floodlit.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'candler-building'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CREAM = srgb(0xe2d9c4)
BASE = srgb(0xcbbfa5)
GREEN = srgb(0x5d8a78)
H = 73.2


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, 15.0, BASE, lm.K_CIVIC, floor_h=5.0, era=1, fid=111)
        parts.band(l, ring, 15.0, 16.2, 0.5, shade(BASE, 1.1), 'lm_flood')
        l.ring_walls('bld_wall', ring, 16.2, H - 4.5, CREAM, lm.K_CIVIC, floor_h=3.6, era=1, fid=112)
        if lod == 0:
            parts.band(l, ring, 38.0, 38.6, 0.35, shade(CREAM, 1.05))
        parts.band(l, ring, H - 4.5, H - 2.2, 0.6, shade(CREAM, 1.05), 'lm_flood')
        parts.band(l, ring, H - 2.2, H, 1.7, CREAM, 'lm_flood')
        top = parts.scaled(ring, 0.84)
        l.cap('bld_roof', ring, H, srgb(0x6a6a68))
        l.prism('bld_wall', top, H, H + 5.0, shade(CREAM, 1.05), srgb(0x6a6a68), lm.K_CIVIC, floor_h=3.4, era=1, fid=113, cap=False)
        parts.pyramid(l, parts.scaled(ring, 0.7), H + 5.0, H + 13.0, GREEN, 'lm_metal')
        if lod == 0:
            parts.band(l, ring, H - 2.2, H - 1.8, 1.6, srgb(0xffe0b0), 'lm_glow', top=False)
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, H)], lod_from=[0, 460])
