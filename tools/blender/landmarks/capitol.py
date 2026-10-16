"""Georgia State Capitol (1889, Neoclassical): a cross-shaped limestone block of four storeys with pedimented
porticoes and, over the crossing, a drum with a colonnade, the gold dome (leaf from Dahlonega), a lantern and the statue
on top, 75 m in all. The plan is the data's rectangle (turned 34 degrees off the grid, as the building stands), the
rotunda is where Overture puts the dome part.
Night: the dome, the colonnade and the porticoes are floodlit.
"""
import math

from . import common, lm, parts
from .lm import circle, shade, srgb

ID = 'georgia-state-capitol'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

STONE = srgb(0xd3c7ad)
STONE_D = srgb(0xbfb294)
ROOF = srgb(0x55575a)
GOLD = srgb(0xffc43a)
H_WALL = 24.0
A, B, C, D = 38.0, 22.0, 22.0, 53.0  # half widths of the crossing (u, v) and of the wings


def cross_ring():
    return [(-C, -D), (C, -D), (C, -B), (A, -B), (A, B), (C, B), (C, D), (-C, D), (-C, B), (-A, B), (-A, -B), (-C, -B)]


def column(l, cu, cv, r, y0, y1, n, col, mat='lm_flood'):
    l.lathe(mat, [(r * 1.25, y0), (r * 1.25, y0 + 0.6), (r, y0 + 0.8), (r * 0.9, y1 - 1.0), (r * 1.0, y1 - 0.9), (r * 1.3, y1)], n, col, cx=cu, cz=cv, smooth=False)


def portico(l, side, lod):
    """A six-column portico on the +u (side=1) or -u face of the crossing, in the (u, v) frame."""
    u0 = A * side
    width, depth = 30.0, 9.0
    ucen = u0 + side * depth / 2
    # the terrace and the steps
    l.box('lm_stone', (ucen + side * 1.5, 1.5, 0), (depth + 3, 3.0, width + 6), shade(STONE_D, 0.95))
    l.box('lm_stone', (ucen + side * 3.0, 3.5, 0), (depth + 1, 1.0, width + 2), STONE_D)
    ncol = 6
    for k in range(ncol):
        v = -width / 2 + 2.0 + k * (width - 4.0) / (ncol - 1)
        column(l, u0 + side * (depth - 1.6), v, 1.05, 4.0, H_WALL - 2.0, 14 if lod == 0 else 8, STONE)
    # entablature and pediment (a triangular prism running along u)
    l.box('lm_flood', (ucen, H_WALL - 1.0, 0), (depth + 0.6, 2.0, width + 1.0), STONE)
    rise = 6.5
    hw = width / 2 + 0.5
    u_a, u_b = u0 + side * 0.2, u0 + side * (depth + 0.4)
    y0 = H_WALL
    tri = [(-hw, y0), (hw, y0), (0.0, y0 + rise)]
    l.poly('lm_flood', [(u_a, y, v) for v, y in tri], shade(STONE, 1.02), hint=(-side, 0, 0))
    l.poly('lm_flood', [(u_b, y, v) for v, y in tri], shade(STONE, 1.02), hint=(side, 0, 0))
    # the two raking sides and the underside
    l.quad('lm_flood', (u_a, y0, -hw), (u_b, y0, -hw), (u_b, y0 + rise, 0.0), (u_a, y0 + rise, 0.0), STONE_D, hint=(0, 1, -1))
    l.quad('lm_flood', (u_a, y0 + rise, 0.0), (u_b, y0 + rise, 0.0), (u_b, y0, hw), (u_a, y0, hw), STONE_D, hint=(0, 1, 1))
    l.quad('lm_flood', (u_a, y0, -hw), (u_b, y0, -hw), (u_b, y0, hw), (u_a, y0, hw), STONE_D, hint=(0, -1, 0))


def rotunda(l, lod, cu, cv):
    n = 28 if lod == 0 else 14
    # the drum
    l.prism('bld_wall', circle(12.0, n, cu, cv), H_WALL, 34.0, STONE, ROOF, lm.K_CIVIC, floor_h=4.5, fid=3, cap=False)
    l.lathe('lm_flood', [(12.0, 34.0), (13.0, 34.0), (13.0, 35.6), (11.7, 35.6)], n, shade(STONE, 1.05), cx=cu, cz=cv, smooth=False)
    # colonnade
    nc = 16 if lod == 0 else 8
    for k in range(nc):
        a = 2 * math.pi * k / nc
        column(l, cu + 11.2 * math.cos(a), cv + 11.2 * math.sin(a), 0.62, 35.6, 42.0, 8 if lod == 0 else 5, STONE)
    l.lathe('lm_flood', [(11.8, 42.0), (11.8, 44.0), (10.8, 44.0)], n, shade(STONE, 1.0), cx=cu, cz=cv, smooth=False)
    l.lathe('lm_flood', [(10.2, 35.6), (10.2, 42.0)], n, shade(STONE_D, 0.8), cx=cu, cz=cv, smooth=False)
    # the dome: a gilded ellipse, ribbed by smooth shading
    prof = []
    steps = 10 if lod == 0 else 5
    for k in range(steps + 1):
        t = (math.pi / 2) * 0.93 * k / steps
        prof.append((10.6 * math.cos(t), 44.0 + 16.5 * math.sin(t)))
    r_top, y_top = prof[-1]
    l.lathe('lm_gold', prof, n, GOLD, cx=cu, cz=cv, smooth=False)
    if lod == 0:
        # sixteen ribs up the dome, a shade deeper gold
        for k in range(16):
            ang = 2 * math.pi * k / 16
            pts = [(cu + (r + 0.12) * math.cos(ang), y + 0.05, cv + (r + 0.12) * math.sin(ang)) for r, y in prof[:-1]]
            for p, q in zip(pts, pts[1:]):
                l.beam('lm_gold', p, q, 0.45, 0.3, shade(GOLD, 0.8))
    # lantern, cupola, statue
    l.lathe('lm_flood', [(r_top + 0.6, y_top - 0.2), (r_top + 0.6, y_top + 0.6), (3.2, y_top + 0.6), (3.2, y_top + 6.2), (3.7, y_top + 6.2), (3.7, y_top + 6.8)], 12, shade(STONE, 1.05), cx=cu, cz=cv, smooth=False)
    l.lathe('lm_gold', [(3.7, y_top + 6.8), (3.0, y_top + 7.4), (1.6, y_top + 9.0), (0.6, y_top + 10.4), (0.0, y_top + 10.8)], 12, GOLD, cx=cu, cz=cv, smooth=False)
    l.lathe('lm_gold', [(0.9, y_top + 10.0), (0.7, y_top + 11.5), (0.45, y_top + 13.0), (0.25, 75.0), (0.0, 75.5)], 6, GOLD, cx=cu, cz=cv, smooth=False)


def plan(l, lod, cu, cv):
    ring = cross_ring()
    l.ring_walls('bld_wall', ring, 0, H_WALL, STONE, lm.K_CIVIC, floor_h=6.0, era=1, fid=7)
    l.cap('bld_roof', ring, H_WALL, ROOF)
    # belt courses over the ground floor and the second, a cornice, and a balustrade
    parts.band(l, ring, 6.6, 7.3, 0.4, shade(STONE, 0.97), 'lm_flood')
    if lod == 0:
        parts.band(l, ring, 14.5, 15.0, 0.3, shade(STONE, 0.97), 'lm_flood')
    parts.band(l, ring, H_WALL - 1.6, H_WALL + 0.2, 0.9, shade(STONE, 1.05), 'lm_flood')
    parts.band(l, ring, H_WALL + 0.2, H_WALL + 1.6, 0.3, STONE_D, 'lm_flood', top=False)
    # pilasters at the corners of the plan: the building's piers
    if lod == 0:
        for (pu, pv) in cross_ring():
            l.box('lm_flood', (pu, H_WALL / 2, pv), (2.2, H_WALL, 2.2), shade(STONE, 1.03))
    portico(l, 1, lod)
    portico(l, -1, lod)
    # pedimented bays at the wing ends
    for sv in (-1, 1):
        hw = 16.0
        v0 = D * sv
        rise = 5.0
        y0 = H_WALL + 1.6
        tri = [(-hw, y0), (hw, y0), (0.0, y0 + rise)]
        l.poly('lm_flood', [(u, y, v0 + sv * 0.25) for u, y in tri], STONE, hint=(0, 0, sv))
        l.poly('lm_flood', [(u, y, v0 - sv * 0.9) for u, y in tri], STONE, hint=(0, 0, -sv))
    rotunda(l, lod, cu, cv)


def build(asset):
    common.start()
    fp = common.footprint(ID)
    dome = fp['parts'][0]['rings'][0]
    cx = sum(p[0] for p in dome) / len(dome)
    cz = sum(p[1] for p in dome) / len(dome)
    _, _, ang, L, W = lm.min_obb(fp['ring'])
    lods = []
    for i in (0, 1):
        m = lm.Lod(i)
        plan(m, i, 0.0, 0.0)
        out = lm.Lod(i)
        out.merge(m, ang, cx, cz)
        lods.append(out)
    # collision: the cross to the cornice and the drum
    wc = lambda pts: [lm.to_world(u, v, cx, cz, ang) for u, v in pts]
    hull = [(wc(cross_ring()), H_WALL + 1.6), (wc(circle(11.8, 14)), 42.0)]
    return common.report(asset, ID, lods, hull, lod_from=[0, 520])
