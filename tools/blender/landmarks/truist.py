"""Truist Plaza ("Trustline Plaza" in the game; built as SunTrust Plaza, 1992): a 265 m tower whose plan steps in at
the corners, tier on tier (the data gives the floor count of each tier: 60 at the core, then 56, 54, 52 ... down to the
shoulders), so the outline rises like a ziggurat to a pyramidal crown. Pale granite and dark ribbon windows.
Night: the crown is lit from below, the tip has a beacon.
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'truist-plaza'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

GRANITE = srgb(0xc2bcb0)
FLOOR = 4.2
CROWN = 265.0


def tiers(fp):
    out = []
    for p in fp['parts']:
        f = p['floors'] or 0
        if f < 6:
            continue
        for r in p['rings']:
            out.append((f, [tuple(q) for q in r]))
    out.sort(key=lambda t: (-t[0]))
    return out


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ts = tiers(fp)
    core = ts[0]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        for k, (f, ring) in enumerate(ts):
            if lod == 1 and f < 44:
                continue
            h = min(f * FLOOR, CROWN - 13.0)
            l.prism('bld_wall', ring, 0, h, shade(GRANITE, 0.92 + 0.08 * (k % 3)), srgb(0x6e6e6c), lm.K_OFFICE, floor_h=FLOOR if f >= 30 else 3.8, fid=71 + k, era=4)
        # the crown: the core's top set back, then a pyramid and a mast
        ring = core[1]
        top = min(core[0] * FLOOR, CROWN - 13.0)
        inner = parts.scaled(ring, 0.78)
        l.prism('bld_wall', inner, top, top + 5.0, shade(GRANITE, 1.05), srgb(0x77777a), lm.K_OFFICE, floor_h=5.0, fid=70, cap=False)
        parts.band(l, inner, top + 5.0, top + 6.2, 0.4, shade(GRANITE, 1.1))
        parts.pyramid(l, parts.scaled(ring, 0.7), top + 6.2, CROWN - 0.0, srgb(0x9aa2a8), 'lm_metal')
        l.lathe('lm_metal', [(0.35, CROWN - 2.0), (0.12, CROWN + 8.0)], 6, srgb(0xcfd3d6), cx=parts.mean(ring)[0], cz=parts.mean(ring)[1], smooth=False)
        l.lathe('lm_glow', [(0.5, CROWN + 6.5), (0.5, CROWN + 7.8), (0.1, CROWN + 8.4)], 6, srgb(0xff3a2a), cx=parts.mean(ring)[0], cz=parts.mean(ring)[1], smooth=False)
        # the lit band at the crown's foot
        if lod == 0:
            parts.band(l, parts.scaled(ring, 0.71), top + 6.0, top + 6.6, 0.0, srgb(0xffe6b8), 'lm_glow', top=False)
        lods.append(l)
    hull = [(r, min(f * FLOOR, CROWN - 13.0)) for f, r in ts[:0]]
    # the collision: the footprints of the tiers over 20 floors as prisms to their tops, and the low ones as a block
    for f, r in ts:
        hull.append((r, min(f * FLOOR, CROWN - 13.0)))
    return common.report(asset, ID, lods, hull, lod_from=[0, 700])
