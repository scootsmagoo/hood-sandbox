"""Fountain of Rings, Centennial Olympic Park: a paved plaza with a shallow basin and five interlocking rings of jets, 3 and 2.
Not a building: a flat model with no collision. The rings are shown as pale stone inlays and white water jets, all one
colour (the rings' marks are not copied).
Night: the inlays glow cool white.

The jets are `lm_water`: columns whose vertices carry their height along the jet (COLOR_0 r: 0 at the foot, 1 at the tip) and
their phase in the show (g) and the compass direction they lean towards, the ring's centre (b: 0 to 1 round the circle); the game moves the vertices in the vertex shader (Landmarks.ts), so the jets rise and fall in waves
round the rings with no per-frame work on the CPU.
"""
import math

from . import common, lm, parts
from .lm import shade, srgb

ID = 'fountain-of-rings'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

R = 6.2
JET_Y0, JET_Y1 = 0.27, 3.0
JET_N = 48   # segments round a ring's water   # the jet's foot and tip (the game scales the height between them)
CENTRES = [(-11.5, -4.0), (0.0, -4.0), (11.5, -4.0), (-5.75, 2.4), (5.75, 2.4)]


def curtain(l, cx, cz, ring_index):
    """The water of one ring: a sheet of rows of points standing on the ring, the game's vertex shader raises it in waves and bends
    it inwards, and its fragment shader cuts it into streaks (so it reads as a crown of jets, not a wall). Per vertex: r the height
    along the jet (0 to 1), g the place round the ring (0 to 1, so the shader's wave and streaks run round it), b the bearing it
    leans towards, the ring's centre (0 to 1 round the circle)."""
    part = l.part('lm_water')
    rows = [JET_Y0 + (JET_Y1 - JET_Y0) * i / 3 for i in range(4)]
    start = 0.7 * ring_index   # the rings begin at different bearings, so their waves are out of step
    ids = []
    for i, y in enumerate(rows):
        row = []
        for j in range(JET_N + 1):
            a = start + 2 * math.pi * j / JET_N
            p = (cx + R * math.cos(a), y, cz + R * math.sin(a))
            n = (math.cos(a), 0.0, math.sin(a))
            col = (round(i / 3, 3), round(j / JET_N, 4), round((((a + math.pi) / (2 * math.pi)) % 1.0), 3), 1.0)
            row.append(part.vert(p, n, col, (0.0, 0.0), None, None, None))
        ids.append(row)
    for i in range(3):
        for j in range(JET_N):
            a, b, c, d = ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]
            part.t.append((a, d, c))
            part.t.append((a, c, b))


def build(asset):
    common.start()
    fp = common.footprint(ID)
    ring = [tuple(p) for p in fp['ring']]
    lods = []
    for lod in (0, 1):
        l = lm.Lod(lod)
        # the paving and a low kerb round the plaza; the model is a decal 14 cm above the ground (the ground here is flat)
        l.cap('lm_stone', ring, 0.2, srgb(0xb8b2a4), up=True)
        # a terrace: the plaza is level at the ground's highest point, with a stone retaining wall down to the lower side
        parts.band(l, ring, -6.0, 0.42, 0.15, srgb(0xcdc7b8))
        n = 36 if lod == 0 else 16
        for (cx, cz) in CENTRES:
            # the inlay: a pale ring in the paving, and the jets round it
            for k in range(n):
                a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
                r0, r1 = R - 0.35, R + 0.35
                pts = [(cx + r0 * math.cos(a0), 0.27, cz + r0 * math.sin(a0)), (cx + r1 * math.cos(a0), 0.27, cz + r1 * math.sin(a0)),
                       (cx + r1 * math.cos(a1), 0.27, cz + r1 * math.sin(a1)), (cx + r0 * math.cos(a1), 0.27, cz + r0 * math.sin(a1))]
                l.poly('lm_glow', pts, srgb(0xd6e8f2), hint=(0, 1, 0))
            if lod == 0:
                curtain(l, cx, cz, CENTRES.index((cx, cz)))
        lods.append(l)
    return common.report(asset, ID, lods, hull=[], lod_from=[0, 260], replaces={'overture': [], 'also': [], 'overlap': 2.0}, clear=[ring], extra={'datum': 'max'})
