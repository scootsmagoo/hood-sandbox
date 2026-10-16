"""191 Peachtree Tower: a 235 m, 50-storey Postmodern tower in pink-grey granite and dark glass, its three parts rising
together to a tall Classical crown (a stepped lantern and a spire). The plan is the data's tiers.
Night: the lantern is floodlit and the spire tip has a beacon.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = '191-peachtree-tower'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

GRANITE = srgb(0xb69f95)
HEIGHT = 234.7


def build(asset):
    common.start()
    fp = common.footprint(ID)
    towers, podium = [], []
    for p in fp['parts']:
        for r in p['rings']:
            (towers if (p['height'] or 0) > 100 else podium).append([tuple(q) for q in r])
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        for k, r in enumerate(towers):
            l.prism('bld_wall', r, 0, HEIGHT - 26.0, shade(GRANITE, 0.94 + 0.06 * (k % 2)), srgb(0x6e6e6c), lm.K_OFFICE, floor_h=4.4, fid=81 + k, era=4, cap=False)
        for k, r in enumerate(podium):
            l.prism('bld_wall', r, 0, 14.0, srgb(0xa89489), srgb(0x66666a), lm.K_OFFICE, floor_h=4.6, fid=90 + k, era=4)
        # the crown: on the largest tower, three stepped stages, a lantern, a spire
        big = max(towers, key=lambda r: abs(lm.area2(r)))
        base = HEIGHT - 26.0
        c = parts.mean(big)
        s1 = parts.scaled(big, 0.86)
        l.prism('bld_wall', s1, base, base + 8.0, shade(GRANITE, 1.08), srgb(0x7a7a7c), lm.K_CIVIC, floor_h=4.0, fid=85, cap=False)
        parts.band(l, s1, base + 8.0, base + 9.5, 0.5, shade(GRANITE, 1.15), 'lm_flood')
        s2 = parts.scaled(big, 0.62)
        l.prism('bld_wall', s2, base + 9.5, base + 17.0, shade(GRANITE, 1.12), srgb(0x7a7a7c), lm.K_CIVIC, floor_h=3.8, fid=86, cap=False)
        parts.band(l, s2, base + 17.0, base + 18.4, 0.5, shade(GRANITE, 1.2), 'lm_flood')
        s3 = parts.scaled(big, 0.36)
        parts.band(l, s3, base + 18.4, base + 23.0, 0.0, srgb(0xe8dccb), 'lm_flood', top=False)
        parts.pyramid(l, parts.scaled(big, 0.38), base + 23.0, HEIGHT - 4.0, srgb(0x8d9ea0), 'lm_metal', cx=c[0], cz=c[1])
        l.lathe('lm_metal', [(0.3, HEIGHT - 6.0), (0.1, HEIGHT + 4.0)], 6, srgb(0xcfd3d6), cx=c[0], cz=c[1], smooth=False)
        l.lathe('lm_glow', [(0.45, HEIGHT + 2.6), (0.45, HEIGHT + 3.8), (0.1, HEIGHT + 4.4)], 6, srgb(0xff3a2a), cx=c[0], cz=c[1], smooth=False)
        if lod == 0:
            parts.band(l, parts.scaled(big, 0.37), base + 22.4, base + 23.0, 0.0, srgb(0xffe6b8), 'lm_glow', top=False)
        lods.append(l)
    hull = [(r, HEIGHT - 26.0) for r in towers] + [(r, 14.0) for r in podium]
    return common.report(asset, ID, lods, hull, lod_from=[0, 700])
