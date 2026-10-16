"""Atlanta Central Library (Marcel Breuer, 1980): the brutalist inverted ziggurat of grey concrete, each of its five levels
reaching further out than the one under it, with a few deep slit windows. The plan is the data's (the top, widest level).
"""
from . import common, lm, parts
from .lm import shade, srgb

ID = 'atlanta-central-library'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CONCRETE = srgb(0xa7a6a0)
H = 21.4


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        n = 5
        h = H / n
        for k in range(n):
            s = 0.56 + 0.11 * k   # the lowest level is the smallest
            r = parts.scaled(ring, s)
            y0, y1 = k * h, (k + 1) * h
            l.ring_walls('bld_wall', r, y0, y1, shade(CONCRETE, 0.92 + 0.04 * (k % 2)), lm.K_INDUSTRIAL, floor_h=h, fid=171 + k, era=3, ao=False)
            # the underside of the overhang
            r0 = parts.scaled(ring, 0.56 + 0.11 * (k - 1)) if k else None
            if r0:
                for q in range(len(r)):
                    a, b = r[q], r[(q + 1) % len(r)]
                    a0, b0 = r0[q], r0[(q + 1) % len(r)]
                    l.quad('lm_stone', (a0[0], y0, a0[1]), (b0[0], y0, b0[1]), (b[0], y0, b[1]), (a[0], y0, a[1]), shade(CONCRETE, 0.7), hint=(0, -1, 0))
            else:
                l.cap('lm_stone', r, 0.0, shade(CONCRETE, 0.6), up=False)
        l.cap('bld_roof', ring, H, srgb(0x6a6a68))
        # deep slit windows: dark vertical strips on the lower levels' faces
        if lod == 0:
            r = parts.scaled(ring, 0.56 + 0.11 * 2)
            for q in range(len(r)):
                a, b = r[q], r[(q + 1) % len(r)]
                import math
                ln = math.hypot(b[0] - a[0], b[1] - a[1])
                m = max(1, int(ln // 7))
                out = parts.outward(r, q)
                for j in range(m):
                    t = (j + 0.5) / m
                    x, z = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                    ol = math.hypot(out[0], out[2])
                    px, pz = out[0] / ol * 0.1, out[2] / ol * 0.1
                    d = ((b[0] - a[0]) / ln * 0.5, (b[1] - a[1]) / ln * 0.5)
                    l.quad('lm_dark', (x - d[0] + px, 2 * h + 0.7, z - d[1] + pz), (x + d[0] + px, 2 * h + 0.7, z + d[1] + pz), (x + d[0] + px, 3 * h - 0.7, z + d[1] + pz), (x - d[0] + px, 3 * h - 0.7, z - d[1] + pz), srgb(0x1c1d1f), hint=out)
        lods.append(l)
    return common.report(asset, ID, lods, [(ring, H)], lod_from=[0, 420])
