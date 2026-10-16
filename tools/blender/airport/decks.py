"""Hartsfield-Jackson's parking decks: the North and South Hourly and Daily decks in front of the Domestic Terminal (4 levels),
the ATL West Parking Deck (7 levels) and the Rental Car Center (two 4-level decks with brick-clad stair towers, the
customer-service hall between them under the SkyTrain station, a big canopy over its curb, and a smaller deck to the south). One
parametric model, the asset name picks the deck; each on its real outline (airport.json).

Open-sided cast-in-place decks: a precast spandrel band at every level (lm_stone), columns standing proud of it, the
openings dark (an lm_dark lining a metre inside), the ceiling lights of each level seen through them; the ramp bays at one
end show sloping spandrels; stair and elevator towers at the corners rise above the roof (glass at the terminal decks, brick
at the Rental Car Center); on the roof, light poles and a few parked cars (plain dark boxes). The hull is the whole outline
to the parapet: cars do not drive into the model (its ramps are not drivable).

Night: the levels' ceiling lights (lm_glow) show through the openings, the roof's pole lamps glow, the towers' glass is lit.
"""
import math

from airport import apt
from landmarks import lm, parts
from landmarks.lm import shade, srgb

VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

SPANDREL = srgb(0xcfcbc1)
SPANDREL_D = srgb(0xbcb7ac)
COLUMN = srgb(0xc4c0b5)
INSIDE = srgb(0x2c2d2e)
DECK = srgb(0x8f8f8b)
STRIPE = srgb(0xd8d6cc)
POLE = srgb(0x8a8f94)
LAMP = srgb(0xfff1d6)
CEILING = srgb(0xe8eef0)
GLASS = srgb(0x5d8197)
BRICK = srgb(0x8c4f3c)
BRICK_D = srgb(0x7b4434)
CAR_COLS = [srgb(0x2b2e33), srgb(0x5c6066), srgb(0x8a8d90), srgb(0x6b1f1f), srgb(0x1f2d4a), srgb(0xb9bbbd), srgb(0x3b3f2f), srgb(0x202020)]

FH = 3.3              # floor to floor
SLAB = 0.35           # slab edge below each deck
BARRIER = 1.05        # the spandrel's height above each deck
TOWER = 8.0

DECKS = {
    'atl-north-hourly-deck': dict(levels=4, towers='glass', fid=1001),
    'atl-north-daily-deck': dict(levels=4, towers='glass', fid=1011),
    'atl-south-hourly-deck': dict(levels=4, towers='glass', fid=1021),
    'atl-south-daily-deck': dict(levels=4, towers='glass', fid=1031),
    'atl-west-parking-deck': dict(levels=7, towers='glass', fid=1041),
    'atl-rental-car-center': dict(levels=4, towers='brick', fid=1051),
}


def h32(*v):
    """A deterministic hash of integers to [0, 1)."""
    x = 0x811C9DC5
    for k in v:
        x = ((x ^ (k & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    x ^= x >> 13
    x = (x * 0x5bd1e995) & 0xFFFFFFFF
    x ^= x >> 15
    return x / 4294967296.0


def edges(ring):
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    out = []
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz)
        if ln < 1e-6:
            continue
        out.append((i, a, b, ln, (dz / ln * s, -dx / ln * s), (dx / ln, dz / ln)))
    return out


def vquad(l, mat, a, b, y0, y1, out, col, d=0.0, ya1=None, yb1=None, ya0=None, yb0=None):
    ox, oz = out[0] * d, out[1] * d
    l.quad(mat, (a[0] + ox, y0 if ya0 is None else ya0, a[1] + oz), (b[0] + ox, y0 if yb0 is None else yb0, b[1] + oz),
           (b[0] + ox, y1 if yb1 is None else yb1, b[1] + oz), (a[0] + ox, y1 if ya1 is None else ya1, a[1] + oz), col, hint=(out[0], 0, out[1]))


def ramp_edge(ring):
    """The edge with the ramp bays: the longest of the short sides (an end of the deck)."""
    es = edges(ring)
    cx, cz, ang, L, W = lm.min_obb(ring)
    along = (math.cos(ang), math.sin(ang)) if L > W else (-math.sin(ang), math.cos(ang))
    ends = [e for e in es if abs(e[4][0] * along[0] + e[4][1] * along[1]) > 0.8 and e[3] > 20.0]
    if not ends:
        return None
    return max(ends, key=lambda e: (e[3], -e[0]))[0]


def deck_shell(l, ring, levels, lod, fid, ramp=True):
    """The facade of an open deck round one ring: spandrels, columns, the dark lining with the levels' lights, the roof."""
    top = (levels - 1) * FH
    es = edges(ring)
    re = ramp_edge(ring) if ramp else None
    inner = lm.inset_ring(ring, 1.0)
    # the dark lining a metre inside, ground to roof
    for k, (i, a, b, ln, out, tg) in enumerate(es):
        ia, ib = inner[i], inner[(i + 1) % len(ring)]
        vquad(l, 'lm_dark', ia, ib, 0.0, top - SLAB, out, INSIDE)
        if lod == 0:
            # the ceiling lights of each level, seen through the openings
            for lv in range(1, levels):
                y = lv * FH - SLAB - 0.12
                vquad(l, 'lm_glow', ia, ib, y - 0.12, y, out, CEILING, d=0.05)
    seen = set()
    for k, (i, a, b, ln, out, tg) in enumerate(es):
        col = SPANDREL if k % 2 else SPANDREL_D
        # the ground curb
        vquad(l, 'lm_stone', a, b, 0.0, 0.45, out, col)
        sloped = re is not None and i == re and lod < 2
        for lv in range(1, levels):
            y = lv * FH
            if sloped and lv < levels - 1:
                # a ramp bay: the spandrel climbs a level along the edge
                vquad(l, 'lm_stone', a, b, 0, 0, out, col, ya0=y - SLAB, yb0=y + FH - SLAB, ya1=y + BARRIER, yb1=y + FH + BARRIER)
            elif sloped and lv == levels - 1:
                vquad(l, 'lm_stone', a, b, y - SLAB, y + BARRIER, out, col)
            elif not sloped:
                vquad(l, 'lm_stone', a, b, y - SLAB, y + BARRIER, out, col)
            if lod == 0 and not sloped:
                # a drip groove under the band
                vquad(l, 'lm_dark', a, b, y - SLAB - 0.06, y - SLAB, out, INSIDE, d=-0.02)
        # columns proud of the bands
        step = 9.0 if lod == 0 else 18.0
        if lod < 2 and ln > 6.0:
            n = max(1, int(round(ln / step)))
            rot = math.atan2(out[0], out[1])
            for j in range(n + 1):
                t = j / n
                q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                key = (round(q[0] / 2.0), round(q[1] / 2.0))
                if key in seen:
                    continue
                seen.add(key)
                p = (q[0] + out[0] * 0.2, q[1] + out[1] * 0.2)
                l.box('lm_stone', (p[0], top / 2 + BARRIER / 2, p[1]), (0.7, top + BARRIER, 0.5), COLUMN, rot=rot, skip=('-y', '-z'))
    # the roof deck and the parapet's inside
    flat_roof(l, ring, top, DECK)
    if lod == 0:
        par = lm.inset_ring(ring, 0.3)
        for i in range(len(ring)):
            a, b = par[i], par[(i + 1) % len(ring)]
            o = parts.outward(ring, i)
            l.quad('lm_stone', (a[0], top, a[1]), (b[0], top, b[1]), (b[0], top + BARRIER, b[1]), (a[0], top + BARRIER, a[1]), shade(SPANDREL, 0.85), hint=(-o[0], 0, -o[2]))
            ra, rb = ring[i], ring[(i + 1) % len(ring)]
            l.quad('lm_stone', (ra[0], top + BARRIER, ra[1]), (rb[0], top + BARRIER, rb[1]), (b[0], top + BARRIER, b[1]), (a[0], top + BARRIER, a[1]), SPANDREL, hint=(0, 1, 0))
    return top


def flat_roof(l, ring, y, col, mat='lm_stone'):
    for (u0, va0, vb0), (u1, va1, vb1) in apt.trapezoids([ring]):
        q = [apt.uv_to_xz(u, v) for u, v in ((u0, va0), (u1, va1), (u1, vb1), (u0, vb0))]
        l.poly(mat, [(p[0], y, p[1]) for p in q], col, hint=(0, 1, 0))


def corners(ring, k=4):
    """Up to k convex, near-square corners of a ring, spread out (farthest-point order from the north-west one)."""
    s = 1.0 if lm.area2(ring) > 0 else -1.0
    n = len(ring)
    cand = []
    for i in range(n):
        p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
        e0 = (p1[0] - p0[0], p1[1] - p0[1])
        e1 = (p2[0] - p1[0], p2[1] - p1[1])
        l0, l1 = math.hypot(*e0), math.hypot(*e1)
        if l0 < 10 or l1 < 10:
            continue
        cr = (e0[0] * e1[1] - e0[1] * e1[0]) * s
        cosang = (e0[0] * e1[0] + e0[1] * e1[1]) / (l0 * l1)
        if cr > 0 and abs(cosang) < 0.35:
            cand.append(i)
    if not cand:
        return []
    first = min(cand, key=lambda i: (ring[i][0] + ring[i][1], i))
    out = [first]
    while len(out) < min(k, len(cand)):
        nxt = max((i for i in cand if i not in out), key=lambda i: (min(math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]) for j in out), -i))
        out.append(nxt)
    return sorted(out)


def tower(l, ring, i, top, style, lod, fid, hull):
    """A stair and elevator tower filling the corner i of the ring, a little proud of the facade, up past the roof."""
    n = len(ring)
    p0, p1, p2 = ring[i - 1], ring[i], ring[(i + 1) % n]
    d0 = (p0[0] - p1[0], p0[1] - p1[1])
    d1 = (p2[0] - p1[0], p2[1] - p1[1])
    l0, l1 = math.hypot(*d0), math.hypot(*d1)
    u0 = (d0[0] / l0, d0[1] / l0)
    u1 = (d1[0] / l1, d1[1] / l1)
    o = 0.45
    c = (p1[0] - u0[0] * o - u1[0] * o, p1[1] - u0[1] * o - u1[1] * o)
    w = TOWER + o
    sq = [c, (c[0] + u1[0] * w, c[1] + u1[1] * w), (c[0] + u1[0] * w + u0[0] * w, c[1] + u1[1] * w + u0[1] * w), (c[0] + u0[0] * w, c[1] + u0[1] * w)]
    if lm.area2(sq) < 0:
        sq = sq[::-1]
    h = top + 4.6
    if style == 'brick':
        l.ring_walls('bld_wall', sq, 0, h, BRICK if i % 2 else BRICK_D, lm.K_BRICK, floor_h=FH, era=4, fid=fid)
    else:
        l.ring_walls('bld_glass', sq, 0, h, GLASS, lm.K_GLASS, floor_h=FH, era=4, fid=fid)
    parts.band(l, sq, h, h + 0.6, 0.15, SPANDREL, top=True)
    l.cap('bld_roof', parts.scaled(sq, 0.96), h + 0.6, srgb(0x77797a))
    if lod == 0:
        # the elevator machine room on top
        mr = parts.scaled(sq, 0.55)
        parts.band(l, mr, h + 0.6, h + 2.8, 0.0, SPANDREL_D, top=False)
        l.cap('bld_roof', mr, h + 2.8, srgb(0x77797a))
    if lod == 0:
        hull.append((sq, h))


def roof_fittings(l, ring, top, seed, max_cars=420, lines=True):
    """Light poles on a 30 m grid and parked cars in rows across the deck's long axis."""
    cx, cz, ang, L, W = lm.min_obb(ring)
    # the rows run along the long side
    if W > L:
        ang += math.pi / 2
        L, W = W, L
    eu = (math.cos(ang), math.sin(ang))
    ev = (-math.sin(ang), math.cos(ang))
    inner = apt.offset(ring, -6.0, tol=2.0)

    def at(u, v):
        return (cx + eu[0] * u + ev[0] * v, cz + eu[1] * u + ev[1] * v)
    rot = math.atan2(eu[0], eu[1])
    # poles
    nu, nv = max(1, int(L / 32.0)), max(1, int(W / 32.0))
    for i in range(nu + 1):
        for j in range(nv + 1):
            u = -L / 2 + 8 + (L - 16) * i / nu
            v = -W / 2 + 8 + (W - 16) * j / nv
            p = at(u, v)
            if not apt.inside(inner, p[0], p[1]):
                continue
            l.box('lm_metal', (p[0], top + 4.5, p[1]), (0.22, 9.0, 0.22), POLE, skip=('-y',))
            l.box('lm_metal', (p[0], top + 9.05, p[1]), (1.4, 0.18, 0.5), POLE, rot=rot, skip=('-y',))
            l.box('lm_glow', (p[0], top + 8.93, p[1]), (1.2, 0.06, 0.4), LAMP, rot=rot, skip=('+y',))
    # cars: double rows of stalls (5.3 m deep, 2.7 m wide) about 16 m apart, some of them taken; the stalls' painted lines
    cars = 0
    rows = int((W - 10) / 16.0)
    for r in range(rows):
        v0 = -W / 2 + 5 + r * 16.0
        for side, dv in ((0, 2.65), (1, 7.95)):
            v = v0 + dv
            nst = int((L - 12) / 2.7)
            if lines:
                for s in range(0, nst + 1):
                    u = -L / 2 + 6 + s * 2.7
                    a, b = at(u - 0.06, v - 2.5), at(u + 0.06, v + 2.5)
                    if not (apt.inside(inner, a[0], a[1]) and apt.inside(inner, b[0], b[1])):
                        continue
                    q = [at(u - 0.06, v - 2.5), at(u + 0.06, v - 2.5), at(u + 0.06, v + 2.5), at(u - 0.06, v + 2.5)]
                    l.poly('lm_stone', [(p[0], top + 0.02, p[1]) for p in q], STRIPE, hint=(0, 1, 0))
            for s in range(nst):
                u = -L / 2 + 6 + s * 2.7 + 1.35
                if h32(seed, r, side, s) > 0.2 or cars >= max_cars:
                    continue
                p = at(u, v)
                corners_ok = all(apt.inside(inner, q[0], q[1]) for q in (at(u - 1.3, v - 2.7), at(u + 1.3, v + 2.7)))
                if not corners_ok:
                    continue
                col = CAR_COLS[int(h32(seed, s, r, side, 7) * len(CAR_COLS))]
                hgt = 1.42 + 0.3 * (h32(seed, s, r, 3) > 0.8)
                l.box('lm_metal', (p[0], top, p[1]), (4.5, hgt, 1.8), col, rot=rot, y_is_base=True, skip=('-y',))
                cars += 1
    return cars


def hall(l, ring, roof_y, lod, fid):
    """The Rental Car Center's customer-service hall: brick piers and a glazed front under the station, a deep fascia."""
    l.ring_walls('bld_wall', ring, 0, 1.2, BRICK_D, lm.K_BRICK, floor_h=1.2, era=4, fid=fid)
    l.ring_walls('bld_glass', ring, 1.2, roof_y - 1.3, GLASS, lm.K_GLASS, floor_h=roof_y - 2.5, era=4, fid=fid + 1)
    parts.band(l, ring, roof_y - 1.3, roof_y, 0.3, BRICK, mat='bld_wall' if False else 'lm_stone', top=True)
    flat_roof(l, apt.offset(ring, 0.25), roof_y, srgb(0x7c7e7f), mat='bld_roof')
    if lod == 0:
        # brick piers every 8 m
        for i, a, b, ln, out, tg in edges(ring):
            n = int(ln / 8.0)
            rot = math.atan2(out[0], out[1])
            for j in range(1, n):
                t = j / n
                p = (a[0] + (b[0] - a[0]) * t + out[0] * 0.3, a[1] + (b[1] - a[1]) * t + out[1] * 0.3)
                l.box('lm_stone', (p[0], (roof_y - 1.3) / 2, p[1]), (1.0, roof_y - 1.3, 0.6), BRICK, rot=rot, skip=('-y', '+y', '-z'))


def canopy(l, ring, y, lod):
    """A big white canopy on slender columns over the ring grown by 3 m."""
    r = apt.offset(ring, 3.0, tol=1.0)
    l.cap('lm_lit', r, y, srgb(0xf0f1ef), up=False)
    l.cap('lm_metal', r, y + 0.9, srgb(0xe6e7e5), up=True)
    parts.band(l, r, y, y + 0.9, 0.0, srgb(0xe6e7e5), mat='lm_metal', top=False)
    cols = []
    if lod < 2:
        inner = apt.offset(ring, 0.5, tol=1.0)
        for i, a, b, ln, out, tg in edges(inner):
            n = max(1, int(ln / 14.0))
            for j in range(n):
                t = (j + 0.5) / n
                p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                l.lathe('lm_metal', [(0.35, 0.0), (0.3, y)], 8 if lod == 0 else 5, srgb(0xd9dbdc), cx=p[0], cz=p[1], smooth=False)
                cols.append(p)
    return cols


def build(asset):
    apt.start()
    sp = DECKS[asset]
    h = apt.hero(asset)
    rings = [[tuple(p) for p in r] for r in h['rings']]
    also = [[tuple(p) for p in r] for r in h.get('alsoRings', [])]
    rcc = asset == 'atl-rental-car-center'
    lv = sp['levels']
    lods = []
    hull = []
    tops = []
    if rcc:
        # the hall sits under the SkyTrain's girders: its roof 2.4 m under the lowest running surface over it
        from airport import skytrain
        ax, az = h['anchor']['x'], h['anchor']['z']
        hr = also[0]
        ys = []
        for p in hr:
            for q in (p, parts.mean(hr)):
                ys.append(skytrain.deck_asl(ax + q[0], az + 1.5) - h['elevation'])
                ys.append(skytrain.deck_asl(ax + q[0], az + 9.2) - h['elevation'])
        hall_y = round(min(ys) - skytrain.GIRDER_D - 0.6, 2)
    for lod in (0, 1, 2):
        l = lm.Lod(lod)
        deck_rings = rings if not rcc else rings + [also[6]]
        for k, ring in enumerate(deck_rings):
            levels = lv if not (rcc and k == 2) else 2
            rr = ring if lod == 0 else parts.simplify(ring, 1.5 if lod == 1 else 4.0, keep=4)
            if lod == 2:
                top = (levels - 1) * FH
                l.ring_walls('bld_wall', rr, 0, top + BARRIER, SPANDREL, lm.K_PARKING, floor_h=FH, era=4, fid=sp['fid'] + k)
                l.cap('lm_stone', rr, top + BARRIER, DECK)
            else:
                top = deck_shell(l, rr, levels, lod, sp['fid'] + k)
            if lod == 0:
                tops.append((ring, top + BARRIER))
                roof_fittings(l, ring, top, sp['fid'] + k, max_cars=260 if lv < 6 else 360)
            if lod < 2 and not rcc:
                cr = parts.simplify(ring, 1.0, keep=4)
                for i in corners(cr, 4):
                    tower(l, cr, i, top, sp['towers'], lod, sp['fid'] + 5 + i, hull)
        if rcc:
            # the brick stair towers on the decks' inner faces (the four building parts), 4.2 m past the roof
            top = (lv - 1) * FH
            for j, r in enumerate(also[2:6]):
                rr = r if lod == 0 else parts.simplify(r, 1.0, keep=4)
                l.ring_walls('bld_wall', rr, 0, top + 4.2, BRICK if j % 2 else BRICK_D, lm.K_BRICK, floor_h=FH, era=4, fid=sp['fid'] + 20 + j)
                parts.band(l, rr, top + 4.2, top + 4.8, 0.2, SPANDREL, top=True)
                l.cap('bld_roof', rr, top + 4.8, srgb(0x77797a))
                if lod == 0:
                    hull.append((apt.offset(r, -0.2), top + 4.2))
            # the customer-service hall and the canopy
            rr = also[0] if lod == 0 else parts.simplify(also[0], 1.0, keep=4)
            hall(l, rr, hall_y, lod, sp['fid'] + 30)
            # (its top level with the hall's roof: the SkyTrain's girders pass over its north edge)
            cols = canopy(l, also[1] if lod == 0 else parts.simplify(also[1], 1.0, keep=4), hall_y - 0.9, lod)
            if lod == 0:
                hull += [(apt.rect_ring(p[0], p[1], 0.6, 0.6), hall_y - 0.9) for p in cols]
                hull.append((apt.offset(also[0], -0.3), hall_y))
        lods.append(l)
    hull = [(apt.offset(r, -0.3), ht) for r, ht in tops] + hull
    flatten = [(apt.offset(r, 2.0), 25.0) for r in rings + ([also[0], also[6]] if rcc else [])]
    extra = {'hallRoof': hall_y} if rcc else None
    return apt.report(asset, asset, lods, hull, lod_from=[0, 600, 1800], flatten=flatten, extra=extra)
