"""Rialto Center for the Arts, 1916 (a former movie palace, now a university theatre): a brick street front with a cream
terracotta frieze and cornice, a deep blank marquee over the doors on the Forsyth Street side (no lettering), and the stage house, a
taller block at the back of the plan. The plan is the data's pentagon; the front is the long edge that faces Forsyth Street.
Night: the marquee's underside glows.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'rialto-center-for-the-arts'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

BRICK = srgb(0x9c5d49)
TERRA = srgb(0xdccdb0)
H = 23.0
H_STAGE = 32.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    n = len(ring)
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    # the front: the longest edge (it faces Forsyth Street, the road that runs along the data's south-east side)
    k = max(range(n), key=lambda i: math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]))
    a, b = ring[k], ring[(k + 1) % n]
    ln = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uz = (b[0] - a[0]) / ln, (b[1] - a[1]) / ln
    ox, oz = uz * s, -ux * s                   # outward
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    rear = max(ring, key=lambda p: -((p[0] - mid[0]) * ox + (p[1] - mid[1]) * oz))   # the vertex furthest behind the front
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        l.ring_walls('bld_wall', ring, 0, H - 4.0, BRICK, lm.K_BRICK, floor_h=5.0, band=5.0, era=1, fid=401)
        # the terracotta frieze and the cornice
        l.ring_walls('bld_wall', ring, H - 4.0, H, TERRA, lm.K_CIVIC, floor_h=4.0, era=1, fid=402)
        parts.band(l, ring, H - 0.5, H + 0.9, 0.7, shade(TERRA, 1.04))
        l.cap('bld_roof', ring, H + 0.9, srgb(0x6a6a68))
        # the stage house: a taller block over the back of the plan
        stage = parts.scaled(ring, 0.58, rear)
        l.prism('bld_wall', stage, H, H_STAGE, shade(BRICK, 0.9), srgb(0x6a6a68), lm.K_BRICK, floor_h=5.0, era=1, fid=403)
        parts.band(l, stage, H_STAGE - 0.4, H_STAGE + 0.5, 0.4, shade(TERRA, 0.95))
        # the marquee: a deep slab over the doors, hung from the front on rods, its underside lit; blank
        cx, cz = mid[0] + ox * 0.0, mid[1] + oz * 0.0
        half = min(9.0, ln * 0.2)
        proj = 3.2
        def at(t, d, y):
            return (cx + ux * t + ox * d, y, cz + uz * t + oz * d)
        y0, y1 = 5.6, 6.6
        corners = [(-half, 0.0), (half, 0.0), (half, proj), (-half, proj)]
        l.poly('lm_metal', [at(t, d, y1) for t, d in corners], shade(TERRA, 0.85), hint=(0, 1, 0))
        if lod == 0:
            l.poly('lm_glow', [at(t, d, y0) for t, d in corners], srgb(0xffd9a0), hint=(0, -1, 0))
            for t, d, nx, nz in ((-half, proj, 0, 1), (half, proj, 0, 1)):
                pass
            # the four faces of the slab's edge
            for (t0, d0), (t1, d1) in zip(corners, corners[1:] + corners[:1]):
                l.quad('lm_metal', at(t0, d0, y0), at(t1, d1, y0), at(t1, d1, y1), at(t0, d0, y1), shade(TERRA, 0.75), hint=(((d0 + d1) / 2 - proj / 2) * ox + ((t0 + t1) / 2) * ux, 0.0, ((d0 + d1) / 2 - proj / 2) * oz + ((t0 + t1) / 2) * uz))
            for t in (-half + 0.8, half - 0.8):
                l.beam('lm_metal', at(t, proj - 0.5, y1), at(t, 0.1, y1 + 3.2), 0.12, 0.12, srgb(0x8d8f91))
            # the doors: dark openings under it, and a blank lit blade above (no lettering)
            for t in (-half * 0.6, 0.0, half * 0.6):
                l.box('lm_dark', (cx + ux * t + ox * 0.15, 2.0, cz + uz * t + oz * 0.15), (2.2, 4.0, 0.3), srgb(0x1a1a1a), rot=-math.atan2(uz, ux))
        lods.append(l)
    hull = [(ring, H), (stage, H_STAGE)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 600])
