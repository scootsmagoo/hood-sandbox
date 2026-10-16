"""State Farm Arena ("Heartland Arena" in the game): the Hawks' arena, a broad grey-and-white bowl with a barrel roof,
and on its park-side frontage a wall of glass between huge white diagonal struts that fold into a canopy. The plan is
the data's; the frontage is its long straight edge. No signage.
Night: a band round the roof glows, the glass front is lit.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'state-farm-arena'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

WALL = srgb(0xb4b8bd)
WHITE = srgb(0xe8eaec)
GLASS = srgb(0x4b6a82)
H_WALL = 27.0
H_ROOF = 44.0


def front_edge(ring):
    """The longest edge that faces east: the frontage."""
    best = None
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        o = parts.outward(ring, i)
        if o[0] > 0 and abs(b[1] - a[1]) > abs(b[0] - a[0]) and (best is None or ln > best[0]):
            best = (ln, i)
    return best[1]


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    c = parts.mean(ring)
    fi = front_edge(ring)
    fa, fb = ring[fi], ring[(fi + 1) % len(ring)]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        # walls: everything but the glass frontage
        s = 1.0 if lm.area2(ring) > 0 else -1.0
        u = 0.0
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            ln = math.hypot(b[0] - a[0], b[1] - a[1])
            out = parts.outward(ring, i)
            if i == fi:
                # the glass front, leaning in a little; between the struts
                l.facade_quad('bld_glass', (a[0], 0, a[1]), (b[0], 0, b[1]), (b[0] - 4.0, H_WALL, b[1]), (a[0] - 4.0, H_WALL, a[1]), GLASS, u, lm.K_GLASS, 6, 0, 4, 40, True, hint=out)
            else:
                l.facade_quad('bld_wall', (a[0], 0, a[1]), (b[0], 0, b[1]), (b[0], H_WALL, b[1]), (a[0], H_WALL, a[1]), WALL, u, lm.K_VENUE, 4, 0, 4, 41 + i, True, hint=out)
            u += ln
        # roof: a shallow barrel of grey metal on a white fascia
        parts.band(l, ring, H_WALL - 2.2, H_WALL + 0.6, 0.6, WHITE)
        r1 = parts.scaled(ring, 0.80, c)
        for k in range(len(ring)):
            a, b = ring[k], ring[(k + 1) % len(ring)]
            a1, b1 = r1[k], r1[(k + 1) % len(ring)]
            l.quad('lm_metal', (a[0], H_WALL + 0.6, a[1]), (b[0], H_WALL + 0.6, b[1]), (b1[0], H_ROOF, b1[1]), (a1[0], H_ROOF, a1[1]), srgb(0x9aa0a6), hint=(a[0] - c[0], 1.0, a[1] - c[1]))
        l.cap('lm_metal', r1, H_ROOF, srgb(0x8d9399))
        # a glowing line under the fascia
        for k in range(len(ring)):
            a, b = ring[k], ring[(k + 1) % len(ring)]
            l.quad('lm_glow', (a[0], H_WALL - 2.8, a[1]), (b[0], H_WALL - 2.8, b[1]), (b[0], H_WALL - 2.4, b[1]), (a[0], H_WALL - 2.4, a[1]), srgb(0xffe2b0), hint=parts.outward(ring, k)) if lod == 0 else None
        # the struts on the frontage: pairs of huge white diagonals, and the canopy
        ln = math.hypot(fb[0] - fa[0], fb[1] - fa[1])
        dz = (fb[1] - fa[1]) / ln
        nb = 8 if lod == 0 else 4
        x0 = fa[0] + 0.2
        for k in range(nb + 1):
            t = k / nb
            z = fa[1] + (fb[1] - fa[1]) * t
            zn = z + (fb[1] - fa[1]) / nb * 0.5
            l.beam('lm_stone', (x0 + 7.0, 0.0, z), (x0 - 1.0, H_WALL + 1.0, zn), 3.0, 2.2, WHITE)
            if k < nb:
                l.beam('lm_stone', (x0 + 7.0, 0.0, z + (fb[1] - fa[1]) / nb), (x0 - 1.0, H_WALL + 1.0, zn), 3.0, 2.2, WHITE)
        cano = [(x0, fa[1]), (x0 + 11.0, fa[1]), (x0 + 11.0, fb[1]), (x0, fb[1])]
        l.cap('lm_stone', cano, 6.0, shade(WHITE, 0.92), up=False)
        l.cap('lm_stone', cano, 6.5, WHITE, up=True)
        l.poly('lm_stone', [(x0 + 11.0, 6.0, fa[1]), (x0 + 11.0, 6.0, fb[1]), (x0 + 11.0, 6.5, fb[1]), (x0 + 11.0, 6.5, fa[1])], WHITE, hint=(1, 0, 0))
        lods.append(l)
    hull = [(ring, H_WALL), (parts.scaled(ring, 0.8, c), H_ROOF)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 600])
