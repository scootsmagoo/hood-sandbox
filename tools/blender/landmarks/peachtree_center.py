"""The Peachtree Center towers: four tall slabs of the 1960s to 80s office complex that the skybridges run between (the Harris,
International, North and South towers). One module builds all four: `build(asset)` looks the asset up in SPECS. Each is the data's
plan at the data's height: a low podium with a deep canopy over the street, a ribbed shaft (the structural piers stand proud of
the ribbon windows, the complex's look), a crown band and a stepped mechanical penthouse. No signage.
Night: the crown band is lit.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

# asset -> (footprints.json id, wall colour, pier colour, glass kind?, floor height, floors' hash id)
SPECS = {
    'peachtree-center-harris-tower': dict(wall=srgb(0xcfcabd), pier=srgb(0xe2ded2), glass=False, floor_h=3.7, fid=301, pent=0.50),
    'peachtree-center-international-tower': dict(wall=srgb(0x5a534b), pier=srgb(0x8a7f70), glass=True, floor_h=3.8, fid=311, pent=0.46),
    'peachtree-center-north-tower': dict(wall=srgb(0xb2a898), pier=srgb(0xcbc2b2), glass=False, floor_h=3.75, fid=321, pent=0.52),
    'peachtree-center-south-tower': dict(wall=srgb(0xb6ab9a), pier=srgb(0xcec5b5), glass=False, floor_h=3.75, fid=331, pent=0.5),
}
PODIUM = 9.0


def piers(l, ring, y0, y1, col, spacing=4.6, w=0.7, d=1.0):
    """Vertical piers standing proud of the wall along every edge of a ring (and one at every corner)."""
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        if ln < 2.5:
            continue
        ox, oz = (b[1] - a[1]) / ln * s, -(b[0] - a[0]) / ln * s   # outward
        k = max(1, int(round(ln / spacing)))
        for j in range(k + 1):
            if j == k:
                continue   # the next edge's first pier is this corner
            t = j / k
            x, z = a[0] + (b[0] - a[0]) * t + ox * d / 2, a[1] + (b[1] - a[1]) * t + oz * d / 2
            rot = -math.atan2(oz, ox) + math.pi / 2
            l.box('lm_stone', (x, (y0 + y1) / 2, z), (w, y1 - y0, d), col, rot=rot)


def build(asset):
    common.start()
    sp = SPECS[asset]
    fp = common.footprint(asset)
    ring = [tuple(p) for p in fp['ring']]
    # the data's plans have little jogs; the walls are the data's, the hull a simplified ring
    H = fp['height']
    c = parts.mean(ring)
    wall = sp['wall']
    lods = []
    shaft_mat = 'bld_glass' if sp['glass'] else 'bld_wall'
    kind = lm.K_GLASS if sp['glass'] else lm.K_OFFICE
    for lod in (0, 1):
        l = lm.Lod(lod)
        # podium: a dark stone base, then the canopy that runs round it over the street
        l.ring_walls('bld_wall', ring, 0, PODIUM, shade(wall, 0.62), lm.K_OFFICE, floor_h=4.5, fid=sp['fid'], era=3)
        parts.band(l, ring, PODIUM - 0.2, PODIUM + 0.9, 1.6, shade(wall, 0.78))
        # the shaft
        top = H - 8.0
        l.ring_walls(shaft_mat, ring, PODIUM + 0.9, top, wall, kind, floor_h=sp['floor_h'], fid=sp['fid'] + 1, era=3)
        if lod == 0:
            piers(l, ring, PODIUM + 0.9, top, sp['pier'])
        # the crown: a deep band, a flat roof and the stepped penthouse
        parts.band(l, ring, top, H, 0.8, shade(wall, 0.9))
        l.cap('bld_roof', ring, H, srgb(0x6c6c6a))
        if lod == 0:
            parts.band(l, ring, top + 1.0, top + 1.5, 0.9, srgb(0xffe6b8), 'lm_glow', top=False)
        pent = parts.scaled(ring, sp['pent'], c)
        l.prism('bld_wall', pent, H, H + 7.0, shade(wall, 0.8), srgb(0x77777a), lm.K_INDUSTRIAL, floor_h=3.5, fid=sp['fid'] + 2)
        l.prism('bld_wall', parts.scaled(pent, 0.55, c), H + 7.0, H + 11.0, shade(wall, 0.72), srgb(0x77777a), lm.K_INDUSTRIAL, floor_h=4.0, fid=sp['fid'] + 3)
        lods.append(l)
    hull = [(ring, H)]
    return common.report(asset, asset, lods, hull, lod_from=[0, 700])
