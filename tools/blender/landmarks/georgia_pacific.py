"""Georgia-Pacific Tower ("Timberline Pacific Tower" in the game), 1982: a stair-stepped pink-granite office tower, 212 m,
whose plan steps back in four stages (the data's four parts: 100, 150, 200 and 212 m) with a square window grid.
Night: the top step is lit.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'georgia-pacific-tower'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

PINK = srgb(0xb98f85)


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ps = sorted(fp['parts'], key=lambda p: -(p['height'] or 0))
    low = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', low, 0, 24.0, srgb(0xa98276), srgb(0x6a6a68), lm.K_OFFICE, floor_h=4.0, fid=121, era=3)
        for k, p in enumerate(ps):
            ring = [tuple(q) for q in p['rings'][0]]
            h = p['height']
            l.prism('bld_wall', ring, 0, h, shade(PINK, 0.94 + 0.05 * k), srgb(0x6e6e6c), lm.K_OFFICE, floor_h=h / (p['floors'] or 50), fid=122 + k, era=3)
            if lod == 0:
                parts.band(l, ring, h - 0.8, h + 0.6, 0.35, shade(PINK, 1.12))
        # the top step's crown: a lit band and a small lantern
        top = [tuple(q) for q in ps[0]['rings'][0]]
        if lod == 0:
            parts.band(l, top, ps[0]['height'] - 3.5, ps[0]['height'] - 3.0, 0.45, srgb(0xffe2b0), 'lm_glow', top=False)
        c = parts.mean(top)
        l.box('lm_stone', (c[0], ps[0]['height'] + 3.0, c[1]), (9.0, 6.0, 9.0), shade(PINK, 1.1))
        l.lathe('lm_metal', [(0.35, ps[0]['height'] + 6.0), (0.1, ps[0]['height'] + 14.0)], 6, srgb(0xcfd3d6), cx=c[0], cz=c[1], smooth=False)
        lods.append(l)
    hull = [(low, 24.0)] + [([tuple(q) for q in p['rings'][0]], p['height']) for p in ps]
    return common.report(asset, ID, lods, hull, lod_from=[0, 700])
