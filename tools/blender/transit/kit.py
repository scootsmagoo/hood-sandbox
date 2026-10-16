"""The Peach Rapid Transit station and tunnel kit: the parts the game instances along platforms, concourses, entrances and
tunnels (the pipeline sweeps the platforms, stairs, escalators and tunnel tubes themselves). 1970s-80s brutalist stations:
raw concrete, brown and orange tile, dark bronze frames, fluorescent tubes. No logos or lettering: sign faces are blank
(`tr_signface`, 0..1 UVs across each face, u to the viewer's right, v up) and the game draws on them.

Every part is a top-level node named for it, at the origin, in its own frame (+X left, +Y up, +Z forward), holding
`<name>_lod0` and, for the bigger parts, `<name>_lod1`:

  column        platform column, 0.7 m square shaft, base and flared capital, floor to the 4.5 m ceiling   origin: floor centre
  bench         2.0 m along X, seat top 0.45, the sitter faces +Z                                           origin: floor centre
  sign_name     hanging station-name sign, faces 3.0 x 0.55 on +Z and -Z, two rods up 0.8 m                 origin: face centre
  screen        hanging next-train display, faces 1.2 x 0.4 (`tr_screen`) on +Z and -Z, rods up 0.6 m       origin: face centre
  fare_gate     cabinet 0.26 wide, 0.85 tall, 1.6 long (Z, the walking direction), reader at the -Z end    origin: floor centre
  pylon         entrance pylon 4.2 m, 0.6 x 0.6, a lit sign box at the top (four `tr_signface` sides)       origin: floor centre
  canopy        entrance canopy over a 3.2 m stair from z = 0 (street, top step) down toward +Z for 9 m    origin: top of the stairs
  railing       1.0 m section along X (-0.5..0.5), 1.0 m tall: a post, top and mid rails               origin: floor centre
  lamp_tube     1.5 m ceiling fluorescent along X, its lens facing down                                    origin: its top (hangs below)
  tunnel_bay    12 m of tunnel side-wall details (wall plane x = 0, details toward +X up to 0.4 m, z -6..6, y = 0 the track bed)
  signal        track signal head on a wall bracket, red/yellow/green lenses facing +Z, 0.9 m tall        origin: the bracket's wall foot (wall x = 0)
  bin           station trash bin, 0.9 m                                                                   origin: floor centre
  map_board     wall-mounted framed map, 2.0 x 1.2 m, face toward +Z                                       origin: bottom centre of the frame, on the wall

Materials: tr_steel, tr_dark, tr_glass, tr_interior, tr_light, tr_concrete, tr_tile, tr_signface, tr_screen, tr_lightface
(emissive lens: its colour in COLOR_0). COLOR_0: linear albedo, alpha the baked ambient occlusion.
"""
import math

from hoodlib import scene
from . import tk
from .tk import Geo, box, chamfer_rect, hexa, mix, prism_x, prism_y, revolve, shade, sign_quad, srgb, tube

VERTEX_COLOR = 'ACTIVE'

CONCRETE = srgb(0x9c968b)
CONCRETE_DK = srgb(0x77716a)
CONCRETE_LT = srgb(0xb3ada2)
TILE_BROWN = srgb(0x7a4426)
TILE_ORANGE = srgb(0xb8642c)
STEEL = srgb(0xa9adb0)
STEEL_DK = srgb(0x6e7276)
BRONZE = srgb(0x3b3026)
DARK = srgb(0x262729)
RUBBER = srgb(0x1f2021)
WHITE = (1.0, 1.0, 1.0)
PAINT_WHITE = srgb(0xd9d6cc)
PAINT_BLUE = srgb(0x1f4f9a)
LAMP_WARM = srgb(0xfff1d6)
LENS_RED, LENS_YELLOW, LENS_GREEN = srgb(0xff2a14), srgb(0xffb014), srgb(0x22e07a)
LENS_BLUE = srgb(0x2a6cff)
CABLE = srgb(0x1c1c1c)
GALV = srgb(0x8e9396)

PARTS = ['column', 'bench', 'sign_name', 'screen', 'fare_gate', 'pylon', 'canopy', 'railing', 'lamp_tube', 'tunnel_bay', 'signal', 'bin', 'map_board']
FLOOR_STANDING = {'column', 'bench', 'fare_gate', 'pylon', 'canopy', 'railing', 'bin'}
FARE_GATE_BOX = (0.26, 0.85, 1.6)


def grime(base, y0=0.0, y1=1.2, k=0.75):
    """A colour darkening toward the floor."""
    return lambda p: mix(shade(base, k), base, min(1.0, max(0.0, (p[1] - y0) / (y1 - y0))))


# ------------------------------------------------------------------------------------------- parts
def column(lod):
    g = Geo(lod)
    base = chamfer_rect(0.42, 0.42, 0.04)
    prism_y(g, 'tr_concrete', base, 0.0, 0.16, CONCRETE_DK, top=True)
    if lod == 0:
        # the shaft: chamfered corners and a vertical groove down the middle of each face (board-marked concrete)
        ring = []
        for k in range(4):
            a = k * math.pi / 2
            c, s = math.cos(a), math.sin(a)
            for x, z in ((0.35, -0.29), (0.35, -0.03), (0.33, -0.03), (0.33, 0.03), (0.35, 0.03), (0.35, 0.29)):
                ring.append((x * c - z * s, x * s + z * c))
        prism_y(g, 'tr_concrete', ring, 0.16, 3.9, CONCRETE, top=False, side_col=lambda i: shade(CONCRETE, 0.97 + 0.06 * ((i // 6) % 2)) if i >= 0 else CONCRETE)
        # a band of orange tile at the foot (the platforms' wainscot)
        prism_y(g, 'tr_tile', chamfer_rect(0.36, 0.36, 0.06), 0.16, 1.1, TILE_ORANGE, top=True)
        # the flared capital and the ceiling slab it carries
        lo = [(0.35, 3.9, -0.35), (-0.35, 3.9, -0.35), (-0.35, 3.9, 0.35), (0.35, 3.9, 0.35)]
        hi = [(0.66, 4.38, -0.66), (-0.66, 4.38, -0.66), (-0.66, 4.38, 0.66), (0.66, 4.38, 0.66)]
        hexa(g, 'tr_concrete', lo + hi, CONCRETE_LT, skip=('-y', '+y'))
        prism_y(g, 'tr_concrete', chamfer_rect(0.68, 0.68, 0.02), 4.38, 4.5, CONCRETE_LT, top=True)
    else:
        prism_y(g, 'tr_concrete', chamfer_rect(0.35, 0.35, 0.06), 1.1, 3.9, CONCRETE, top=False)
        prism_y(g, 'tr_tile', chamfer_rect(0.36, 0.36, 0.06), 0.16, 1.1, TILE_ORANGE, top=True)
        lo = [(0.35, 3.9, -0.35), (-0.35, 3.9, -0.35), (-0.35, 3.9, 0.35), (0.35, 3.9, 0.35)]
        hi = [(0.68, 4.5, -0.68), (-0.68, 4.5, -0.68), (-0.68, 4.5, 0.68), (0.68, 4.5, 0.68)]
        hexa(g, 'tr_concrete', lo + hi, CONCRETE_LT, skip=('-y',))
    return g


def bench(lod):
    g = Geo(lod)
    # two concrete pedestals, a seat and a back of steel slats on bronze brackets
    for x in (-0.68, 0.68):
        prof = [(-0.24, 0.0), (0.2, 0.0), (0.2, 0.06), (0.16, 0.39), (-0.2, 0.39), (-0.24, 0.3)]
        prism_x(g, 'tr_concrete', prof, x - 0.09, x + 0.09, grime(CONCRETE, 0.0, 0.4, 0.8))
        if lod == 0:
            # the back bracket: a bronze flat bar up from the pedestal's back
            g.beam('tr_dark', (x, 0.36, -0.2), (x, 0.88, -0.28), 0.05, 0.02, BRONZE)
    n = 5 if lod == 0 else 1
    z0, z1 = -0.23, 0.21
    for k in range(n):
        if n == 1:
            za, zb = z0, z1
        else:
            w = (z1 - z0 - (n - 1) * 0.02) / n
            za = z0 + k * (w + 0.02)
            zb = za + w
        box(g, 'tr_steel', (-1.0, 0.41, za), (1.0, 0.45, zb), STEEL, skip=('-y',) if lod else ())
    # the back: slats leaning back a little
    m = 3 if lod == 0 else 1
    for k in range(m):
        y0 = 0.56 + k * 0.11 if m > 1 else 0.56
        y1 = y0 + (0.08 if m > 1 else 0.3)
        zb0, zb1 = -0.25 - (y0 - 0.56) * 0.15, -0.25 - (y1 - 0.56) * 0.15
        corners = [(-1.0, y0, zb0), (1.0, y0, zb0), (1.0, y0, zb0 - 0.03), (-1.0, y0, zb0 - 0.03),
                   (-1.0, y1, zb1), (1.0, y1, zb1), (1.0, y1, zb1 - 0.03), (-1.0, y1, zb1 - 0.03)]
        hexa(g, 'tr_steel', corners, STEEL)
    return g


def _hanging_box(g, lod, fw, fh, depth, border, face_mat, rods_up, rod_x, frame_col):
    """A double-sided hanging box: faces fw x fh on +Z and -Z (0..1 UVs), a dark frame `border` wide round them, rods up."""
    hw, hh, hd = fw / 2 + border, fh / 2 + border, depth / 2
    if lod == 0:
        # the frame: the rings round the faces, the outer edges
        for z, h in ((hd, 1), (-hd, -1)):
            for a, b in (((-hw, -hh), (hw, -fh / 2)), ((-hw, fh / 2), (hw, hh)), ((-hw, -fh / 2), (-fw / 2, fh / 2)), ((fw / 2, -fh / 2), (hw, fh / 2))):
                g.poly('tr_dark', [(a[0], a[1], z), (b[0], a[1], z), (b[0], b[1], z), (a[0], b[1], z)], frame_col, hint=(0, 0, h))
        box(g, 'tr_dark', (-hw, -hh, -hd), (hw, hh, hd), frame_col, skip=('+z', '-z'))
        inset = 0.006
        # a shallow lip so the face sits in the frame
        for z, h in ((hd, 1), (-hd, -1)):
            zi = z - h * inset
            for (a, b, n) in (((-fw / 2, -fh / 2), (fw / 2, -fh / 2), (0, 1, 0)), ((-fw / 2, fh / 2), (fw / 2, fh / 2), (0, -1, 0))):
                g.poly('tr_dark', [(a[0], a[1], z), (b[0], b[1], z), (b[0], b[1], zi), (a[0], a[1], zi)], frame_col, hint=n)
            for x, n in ((-fw / 2, (1, 0, 0)), (fw / 2, (-1, 0, 0))):
                g.poly('tr_dark', [(x, -fh / 2, z), (x, fh / 2, z), (x, fh / 2, zi), (x, -fh / 2, zi)], frame_col, hint=n)
    else:
        box(g, 'tr_dark', (-hw, -hh, -hd), (hw, hh, hd), frame_col)
        inset = -0.002
    sign_quad(g, face_mat, (0.0, 0.0, hd - inset), (1, 0, 0), (0, 1, 0), fw, fh)
    sign_quad(g, face_mat, (0.0, 0.0, -hd + inset), (-1, 0, 0), (0, 1, 0), fw, fh)
    for x in (-rod_x, rod_x):
        if lod == 0:
            tube(g, 'tr_steel', (x, hh, 0.0), (x, hh + rods_up, 0.0), 0.012, 6, STEEL_DK, caps=False)
            box(g, 'tr_steel', (x - 0.06, hh + rods_up - 0.01, -0.06), (x + 0.06, hh + rods_up, 0.06), STEEL_DK, skip=('+y',))
        else:
            box(g, 'tr_steel', (x - 0.01, hh, -0.01), (x + 0.01, hh + rods_up, 0.01), STEEL_DK, skip=('-y', '+y'))


def sign_name(lod):
    g = Geo(lod)
    _hanging_box(g, lod, 3.0, 0.55, 0.12, 0.05, 'tr_signface', 0.8, 1.1, BRONZE)
    return g


def screen(lod):
    g = Geo(lod)
    _hanging_box(g, lod, 1.2, 0.4, 0.16, 0.06, 'tr_screen', 0.6, 0.45, DARK)
    if lod == 0:
        # a little hood over each face against the glare
        for z, h in ((0.08, 1), (-0.08, -1)):
            za, zb = sorted((z, z + h * 0.08))
            box(g, 'tr_dark', (-0.66, 0.26, za), (0.66, 0.275, zb), DARK)
    return g


def fare_gate(lod):
    g = Geo(lod)
    hx, H, hz = FARE_GATE_BOX[0] / 2, FARE_GATE_BOX[1], FARE_GATE_BOX[2] / 2
    # plinth, body, a chamfered top
    box(g, 'tr_dark', (-hx - 0.005, 0.0, -hz - 0.005), (hx + 0.005, 0.08, hz + 0.005), RUBBER, skip=('-y',))
    if lod == 0:
        box(g, 'tr_steel', (-hx, 0.08, -hz), (hx, H - 0.05, hz), grime(STEEL, 0.0, 0.8, 0.8), skip=('-y', '+y'))
        lo = [(hx, H - 0.05, -hz), (-hx, H - 0.05, -hz), (-hx, H - 0.05, hz), (hx, H - 0.05, hz)]
        hi = [(hx - 0.035, H, -hz + 0.02), (-hx + 0.035, H, -hz + 0.02), (-hx + 0.035, H, hz - 0.02), (hx - 0.035, H, hz - 0.02)]
        hexa(g, 'tr_steel', lo + hi, shade(STEEL, 1.05), skip=('-y',))
        # a dark glass top strip and the panel seams
        box(g, 'tr_dark', (-hx + 0.04, H, -hz + 0.35), (hx - 0.04, H + 0.004, hz - 0.1), DARK, skip=('-y',))
        for z in (-0.25, 0.35):
            for s in (1, -1):
                x = s * (hx + 0.002)
                g.poly('tr_dark', [(x, 0.12, z - 0.006), (x, 0.12, z + 0.006), (x, H - 0.08, z + 0.006), (x, H - 0.08, z - 0.006)], DARK, hint=(s, 0, 0))
        # the reader on top at the entry end (-Z): a sloped head with a small display facing the one who comes, a lamp
        lo = [(0.1, H, -hz + 0.04), (-0.1, H, -hz + 0.04), (-0.1, H, -hz + 0.34), (0.1, H, -hz + 0.34)]
        hi = [(0.1, H + 0.05, -hz + 0.06), (-0.1, H + 0.05, -hz + 0.06), (-0.1, H + 0.12, -hz + 0.34), (0.1, H + 0.12, -hz + 0.34)]
        hexa(g, 'tr_dark', lo + hi, DARK, skip=('-y',))
        a, b = (0.0, H + 0.065, -hz + 0.14), (0.0, H + 0.1, -hz + 0.27)
        up = tk.vnorm(tk.vsub(b, a))
        ctr = tuple((a[k] + b[k]) / 2 + (0.003 if k == 1 else 0.0) for k in range(3))
        sign_quad(g, 'tr_screen', ctr, (1, 0, 0), (0.0, up[1], up[2]), 0.15, 0.13)
        box(g, 'tr_lightface', (-0.04, H + 0.12, -hz + 0.29), (0.04, H + 0.13, -hz + 0.33), LENS_GREEN, skip=('-y',))
        # direction lamps on both end faces
        for z, h, col in ((-hz - 0.002, -1, LENS_GREEN), (hz + 0.002, 1, LENS_RED)):
            g.poly('tr_lightface', [(-0.05, 0.62, z), (0.05, 0.62, z), (0.05, 0.72, z), (-0.05, 0.72, z)], col, hint=(0, 0, h))
        # the low paddle stubs, both sides
        for s in (1, -1):
            xa, xb = sorted((s * hx, s * (hx + 0.16)))
            corners = [(xa, 0.42, 0.06), (xb, 0.46, 0.06), (xb, 0.46, 0.08), (xa, 0.42, 0.08), (xa, 0.78, 0.06), (xb, 0.74, 0.06), (xb, 0.74, 0.08), (xa, 0.78, 0.08)]
            hexa(g, 'tr_dark', corners, shade(RUBBER, 1.6))
    else:
        box(g, 'tr_steel', (-hx, 0.08, -hz), (hx, H, hz), STEEL, skip=('-y',))
        box(g, 'tr_dark', (-0.1, H, -hz + 0.04), (0.1, H + 0.1, -hz + 0.34), DARK, skip=('-y',))
        for s in (1, -1):
            xa, xb = sorted((s * hx, s * (hx + 0.16)))
            box(g, 'tr_dark', (xa, 0.44, 0.06), (xb, 0.76, 0.08), shade(RUBBER, 1.6), skip=())
    return g


def pylon(lod):
    g = Geo(lod)
    h = 0.3
    prism_y(g, 'tr_concrete', chamfer_rect(0.36, 0.36, 0.03), 0.0, 0.3, CONCRETE_DK, top=True)
    # the shaft: dark bronze panels with vertical seams
    prism_y(g, 'tr_dark', chamfer_rect(h, h, 0.03), 0.3, 3.4, grime(BRONZE, 0.3, 1.5, 0.85), top=False)
    if lod == 0:
        for k in range(4):
            a = k * math.pi / 2
            c, s = math.cos(a), math.sin(a)
            for off in (-0.1, 0.1):
                p = [(h + 0.002, 0.35, off - 0.006), (h + 0.002, 0.35, off + 0.006), (h + 0.002, 3.35, off + 0.006), (h + 0.002, 3.35, off - 0.006)]
                g.poly('tr_dark', [(x * c - z * s, y, x * s + z * c) for x, y, z in p], shade(BRONZE, 0.55), hint=(c, 0, s))
    # the sign box: four faces in a dark frame, a cap
    y0, y1 = 3.4, 4.12
    fw, fh = 0.54, y1 - y0 - 0.08
    frame = 0.31
    box(g, 'tr_dark', (-frame, y0 - 0.04, -frame), (frame, y0, frame), DARK)
    box(g, 'tr_dark', (-frame, y1, -frame), (frame, 4.2, frame), DARK, skip=('-y',))
    yc = (y0 + y1) / 2
    for k, (n, right) in enumerate((((0, 0, 1), (1, 0, 0)), ((1, 0, 0), (0, 0, -1)), ((0, 0, -1), (-1, 0, 0)), ((-1, 0, 0), (0, 0, 1)))):
        ctr = (n[0] * (frame - 0.01), yc, n[2] * (frame - 0.01))
        sign_quad(g, 'tr_signface', ctr, right, (0, 1, 0), fw, fh + 0.04)
    # corner posts of the frame
    for sx in (1, -1):
        for sz in (1, -1):
            xa, xb = sorted((sx * (frame - 0.03), sx * frame))
            za, zb = sorted((sz * (frame - 0.03), sz * frame))
            box(g, 'tr_dark', (xa, y0, za), (xb, y1, zb), DARK, skip=('-y', '+y'))
    return g


def canopy(lod):
    g = Geo(lod)
    W = 1.6               # the stair's half width
    wall_in, wall_out = W + 0.02, W + 0.28
    zb0, zb1 = 9.0, 9.26  # the back wall
    top = 1.05            # the waist-high wall
    zf = -0.7             # the roof's front edge, over the street
    zr = 9.5              # the roof's back edge
    roof_y = lambda z: 3.05 - 0.065 * (z - zf)
    xr = W + 0.42         # the roof's half width
    xp = (wall_in + wall_out) / 2
    # the walls round the sides and the back of the well: concrete inside (down past the street), orange tile outside,
    # a concrete coping; a short concrete return at the front
    for s in (1, -1):
        xa, xb = sorted((s * wall_in, s * wall_out))
        za, zb = -0.1, zb1
        g.poly('tr_concrete', [(s * wall_in, -0.6, za), (s * wall_in, -0.6, zb0), (s * wall_in, top, zb0), (s * wall_in, top, za)], grime(CONCRETE, -0.6, 1.0, 0.7), hint=(-s, 0, 0))
        g.poly('tr_tile', [(s * wall_out, -0.05, za), (s * wall_out, -0.05, zb), (s * wall_out, top, zb), (s * wall_out, top, za)], grime(TILE_ORANGE, 0.0, 0.6, 0.75), hint=(s, 0, 0))
        g.poly('tr_concrete', [(xa, -0.6, za), (xb, -0.6, za), (xb, top, za), (xa, top, za)], CONCRETE, hint=(0, 0, -1))
        box(g, 'tr_concrete', (xa - 0.03, top, za - 0.03), (xb + 0.03, top + 0.08, zb + 0.03), CONCRETE_LT, skip=('-y',))
        if lod == 0:
            # a dark tile skirting stripe along the outside
            g.poly('tr_tile', [(s * (wall_out + 0.003), -0.05, za), (s * (wall_out + 0.003), -0.05, zb), (s * (wall_out + 0.003), 0.18, zb), (s * (wall_out + 0.003), 0.18, za)], TILE_BROWN, hint=(s, 0, 0))
    g.poly('tr_concrete', [(-wall_in, -0.6, zb0), (wall_in, -0.6, zb0), (wall_in, top, zb0), (-wall_in, top, zb0)], grime(CONCRETE, -0.6, 1.0, 0.7), hint=(0, 0, -1))
    g.poly('tr_tile', [(-wall_out, -0.05, zb1), (wall_out, -0.05, zb1), (wall_out, top, zb1), (-wall_out, top, zb1)], grime(TILE_ORANGE, 0.0, 0.6, 0.75), hint=(0, 0, 1))
    box(g, 'tr_concrete', (-wall_in, top, zb0 - 0.03), (wall_in, top + 0.08, zb1 + 0.03), CONCRETE_LT, skip=('-y',))
    # posts on the walls carrying the roof; the front pair heavier
    post_z = [0.0, 3.0, 6.0, 9.13] if lod == 0 else [0.0, 9.13]
    for s in (1, -1):
        for z in post_z:
            yt = roof_y(z) - 0.16
            r = 0.09 if z == 0.0 else 0.06
            box(g, 'tr_steel', (s * xp - r, top + 0.08, z - r), (s * xp + r, yt, z + r), STEEL_DK, skip=('-y', '+y'))
    # the roof: edge beams, cross beams and purlins, glass between them; a fascia at the front with a sign face
    if lod == 0:
        cross = [zf + 0.1] + [zf + 0.1 + k * (zr - zf - 0.2) / 7 for k in range(1, 7)] + [zr - 0.1]
    else:
        cross = [zf + 0.1, zr - 0.1]
    for s in (1, -1):
        g.beam('tr_steel', (s * (xr - 0.07), roof_y(zf) - 0.08, zf), (s * (xr - 0.07), roof_y(zr) - 0.08, zr), 0.14, 0.22, STEEL_DK)
        g.beam('tr_steel', (s * xp, roof_y(zf + 0.3) - 0.17, zf + 0.3), (s * xp, roof_y(zr - 0.2) - 0.17, zr - 0.2), 0.12, 0.12, STEEL_DK)
    for z in cross:
        g.beam('tr_steel', (-(xr - 0.14), roof_y(z) - 0.05, z), ((xr - 0.14), roof_y(z) - 0.05, z), 0.07, 0.09, STEEL_DK)
    if lod == 0:
        # a ridge purlin down the middle
        g.beam('tr_steel', (0.0, roof_y(zf + 0.1) - 0.05, zf + 0.1), (0.0, roof_y(zr - 0.1) - 0.05, zr - 0.1), 0.06, 0.08, STEEL_DK)
    for a, b in zip(cross, cross[1:]):
        za, zb = a + 0.035, b - 0.035
        pts = [(-(xr - 0.14), roof_y(za) - 0.005, za), ((xr - 0.14), roof_y(za) - 0.005, za), ((xr - 0.14), roof_y(zb) - 0.005, zb), (-(xr - 0.14), roof_y(zb) - 0.005, zb)]
        g.poly('tr_glass', pts, WHITE, hint=(0, 1, 0))
    fy0, fy1 = roof_y(zf) - 0.34, roof_y(zf) + 0.06
    box(g, 'tr_steel', (-xr, fy0, zf - 0.07), (xr, fy1, zf + 0.07), STEEL_DK, skip=('-z',) if lod == 0 else ())
    if lod == 0:
        rr = [((-xr, fy0), (xr, fy0 + 0.04)), ((-xr, fy1 - 0.04), (xr, fy1)), ((-xr, fy0 + 0.04), (-xr + 0.06, fy1 - 0.04)), ((xr - 0.06, fy0 + 0.04), (xr, fy1 - 0.04))]
        for a, b in rr:
            g.poly('tr_steel', [(a[0], a[1], zf - 0.07), (b[0], a[1], zf - 0.07), (b[0], b[1], zf - 0.07), (a[0], b[1], zf - 0.07)], STEEL_DK, hint=(0, 0, -1))
        # the back fascia, plainer
        box(g, 'tr_steel', (-xr, roof_y(zr) - 0.2, zr - 0.06), (xr, roof_y(zr) + 0.05, zr + 0.02), STEEL_DK)
        # a down-light under the front fascia
        g.poly('tr_lightface', [(-0.6, fy0 - 0.002, zf + 0.0), (0.6, fy0 - 0.002, zf + 0.0), (0.6, fy0 - 0.002, zf + 0.06), (-0.6, fy0 - 0.002, zf + 0.06)], LAMP_WARM, hint=(0, -1, 0))
    sign_quad(g, 'tr_signface', (0.0, (fy0 + fy1) / 2, zf - 0.07 - 0.002), (-1, 0, 0), (0, 1, 0), 2 * xr - 0.12, fy1 - fy0 - 0.08)
    # glass side screens between the posts (mullions between), over the walls, and over the back wall
    for s in (1, -1):
        x = s * xp
        for a, b in zip(post_z, post_z[1:]):
            za, zb = a + 0.06, b - 0.06
            g.poly('tr_glass', [(x, top + 0.08, za), (x, top + 0.08, zb), (x, roof_y(zb) - 0.23, zb), (x, roof_y(za) - 0.23, za)], WHITE, hint=(s, 0, 0))
            if lod == 0:
                zm = (a + b) / 2
                box(g, 'tr_steel', (x - 0.02, top + 0.08, zm - 0.02), (x + 0.02, roof_y(zm) - 0.23, zm + 0.02), STEEL_DK, skip=('-y', '+y'))
        if lod == 0:
            g.beam('tr_steel', (x, top + 0.13, 0.0), (x, top + 0.13, 9.13), 0.05, 0.04, STEEL)
    zg = 9.13
    g.poly('tr_glass', [(-xp + 0.06, top + 0.08, zg), (xp - 0.06, top + 0.08, zg), (xp - 0.06, roof_y(zg) - 0.23, zg), (-xp + 0.06, roof_y(zg) - 0.23, zg)], WHITE, hint=(0, 0, 1))
    if lod == 0:
        box(g, 'tr_steel', (-0.02, top + 0.08, zg - 0.02), (0.02, roof_y(zg) - 0.23, zg + 0.02), STEEL_DK, skip=('-y', '+y'))
    return g


def railing(lod):
    g = Geo(lod)
    tube(g, 'tr_steel', (0.0, 0.0, 0.0), (0.0, 0.975, 0.0), 0.025, 8, STEEL)
    box(g, 'tr_steel', (-0.06, 0.0, -0.06), (0.06, 0.012, 0.06), STEEL_DK, skip=('-y',))
    tube(g, 'tr_steel', (-0.5, 0.975, 0.0), (0.5, 0.975, 0.0), 0.025, 8, STEEL, caps=False)
    tube(g, 'tr_steel', (-0.5, 0.5, 0.0), (0.5, 0.5, 0.0), 0.016, 6, STEEL, caps=False)
    tube(g, 'tr_steel', (-0.5, 0.1, 0.0), (0.5, 0.1, 0.0), 0.012, 6, STEEL_DK, caps=False)
    return g


def lamp_tube(lod):
    g = Geo(lod)
    box(g, 'tr_steel', (-0.75, -0.08, -0.11), (0.75, 0.0, 0.11), PAINT_WHITE, skip=('+y',))
    # the prismatic diffuser under it: bottom and sides glow
    lens = [(-0.72, -0.12, -0.09), (0.72, -0.12, -0.09), (0.72, -0.12, 0.09), (-0.72, -0.12, 0.09)]
    g.poly('tr_lightface', lens, LAMP_WARM, hint=(0, -1, 0))
    for z, h in ((-0.09, -1), (0.09, 1)):
        g.poly('tr_lightface', [(-0.72, -0.12, z), (0.72, -0.12, z), (0.72, -0.08, z), (-0.72, -0.08, z)], LAMP_WARM, hint=(0, 0, h))
    for x, h in ((-0.72, -1), (0.72, 1)):
        g.poly('tr_lightface', [(x, -0.12, -0.09), (x, -0.12, 0.09), (x, -0.08, 0.09), (x, -0.08, -0.09)], LAMP_WARM, hint=(h, 0, 0))
    return g


def tunnel_bay(lod):
    g = Geo(lod)
    levels = [1.1, 1.65, 2.2]
    z0, z1 = -6.0, 6.0
    zn, nw, nh, fr = 4.0, 0.9, 2.0, 0.08          # the refuge niche: centre, width, height, frame
    gap = (zn - nw / 2 - fr - 0.12, zn + nw / 2 + fr + 0.12)   # the trays and the low conduit stop short of it
    runs = [(z0, gap[0]), (gap[1], z1)]
    if lod == 0:
        for z in (-5.0, -3.0, -1.0, 1.0, 3.0, 5.0):
            box(g, 'tr_steel', (0.0, 0.95, z - 0.025), (0.05, 2.45, z + 0.025), GALV, skip=('-x', '-y'))
            for y in levels:
                box(g, 'tr_steel', (0.05, y - 0.04, z - 0.02), (0.36, y, z + 0.02), GALV, skip=('-x', '-y', '+x'))
    for y in levels:
        for za, zb in runs:
            # the tray: a floor and a front lip, galvanised, with cables in it
            g.poly('tr_steel', [(0.06, y, za), (0.38, y, za), (0.38, y, zb), (0.06, y, zb)], GALV, hint=(0, 1, 0))
            g.poly('tr_steel', [(0.06, y - 0.01, za), (0.38, y - 0.01, za), (0.38, y - 0.01, zb), (0.06, y - 0.01, zb)], shade(GALV, 0.7), hint=(0, -1, 0))
            g.poly('tr_steel', [(0.38, y - 0.01, za), (0.38, y + 0.07, za), (0.38, y + 0.07, zb), (0.38, y - 0.01, zb)], GALV, hint=(1, 0, 0))
            if lod == 0:
                for k, x in enumerate((0.13, 0.22, 0.3)):
                    tube(g, 'tr_dark', (x, y + 0.045, za), (x, y + 0.045, zb), 0.034 if k != 1 else 0.028, 5, shade(CABLE, 1.0 + 0.5 * k), caps=False, phase=0.3)
            else:
                g.poly('tr_dark', [(0.1, y + 0.05, za), (0.36, y + 0.05, za), (0.36, y + 0.05, zb), (0.1, y + 0.05, zb)], CABLE, hint=(0, 1, 0))
    # conduits on the wall: the high one runs through over the niche, the low one stops at it
    tube(g, 'tr_steel', (0.035, 2.5, z0), (0.035, 2.5, z1), 0.03, 6 if lod == 0 else 4, shade(GALV, 0.9), caps=False)
    for za, zb in runs:
        tube(g, 'tr_steel', (0.035, 0.95, za), (0.035, 0.95, zb), 0.03, 6 if lod == 0 else 4, shade(GALV, 0.9), caps=False)
    # the wall lamp (one per bay) above the trays
    box(g, 'tr_dark', (0.0, 2.72, -0.28), (0.14, 2.94, 0.28), DARK, skip=('-x',))
    g.poly('tr_lightface', [(0.141, 2.75, -0.24), (0.141, 2.75, 0.24), (0.141, 2.91, 0.24), (0.141, 2.91, -0.24)], LAMP_WARM, hint=(1, 0, 0))
    if lod == 0:
        g.poly('tr_lightface', [(0.02, 2.719, -0.24), (0.12, 2.719, -0.24), (0.12, 2.719, 0.24), (0.02, 2.719, 0.24)], LAMP_WARM, hint=(0, -1, 0))
    # the blue light: an emergency phone and power-cut box with a blue lamp over it
    zp = -3.6
    box(g, 'tr_steel', (0.0, 1.15, zp - 0.22), (0.18, 1.7, zp + 0.22), PAINT_BLUE, skip=('-x',))
    box(g, 'tr_lightface', (0.0, 1.8, zp - 0.07), (0.12, 1.96, zp + 0.07), LENS_BLUE, skip=('-x',))
    if lod == 0:
        g.poly('tr_dark', [(0.181, 1.22, zp - 0.16), (0.181, 1.22, zp + 0.16), (0.181, 1.6, zp + 0.16), (0.181, 1.6, zp - 0.16)], shade(PAINT_BLUE, 0.6), hint=(1, 0, 0))
        sign_quad(g, 'tr_signface', (0.182, 1.52, zp), (0, 0, -1), (0, 1, 0), 0.24, 0.1)
    # the refuge niche: a white-painted frame round a dark recess
    g.poly('tr_dark', [(0.004, 0.3, zn - nw / 2), (0.004, 0.3, zn + nw / 2), (0.004, 0.3 + nh, zn + nw / 2), (0.004, 0.3 + nh, zn - nw / 2)], shade(DARK, 0.5), hint=(1, 0, 0))
    for lo, hi in (((0.0, 0.3, zn - nw / 2 - fr), (0.05, 0.3 + nh + fr, zn - nw / 2)), ((0.0, 0.3, zn + nw / 2), (0.05, 0.3 + nh + fr, zn + nw / 2 + fr)),
                   ((0.0, 0.3 + nh, zn - nw / 2), (0.05, 0.3 + nh + fr, zn + nw / 2))):
        box(g, 'tr_concrete', lo, hi, PAINT_WHITE, skip=('-x',))
    if lod == 0:
        # a numbered plate beside the niche (the game writes the number)
        sign_quad(g, 'tr_signface', (0.011, 0.62, 2.0), (0, 0, -1), (0, 1, 0), 0.3, 0.2)
        box(g, 'tr_dark', (0.0, 0.51, 1.84), (0.01, 0.73, 2.16), DARK, skip=('-x',))
    return g


def signal(lod):
    g = Geo(lod)
    # the bracket: a plate on the wall, an arm out to the head
    box(g, 'tr_dark', (0.0, 0.0, -0.09), (0.02, 0.3, 0.09), DARK, skip=('-x',))
    box(g, 'tr_dark', (0.02, 0.06, -0.04), (0.25, 0.14, 0.04), DARK)
    # the head: a black housing with three hooded lenses facing +Z
    xc = 0.39
    box(g, 'tr_dark', (0.25, 0.0, -0.09), (0.53, 0.9, 0.09), shade(DARK, 0.7))
    for y, col in ((0.72, LENS_RED), (0.47, LENS_YELLOW), (0.22, LENS_GREEN)):
        revolve(g, 'tr_lightface', (xc, y, 0.09), (0, 0, 1), [(0.0, 0.0), (0.075, 0.0), (0.07, 0.012), (0.0, 0.018)], 12, col)
        # the hood: a half tube over the top of the lens
        n = 6
        pts_o, pts_i = [], []
        for k in range(n + 1):
            a = math.pi * k / n
            pts_o.append((xc + 0.095 * math.cos(a), y + 0.095 * math.sin(a)))
        for k in range(n):
            (x0, y0), (x1, y1) = pts_o[k], pts_o[k + 1]
            nm = ((x0 + x1) / 2 - xc, (y0 + y1) / 2 - y)
            g.poly('tr_dark', [(x0, y0, 0.09), (x1, y1, 0.09), (x1, y1, 0.22), (x0, y0, 0.22)], RUBBER, hint=(nm[0], nm[1], 0))
            g.poly('tr_dark', [(x0, y0, 0.09), (x1, y1, 0.09), (x1, y1, 0.22), (x0, y0, 0.22)], RUBBER, hint=(-nm[0], -nm[1], 0))
    return g


def bin_(lod):
    g = Geo(lod)
    n = 14 if lod == 0 else 8
    revolve(g, 'tr_dark', (0, 0, 0), (0, 1, 0), [(0.0, 0.0), (0.24, 0.0), (0.24, 0.06), (0.25, 0.06)], n, RUBBER)
    revolve(g, 'tr_steel', (0, 0, 0), (0, 1, 0), [(0.25, 0.06), (0.26, 0.74)] if lod else [(0.25, 0.06), (0.255, 0.4), (0.26, 0.74), (0.25, 0.76)], n,
            lambda k: shade(STEEL, 0.85 + 0.1 * k))
    if lod == 0:
        # the slot ring under the lid, the domed lid
        revolve(g, 'tr_dark', (0, 0, 0), (0, 1, 0), [(0.25, 0.76), (0.22, 0.76), (0.22, 0.82)], n, RUBBER)
        revolve(g, 'tr_steel', (0, 0, 0), (0, 1, 0), [(0.22, 0.82), (0.275, 0.82), (0.275, 0.85), (0.2, 0.89), (0.0, 0.9)], n, lambda k: shade(STEEL, 1.05))
    else:
        revolve(g, 'tr_steel', (0, 0, 0), (0, 1, 0), [(0.26, 0.74), (0.27, 0.82), (0.0, 0.9)], n, STEEL)
    return g


def map_board(lod):
    g = Geo(lod)
    W, H, D, b = 2.0, 1.2, 0.06, 0.05
    hw = W / 2
    # the frame: front ring, outer edges, a recessed face
    ring = [((-hw, 0.0), (hw, b)), ((-hw, H - b), (hw, H)), ((-hw, b), (-hw + b, H - b)), ((hw - b, b), (hw, H - b))]
    for a, c in ring:
        g.poly('tr_dark', [(a[0], a[1], D), (c[0], a[1], D), (c[0], c[1], D), (a[0], c[1], D)], BRONZE, hint=(0, 0, 1))
    box(g, 'tr_dark', (-hw, 0.0, 0.0), (hw, H, D), BRONZE, skip=('+z', '-z'))
    zi = D - 0.012
    for (a, c, n) in (((-hw + b, b), (hw - b, b), (0, 1, 0)), ((-hw + b, H - b), (hw - b, H - b), (0, -1, 0))):
        g.poly('tr_dark', [(a[0], a[1], D), (c[0], c[1], D), (c[0], c[1], zi), (a[0], a[1], zi)], BRONZE, hint=n)
    for x, n in ((-hw + b, (1, 0, 0)), (hw - b, (-1, 0, 0))):
        g.poly('tr_dark', [(x, b, D), (x, H - b, D), (x, H - b, zi), (x, b, zi)], BRONZE, hint=n)
    sign_quad(g, 'tr_signface', (0.0, H / 2, zi), (1, 0, 0), (0, 1, 0), W - 2 * b, H - 2 * b)
    return g


BUILDERS = {'column': column, 'bench': bench, 'sign_name': sign_name, 'screen': screen, 'fare_gate': fare_gate, 'pylon': pylon,
            'canopy': canopy, 'railing': railing, 'lamp_tube': lamp_tube, 'tunnel_bay': tunnel_bay, 'signal': signal, 'bin': bin_, 'map_board': map_board}
LODS = {'column': 2, 'bench': 2, 'fare_gate': 2, 'pylon': 1, 'canopy': 2, 'tunnel_bay': 2, 'bin': 2}
ORIGIN = {
    'column': 'floor centre', 'bench': 'floor centre', 'sign_name': 'face centre', 'screen': 'face centre', 'fare_gate': 'floor centre',
    'pylon': 'floor centre', 'canopy': 'top of the stairs, street level, centre', 'railing': 'floor centre', 'lamp_tube': 'top (hangs below)',
    'tunnel_bay': 'wall plane x = 0, track bed y = 0, bay centre', 'signal': "bracket's wall foot (wall x = 0)", 'bin': 'floor centre',
    'map_board': 'bottom centre of the frame, on the wall (z = 0)',
}
FACES = {'sign_name': [3.0, 0.55], 'screen': [1.2, 0.4], 'map_board': [1.9, 1.1], 'pylon': [0.54, 0.68]}
GROUND = [((-40.0, 0.0, -40.0), (40.0, 0.0, -40.0), (40.0, 0.0, 40.0)), ((-40.0, 0.0, -40.0), (40.0, 0.0, 40.0), (-40.0, 0.0, 40.0))]
WALL_X = [((0.0, -1.0, -40.0), (0.0, 6.0, -40.0), (0.0, 6.0, 40.0)), ((0.0, -1.0, -40.0), (0.0, 6.0, 40.0), (0.0, -1.0, 40.0))]
WALL_Z = [((-40.0, -1.0, 0.0), (40.0, -1.0, 0.0), (40.0, 6.0, 0.0)), ((-40.0, -1.0, 0.0), (40.0, 6.0, 0.0), (-40.0, 6.0, 0.0))]


def build(asset):
    scene.reset()
    root = scene.empty('station-kit', props={'asset': asset})
    parts = {}
    totals = [0, 0]
    for name in PARTS:
        node = scene.empty(name, parent=root)
        n = LODS.get(name, 1)
        geos = [BUILDERS[name](lod) for lod in range(n)]
        extra = GROUND if name in FLOOR_STANDING else WALL_X if name in ('tunnel_bay', 'signal') else WALL_Z if name == 'map_board' else ()
        for g in geos:
            tk.bake_ao([g], dist=0.5 if name != 'canopy' else 0.9, rays=16, extra=extra, strength=1.0, floor=0.3)
        tris = []
        for lod, g in enumerate(geos):
            tk.emit(f'{name}_lod{lod}', g, node)
            tris.append(tk.tris(g))
            totals[lod] += tk.tris(g)
        if n == 1:
            totals[1] += tris[0]
        lo, hi = tk.bounds(geos[:1])
        node['lods'] = n
        parts[name] = {
            'size': [round(hi[k] - lo[k], 3) for k in range(3)],
            'min': [round(v, 3) for v in lo],
            'max': [round(v, 3) for v in hi],
            'tris': tris,
            'origin': ORIGIN[name],
        }
        if name in FACES:
            parts[name]['face'] = FACES[name]
        if name == 'fare_gate':
            parts[name]['collider'] = list(FARE_GATE_BOX)
    root['lod_tris'] = totals

    from . import preview
    lay = {  # where each part stands for the pictures (moved back after)
        'column': ((-7.5, 0, 0), 0), 'bench': ((-4.8, 0, 1.2), 0), 'bin': ((-3.2, 0, 1.4), 0), 'fare_gate': ((-1.6, 0, 0.6), 0),
        'pylon': ((0.4, 0, 1.0), 0), 'railing': ((2.0, 0, 1.5), 0), 'sign_name': ((-4.6, 3.1, -1.0), 0), 'screen': ((-0.9, 2.9, -1.0), 0),
        'lamp_tube': ((2.0, 3.6, -0.6), 0), 'map_board': ((5.0, 0.9, -2.0), 0), 'signal': ((7.4, 1.6, -2.0), -math.pi / 2),
        'canopy': ((14.0, 0, 6.0), math.pi), 'tunnel_bay': ((30.0, 0, -2.0), -math.pi / 2),
    }

    def setup():
        import bpy
        from hoodlib.frame import to_bl
        saved = []
        for name, (pos, rot) in lay.items():
            o = bpy.data.objects[name]
            saved.append((o, o.location.copy(), o.rotation_euler.copy()))
            o.location = to_bl(*pos)
            o.rotation_euler = (0, 0, rot)
        me = bpy.data.meshes.new('preview_wall')
        me.from_pydata([to_bl(3.0, -0.5, -2.0), to_bl(9.0, -0.5, -2.0), to_bl(9.0, 5.0, -2.0), to_bl(3.0, 5.0, -2.0),
                        to_bl(22.0, -0.5, -2.0), to_bl(40.0, -0.5, -2.0), to_bl(40.0, 5.0, -2.0), to_bl(22.0, 5.0, -2.0)], [], [(0, 1, 2, 3), (4, 5, 6, 7)])
        wm = bpy.data.materials.new('preview_wall')
        wm.use_nodes = True
        wm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.3, 0.27, 1)
        me.materials.append(wm)
        wall = bpy.data.objects.new('preview_wall', me)
        bpy.context.scene.collection.objects.link(wall)

        def undo():
            for o, loc, rot in saved:
                o.location, o.rotation_euler = loc, rot
            bpy.data.objects.remove(wall)
            bpy.data.meshes.remove(me)
            bpy.data.materials.remove(wm)
        return undo

    l0 = lambda n: n.endswith('_lod0') or n.startswith('preview')
    l1 = lambda n: n.endswith('_lod1') or (n.endswith('_lod0') and LODS.get(n[:-5], 1) == 1) or n.startswith('preview')
    preview.install({
        'overview': dict(cam=(-1.0, 4.5, 12.0), at=(0.5, 1.5, 0.0), lens=24, show=l0),
        'platform': dict(cam=(-2.5, 1.7, 5.5), at=(-3.5, 1.6, 0.0), lens=28, show=l0),
        'gate': dict(cam=(0.6, 1.4, 3.2), at=(-1.4, 0.6, 0.4), lens=32, show=l0),
        'canopy': dict(cam=(19.0, 3.6, 15.0), at=(14.0, 1.4, 3.0), lens=26, show=l0),
        'canopy_back': dict(cam=(9.0, 5.0, -10.0), at=(14.0, 1.2, 0.0), lens=26, show=l0),
        'canopy_in': dict(cam=(14.3, 1.65, 8.2), at=(14.0, 0.2, -2.0), lens=22, show=l0),
        'tunnel': dict(cam=(30.0, 1.9, 4.5), at=(30.0, 1.6, -2.0), lens=20, show=l0, sky=0.4, sun=0.6),
        'walls': dict(cam=(6.0, 1.8, 2.6), at=(6.2, 1.4, -2.0), lens=28, show=l0),
        'lod1': dict(cam=(-1.0, 4.5, 12.0), at=(0.5, 1.5, 0.0), lens=24, show=l1),
        'canopy_lod1': dict(cam=(19.0, 3.6, 15.0), at=(14.0, 1.4, 3.0), lens=26, show=l1),
    }, setup=setup, size=(960, 540), ground_y=0.0)

    sidecar = {'asset': asset, 'materials': tk.KIT_MATERIALS, 'parts': parts}
    return {'asset': asset, 'tris': totals, 'sidecar': sidecar}
