"""Atlanta Marriott Marquis ("Atlanta Marquee Hotel" in the game), Portman's 1985 atrium hotel: a half-round tower of tan
precast concrete, 169 m, that flares out over a wide three-storey podium round the atrium, a small dome over the
lobby. The plan and heights are the data's.
Night: the tower's rooms are lit by the facade shader; the dome glows.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'marriott-marquis'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

TAN = srgb(0xc6b48f)
H = 168.9


def build(asset):
    common.start()
    fp = common.footprint(ID)
    base = [tuple(p) for p in fp['parts'][0]['rings'][0]]
    dome = [tuple(p) for p in fp['parts'][1]['rings'][0]]
    tower = [tuple(p) for p in fp['parts'][2]['rings'][0]]
    c = parts.mean(tower)
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', base, 0, 20.5, srgb(0xb7a888), srgb(0x6a6a68), lm.K_OFFICE, floor_h=6.8, fid=131)
        # the tower flares at its foot: the first 60 m lean out by up to 9%
        flare = lambda y: 1.0 + 0.09 * max(0.0, 1.0 - (y - 20.5) / 60.0)
        l.ring_walls('bld_wall', tower, 20.5, 80.5, TAN, lm.K_OFFICE, floor_h=3.3, fid=132, taper=flare, centre=c)
        top = [(c[0] + (p[0] - c[0]), c[1] + (p[1] - c[1])) for p in tower]
        l.ring_walls('bld_wall', top, 80.5, H, TAN, lm.K_OFFICE, floor_h=3.3, fid=132, era=3)
        parts.band(l, top, H, H + 1.2, 0.5, shade(TAN, 1.1))
        l.cap('bld_roof', top, H + 1.2, srgb(0x6e6e6c))
        # a rooftop ring of plant and a lit crown band
        l.prism('bld_wall', parts.scaled(top, 0.55), H + 1.2, H + 7.0, shade(TAN, 1.05), srgb(0x6e6e6c), lm.K_OFFICE, floor_h=3.0, fid=133)
        if lod == 0:
            parts.band(l, top, H - 3.0, H - 2.6, 0.55, srgb(0xffe2b0), 'lm_glow', top=False)
        dc = parts.mean(dome)
        n = 18 if lod == 0 else 8
        prof = [(6.5 * math.cos(t), 20.5 + 6.0 * math.sin(t)) for t in [i * (math.pi / 2) * 0.96 / 5 for i in range(6)]]
        l.lathe('lm_glass', prof, n, srgb(0x4b7fb0), cx=dc[0], cz=dc[1], smooth=False)
        l.lathe('lm_glow', [(6.6, 20.5), (6.6, 21.0)], n, srgb(0xa8d0ff), cx=dc[0], cz=dc[1], smooth=False)
        lods.append(l)
    hull = [(base, 20.5), (tower, H)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 760])
