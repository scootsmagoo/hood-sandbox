"""Corey Tower: a slim round 91 m residential tower (Georgia State University), a cylinder of pale concrete with ribbon windows.
Night: its rooms are lit by the facade shader.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'corey-tower'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

H = 91.44


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', ring, 0, H, srgb(0xc4c0b6), srgb(0x6a6a68), lm.K_RESID, floor_h=3.05, fid=191, era=3)
        if lod == 0:
            parts.band(l, ring, H, H + 1.2, 0.4, srgb(0xb3afa4))
            parts.band(l, ring, 0, 5.0, 0.5, srgb(0x9d9a90))
        c = parts.mean(ring)
        l.box('lm_stone', (c[0], H + 2.2, c[1]), (5.0, 2.4, 5.0), srgb(0xa9a69c))
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, H)], lod_from=[0, 520])
