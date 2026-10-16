"""Hyatt Regency Atlanta ("Atlas Regent Hotel" in the game), John Portman's 1967 atrium hotel: a cream concrete slab
whose every floor wears a white balcony rail, a low podium round the atrium, and on the roof the saucer of the revolving
lounge under a blue glass dome. The plan and the heights come from the data (the 24-floor slab, the 2-floor podium, the
dome part), the heights eased by a tenth: Overture's 100 m is 4 m a floor.
Night: the dome glows blue, the slab's rooms are lit by the facade shader.
"""
import math

from . import common, lm, parts
from .lm import circle, shade, srgb

ID = 'hyatt-regency-atlanta'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CREAM = srgb(0xd9cfba)
RAIL = srgb(0xece6d6)
BROWN = srgb(0x7b6753)
SLAB_H = 90.0
FLOOR = SLAB_H / 24.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ps = fp['parts']
    tower = [tuple(p) for p in ps[0]['rings'][0]]
    wing = [tuple(p) for p in ps[1]['rings'][0]]
    drum = [tuple(p) for p in ps[2]['rings'][0]]
    dome = [tuple(p) for p in ps[3]['rings'][0]]
    base = [tuple(p) for p in ps[4]['rings'][0]]
    lods = []
    for i in (0, 1):
        l = lm.Lod(i)
        # the podium round the atrium
        l.prism('bld_wall', base, 0, 9.0, srgb(0xb9ae98), srgb(0x6b6a68), lm.K_OFFICE, floor_h=4.5, fid=31)
        # the slab, the wing, and the round stair tower
        l.prism('bld_wall', tower, 9.0, SLAB_H, CREAM, srgb(0x8b8a86), lm.K_RESID, floor_h=FLOOR, fid=32)
        l.ring_walls('bld_wall', tower, 0, 9.0, srgb(0xb9ae98), lm.K_OFFICE, floor_h=4.5, fid=31)
        l.prism('bld_wall', wing, 9.0, SLAB_H - 6.0, srgb(0xcdc2ab), srgb(0x8b8a86), lm.K_RESID, floor_h=FLOOR, fid=33)
        l.prism('bld_wall', drum, 9.0, SLAB_H - 2.0, shade(BROWN, 1.0), srgb(0x8b8a86), lm.K_OFFICE, floor_h=FLOOR, fid=34)
        if i == 0:
            # a balcony rail round the slab at every floor: the building's signature stripes
            for f in range(1, 24):
                y = FLOOR * f
                parts.band(l, tower, y - 0.05, y + 0.9, 0.9, RAIL, top=False)
            for f in range(4, 22):
                parts.band(l, wing, FLOOR * f - 0.05, FLOOR * f + 0.9, 0.9, RAIL, top=False)
        # the crown of the slab, a deep fascia
        parts.band(l, tower, SLAB_H, SLAB_H + 2.6, 0.5, RAIL)
        # the lounge: a drum, the saucer, the blue dome
        cx = sum(p[0] for p in dome) / len(dome)
        cz = sum(p[1] for p in dome) / len(dome)
        n = 28 if i == 0 else 12
        l.lathe('lm_stone', [(4.5, SLAB_H + 2.6), (4.5, SLAB_H + 6.5)], n, RAIL, cx=cx, cz=cz, smooth=False)
        l.lathe('lm_stone', [(4.5, SLAB_H + 6.5), (9.5, SLAB_H + 7.4), (12.2, SLAB_H + 8.4), (12.8, SLAB_H + 9.8), (11.5, SLAB_H + 10.8), (9.0, SLAB_H + 10.8)], n, RAIL, cx=cx, cz=cz, smooth=False)
        l.lathe('lm_stone', [(12.8, SLAB_H + 9.8), (12.8, SLAB_H + 8.4), (12.2, SLAB_H + 8.4)], n, shade(RAIL, 0.8), cx=cx, cz=cz, smooth=False)
        prof = []
        for k in range(7 if i == 0 else 4):
            t = (math.pi / 2) * 0.96 * k / (6 if i == 0 else 3)
            prof.append((8.6 * math.cos(t), SLAB_H + 10.8 + 6.2 * math.sin(t)))
        l.lathe('lm_glass', prof, n, srgb(0x2f64a8), cx=cx, cz=cz, smooth=False)
        l.lathe('lm_glow', [(9.0, SLAB_H + 10.8), (9.0, SLAB_H + 11.4)], n, srgb(0x6ea8ff), cx=cx, cz=cz, smooth=False)
        lods.append(l)
    hull = [(tower, SLAB_H), (wing, SLAB_H - 6), (base, 9.0), (drum, SLAB_H - 2)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 600])
