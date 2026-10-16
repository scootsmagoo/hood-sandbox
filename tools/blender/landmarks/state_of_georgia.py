"""State of Georgia Building (2 Peachtree Street), 1966: a 44-storey, 169 m slab tower in pale stone and glass, set back in
three stages under a pyramidal, lit crown. The plan is the data's long sliver.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'state-of-georgia-building'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

STONE = srgb(0xc9c5b8)
H = 169.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    top = H - 30.0
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.prism('bld_wall', ring, 0, 16.0, shade(STONE, 0.88), srgb(0x6a6a68), lm.K_OFFICE, floor_h=5.3, fid=141, cap=False)
        parts.band(l, ring, 16.0, 17.2, 0.6, shade(STONE, 0.95))
        l.ring_walls('bld_wall', ring, 17.2, top, STONE, lm.K_OFFICE, floor_h=3.65, fid=142)
        parts.band(l, ring, top, top + 1.4, 0.5, shade(STONE, 1.08))
        # three setbacks and a pyramid
        y = top + 1.4
        for k, (s, h) in enumerate(((0.86, 9.0), (0.68, 8.0), (0.5, 7.0))):
            r = parts.scaled(ring, s)
            l.prism('bld_wall', r, y, y + h, shade(STONE, 1.06 + 0.03 * k), srgb(0x77777a), lm.K_OFFICE, floor_h=3.6, fid=143 + k, cap=False)
            parts.band(l, r, y + h, y + h + 0.9, 0.35, shade(STONE, 1.12), 'lm_flood')
            y += h + 0.9
        r = parts.scaled(ring, 0.38)
        parts.pyramid(l, r, y, H - 3.0, srgb(0x9aa3a8), 'lm_metal')
        c = parts.mean(r)
        l.lathe('lm_metal', [(0.3, H - 5.0), (0.1, H + 5.0)], 6, srgb(0xcfd3d6), cx=c[0], cz=c[1], smooth=False)
        l.lathe('lm_glow', [(0.45, H + 3.0), (0.45, H + 4.2), (0.1, H + 4.8)], 6, srgb(0xff3a2a), cx=c[0], cz=c[1], smooth=False)
        if lod == 0:
            parts.band(l, parts.scaled(ring, 0.5), y - 1.0, y - 0.6, 0.2, srgb(0xffe2b0), 'lm_glow', top=False)
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, top)], lod_from=[0, 700])
