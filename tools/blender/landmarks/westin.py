"""Westin Peachtree Plaza ("Peachtree Summit Plaza" in the game): John Portman's 1976 cylindrical hotel tower,
73 storeys and 220 m, a slightly tapering drum of mirrored blue-silver glass in a grid of dark mullions on a low
concrete podium with round concrete service towers, a dark band of plant floors under a crown ring, and a mast.
Night: the crown ring is lit, the red beacon on the mast, the windows by the facade shader.
The drum's centre and the podium come from the data (footprints.json: the 73-floor part and the building's ring).
"""
from . import common, lm
from .lm import circle, srgb, shade

ID = 'westin-peachtree-plaza'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CX, CZ = -16.0, 1.2          # the drum's centre in the data (the 73-floor building part)
R0, R1 = 19.8, 18.4          # radius at the foot and under the crown
H_TOP = 208.0                # the top of the glass
FLOOR = 2.86
CONCRETE = srgb(0x8d8a84)
GLASS = srgb(0x8ea6b8)
DARK = srgb(0x2a323a)
RING_GLOW = srgb(0xffd49a)


def tower(l, n):
    ring = circle(1.0, n, CX, CZ)
    ring = [(CX + (p[0] - CX) * R0, CZ + (p[1] - CZ) * R0) for p in ring]
    k = lambda y: (R0 + (R1 - R0) * (y - 8.0) / (H_TOP - 20.0)) / R0
    l.ring_walls('bld_glass', ring, 8, H_TOP - 12, GLASS, lm.K_GLASS, floor_h=FLOOR, fid=11, taper=k, centre=(CX, CZ))
    ra = R0 * k(H_TOP - 12)
    ring2 = [(CX + (p[0] - CX) * ra / R0, CZ + (p[1] - CZ) * ra / R0) for p in ring]
    k2 = lambda y: (ra + (R1 - ra) * (y - (H_TOP - 12)) / 12.0) / ra
    # plant floors: a darker band
    l.ring_walls('bld_glass', ring2, H_TOP - 12, H_TOP, DARK, lm.K_GLASS, floor_h=3.0, fid=12, taper=k2, centre=(CX, CZ))


def build(asset):
    common.start()
    l0, l1 = lm.Lod(0), lm.Lod(1)
    fp = common.footprint(ID)
    podium = [tuple(p) for p in fp['ring']]
    h_pod = 15.0

    for lod, n in ((l0, 40), (l1, 16)):
        l = lod
        tower(l, n)
        # the foot: a concrete drum under the glass
        l.lathe('lm_stone', [(R0 + 0.2, 0.0), (R0 + 0.2, 8.0), (R0 - 0.6, 8.0)], n, CONCRETE, cx=CX, cz=CZ, smooth=False)
        # crown: an overhanging ring, a lit band, the roof
        rc = R1 + 0.9
        l.lathe('lm_stone', [(R1, H_TOP), (rc, H_TOP), (rc, H_TOP + 3.2), (R1 - 0.2, H_TOP + 3.2)], n, shade(CONCRETE, 1.1), cx=CX, cz=CZ, smooth=False)
        l.lathe('lm_glow', [(rc + 0.05, H_TOP + 0.5), (rc + 0.05, H_TOP + 1.1)], n, RING_GLOW, cx=CX, cz=CZ, smooth=False)
        l.cap('bld_roof', circle(R1 - 0.2, n, CX, CZ), H_TOP + 3.2, srgb(0x6a6a68))
        l.lathe('lm_metal', [(0.5, H_TOP + 3.2), (0.3, H_TOP + 14.0), (0.1, 220.0)], 6, srgb(0xbfc3c6), cx=CX, cz=CZ, smooth=False)
        l.lathe('lm_glow', [(0.7, 218.6), (0.7, 220.0), (0.2, 220.8)], 8, srgb(0xff2a1a), cx=CX, cz=CZ, smooth=False)
        # the podium: Portman's concrete base, the data's ring, dark and heavy
        l.prism('bld_wall', podium, 0, h_pod, srgb(0x7b7872), srgb(0x5a5a58), lm.K_OFFICE, floor_h=4.2, fid=13)
    l = l0
    # round concrete stair and lift drums, taller than the podium
    for (cx, cz, r, h) in [(-50.0, -6.0, 5.6, 36.0), (42.0, 6.0, 5.0, 28.0), (-26.0, 19.0, 4.2, 26.0)]:
        l.prism('bld_wall', circle(r, 14, cx, cz), 0, h, shade(CONCRETE, 0.95), srgb(0x66666a), lm.K_OFFICE, floor_h=4.0, fid=14 + int(h))
    hull = [(circle(R0 * 0.97, 16, CX, CZ), H_TOP + 3.0), (podium, h_pod)]
    return common.report(asset, ID, [l0, l1], hull, lod_from=[0, 700])
