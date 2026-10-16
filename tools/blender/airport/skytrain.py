"""The ATL SkyTrain: the elevated people mover from the Airport station (west of the Domestic Terminal) over the parking and
the roads to the Georgia International Convention Center / Gateway Center and on to the Rental Car Center. Drawn on the
OSM guideways (airport.json skytrain.ways: two tracks most of the way, the loops and tail tracks at the ends), each a precast
concrete box girder with its running surfaces, a steel guide beam on the centre line and low curbs, on single round
columns every 30 m (one column with a crosshead under both girders where the tracks run side by side), and the three
stations as glazed boxes with canopies over the guideway, on their own supports. No lettering.

The running surface follows the ground under the guideway, smoothed over a few hundred metres, 9 m up (layer 2). The model's
y = 0 is the lowest ground under it (airport.json `elevation`), so the columns stand on the ground under each one
(ground - elevation) and their hull prisms (from y = 0 up) reach it everywhere; the guideway itself is overhead, not solid.

`deck_asl(x, z)` (game frame, metres above sea level) is the running surface's height, which the Rental Car Center's hall
(decks.py) is built under.

Night: the stations' soffits are lit (lm_lit), a lit line runs round their canopies (lm_glow), the facade shader lights their glass.
"""
import math

from airport import apt
from landmarks import lm
from landmarks.lm import shade, srgb

ID = 'atl-skytrain'
VERTEX_COLOR = 'ACTIVE'
ATTRIBUTES = True

CLEAR = 9.0          # running surface above the smoothed ground
GIRDER_D = 2.0
COL_R = 0.85
SPAN = 30.0
CONCRETE = srgb(0xcfccc4)
CONCRETE_D = srgb(0xb7b3aa)
STEEL = srgb(0x8c939a)
GLASS = srgb(0x5f8aa3)
ROOF = srgb(0xd9dbdc)
SOFFIT = srgb(0xeef0ef)
GLOW = srgb(0xdfe9ff)
PLATFORM_L = 54.0

# the girder's cross-section (across, up from the running surface), going round it; and which faces are steel
PROFILE = [(-2.2, 0.75), (-1.9, 0.75), (-1.9, 0.0), (-0.15, 0.0), (-0.15, 0.35), (0.15, 0.35), (0.15, 0.0), (1.9, 0.0), (1.9, 0.75), (2.2, 0.75),
           (2.2, -0.35), (1.5, -GIRDER_D), (-1.5, -GIRDER_D), (-2.2, -0.35)]
STEEL_EDGES = {3, 4, 5}
PROFILE_FAR = [(-2.2, 0.75), (2.2, 0.75), (2.2, -0.35), (1.5, -GIRDER_D), (-1.5, -GIRDER_D), (-2.2, -0.35)]

_CACHE = {}


def hero():
    return apt.hero(ID)


def elev():
    return hero()['elevation']


def anchor():
    a = hero()['anchor']
    return a['x'], a['z']


def ways():
    """The guideways in the model frame: [{id, pts [(x, z)], ground [m above sea level]}]."""
    if 'ways' not in _CACHE:
        ax, az = anchor()
        _CACHE['ways'] = [{'id': w['id'], 'pts': [(p[0] - ax, p[1] - az) for p in w['pts']], 'ground': list(w['ground'])} for w in apt.data()['skytrain']['ways']]
    return _CACHE['ways']


def densify(pts, vals, step):
    """Points every `step` m or less along a polyline (the original points kept), values interpolated."""
    out, ov = [pts[0]], [vals[0]]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(math.ceil(ln / step)))
        for k in range(1, n + 1):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            ov.append(vals[i] + (vals[i + 1] - vals[i]) * t)
    return out, ov


def resample(pts, step):
    """Points at even arc length (at most `step` apart) along a polyline, its ends kept: the far levels' chords."""
    segs = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)]
    total = sum(segs)
    n = max(1, int(math.ceil(total / step)))
    out = []
    for k in range(n + 1):
        s = total * k / n
        acc = 0.0
        for i, ln in enumerate(segs):
            if acc + ln >= s - 1e-9 or i == len(segs) - 1:
                t = 0.0 if ln == 0 else max(0.0, min(1.0, (s - acc) / ln))
                a, b = pts[i], pts[i + 1]
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            acc += ln
    return out


def samples():
    if 'samples' not in _CACHE:
        s = []
        for w in ways():
            p, g = densify(w['pts'], w['ground'], 8.0)
            s += [(q[0], q[1], h) for q, h in zip(p, g)]
        _CACHE['samples'] = s
    return _CACHE['samples']


def ground_smooth(x, z, r=70.0):
    sw = sg = 0.0
    for px, pz, g in samples():
        d2 = (px - x) ** 2 + (pz - z) ** 2
        if d2 > 9 * r * r:
            continue
        w = math.exp(-d2 / (r * r))
        sw += w
        sg += w * g
    return sg / sw if sw else elev()


def ground_near(x, z, r=20.0):
    """The highest sampled ground within r m: the running surface keeps at least 7.6 m over it."""
    best = None
    for px, pz, g in samples():
        if (px - x) ** 2 + (pz - z) ** 2 <= r * r:
            best = g if best is None else max(best, g)
    return best


def deck_local(x, z):
    """The running surface at a model-frame point, metres above sea level."""
    key = (round(x, 2), round(z, 2))
    c = _CACHE.setdefault('deck', {})
    if key not in c:
        y = ground_smooth(x, z) + CLEAR
        gn = ground_near(x, z)
        if gn is not None:
            y = max(y, gn + 7.6)
        c[key] = y
    return c[key]


def deck_asl(x, z):
    """The running surface over a GAME point (x, z), metres above sea level."""
    ax, az = anchor()
    return deck_local(x - ax, z - az)


def ground_at(x, z):
    """The DEM ground (from the guideway's own samples: nearest two) at a model-frame point, above sea level."""
    best = sorted(((px - x) ** 2 + (pz - z) ** 2, g) for px, pz, g in samples())[:3]
    sw = sum(1.0 / (d + 1.0) for d, _ in best)
    return sum(g / (d + 1.0) for d, g in best) / sw


# ---------------------------------------------------------------------------------------------- the girders
def frames(pts):
    out = []
    n = len(pts)
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz) or 1.0
        out.append((dx / ln, dz / ln))
    return out


def girder(l, pts, ys, profile, steel, caps):
    """Lofts the cross-section along a polyline: per point the section is set square to the mean tangent, at ys[i]."""
    tf = frames(pts)
    s = 1.0 if lm.area2(profile) > 0 else -1.0
    rings = []
    for (x, z), y, (tx, tz) in zip(pts, ys, tf):
        nx, nz = -tz, tx
        rings.append([(x + nx * a, y + b, z + nz * a) for a, b in profile])
    m = len(profile)
    for i in range(len(rings) - 1):
        tx, tz = tf[i]
        nx, nz = -tz, tx
        for k in range(m):
            k2 = (k + 1) % m
            (a0, b0), (a1, b1) = profile[k], profile[k2]
            # the profile edge's outward normal (across, up), in 3D
            ex, ey = a1 - a0, b1 - b0
            on = (ey * s, -ex * s)
            hint = (nx * on[0], on[1], nz * on[0])
            mat = 'lm_metal' if k in steel else 'lm_stone'
            col = STEEL if k in steel else (CONCRETE if on[1] >= 0 else CONCRETE_D)
            l.quad(mat, rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k], col, hint=hint)
    for end, sg in caps:
        tx, tz = tf[end]
        l.poly('lm_stone', rings[end], CONCRETE_D, hint=(tx * sg, 0, tz * sg))


def dangling(ws):
    """Per way: which of its two ends meets no other way (its girder gets an end face there)."""
    ends = {}
    for w in ws:
        for p in (w['pts'][0], w['pts'][-1]):
            k = (round(p[0], 1), round(p[1], 1))
            ends[k] = ends.get(k, 0) + 1
    out = []
    for w in ws:
        e = []
        for idx, p, sg in ((0, w['pts'][0], -1), (-1, w['pts'][-1], 1)):
            if ends[(round(p[0], 1), round(p[1], 1))] == 1:
                e.append((idx, sg))
        out.append(e)
    return out


def nearest_on(pts, p):
    best = None
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dx, dz = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dz * dz or 1.0
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2))
        q = (a[0] + dx * t, a[1] + dz * t)
        d = math.hypot(q[0] - p[0], q[1] - p[1])
        if best is None or d < best[0]:
            ln = math.sqrt(l2)
            best = (d, q, (dx / ln, dz / ln))
    return best


def avoid():
    """The carriageways and railways near the guideway (airport.json skytrain.avoid), model frame: [(a, b, clearance)] segments
    a column's centre keeps that far from."""
    if 'avoid' not in _CACHE:
        ax, az = anchor()
        out = []
        for r in apt.data()['skytrain'].get('avoid', []):
            clear = r['halfWidth'] + COL_R + (2.5 if r['highway'] in ('rail', 'light_rail') else 1.2)
            pts = [(p[0] - ax, p[1] - az) for p in r['pts']]
            out += [(pts[i], pts[i + 1], clear) for i in range(len(pts) - 1)]
        _CACHE['avoid'] = out
    return _CACHE['avoid']


def blocked(c):
    for a, b, clear in avoid():
        dx, dz = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dz * dz or 1.0
        t = max(0.0, min(1.0, ((c[0] - a[0]) * dx + (c[1] - a[1]) * dz) / l2))
        if math.hypot(a[0] + dx * t - c[0], a[1] + dz * t - c[1]) < clear:
            return True
    return False


def point_at(pts, s):
    acc = 0.0
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        if acc + ln >= s or k == len(pts) - 2:
            t = max(0.0, min(1.0, (s - acc) / ln)) if ln else 0.0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), (((b[0] - a[0]) / ln, (b[1] - a[1]) / ln) if ln else (1.0, 0.0))
        acc += ln
    return pts[-1], (1.0, 0.0)


def piers():
    """The columns: every 30 m along each way; where another way runs alongside 3.5 to 12 m away, one column between them with
    a crosshead under both. A column that would stand on a road or a railway (airport.json skytrain.avoid) moves up to 14 m
    along the guideway, or is left out (a longer span). [(centre (x, z), [(x, z) girder points it carries], tangent)]."""
    if 'piers' in _CACHE:
        return _CACHE['piers']
    ws = ways()
    out = []

    def place(i, pts, s):
        p, tg = point_at(pts, s)
        mate = None
        for j, o in enumerate(ws):
            if j == i:
                continue
            d, q, ot = nearest_on(o['pts'], p)
            if 3.5 < d < 12.0 and abs(ot[0] * tg[0] + ot[1] * tg[1]) > 0.94 and (mate is None or d < mate[0]):
                mate = (d, q)
        c = p if mate is None else ((p[0] + mate[1][0]) / 2, (p[1] + mate[1][1]) / 2)
        return c, ([p] if mate is None else [p, mate[1]]), tg

    for i, w in enumerate(ws):
        pts = w['pts']
        total = sum(math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) for k in range(len(pts) - 1))
        stations_s = [SPAN / 2 + SPAN * k for k in range(int(max(0.0, total - 4.0 - SPAN / 2) // SPAN) + 1)] if total > SPAN else [total / 2]
        for s in stations_s:
            pick = None
            for ds in (0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10, 12, -12, 14, -14):
                if not (0.0 <= s + ds <= total):
                    continue
                c, carried, tg = place(i, pts, s + ds)
                if not blocked(c):
                    pick = (c, carried, tg)
                    break
            if pick and all(math.hypot(pick[0][0] - e[0][0], pick[0][1] - e[0][1]) > 13.0 for e in out):
                out.append(pick)
    _CACHE['piers'] = out
    return out


def pier(l, c, carried, tg, lod, E):
    """A column from the ground to a cap (single) or a crosshead (shared) under the girder(s)."""
    gy = ground_at(*c) - E - 2.5
    tops = [deck_local(*p) - E - GIRDER_D for p in carried]
    ytop = min(tops)
    cap_h = 1.0
    yc = ytop - cap_h
    n = (10, 6, 0)[lod]
    if lod == 0:
        l.lathe('lm_stone', [(COL_R * 1.1, gy), (COL_R, gy + 1.2), (COL_R, yc - 0.6), (COL_R * 1.25, yc)], n, CONCRETE, cx=c[0], cz=c[1], smooth=False)
    elif lod == 1:
        l.lathe('lm_stone', [(COL_R, gy), (COL_R, yc)], n, CONCRETE, cx=c[0], cz=c[1], smooth=False)
    rot = math.atan2(tg[0], tg[1])
    if len(carried) == 1:
        if lod == 0:
            l.box('lm_stone', (c[0], yc, c[1]), (3.4, cap_h, 2.2), CONCRETE_D, rot=rot, y_is_base=True)
    else:
        a, b = carried
        dx, dz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dz) or 1.0
        ux, uz = dx / ln, dz / ln
        a2 = (a[0] - ux * 2.3, a[1] - uz * 2.3)
        b2 = (b[0] + ux * 2.3, b[1] + uz * 2.3)
        if lod < 2:
            l.beam('lm_stone', (a2[0], yc + cap_h / 2, a2[1]), (b2[0], yc + cap_h / 2, b2[1]), 2.2, cap_h, CONCRETE_D, caps=lod == 0)
    return gy, yc


# ---------------------------------------------------------------------------------------------- stations
def stations():
    """Each station: name, centre (model frame), axis t, the across offsets of its tracks, platform height (model frame)."""
    if 'stations' in _CACHE:
        return _CACHE['stations']
    ax, az = anchor()
    E = elev()
    out = []
    for st in apt.data()['skytrain']['stations']:
        S = (st['at'][0] - ax, st['at'][1] - az)
        near = []
        for w in ways():
            d, q, tg = nearest_on(w['pts'], S)
            if d < 22.0:
                near.append((d, q, tg, w['id']))
        near.sort()
        if not near:
            continue
        t = near[0][2]
        n = (-t[1], t[0])
        cand = []
        for d, q, tg, wid in near:
            if abs(tg[0] * t[0] + tg[1] * t[1]) < 0.9:
                continue
            o = (q[0] - S[0]) * n[0] + (q[1] - S[1]) * n[1]
            if all(abs(o - x) > 3.0 for _, x in cand):
                cand.append((d, o))
        # the two tracks nearest the station node
        offs = sorted(o for _, o in sorted(cand)[:2])
        deck = max(deck_local(*near[0][1]), deck_local(*S))
        out.append({'name': st['name'], 'c': S, 't': t, 'n': n, 'offs': offs, 'deck': deck - E, 'ground': ground_at(*S) - E})
    _CACHE['stations'] = out
    return out


def station(l, st, lod, hull):
    if lod == 2:
        return station_far(l, st)
    c, t, n = st['c'], st['t'], st['n']
    offs = st['offs']
    yp = st['deck'] + 1.1          # the platform (the cars' floor)
    o0, o1 = offs[0] - 2.4, offs[-1] + 2.4
    pw = 5.5
    L = PLATFORM_L / 2

    def P(a, o, y):
        return (c[0] + t[0] * a + n[0] * o, y, c[1] + t[1] * a + n[1] * o)

    def rect(a0, a1, b0, b1):
        r = [(P(a, o, 0)[0], P(a, o, 0)[2]) for a, o in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
        return r if lm.area2(r) > 0 else r[::-1]
    rot = math.atan2(t[0], t[1])
    island = len(offs) > 1 and offs[1] - offs[0] >= 10.0
    if island:
        # an island platform between the tracks, the box's walls just outside them
        sides = [(offs[0] + 2.4, offs[1] - 2.4)]
        wo0, wo1 = o0 - 0.8, o1 + 0.8
    else:
        sides = [(o0 - pw, o0), (o1, o1 + pw)] if len(offs) > 1 else [(o1, o1 + pw)]
        wo0, wo1 = (o0 - pw, o1 + pw) if len(offs) > 1 else (o0 - 0.5, o1 + pw)
    for b0, b1 in sides:
        m = (b0 + b1) / 2
        q = P(0, m, yp - 1.2)
        l.box('lm_stone', (q[0], yp - 1.2, q[2]), (b1 - b0, 1.2, 2 * L), CONCRETE, rot=rot, y_is_base=True)
        if lod == 0:
            # the platform screen doors' line along the edges by the tracks
            for e in (b0, b1):
                if min(abs(e - (x - 2.4)) for x in offs) < 0.05 or min(abs(e - (x + 2.4)) for x in offs) < 0.05:
                    a = P(-L, e, yp + 0.01)
                    bq = P(L, e, yp + 0.01)
                    l.beam('lm_metal', (a[0], yp + 1.1, a[2]), (bq[0], yp + 1.1, bq[2]), 0.12, 2.2, srgb(0x9fb4c0))
        # supports under the platform, down to the ground
        for k in range(4):
            a = -L + 4.0 + k * (2 * L - 8.0) / 3
            q = P(a, m, 0)
            gy = ground_at(q[0], q[2]) - elev() - 2.5
            l.box('lm_stone', (q[0], gy, q[2]), (1.2, yp - 1.2 - gy, 1.2), CONCRETE_D, rot=rot, y_is_base=True, skip=('+y', '-y'))
            if lod == 0:
                hull.append((apt.rect_ring(q[0], q[2], 1.2, 1.2, -rot), yp - 1.2))
    # the glazed box: long walls outside the tracks or platforms, end walls over the platforms only, the roof over all
    H = 5.4
    for o, sg in ((wo0, -1), (wo1, 1)):
        a, b = P(-L, o, yp), P(L, o, yp)
        p0, p1 = (a, b) if sg < 0 else (b, a)
        l.facade_quad('bld_glass', p0, p1, (p1[0], yp + H, p1[2]), (p0[0], yp + H, p0[2]), GLASS, 0.0, lm.K_GLASS, 1, 0, 4, 901, True, hint=(n[0] * sg, 0, n[1] * sg))
        # its base: a solid upstand down to the platform's underside
        l.quad('lm_stone', (p0[0], yp - 1.2, p0[2]), (p1[0], yp - 1.2, p1[2]), (p1[0], yp, p1[2]), (p0[0], yp, p0[2]), CONCRETE, hint=(n[0] * sg, 0, n[1] * sg))
    for a, sg in ((-L, -1), (L, 1)):
        for b0, b1 in sides:
            p0, p1 = P(a, b0, yp), P(a, b1, yp)
            if sg < 0:
                p0, p1 = p1, p0
            l.facade_quad('bld_glass', p0, p1, (p1[0], yp + H, p1[2]), (p0[0], yp + H, p0[2]), GLASS, 0.0, lm.K_GLASS, 1, 0, 4, 902, True, hint=(t[0] * sg, 0, t[1] * sg))
    ov = 2.0
    ro = rect(-L - ov, L + ov, wo0 - ov, wo1 + ov)
    l.cap('lm_lit', ro, yp + H, SOFFIT, up=False)
    l.cap('bld_roof', ro, yp + H + 0.8, ROOF)
    for i in range(4):
        a, b = ro[i], ro[(i + 1) % 4]
        mx, mz = (a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1]
        l.quad('lm_metal', (a[0], yp + H, a[1]), (b[0], yp + H, b[1]), (b[0], yp + H + 0.8, b[1]), (a[0], yp + H + 0.8, a[1]), ROOF, hint=(mx, 0, mz))
    if lod == 0:
        # a lit line round the canopy's edge
        for i in range(4):
            a, b = ro[i], ro[(i + 1) % 4]
            mx, mz = (a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1]
            ln = math.hypot(mx, mz) or 1.0
            l.quad('lm_glow', (a[0] + mx / ln * 0.02, yp + H + 0.05, a[1] + mz / ln * 0.02), (b[0] + mx / ln * 0.02, yp + H + 0.05, b[1] + mz / ln * 0.02),
                   (b[0] + mx / ln * 0.02, yp + H + 0.2, b[1] + mz / ln * 0.02), (a[0] + mx / ln * 0.02, yp + H + 0.2, a[1] + mz / ln * 0.02), GLOW, hint=(mx, 0, mz))
        # roof ribs
        for k in range(1, 9):
            a = -L - ov + (2 * (L + ov)) * k / 9
            p, q = P(a, wo0 - ov, yp + H + 0.85), P(a, wo1 + ov, yp + H + 0.85)
            l.beam('lm_metal', p, q, 0.3, 0.12, shade(ROOF, 0.85))
    # the circulation core at one end, down to the street (not at the Rental Car Center: its hall is under the station)
    if not st['name'].startswith('Rental'):
        core = P(L - 7.0, wo1 + 4.4, 0)
        gy = st['ground'] - 2.0
        ring = apt.rect_ring(core[0], core[2], 7.0, 8.0, -rot)
        if lm.area2(ring) < 0:
            ring = ring[::-1]
        l.ring_walls('bld_glass', ring, gy, yp + H, GLASS, lm.K_GLASS, floor_h=4.0, era=4, fid=903)
        l.cap('bld_roof', ring, yp + H, ROOF)
        if lod == 0:
            hull.append((apt.offset(ring, -0.2), yp + H))


def station_far(l, st):
    c, t, n = st['c'], st['t'], st['n']
    offs = st['offs']
    yp = st['deck'] + 1.1
    o0, o1 = offs[0] - 7.9, offs[-1] + 7.9
    L = PLATFORM_L / 2 + 2.0
    mid = (o0 + o1) / 2
    q = (c[0] + n[0] * mid, c[1] + n[1] * mid)
    l.box('lm_glass', (q[0], yp - 1.2, q[1]), (o1 - o0, 7.4, 2 * L), GLASS, rot=math.atan2(t[0], t[1]), y_is_base=True, skip=('-y',))


# ---------------------------------------------------------------------------------------------- the model
def build(asset):
    apt.start()
    E = elev()
    ws = ways()
    dang = dangling(ws)
    lods = []
    hull = []
    for lod in (0, 1, 2):
        l = lm.Lod(lod)
        step = (10.0, 30.0, 60.0)[lod]
        for w, caps in zip(ws, dang):
            pts = densify(w['pts'], [0.0] * len(w['pts']), step)[0] if lod == 0 else resample(w['pts'], step)
            ys = [deck_local(*p) - E for p in pts]
            if lod == 0:
                girder(l, pts, ys, PROFILE, STEEL_EDGES, caps)
            elif lod == 1:
                girder(l, pts, ys, PROFILE_FAR, set(), caps)
            else:
                girder(l, pts, ys, [(-2.2, 0.75), (2.2, 0.75), (1.5, -GIRDER_D), (-1.5, -GIRDER_D)], set(), [])
        for c, carried, tg in piers():
            gy, yc = pier(l, c, carried, tg, lod, E)
            if lod == 0:
                ring = lm.circle(COL_R - 0.1, 8, c[0], c[1])
                hull.append((ring, yc))
        for st in stations():
            station(l, st, lod, hull if lod == 0 else [])
        lods.append(l)
    h = hero()
    rings = [[tuple(p) for p in r] for r in h['rings']]
    return apt.report(asset, ID, lods, hull, lod_from=[0, 600, 1800], clear=rings, overlap=0.0)
