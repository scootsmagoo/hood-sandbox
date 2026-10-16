"""Georgia Aquarium: a long, low, blue-grey building of rolled metal panels, its entrance a curved glass prow that leans
in under a slender white blade, with a sweeping canopy on white columns along the park side. The plan is the data's;
the prow is where its outline rounds off. No lettering.
Night: the prow is lit from inside, a blue line runs under the canopy.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'georgia-aquarium'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

PANEL = srgb(0x7f95a6)
PANEL_D = srgb(0x5d7488)
WHITE = srgb(0xe9ecee)
GLASS = srgb(0x4d7a96)
H = 13.0


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    c = parts.mean(ring)
    # the prow: the rounded part of the outline (east end, north of the straight frontage)
    prow = [i for i in range(len(ring)) if ring[i][0] > 74 and ring[i][1] > 44 and ring[(i + 1) % len(ring)][0] > 74 and ring[(i + 1) % len(ring)][1] > 44]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        u = 0.0
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            ln = math.hypot(b[0] - a[0], b[1] - a[1])
            out = parts.outward(ring, i)
            if i in prow:
                # the glass prow: leans in, taller than the rest
                l.facade_quad('bld_glass', (a[0], 0, a[1]), (b[0], 0, b[1]), (b[0] - 5.0, 24.0, b[1] - 2.0), (a[0] - 5.0, 24.0, a[1] - 2.0), GLASS, u, lm.K_GLASS, 6, 0, 4, 51, True, hint=out)
            else:
                l.facade_quad('bld_wall', (a[0], 0, a[1]), (b[0], 0, b[1]), (b[0], H, b[1]), (a[0], H, a[1]), PANEL if i % 3 else PANEL_D, u, lm.K_VENUE, 3, 0, 4, 52 + i, True, hint=out)
            u += ln
        l.cap('bld_roof', ring, H, srgb(0x8a929a))
        # the prow's roof, sloping up to the blade
        pr = [ring[i] for i in prow] + [ring[(prow[-1] + 1) % len(ring)]]
        if len(pr) >= 3:
            pts = [(p[0] - 5.0, 24.0, p[1] - 2.0) for p in pr] + [(pr[-1][0] - 0.0, H, pr[-1][1]), (pr[0][0], H, pr[0][1])]
            l.poly('lm_glass', pts, srgb(0x6ea0bc), hint=(0, 1, 0))
            tip = pr[len(pr) // 2]
            l.beam('lm_stone', (tip[0] - 4.0, 18.0, tip[1] - 2.0), (tip[0] - 8.0, 40.0, tip[1] - 6.0), 1.2, 3.0, WHITE)
        # the canopy on the park side (the straight frontage, x = 72): a sweep of white on columns
        fa, fb = (72.3, -55.0), (72.3, 43.0)
        cano = [(fa[0], fa[1]), (fa[0] + 11.0, fa[1] + 6.0), (fb[0] + 11.0, fb[1] - 4.0), (fb[0], fb[1])]
        l.cap('lm_stone', cano, 7.0, shade(WHITE, 0.9), up=False)
        l.cap('lm_stone', cano, 7.7, WHITE, up=True)
        for k in range(len(cano)):
            a, b = cano[k], cano[(k + 1) % len(cano)]
            l.quad('lm_stone', (a[0], 7.0, a[1]), (b[0], 7.0, b[1]), (b[0], 7.7, b[1]), (a[0], 7.7, a[1]), WHITE, hint=parts.outward(cano, k))
        ncol = 7 if lod == 0 else 3
        for k in range(ncol):
            t = (k + 0.5) / ncol
            x = cano[1][0] + (cano[2][0] - cano[1][0]) * t - 0.5
            z = cano[1][1] + (cano[2][1] - cano[1][1]) * t
            parts.column(l, x, z, 0.5, 0.0, 7.0, 10 if lod == 0 else 6, WHITE)
        if lod == 0:
            for k in range(len(cano) - 1):
                a, b = cano[k], cano[k + 1]
                l.quad('lm_glow', (a[0], 6.7, a[1]), (b[0], 6.7, b[1]), (b[0], 7.0, b[1]), (a[0], 7.0, a[1]), srgb(0x7fc4ff), hint=parts.outward(cano, k)) if k == 1 else None
        # rooftop plant
        l.box('lm_stone', (-30.0, H + 2.0, -10.0), (30.0, 4.0, 20.0), srgb(0x9aa0a6))
        lods.append(l)
    hull = [(ring, H)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 560])
