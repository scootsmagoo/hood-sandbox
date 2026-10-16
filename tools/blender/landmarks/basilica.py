"""Basilica of the Sacred Heart of Jesus (1897): a red-brick Romanesque-Gothic church whose twin spires stand over the
west front, a gabled nave, stone trim, slate-green spires. The plan and the towers' places come from the data.
Night: the spires' lanterns are lit.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'basilica-of-the-sacred-heart'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

BRICK = srgb(0x8f4a38)
STONE = srgb(0xcfc6b0)
SLATE = srgb(0x55736b)
H_WALL = 13.0


def gable(l, x0, x1, z0, z1, y, rise, col, mat='lm_metal'):
    zc = (z0 + z1) / 2
    for z, hz in ((z0, -1), (z1, 1)):
        l.quad(mat, (x0, y, z), (x1, y, z), (x1, y + rise, zc), (x0, y + rise, zc), col, hint=(0, 0.6, hz))
    for x, hx in ((x0, -1), (x1, 1)):
        l.poly('bld_wall', [(x, y, z0), (x, y, z1), (x, y + rise, zc)], BRICK, hint=(hx, 0, 0), wall=(0.0, z1 - z0, y, y + rise), bld=(lm.K_BRICK, 1, 1, 0), uvs=[(0, y), (z1 - z0, y), ((z1 - z0) / 2, y + rise)])


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, H_WALL, BRICK, lm.K_BRICK, floor_h=6.5, fid=181, era=1)
        parts.band(l, ring, H_WALL - 0.8, H_WALL + 0.2, 0.35, STONE)
        # the nave roof: a gable over the long axis (x), slate
        gable(l, min(xs) + 6.0, max(xs), min(zs) + 1.0, max(zs) - 0.5, H_WALL, 7.0, srgb(0x4b5a5a))
        # the twin towers at the west front, with stone belt courses, belfries and spires
        for (cx, cz) in ((-20.5, 12.5), (-20.5, -0.5)):
            sq = lm.rect(cx, cz, 6.4, 6.4)
            l.prism('bld_wall', sq, 0, 30.0, shade(BRICK, 1.02), STONE, lm.K_BRICK, floor_h=6.0, fid=182, era=1, cap=False)
            parts.band(l, sq, 30.0, 30.9, 0.4, STONE)
            l.prism('bld_wall', lm.rect(cx, cz, 5.2, 5.2), 30.9, 38.0, shade(BRICK, 1.05), STONE, lm.K_BRICK, floor_h=7.0, fid=183, era=1, cap=False)
            parts.band(l, lm.rect(cx, cz, 5.2, 5.2), 38.0, 38.8, 0.4, STONE)
            parts.pyramid(l, lm.rect(cx, cz, 5.2, 5.2), 38.8, 58.0, SLATE, 'lm_metal', cx=cx, cz=cz)
            l.lathe('lm_metal', [(0.25, 55.0), (0.08, 62.0)], 6, srgb(0xcfd3d6), cx=cx, cz=cz, smooth=False)
            if lod == 0:
                # the belfry's louvres: dark arches on each face, lit at night
                for dx, dz, hint in ((2.62, 0, (1, 0, 0)), (-2.62, 0, (-1, 0, 0)), (0, 2.62, (0, 0, 1)), (0, -2.62, (0, 0, -1))):
                    w = 1.2
                    if dx:
                        pts = [(cx + dx, 32.5, cz - w), (cx + dx, 32.5, cz + w), (cx + dx, 36.5, cz + w), (cx + dx, 36.5, cz - w)]
                    else:
                        pts = [(cx - w, 32.5, cz + dz), (cx + w, 32.5, cz + dz), (cx + w, 36.5, cz + dz), (cx - w, 36.5, cz + dz)]
                    l.poly('lm_glow', pts, srgb(0xffb86a), hint=hint)
        # a rose window and a door arch on the west front, in stone
        l.box('lm_stone', (-23.4, 5.0, 6.0), (0.6, 5.0, 4.2), shade(STONE, 0.95)) if lod == 0 else None
        lods.append(l)
    hull = [(ring, H_WALL)] + [(lm.rect(cx, cz, 6.4, 6.4), 40.0) for cx, cz in ((-20.5, 12.5), (-20.5, -0.5))]
    return common.report(asset, ID, lods, hull, lod_from=[0, 420])
