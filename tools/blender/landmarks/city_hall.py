"""Atlanta City Hall (1930): a limestone Gothic-Deco civic block of five and six storeys and, over its heart, a tower whose vertical piers
rise through three setbacks to a pyramidal cap. The plan, the parts and the heights are the data's.
Night: the tower is floodlit.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'atlanta-city-hall'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

STONE = srgb(0xcfc7b4)
H = 66.6


def piers(l, ring, y0, y1, step, col):
    """Vertical piers up the faces of a ring, every `step` metres."""
    import math
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(ln // step))
        out = parts.outward(ring, i)
        ol = math.hypot(out[0], out[2]) or 1.0
        for j in range(n + 1):
            t = j / n
            x, z = a[0] + (b[0] - a[0]) * t + out[0] / ol * 0.35, a[1] + (b[1] - a[1]) * t + out[2] / ol * 0.35
            l.box('lm_flood', (x, (y0 + y1) / 2, z), (0.9, y1 - y0, 0.9), col)


def build(asset):
    common.start()
    fp = common.footprint(ID)
    low1, low2, tower = [[tuple(q) for q in p['rings'][0]] for p in fp['parts']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', low1, 0, 26.0, STONE, srgb(0x6a6a68), lm.K_CIVIC, floor_h=4.3, fid=151, era=1)
        l.prism('bld_wall', low2, 0, 22.0, shade(STONE, 0.97), srgb(0x6a6a68), lm.K_CIVIC, floor_h=4.4, fid=152, era=1)
        parts.band(l, low1, 25.2, 26.4, 0.5, shade(STONE, 1.05), 'lm_flood')
        # the tower: full width to 36 m, then three setbacks and a pyramid
        y = 0.0
        stages = [(1.0, 38.0), (0.82, 10.0), (0.62, 8.0)]
        for k, (s, h) in enumerate(stages):
            r = parts.scaled(tower, s)
            l.prism('bld_wall', r, y, y + h, shade(STONE, 1.0 + 0.03 * k), srgb(0x77777a), lm.K_CIVIC, floor_h=4.2, fid=153 + k, era=1, cap=False)
            if lod == 0 and k == 0:
                piers(l, r, y, y + h, 4.0, shade(STONE, 1.08))
            parts.band(l, r, y + h, y + h + 0.9, 0.35, shade(STONE, 1.1), 'lm_flood')
            y += h + 0.9
        parts.pyramid(l, parts.scaled(tower, 0.46), y, H + 8.0, srgb(0x6f8f86), 'lm_metal')
        c = parts.mean(tower)
        l.lathe('lm_metal', [(0.3, H + 6.0), (0.1, H + 13.0)], 6, srgb(0xcfd3d6), cx=c[0], cz=c[1], smooth=False)
        lods.append(l)
    hull = [(low1, 26.0), (low2, 22.0), (tower, 38.0), (parts.scaled(tower, 0.82), 48.9)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 600])
