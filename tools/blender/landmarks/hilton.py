"""Hilton Atlanta ("Crestview Atlanta Hotel" in the game), 1971: a broad 30-storey hotel slab of pale concrete with a concave,
leaning profile and a flat crown of plant. The plan and the height are the data's. No signage.
Night: the crown is lit.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'hilton-atlanta'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CONCRETE = srgb(0xd0cdc4)
H = 116.7


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    c = parts.mean(ring)
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, 18.0, srgb(0xa9a699), lm.K_OFFICE, floor_h=4.5, fid=201, era=3)
        # the shaft leans in towards the top: the concave profile of 1971
        lean = lambda y: 1.0 - 0.07 * ((y - 18.0) / (H - 18.0)) ** 1.6
        l.ring_walls('bld_wall', ring, 18.0, H - 6.0, CONCRETE, lm.K_OFFICE, floor_h=3.3, fid=202, era=3, taper=lean, centre=c)
        s = lean(H - 6.0)
        top = parts.scaled(ring, s, c)
        parts.band(l, top, H - 6.0, H, 0.9, shade(CONCRETE, 0.92))
        l.cap('bld_roof', top, H, srgb(0x6a6a68))
        l.prism('bld_wall', parts.scaled(top, 0.5, c), H, H + 6.0, shade(CONCRETE, 1.0), srgb(0x6e6e6c), lm.K_OFFICE, floor_h=3.0, fid=203)
        if lod == 0:
            parts.band(l, top, H - 4.0, H - 3.6, 1.0, srgb(0xffe2b0), 'lm_glow', top=False)
        lods.append(l)
    hull = [(ring, 18.0), (parts.scaled(ring, 0.94, c), H - 2.0)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 700])
