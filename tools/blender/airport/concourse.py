"""Hartsfield-Jackson's midfield concourses A, B, C, D (1980), E (1994) and F (2012): one parametric model, the asset name
picks the concourse (`atl-concourse-a` ... `-f`). Drawn on the real outline (airport.json rings[0]; E also its north link
and annex), at the real orientation, its jet bridges reaching the parked aircraft's L1 doors (apt.gates).

The look, read from photographs of the airside: long, low, two-storey piers. The apron level (baggage, ramp offices) is
precast and metal panels with roll-up doors for the baggage tugs; over it a concrete slab edge and the gate level, a glazed
curtain wall with mullions and a transom; a white metal fascia and parapet; a flat membrane roof with a raised clerestory of
skylights along the spine, a taller glazed atrium over the middle where the outline widens (the Plane Train station and the
food court), and plant on the roof. E is taller, with more glass. F, the international concourse of 2012, has a taller glass
wall under a gently curving roof with deep overhangs and a skylight along its crest. No lettering anywhere: the gate-number
boards are blank lit panels (lm_screen).

Night: the facade shader lights the gate level; the clerestories glow (lm_lit), a light cove runs along the top of the glass
(lm_glow), the gate boards are lit.
"""
import math

from airport import apt
from landmarks import lm, parts
from landmarks.lm import shade, srgb

VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

PRECAST = srgb(0xc9c3b6)
PRECAST_D = srgb(0xb2ac9f)
SLAB = srgb(0xd9d5cc)
FASCIA = srgb(0xe4e5e2)
ROOF = srgb(0x9d9b95)
MULLION = srgb(0x7f868d)
DOOR = srgb(0x8e9296)
PLANT = srgb(0xa7aaa9)
CLER = srgb(0xdfe9ee)
COVE = srgb(0xffe6c2)
BRIDGE = srgb(0xc9cdd1)
BRIDGE_GLASS = srgb(0x3b5566)
DARK = srgb(0x2a2c30)
SCREEN = srgb(0x2156c9)
SCREEN_HI = srgb(0xdfe8ff)
STAIR = srgb(0x9a9d9f)
GPU = srgb(0xd9b13a)

SLAB_Y0, SLAB_Y1 = 3.0, 3.7    # the slab edge between the apron level and the gate level (the bridges' floor is apt.ROOT_Y)

# per concourse: gate-level glass top, flat roof, parapet, clerestory (width, rise), glass colour, era, the roof's style
SPEC = {
    'a': dict(glass_top=9.4, roof=12.8, parapet=1.1, cler=(7.0, 2.6), glass=srgb(0x5b7d8c), era=2, fid=601),
    'b': dict(glass_top=9.4, roof=12.8, parapet=1.1, cler=(7.0, 2.6), glass=srgb(0x587b8b), era=2, fid=611),
    'c': dict(glass_top=9.6, roof=13.0, parapet=1.1, cler=(7.0, 2.6), glass=srgb(0x5a7b88), era=2, fid=621),
    'd': dict(glass_top=9.4, roof=12.8, parapet=1.1, cler=(7.0, 2.6), glass=srgb(0x5d7e8b), era=2, fid=631),
    'e': dict(glass_top=11.6, roof=14.8, parapet=1.2, cler=(9.0, 3.1), glass=srgb(0x4c7b84), era=3, fid=641),
    'f': dict(glass_top=None, roof=None, eave=16.4, crest=20.6, overhang=7.0, cler=(6.0, 1.4), glass=srgb(0x5585a6), era=4, fid=651),
}


def letter(asset):
    return asset.rsplit('-', 1)[1]


# ---------------------------------------------------------------------------------------------- outline frame
def axis_of(ring):
    """The across axis (radians, u = x cos + z sin) of a long concourse. The plan's grid is the length-weighted mean direction
    of its edges taken modulo 90 degrees (a cross-shaped plan like E's skews an oriented box); of the two grid directions the
    across one is that in which the outline is narrower."""
    sx = sy = 0.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz)
        th = math.atan2(dz, dx)
        sx += ln * math.cos(4 * th)
        sy += ln * math.sin(4 * th)
    g = math.atan2(sy, sx) / 4

    def extent(ang):
        us = [to_uv(p, ang)[0] for p in ring]
        return max(us) - min(us)
    return g if extent(g) < extent(g + math.pi / 2) else g + math.pi / 2


def to_uv(p, ang):
    c, s = math.cos(ang), math.sin(ang)
    return (p[0] * c + p[1] * s, -p[0] * s + p[1] * c)


def intervals(uvr, v):
    """The u intervals of a (u, v) ring along the line at v."""
    xs = []
    n = len(uvr)
    for i in range(n):
        p, q = uvr[i], uvr[(i + 1) % n]
        if (p[1] < v) != (q[1] < v):
            xs.append(p[0] + (q[0] - p[0]) * (v - p[1]) / (q[1] - p[1]))
    xs.sort()
    return [(xs[k], xs[k + 1]) for k in range(0, len(xs) - 1, 2)]


def spine(ring, ang, vrange=None, step=4.0):
    """The concourse's centre line: (u centre, [(v0, v1) runs where a strip about it fits], [(v0, v1, u0, u1) wide runs]) in the
    (u, v) frame of `ang`. The centre is the median of the narrow sections' middles."""
    uvr = [to_uv(p, ang) for p in ring]
    v0 = min(p[1] for p in uvr) + 1.0
    v1 = max(p[1] for p in uvr) - 1.0
    if vrange:
        v0, v1 = max(v0, vrange[0]), min(v1, vrange[1])
    vs = []
    v = v0
    while v <= v1:
        vs.append(v)
        v += step
    secs = [(v, intervals(uvr, v)) for v in vs]
    mids = sorted((a + b) / 2 for _, iv in secs for a, b in iv if 12.0 < b - a < 45.0)
    uc = mids[len(mids) // 2] if mids else sum(p[0] for p in uvr) / len(uvr)
    return uc, secs


def runs(secs, ok, min_len=16.0):
    out = []
    cur = None
    for v, iv in secs:
        if ok(iv):
            cur = [v, v] if cur is None else [cur[0], v]
        else:
            if cur and cur[1] - cur[0] >= min_len:
                out.append(tuple(cur))
            cur = None
    if cur and cur[1] - cur[0] >= min_len:
        out.append(tuple(cur))
    return out


def holds(iv, u0, u1):
    return any(a <= u0 and b >= u1 for a, b in iv)


def edge_list(ring):
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    out = []
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz)
        if ln < 1e-6:
            continue
        out.append((a, b, ln, (dz / ln * s, -dx / ln * s), (dx / ln, dz / ln)))
    return out


# ---------------------------------------------------------------------------------------------- pieces
def strip_quad(l, mat, a, b, y0, y1, out, col, d=0.0):
    """A plain vertical quad along a-b (x, z), pushed `d` along the outward normal."""
    ox, oz = out[0] * d, out[1] * d
    l.quad(mat, (a[0] + ox, y0, a[1] + oz), (b[0] + ox, y0, b[1] + oz), (b[0] + ox, y1, b[1] + oz), (a[0] + ox, y1, a[1] + oz), col, hint=(out[0], 0, out[1]))


def walls(l, ring, sp, lod, top_of=None, fid=0):
    """The concourse's facade round one ring: apron level, slab edge, gate-level glass, fascia (or the wall up to a curved roof)."""
    gt = sp['glass_top']
    es = edge_list(ring)
    u = 0.0
    for k, (a, b, ln, out, tg) in enumerate(es):
        col = PRECAST if k % 3 else PRECAST_D
        l.facade_quad('bld_wall', (a[0], 0, a[1]), (b[0], 0, b[1]), (b[0], SLAB_Y0, b[1]), (a[0], SLAB_Y0, a[1]), col, u, lm.K_CIVIC, 1, 0, sp['era'], fid, True, hint=(out[0], 0, out[1]))
        strip_quad(l, 'lm_stone', a, b, SLAB_Y0, SLAB_Y1, out, SLAB)
        if top_of is None:
            l.facade_quad('bld_glass', (a[0], SLAB_Y1, a[1]), (b[0], SLAB_Y1, b[1]), (b[0], gt, b[1]), (a[0], gt, a[1]), sp['glass'], u, lm.K_GLASS, 1, 0, sp['era'], fid + 1, True, hint=(out[0], 0, out[1]))
            ytop = sp['roof'] + sp['parapet']
            strip_quad(l, 'lm_metal', a, b, gt, ytop - 0.35, out, FASCIA if k % 4 else shade(FASCIA, 0.96))
            # the coping, a little proud, and a reveal between the fascia's panels
            strip_quad(l, 'lm_metal', a, b, ytop - 0.35, ytop, out, shade(FASCIA, 1.04), d=0.12)
            if lod == 0:
                yr = gt + (ytop - gt) * 0.45
                strip_quad(l, 'lm_dark', a, b, yr, yr + 0.07, out, DARK, d=0.01)
        else:
            ta, tb = top_of(a), top_of(b)
            l.facade_quad('bld_glass', (a[0], SLAB_Y1, a[1]), (b[0], SLAB_Y1, b[1]), (b[0], tb, b[1]), (a[0], ta, a[1]), sp['glass'], u, lm.K_GLASS, 2, 0, sp['era'], fid + 1, True, hint=(out[0], 0, out[1]))
        if lod < 2 and ln > 3.0:
            yt = gt if top_of is None else None
            # mullions (fins) and a transom over the glass, a sill under it
            nm = max(1, int(ln / (3.6 if lod == 0 else 7.2)))
            for j in range(1, nm):
                t = j / nm
                p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                y1 = yt if yt is not None else top_of(p) - 0.1
                rot = math.atan2(out[0], out[1])
                l.box('lm_metal', (p[0] + out[0] * 0.14, (SLAB_Y1 + y1) / 2, p[1] + out[1] * 0.14), (0.12, y1 - SLAB_Y1, 0.28), MULLION, rot=rot, skip=('-z', '+y', '-y'))
        if lod == 0 and ln > 3.0:
            ytr = SLAB_Y1 + 3.1
            for y0, y1, dd in ((ytr, ytr + 0.16, 0.16), (SLAB_Y1, SLAB_Y1 + 0.22, 0.1)):
                strip_quad(l, 'lm_metal', a, b, y0, y1, out, MULLION, d=dd)
            if ln > 12.0:
                # the light cove under the fascia
                ycove = (gt if top_of is None else min(top_of(a), top_of(b))) - 0.35
                strip_quad(l, 'lm_glow', a, b, ycove, ycove + 0.22, out, COVE, d=0.05)
            if ln > 26.0:
                # roll-up doors for the baggage tugs in the apron level
                nd = int(ln / 30.0)
                for j in range(nd):
                    t = (j + 0.5) / nd
                    c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                    p0 = (c[0] - tg[0] * 2.0, c[1] - tg[1] * 2.0)
                    p1 = (c[0] + tg[0] * 2.0, c[1] + tg[1] * 2.0)
                    strip_quad(l, 'lm_metal', p0, p1, 0.0, 2.7, out, DOOR, d=0.06)
                    strip_quad(l, 'lm_dark', p0, p1, 2.7, 2.95, out, DARK, d=0.06)
        u += ln


def parapet(l, ring, y0, y1):
    """The parapet's inner face and top round a flat roof."""
    inner = lm.inset_ring(ring, 0.35)
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        ia, ib = inner[i], inner[(i + 1) % n]
        out = parts.outward(ring, i)
        l.quad('lm_metal', (ia[0], y0, ia[1]), (ib[0], y0, ib[1]), (ib[0], y1, ib[1]), (ia[0], y1, ia[1]), shade(FASCIA, 0.85), hint=(-out[0], 0, -out[2]))
        l.quad('lm_metal', (a[0], y1, a[1]), (b[0], y1, b[1]), (ib[0], y1, ib[1]), (ia[0], y1, ia[1]), FASCIA, hint=(0, 1, 0))


def flat_roof(l, rings, y, col=ROOF, mat='bld_roof'):
    for (u0, va0, vb0), (u1, va1, vb1) in apt.trapezoids(rings):
        pts = [(u0, va0), (u1, va1), (u1, vb1), (u0, vb0)]
        q = [apt.uv_to_xz(u, v) for u, v in pts]
        l.poly(mat, [(p[0], y, p[1]) for p in q], col, hint=(0, 1, 0))


def clerestory(l, ang, uc, v0, v1, w, base, rise, lod, mat_side='lm_lit'):
    """A raised skylight box along the spine: glazed sides, a metal lid a little wider, end walls."""
    def P(u, v, y):
        x, z = apt.uv_to_xz(u, v, ang)
        return (x, y, z)
    hw = w / 2
    top = base + rise
    eu = (math.cos(ang), math.sin(ang))
    for sgn in (-1, 1):
        u = uc + sgn * hw
        l.quad(mat_side, P(u, v0, base), P(u, v1, base), P(u, v1, top - 0.25), P(u, v0, top - 0.25), CLER, hint=(eu[0] * sgn, 0, eu[1] * sgn))
        l.quad('lm_metal', P(u, v0, top - 0.25), P(u, v1, top - 0.25), P(u, v1, top), P(u, v0, top), FASCIA, hint=(eu[0] * sgn, 0, eu[1] * sgn))
    ev = (-math.sin(ang), math.cos(ang))
    for v, sgn in ((v0, -1), (v1, 1)):
        l.quad('lm_metal', P(uc - hw, v, base), P(uc + hw, v, base), P(uc + hw, v, top), P(uc - hw, v, top), FASCIA, hint=(ev[0] * sgn, 0, ev[1] * sgn))
    lid = 0.5 if lod == 0 else 0.0
    l.quad('lm_metal', P(uc - hw - lid, v0 - lid, top), P(uc + hw + lid, v0 - lid, top), P(uc + hw + lid, v1 + lid, top), P(uc - hw - lid, v1 + lid, top), shade(FASCIA, 0.9), hint=(0, 1, 0))
    if lod == 0:
        # frames on the glazing every 6 m
        n = max(1, int((v1 - v0) / 6.0))
        for sgn in (-1, 1):
            u = uc + sgn * (hw + 0.06)
            for j in range(1, n):
                v = v0 + (v1 - v0) * j / n
                a, b = P(u, v - 0.1, base), P(u, v + 0.1, base)
                l.quad('lm_metal', a, b, (b[0], top - 0.25, b[2]), (a[0], top - 0.25, a[2]), MULLION, hint=(eu[0] * sgn, 0, eu[1] * sgn))


def atrium(l, ang, u0, u1, v0, v1, base, rise, fid, era, lod):
    """The taller glazed pavilion over the middle of the concourse."""
    ring = [apt.uv_to_xz(u, v, ang) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    if lm.area2(ring) < 0:
        ring = ring[::-1]
    l.ring_walls('bld_glass', ring, base, base + rise, srgb(0x6a8fa2), lm.K_GLASS, floor_h=rise, era=era, fid=fid)
    parts.band(l, ring, base + rise, base + rise + 0.9, 0.4, FASCIA, mat='lm_metal')
    l.cap('bld_roof', ring, base + rise + 0.9, shade(ROOF, 1.05))
    if lod == 0:
        sky = parts.scaled(ring, 0.55)
        l.cap('lm_lit', sky, base + rise + 1.0, CLER)
        parts.band(l, sky, base + rise + 0.9, base + rise + 1.0, 0.0, FASCIA, mat='lm_metal', top=False)


def box_uv(l, mat, ang, u, v, y0, su, sv, h, col, skip=()):
    x, z = apt.uv_to_xz(u, v, ang)
    # lm.box turns by rot about Y with its local x along (cos rot, -sin rot): u along (cos ang, sin ang) -> rot = -ang
    l.box(mat, (x, y0, z), (su, h, sv), col, rot=-ang, y_is_base=True, skip=skip)


def inside_all(ring, pts):
    return all(apt.inside(ring, p[0], p[1]) for p in pts)


# ---------------------------------------------------------------------------------------------- jet bridges
def bridge(l, g, rings, lod):
    """A jet bridge (apt.jet_bridge at LOD0, a plain beam further away), its service stair, a ground power unit under it and the
    gate board on the wall above its root. Returns the hull prisms of its legs."""
    g = apt.snap_root(g, rings)
    rx, rz = g['root']
    tx, ty, tz = g['tip']
    ln = math.hypot(tx - rx, tz - rz)
    ux, uz = (tx - rx) / ln, (tz - rz) / ln
    sx, sz = -uz, ux
    ry = apt.ROOT_Y
    if lod == 0:
        hull = apt.jet_bridge(l, g, BRIDGE, BRIDGE_GLASS, DARK)
        rot = (rx + ux * 4.0, rz + uz * 4.0)
        cab = (tx - ux * 2.2, tz - uz * 2.2)
        if ln > 46.0:
            # a long bridge rests on a second fixed leg halfway along
            t = 0.38
            m = (rot[0] + (cab[0] - rot[0]) * t, rot[1] + (cab[1] - rot[1]) * t)
            ym = ry + (ty - ry) * t
            l.box('lm_stone', (m[0], ym / 2, m[1]), (0.8, ym, 0.8), DARK)
            hull.append((apt.rect_ring(m[0], m[1], 1.0, 1.0), ym))
        # the drive leg's wheels, either side of its bogie (apt.jet_bridge puts the bogie at 72 % of the way to the cab)
        leg = (rot[0] + (cab[0] - rot[0]) * 0.72, rot[1] + (cab[1] - rot[1]) * 0.72)
        for sg in (-1, 1):
            w0 = (leg[0] + sx * sg * 1.32, leg[1] + sz * sg * 1.32)
            w1 = (leg[0] + sx * sg * 1.72, leg[1] + sz * sg * 1.72)
            l.tube('lm_dark', [(w0[0], 0.45, w0[1]), (w1[0], 0.45, w1[1])], [0.45, 0.45], 8, DARK)
        # the service stair from the rotunda down to the apron, beside the tunnel
        side = 1 if (g['ref'] and sum(ord(c) for c in g['ref']) % 2) else -1
        top = (rot[0] + sx * side * 2.35, rot[1] + sz * side * 2.35)
        foot = (top[0] + ux * 5.2, top[1] + uz * 5.2)
        l.box('lm_metal', (top[0] - ux * 0.3, ry - 0.12, top[1] - uz * 0.3), (1.3, 0.24, 1.6), STAIR, rot=math.atan2(ux, uz))
        l.beam('lm_metal', (top[0] + ux * 0.4, ry - 0.2, top[1] + uz * 0.4), (foot[0], 0.15, foot[1]), 1.05, 0.25, STAIR)
        rail_o = (sx * side * 0.55, sz * side * 0.55)
        l.beam('lm_metal', (top[0] + rail_o[0], ry + 0.9, top[1] + rail_o[1]), (foot[0] + rail_o[0], 1.0, foot[1] + rail_o[1]), 0.06, 0.06, STAIR, caps=False)
        for p, y in ((top, ry), (foot, 0.1)):
            l.box('lm_metal', (p[0] + rail_o[0], y + 0.45, p[1] + rail_o[1]), (0.06, 0.9, 0.06), STAIR, skip=('+y', '-y'))
        # the ground power unit hung under the outer tunnel
        t = 0.62
        gp = (rot[0] + (cab[0] - rot[0]) * t, rot[1] + (cab[1] - rot[1]) * t)
        yu = ry + (ty - ry) * t
        if yu - 1.05 > 0.25:
            l.box('lm_metal', (gp[0], yu - 0.5, gp[1]), (1.3, 0.95, 0.9), GPU, rot=math.atan2(ux, uz), skip=('+y',))
        # the gate board on the wall above the root
        w = min(ring_edge_normal(rings, (rx, rz)), key=lambda e: e[0])
        _, ox, oz, tgx, tgz = w
        bx, bz = rx - ux * 0.4 + ox * 0.3, rz - uz * 0.4 + oz * 0.3
        rotb = math.atan2(ox, oz)
        l.box('lm_metal', (bx, ry + 4.35, bz), (2.1, 1.05, 0.16), DARK, rot=rotb)
        p0 = (bx + ox * 0.085 - tgx * 0.95, bz + oz * 0.085 - tgz * 0.95)
        p1 = (bx + ox * 0.085 + tgx * 0.95, bz + oz * 0.085 + tgz * 0.95)
        l.quad('lm_screen', (p0[0], ry + 3.9, p0[1]), (p1[0], ry + 3.9, p1[1]), (p1[0], ry + 4.8, p1[1]), (p0[0], ry + 4.8, p0[1]), SCREEN, hint=(ox, 0, oz))
        q0 = (p0[0] + tgx * 0.25 + ox * 0.01, p0[1] + tgz * 0.25 + oz * 0.01)
        q1 = (p0[0] + tgx * 0.75 + ox * 0.01, p0[1] + tgz * 0.75 + oz * 0.01)
        l.quad('lm_screen', (q0[0], ry + 4.0, q0[1]), (q1[0], ry + 4.0, q1[1]), (q1[0], ry + 4.7, q1[1]), (q0[0], ry + 4.7, q0[1]), SCREEN_HI, hint=(ox, 0, oz))
        return hull
    # far: a plain beam from the wall to the cab, a rotunda column and the drive leg
    cab = (tx - ux * 1.2, tz - uz * 1.2)
    rot = (rx + ux * 4.0, rz + uz * 4.0)
    h = apt.BRIDGE_H
    l.beam('lm_metal', (rx, ry + h / 2, rz), (rot[0], ry + h / 2, rot[1]), apt.BRIDGE_W, h, BRIDGE, caps=False)
    l.beam('lm_metal', (rot[0], ry + h / 2, rot[1]), (cab[0], ty + h / 2, cab[1]), apt.BRIDGE_W, h, BRIDGE)
    if lod == 1:
        l.box('lm_metal', (rot[0], ry + 1.6, rot[1]), (3.6, 3.4, 3.6), BRIDGE, skip=('-y',))
        l.box('lm_metal', (cab[0], ty + h / 2, cab[1]), (3.4, h + 0.2, 2.6), BRIDGE, rot=math.atan2(ux, uz), skip=('-y',))
        l.box('lm_stone', (rot[0], ry / 2, rot[1]), (0.9, ry, 0.9), DARK, skip=('+y', '-y'))
        leg = (rot[0] + (cab[0] - rot[0]) * 0.72, rot[1] + (cab[1] - rot[1]) * 0.72)
        yl = ry + (ty - ry) * 0.72
        l.box('lm_stone', (leg[0], yl / 2, leg[1]), (1.6, yl, 0.5), DARK, rot=math.atan2(ux, uz), skip=('+y', '-y'))
    return []


def ring_edge_normal(rings, p):
    """(distance, outward normal x, z, tangent x, z) of every edge of `rings` from p."""
    out = []
    for r in rings:
        for a, b, ln, o, tg in edge_list(r):
            t = max(0.0, min(1.0, ((p[0] - a[0]) * tg[0] + (p[1] - a[1]) * tg[1]) / ln))
            q = (a[0] + tg[0] * ln * t, a[1] + tg[1] * ln * t)
            out.append((math.hypot(q[0] - p[0], q[1] - p[1]), o[0], o[1], tg[0], tg[1]))
    return out


# ---------------------------------------------------------------------------------------------- the curved roof of F
def f_profile(sp, uw, ue):
    """F's roof height across the main body: eaves at the walls (u = uw west, ue east), the crest between; the curve as a
    function of u (piecewise linear between `breaks`, so each trapezoid of the roof is planar), and its slope for normals."""
    mid = (uw + ue) / 2
    hw = (ue - uw) / 2 + sp['overhang']

    def y(u):
        t = max(-1.0, min(1.0, (u - mid) / hw))
        return sp['crest'] - (sp['crest'] - sp['eave']) * t * t

    def dy(u):
        t = (u - mid) / hw
        if abs(t) > 1.0:
            return 0.0
        return -2.0 * (sp['crest'] - sp['eave']) * t / hw
    breaks = [mid + hw * (k / 6.0) for k in range(-6, 7)]
    return y, dy, breaks


def curved_roof(l, rings, ang, y, dy, breaks, col, lod, lift=0.0):
    """The roof over `rings` at height y(u): trapezoids between breaks, smooth normals from the slope."""
    eu = (math.cos(ang), math.sin(ang))
    for (u0, va0, vb0), (u1, va1, vb1) in apt.trapezoids(rings, ang, breaks):
        pts = [(u0, va0), (u1, va1), (u1, vb1), (u0, vb0)]
        P = []
        N = []
        for u, v in pts:
            x, z = apt.uv_to_xz(u, v, ang)
            P.append((x, y(u) + lift, z))
            s = dy(u)
            n = (-s * eu[0], 1.0, -s * eu[1])
            ln = math.sqrt(n[0] ** 2 + 1 + n[2] ** 2)
            N.append((n[0] / ln, 1 / ln, n[2] / ln))
        l.poly('bld_roof', P, col, hint=(0, 1, 0), normals=N if lod == 0 else None)


# ---------------------------------------------------------------------------------------------- the model
def build(asset):
    apt.start()
    k = letter(asset)
    sp = SPEC[k]
    h = apt.hero(asset)
    ring = [tuple(p) for p in h['rings'][0]]
    others = [[tuple(p) for p in r] for r in h['rings'][1:]]
    gates = apt.gates(asset)
    ang = axis_of(ring)
    uc, secs = spine(ring, ang)
    curved = k == 'f'
    if curved:
        # F's main body: the widest run of narrow sections gives its west and east walls
        nar = [iv for _, ivs in secs for iv in ivs if 25 < iv[1] - iv[0] < 45]
        uw = sorted(a for a, b in nar)[len(nar) // 2]
        ue = sorted(b for a, b in nar)[len(nar) // 2]
        fy, fdy, fbreaks = f_profile(sp, uw, ue)
        sp = dict(sp, glass_top=sp['eave'] - 1.0, roof=sp['eave'], parapet=0.0)
        uc = (uw + ue) / 2
    else:
        fy = None
    cw, crise = sp['cler']
    # the clerestory runs: where a strip of the clerestory's width (and 4 m either side) fits in the outline
    cruns = runs(secs, lambda iv: holds(iv, uc - cw / 2 - 4.0, uc + cw / 2 + 4.0))
    # the atrium: where the outline is much wider than the pier
    wide = runs(secs, lambda iv: holds(iv, uc - 24.0, uc + 24.0), min_len=24.0) if not curved else []
    extra_spines = []
    if k == 'e':
        # E's long east arm (the cross of the plan): its own clerestory along it
        a2 = ang + math.pi / 2
        uc2, secs2 = spine(ring, a2, vrange=None)
        extra_spines.append((a2, uc2, secs2))

    lods = []
    hull = []
    for lod in (0, 1, 2):
        l = lm.Lod(lod)
        if lod == 2:
            far = parts.simplify(ring, 4.0, keep=8)
            top = (sp['roof'] + sp['parapet']) if not curved else sp['eave'] + 1.5
            l.ring_walls('bld_wall', far, 0, top, PRECAST, lm.K_CIVIC, floor_h=4.5, era=sp['era'], fid=sp['fid'])
            flat_roof(l, [far], top, mat='bld_roof')
            for cr in cruns:
                clerestory(l, ang, uc, cr[0] + 4, cr[1] - 4, cw, top, crise, lod)
            for r in others:
                rr = parts.simplify(r, 3.0, keep=4)
                l.ring_walls('bld_wall', rr, 0, 9.0, PRECAST, lm.K_CIVIC, floor_h=4.5, era=sp['era'], fid=sp['fid'] + 5)
                l.cap('bld_roof', rr, 9.0, ROOF)
            lods.append(l)
            continue
        rr = ring if lod == 0 else parts.simplify(ring, 1.2, keep=8)
        if curved:
            walls(l, rr, sp, lod, top_of=lambda p: fy(to_uv(p, ang)[0]) - 0.05, fid=sp['fid'])
            # the roof: over the outline grown by the overhang along the long sides
            roof_ring = apt.offset(rr, 1.2, tol=1.5)
            curved_roof(l, [roof_ring], ang, fy, fdy, fbreaks if lod == 0 else fbreaks[::2], srgb(0xc7cacb), lod)
            roof_edge(l, roof_ring, lambda p: fy(to_uv(p, ang)[0]), 0.7)
            overhangs(l, rr, ang, fy, lod)
            for cr in cruns:
                v0, v1 = cr[0] + 6.0, cr[1] - 6.0
                clerestory(l, ang, uc, v0, v1, cw, fy(uc) - 0.3, crise, lod)
        else:
            walls(l, rr, sp, lod, fid=sp['fid'])
            flat_roof(l, [rr], sp['roof'])
            if lod == 0:
                parapet(l, rr, sp['roof'], sp['roof'] + sp['parapet'])
            for cr in cruns:
                v0, v1 = cr[0] + 4.0, cr[1] - 4.0
                if v1 - v0 > 10:
                    clerestory(l, ang, uc, v0, v1, cw, sp['roof'], crise, lod)
            for a2, uc2, secs2 in extra_spines:
                # E's arm: from 12 m east of the pier's east face to near its end
                for cr in runs(secs2, lambda iv: holds(iv, uc2 - cw / 2 - 4.0, uc2 + cw / 2 + 4.0)):
                    v0, v1 = cr[0] + 4.0, cr[1] - 4.0
                    # keep it off the main pier's clerestory
                    pts = [apt.uv_to_xz(uc2, v, a2) for v in (v0, v1)]
                    ok = [to_uv(p, ang) for p in pts]
                    if all(abs(q[0] - uc) < cw / 2 + 3 for q in ok):
                        continue
                    lo_v = v0
                    # clip where it would cross the pier's strip
                    vs = [v0 + (v1 - v0) * t / 40.0 for t in range(41)]
                    good = [v for v in vs if abs(to_uv(apt.uv_to_xz(uc2, v, a2), ang)[0] - uc) > cw / 2 + 6]
                    if len(good) > 4:
                        seg = longest_run(vs, good)
                        if seg[1] - seg[0] > 12:
                            clerestory(l, a2, uc2, seg[0], seg[1], cw * 0.8, sp['roof'], crise * 0.85, lod)
            for wr in wide:
                v0, v1 = wr[0] + 5.0, wr[1] - 5.0
                if v1 - v0 > 12:
                    atrium(l, ang, uc - 17.0, uc + 17.0, v0, v1, sp['roof'], 2.2, sp['fid'] + 3, sp['era'], lod)
            if lod == 0:
                rooftop(l, ring, ang, uc, cruns, cw, sp['roof'])
        # E's north link and annex
        for j, r in enumerate(others):
            r2 = r if lod == 0 else parts.simplify(r, 1.0, keep=4)
            l.ring_walls('bld_wall', r2, 0, SLAB_Y0, PRECAST_D, lm.K_CIVIC, floor_h=3.0, era=sp['era'], fid=sp['fid'] + 6 + j)
            parts.band(l, r2, SLAB_Y0, SLAB_Y1, 0.0, SLAB, top=False)
            l.ring_walls('bld_glass', r2, SLAB_Y1, 8.2, sp['glass'], lm.K_GLASS, floor_h=4.5, era=sp['era'], fid=sp['fid'] + 8 + j)
            parts.band(l, r2, 8.2, 9.4, 0.0, FASCIA, mat='lm_metal', top=False)
            l.cap('bld_roof', r2, 9.4, ROOF)
        # the jet bridges
        for g in gates:
            hb = bridge(l, g, [ring] + others, lod)
            if lod == 0:
                hull += hb
        lods.append(l)

    top = (sp['roof'] if not curved else sp['eave'])
    hull = [(apt.offset(ring, -0.3), top)] + [(apt.offset(r, -0.3), 9.4) for r in others] + hull
    flatten = [(apt.offset(r, 2.0), 25.0) for r in [ring] + others]
    return apt.report(asset, asset, lods, hull, lod_from=[0, 600, 1800], flatten=flatten)


def longest_run(vs, good):
    gs = set(round(v, 6) for v in good)
    best, cur = (0, 0), None
    for v in vs:
        if round(v, 6) in gs:
            cur = [v, v] if cur is None else [cur[0], v]
            if cur[1] - cur[0] > best[1] - best[0]:
                best = tuple(cur)
        else:
            cur = None
    return best


def rooftop(l, ring, ang, uc, cruns, cw, y):
    """Plant on the roof beside the clerestory: air handlers every 60 m or so, alternating sides, and a few small louvred boxes."""
    k = 0
    for v0, v1 in cruns:
        v = v0 + 18.0
        while v < v1 - 12.0:
            side = 1 if k % 2 else -1
            u = uc + side * (cw / 2 + 5.0)
            su, sv, hgt = 5.0, 9.0 + (k % 3) * 2.0, 2.4 + (k % 2) * 0.6
            pts = [apt.uv_to_xz(u + du, v + dv, ang) for du in (-su / 2 - 1, su / 2 + 1) for dv in (-sv / 2 - 1, sv / 2 + 1)]
            if inside_all(ring, pts):
                box_uv(l, 'lm_metal', ang, u, v, y, su, sv, hgt, PLANT, skip=('-y',))
                box_uv(l, 'lm_dark', ang, u, v + sv / 2 - 1.6, y + hgt, 2.2, 2.2, 0.5, DARK, skip=('-y',))
                if k % 3 == 0:
                    box_uv(l, 'lm_metal', ang, u + side * 4.5, v - 3.0, y, 2.0, 3.0, 1.6, shade(PLANT, 0.9), skip=('-y',))
            k += 1
            v += 62.0


def roof_edge(l, ring, Y, th):
    """A fascia round the edge of a sloping roof: from Y(p) - th up to Y(p)."""
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        out = parts.outward(ring, i)
        l.quad('lm_metal', (a[0], Y(a) - th, a[1]), (b[0], Y(b) - th, b[1]), (b[0], Y(b), b[1]), (a[0], Y(a), a[1]), FASCIA, hint=out)


def overhangs(l, ring, ang, fy, lod):
    """F's deep eaves: along every long wall roughly parallel to the concourse, a ribbon of roof reaching out over the apron,
    its soffit white, its edge a thin fascia."""
    eu = (math.cos(ang), math.sin(ang))
    for a, b, ln, out, tg in edge_list(ring):
        if ln < 30.0 or abs(out[0] * eu[0] + out[1] * eu[1]) < 0.9:
            continue
        d = SPEC['f']['overhang']
        a2 = (a[0] + out[0] * d, a[1] + out[1] * d)
        b2 = (b[0] + out[0] * d, b[1] + out[1] * d)
        # shorten the ribbon a little at each end so neighbouring ribbons do not cross
        ta = (a[0] + tg[0] * 1.0, a[1] + tg[1] * 1.0)
        tb = (b[0] - tg[0] * 1.0, b[1] - tg[1] * 1.0)
        a2 = (a2[0] + tg[0] * 1.0, a2[1] + tg[1] * 1.0)
        b2 = (b2[0] - tg[0] * 1.0, b2[1] - tg[1] * 1.0)
        Y = lambda p: fy(to_uv(p, ang)[0])
        top = [(ta[0], Y(ta), ta[1]), (tb[0], Y(tb), tb[1]), (b2[0], Y(b2), b2[1]), (a2[0], Y(a2), a2[1])]
        l.poly('bld_roof', top, srgb(0xc7cacb), hint=(0, 1, 0))
        th = 0.9
        bot = [(p[0], p[1] - th, p[2]) for p in top]
        l.poly('lm_stone', bot, srgb(0xeef0ef), hint=(0, -1, 0))
        # the fascia at the outer edge and the two ends
        p, q = top[3], top[2]
        l.quad('lm_metal', (p[0], p[1] - th, p[2]), (q[0], q[1] - th, q[2]), q, p, FASCIA, hint=(out[0], 0, out[1]))
        for e0, e1, sg in ((top[0], top[3], -1), (top[1], top[2], 1)):
            l.quad('lm_metal', (e0[0], e0[1] - th, e0[2]), (e1[0], e1[1] - th, e1[2]), e1, e0, FASCIA, hint=(tg[0] * sg, 0, tg[1] * sg))
        if lod == 0:
            # a light line under the edge, and slender struts from the wall's top to the edge every 18 m
            ga, gb = bot[3], bot[2]
            l.quad('lm_glow', (ga[0] - out[0] * 0.3, ga[1] - 0.02, ga[2] - out[1] * 0.3), (gb[0] - out[0] * 0.3, gb[1] - 0.02, gb[2] - out[1] * 0.3),
                   (gb[0] - out[0] * 0.6, gb[1] - 0.02, gb[2] - out[1] * 0.6), (ga[0] - out[0] * 0.6, ga[1] - 0.02, ga[2] - out[1] * 0.6), COVE, hint=(0, -1, 0))
            n = max(1, int(ln / 18.0))
            for j in range(n + 1):
                t = j / n
                w = (ta[0] + (tb[0] - ta[0]) * t, ta[1] + (tb[1] - ta[1]) * t)
                e = (w[0] + out[0] * (d - 1.0), w[1] + out[1] * (d - 1.0))
                l.beam('lm_metal', (w[0] + out[0] * 0.2, 7.0, w[1] + out[1] * 0.2), (e[0], Y(e) - th - 0.1, e[1]), 0.35, 0.35, FASCIA)
