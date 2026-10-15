"""
Police cruisers: a car's spec with a police kit. The kit is a roof lightbar (two lens halves,
`light_bar_a` on the left and `light_bar_b` on the right, flashed by the game in the agency's
colours), a black push bar, a spotlight on the driver's A-pillar, black steel wheels and a livery
band (`livery`, painted the agency's stripe colour) along both flanks. The body takes the
agency's body colour through `paint`, as on any car.

  sedan-police   the sedan cruiser (most agencies)
  coupe-police   a pursuit coupe (state patrol)
"""
from hoodlib import handling
from hoodlib.mesh import Mesh
from cars import coupe, sedan
from cars.builder import assemble


def kit(b, lod, parts):
    g = b.g
    car = b.car
    zc = (g['roof_front'] + g['roof_rear']) / 2 + 0.08
    top = b.roof(zc) + g.get('crown', 0.025)
    belt = b.belt(zc)
    half = b.w(zc) - b.belt_inset - b.tumble * (b.roof(zc) - belt) - 0.08
    bw = min(0.62, half)
    bev = 0.02 if lod == 0 else 0
    base = Mesh()
    base.box((0, top + 0.03, zc), (bw * 2, 0.05, 0.3), 'trim', bevel=bev)
    if lod == 0:
        for sx in (1, -1):
            base.box((sx * (bw - 0.06), top + 0.005, zc), (0.05, 0.04, 0.34), 'trim')
    base.box((0, top + 0.1, zc), (0.08, 0.09, 0.26), 'trim')
    a = Mesh()
    a.box((bw / 2 + 0.02, top + 0.1, zc), (bw - 0.04, 0.09, 0.25), 'light_bar_a', bevel=0.03 if lod == 0 else 0, segments=2)
    bm = Mesh()
    bm.box((-bw / 2 - 0.02, top + 0.1, zc), (bw - 0.04, 0.09, 0.25), 'light_bar_b', bevel=0.03 if lod == 0 else 0, segments=2)
    if lod < 2:
        # the push bar: two uprights and two rails in front of the grille
        zf = b.zf + b.s['bumper_front'].get('offset', 0.04) + 0.17
        yb = b.s['bumper_front']['y']
        r = 0.028
        prof = [(-r, -r), (r, -r), (r, r), (-r, r)] if lod == 1 else [(-r, 0), (-r * 0.7, -r * 0.7), (0, -r), (r * 0.7, -r * 0.7), (r, 0), (r * 0.7, r * 0.7), (0, r), (-r * 0.7, r * 0.7)]
        for sx in (1, -1):
            base.sweep([(sx * 0.3, yb - 0.1, zf), (sx * 0.3, yb + 0.42, zf - 0.03)], prof, 'trim', up=(0, 0, 1), outward=(sx * 0.3, yb, zf - 1))
            base.sweep([(sx * 0.3, yb + 0.05, zf), (sx * 0.3, yb + 0.05, zf - 0.2)], prof, 'trim', up=(0, 1, 0))
        for y in (yb + 0.02, yb + 0.3):
            base.sweep([(0.42, y, zf + 0.01), (0.0, y, zf + 0.02), (-0.42, y, zf + 0.01)], prof, 'trim', up=(0, 1, 0), outward=(0, y, zf - 1))
    if lod == 0:
        # the spotlight on the driver's A-pillar
        zs = g['ws_base'] - 0.12
        xs = b.w(zs) - b.belt_inset + 0.07
        ys = b.belt(zs) + 0.13
        base.cylinder((xs, ys, zs), 0.065, 0.16, 12, 'chrome', axis='z', cap=True, cap_mat='chrome')
        base.cylinder((xs, ys, zs + 0.085), 0.055, 0.01, 12, 'light_head', axis='z', cap=True, cap_mat='light_head')
        base.box((xs - 0.05, ys - 0.06, zs - 0.02), (0.08, 0.02, 0.02), 'trim')
        # antennas on the boot
        for x in (0.25, -0.25):
            base.box((x, b.y_top(b.zr + 0.5) + 0.25, b.zr + 0.5), (0.008, 0.5, 0.008), 'trim')
    base.clean()
    parts['police'] = base
    parts['light_bar_a'] = a
    parts['light_bar_b'] = bm


def police_spec(base, car):
    s = dict(base)
    s['livery'] = {'z': (-car.hz + 0.25, car.hz - 0.3)}
    s['wheel'] = {'rim': 0.6, 'face': 'trim', 'dish': 'trim', 'slots': 0, 'lugs': 5}
    return s


def build(asset):
    type_id = asset.split('-')[0]
    car = handling.Car(handling.load(type_id))
    base = {'sedan': sedan, 'coupe': coupe}[type_id].spec(car)
    return assemble(asset, police_spec(base, car), car, extras=kit)
