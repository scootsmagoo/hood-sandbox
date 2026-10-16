"""Atlanta Tower (2006): Hartsfield-Jackson's air traffic control tower, 121 m (398 ft) to the top of its mast, when it opened
the tallest control tower in North America. Drawn on the OSM footprint (its base, about 14 m across): a low base, a slender
tapering concrete shaft with a deep vertical fin on its south face and two lesser ribs, a flared neck under two equipment
floors, the wide cab at about 98 m with outward-leaning dark glass behind a catwalk, its roof overhanging, a plant room on
the roof, antennas and a mast with the red obstruction light. No lettering.

Night: the cab glows faintly from its consoles and its lit soffit, the obstruction light is red.
"""
import math

from airport import apt
from landmarks import lm, parts
from landmarks.lm import shade, srgb

ID = 'atl-control-tower'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CONCRETE = srgb(0xd9d6ce)
CONCRETE_D = srgb(0xbfbbb2)
BASE = srgb(0xc9c5bb)
METAL = srgb(0xb8bcc0)
DARK_METAL = srgb(0x50565c)
CAB_GLASS = srgb(0x22303a)
CONSOLE = srgb(0x3f6359)
SOFFIT = srgb(0xe9ebea)
ROOFC = srgb(0x6d7072)
RED = srgb(0xff2a18)

H_BASE = 7.5
H_SHAFT = 82.0
H_NECK = 89.0
H_CAB = 97.6          # the cab floor (and the catwalk)
H_SILL = 98.2
H_GLASS = 104.6
H_ROOF = 105.7
H_PENT = 108.6
H_TOP = 121.0
R0, R1 = 5.3, 4.3     # the shaft's radius at its foot and its top
R_NECK = 8.8
R_CAB0, R_CAB1 = 9.0, 10.3


def ngon(r, n, phase=0.0, cx=0.0, cz=0.0):
    return [(cx + r * math.cos(phase + 2 * math.pi * k / n), cz + r * math.sin(phase + 2 * math.pi * k / n)) for k in range(n)]


def frustum(l, mat, r0, y0, r1, y1, n, col, cx, cz, phase=0.0):
    a = [(cx + r0 * math.cos(phase + 2 * math.pi * k / n), y0, cz + r0 * math.sin(phase + 2 * math.pi * k / n)) for k in range(n)]
    b = [(cx + r1 * math.cos(phase + 2 * math.pi * k / n), y1, cz + r1 * math.sin(phase + 2 * math.pi * k / n)) for k in range(n)]
    l.skin(mat, [a, b], col, inside=(cx, (y0 + y1) / 2, cz))


def annulus(l, mat, r0, r1, y, n, col, cx, cz, up=True, phase=0.0):
    for k in range(n):
        a0, a1 = phase + 2 * math.pi * k / n, phase + 2 * math.pi * (k + 1) / n
        pts = [(cx + r0 * math.cos(a0), y, cz + r0 * math.sin(a0)), (cx + r1 * math.cos(a0), y, cz + r1 * math.sin(a0)),
               (cx + r1 * math.cos(a1), y, cz + r1 * math.sin(a1)), (cx + r0 * math.cos(a1), y, cz + r0 * math.sin(a1))]
        l.poly(mat, pts, col, hint=(0, 1 if up else -1, 0))


def shaft_r(y):
    return R0 + (R1 - R0) * (y - H_BASE) / (H_SHAFT - H_BASE)


def fin(l, cx, cz, ang, depth, width, y0, y1, col, n_slots=0):
    """A vertical rib standing out of the shaft along direction `ang`, tapering with it; its outer face a little narrower."""
    d = (math.cos(ang), math.sin(ang))
    t = (-d[1], d[0])

    def P(y, o, s):
        r = shaft_r(min(y, H_SHAFT)) - 0.3 + o
        return (cx + d[0] * r + t[0] * s, y, cz + d[1] * r + t[1] * s)
    hw, hwo = width / 2, width / 2 * 0.8
    for (o0, s0), (o1, s1), hint in (((0, -hw), (depth, -hwo), (-t[0], 0, -t[1])), ((depth, hwo), (0, hw), (t[0], 0, t[1])), ((depth, -hwo), (depth, hwo), (d[0], 0, d[1]))):
        l.quad('lm_stone', P(y0, o0, s0), P(y0, o1, s1), P(y1, o1, s1), P(y1, o0, s0), col, hint=hint)
    l.quad('lm_stone', P(y1, 0, -hw), P(y1, depth, -hwo), P(y1, depth, hwo), P(y1, 0, hw), shade(col, 1.05), hint=(0, 1, 0))
    if n_slots:
        # a slot of stair windows up the fin's face
        for k in range(n_slots):
            ya = y0 + 6.0 + k * (y1 - y0 - 10.0) / n_slots
            a, b = P(ya, depth + 0.03, -0.25), P(ya, depth + 0.03, 0.25)
            l.quad('lm_dark', a, b, (b[0], ya + 2.2, b[2]), (a[0], ya + 2.2, a[2]), srgb(0x1c2228), hint=(d[0], 0, d[1]))


def build(asset):
    apt.start()
    h = apt.hero(ID)
    ring = [tuple(p) for p in h['rings'][0]]
    cx, cz = parts.mean(ring)
    lods = []
    for lod in (0, 1, 2):
        l = lm.Lod(lod)
        n = (24, 10, 6)[lod]
        nc = (12, 12, 6)[lod]
        base = ring if lod == 0 else ngon(7.0, n, cx=cx, cz=cz)
        # the base: two storeys round the shaft's foot, a band over them
        l.ring_walls('bld_wall', base, 0, H_BASE, BASE, lm.K_CIVIC, floor_h=3.75, era=4, fid=801)
        parts.band(l, base, H_BASE - 0.6, H_BASE, 0.35, CONCRETE, top=True)
        l.cap('bld_roof', base, H_BASE, ROOFC)
        # the shaft
        frustum(l, 'lm_stone', R0, H_BASE, R1, H_SHAFT, n, CONCRETE, cx, cz)
        if lod < 2:
            # the fin on the south face (+z) and two lesser ribs
            fin(l, cx, cz, math.pi / 2, 2.6, 2.0, H_BASE, H_NECK - 1.0, CONCRETE_D, n_slots=14 if lod == 0 else 0)
            for a in (math.pi / 2 + 2.2, math.pi / 2 - 2.2):
                fin(l, cx, cz, a, 0.9, 1.2, H_BASE, H_SHAFT, CONCRETE_D)
        if lod == 0:
            # the lift joints of the slip-formed shaft
            y = H_BASE + 9.0
            while y < H_SHAFT - 2.0:
                r = shaft_r(y)
                frustum(l, 'lm_dark', r + 0.02, y, r + 0.02, y + 0.12, n, srgb(0x8a8780), cx, cz)
                y += 9.0
        # the neck flaring out to the equipment floors
        frustum(l, 'lm_stone', R1, H_SHAFT, R_NECK, H_NECK, n, CONCRETE, cx, cz)
        drum = ngon(R_NECK, nc, phase=math.pi / nc, cx=cx, cz=cz)
        l.ring_walls('bld_wall', drum, H_NECK, H_CAB, srgb(0xc6c8c8), lm.K_OFFICE, floor_h=2.9, era=4, fid=802)
        if lod == 0:
            # sun visors over the equipment floors' windows
            for yv in (H_NECK + 2.6, H_NECK + 5.5):
                vis = ngon(R_NECK + 0.7, nc, phase=math.pi / nc, cx=cx, cz=cz)
                annulus(l, 'lm_metal', R_NECK * 0.99, R_NECK + 0.7, yv, nc, METAL, cx, cz, up=True, phase=math.pi / nc)
                annulus(l, 'lm_metal', R_NECK * 0.99, R_NECK + 0.7, yv - 0.15, nc, shade(METAL, 0.8), cx, cz, up=False, phase=math.pi / nc)
                parts.band(l, vis, yv - 0.15, yv, 0.0, METAL, mat='lm_metal', top=False)
        # the catwalk: a ring of deck round the cab, its rail
        cat = ngon(R_CAB0 + 1.9, nc, phase=math.pi / nc, cx=cx, cz=cz)
        annulus(l, 'lm_metal', R_NECK * 0.98, R_CAB0 + 1.9, H_CAB, nc, METAL, cx, cz, up=True, phase=math.pi / nc)
        annulus(l, 'lm_metal', R_NECK * 0.98, R_CAB0 + 1.9, H_CAB - 0.35, nc, shade(METAL, 0.8), cx, cz, up=False, phase=math.pi / nc)
        parts.band(l, cat, H_CAB - 0.35, H_CAB, 0.0, METAL, mat='lm_metal', top=False)
        if lod == 0:
            parts.band(l, cat, H_CAB + 1.0, H_CAB + 1.1, 0.0, DARK_METAL, mat='lm_metal', top=False)
            for k in range(nc * 2):
                a = math.pi / nc + 2 * math.pi * k / (nc * 2)
                r = (R_CAB0 + 1.9) * math.cos(math.pi / nc) if k % 2 else R_CAB0 + 1.85
                p = (cx + r * math.cos(a), cz + r * math.sin(a))
                l.box('lm_metal', (p[0], H_CAB + 0.55, p[1]), (0.06, 1.1, 0.06), DARK_METAL, skip=('+y', '-y'))
        # the cab: a sill, the outward-leaning glass, mullions at the corners
        sill = ngon(R_CAB0, nc, cx=cx, cz=cz)
        parts.band(l, sill, H_CAB, H_SILL, 0.0, METAL, mat='lm_metal', top=False)
        frustum(l, 'lm_glass', R_CAB0, H_SILL, R_CAB1, H_GLASS, nc, CAB_GLASS, cx, cz)
        if lod < 2:
            # the consoles' glow seen through the lower glass, faint
            yb = H_SILL + 1.5
            rb = R_CAB0 + (R_CAB1 - R_CAB0) * (yb - H_SILL) / (H_GLASS - H_SILL)
            frustum(l, 'lm_glow', R_CAB0 + 0.05, H_SILL + 0.02, rb + 0.05, yb, nc, CONSOLE, cx, cz)
        if lod == 0:
            for k in range(nc):
                a = 2 * math.pi * k / nc
                l.beam('lm_metal', (cx + (R_CAB0 + 0.05) * math.cos(a), H_SILL, cz + (R_CAB0 + 0.05) * math.sin(a)),
                       (cx + (R_CAB1 + 0.05) * math.cos(a), H_GLASS, cz + (R_CAB1 + 0.05) * math.sin(a)), 0.16, 0.16, DARK_METAL)
        # the roof: an overhanging lid with a lit soffit, a plant room and the mast
        lid = ngon(R_CAB1 + 1.1, nc, cx=cx, cz=cz)
        annulus(l, 'lm_lit', R_CAB1 - 0.2, R_CAB1 + 1.1, H_GLASS, nc, SOFFIT, cx, cz, up=False)
        parts.band(l, lid, H_GLASS, H_ROOF, 0.0, METAL, mat='lm_metal', top=False)
        l.cap('bld_roof', lid, H_ROOF, ROOFC)
        pent = ngon(5.0, n if lod else 12, cx=cx, cz=cz)
        l.ring_walls('bld_wall', pent, H_ROOF, H_PENT, CONCRETE_D, lm.K_CIVIC, floor_h=2.9, era=4, fid=803)
        l.cap('bld_roof', pent, H_PENT, shade(ROOFC, 1.1))
        # the mast and the obstruction light
        if lod == 2:
            l.beam('lm_metal', (cx, H_PENT, cz), (cx, H_TOP - 0.5, cz), 0.6, 0.6, METAL)
        else:
            l.lathe('lm_metal', [(0.45, H_PENT), (0.38, H_PENT + 4.0), (0.24, H_PENT + 8.0), (0.15, H_TOP - 0.6)], 8 if lod == 0 else 5, METAL, cx=cx, cz=cz, smooth=False)
        l.box('lm_glow', (cx, H_TOP - 0.3, cz), (0.6, 0.6, 0.6), RED)
        if lod == 0:
            # crossbars and side lights on the mast, whips and dishes on the roof
            for y in (H_PENT + 3.0, H_PENT + 6.5):
                l.beam('lm_metal', (cx - 1.8, y, cz), (cx + 1.8, y, cz), 0.12, 0.12, METAL)
                l.beam('lm_metal', (cx, y, cz - 1.8), (cx, y, cz + 1.8), 0.12, 0.12, METAL)
            for dx, dz in ((1.8, 0.0), (-1.8, 0.0)):
                l.box('lm_glow', (cx + dx, H_PENT + 6.5, cz + dz), (0.3, 0.3, 0.3), RED)
            for k in range(6):
                a = 0.4 + 2 * math.pi * k / 6
                p = (cx + 8.2 * math.cos(a), cz + 8.2 * math.sin(a))
                l.beam('lm_metal', (p[0], H_ROOF, p[1]), (p[0], H_ROOF + 3.5 + (k % 2) * 2.0, p[1]), 0.08, 0.08, METAL, caps=False)
            for a in (1.2, 3.6):
                p = (cx + 6.6 * math.cos(a), cz + 6.6 * math.sin(a))
                l.box('lm_metal', (p[0], H_ROOF + 0.6, p[1]), (0.3, 1.2, 0.3), DARK_METAL)
                l.lathe('lm_metal', [(0.05, H_ROOF + 1.0), (0.8, H_ROOF + 1.45), (0.9, H_ROOF + 1.55)], 10, srgb(0xe6e6e2), cx=p[0], cz=p[1], smooth=False)
            # an entrance canopy on the base
            l.box('lm_metal', (cx, 3.6, cz - 8.2), (5.0, 0.35, 2.6), METAL)
            l.ring_walls('bld_glass', [(cx - 2.0, cz - 7.2), (cx + 2.0, cz - 7.2), (cx + 2.0, cz - 6.6), (cx - 2.0, cz - 6.6)][::-1], 0, 3.4, srgb(0x56788c), lm.K_GLASS, floor_h=3.4, era=4, fid=804)
        lods.append(l)
    hull = [(apt.offset(ring, -0.3), H_BASE), (ngon(R0 - 0.3, 12, cx=cx, cz=cz), H_SHAFT)]
    flatten = [(apt.offset(ring, 2.0), 25.0)]
    return apt.report(asset, ID, lods, hull, lod_from=[0, 700, 2000], flatten=flatten)
