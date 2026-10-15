"""
The pickup: a mid-2000s American full-size regular-cab pickup (a tall flat bonnet, a big chrome
crosshair grille, square lamps, a cab with a near-vertical back window, a bed with a black liner,
black wheel-arch flares, chrome step bumpers, six-spoke chrome wheels). No maker's badges.

Built to the `pickup` entry of handling.json: hull x +-1.0, y -0.06..0.66 (cab to 1.4),
z +-2.65, wheels (r 0.4) at z 1.72 and -1.55 on a 1.78 m track.
"""
import math

from hoodlib import handling
from hoodlib.mesh import Mesh
from cars.builder import assemble, rect_profile


def flares_and_handle(b, lod, body):
    car = b.car
    if lod < 2:
        segs = 10 if lod == 0 else 5
        for z0 in (car.front_z, car.rear_z):
            r = car.radius + b.s.get('arch_gap', 0.06) + 0.025
            for side in (1, -1):
                path = []
                for i in range(segs + 1):
                    a = math.radians(-8 + 196 * i / segs)
                    z = z0 + r * math.cos(a)
                    path.append((side * (b.w(z) + 0.005), car.wheel_y + r * math.sin(a), z))
                m = Mesh()
                m.sweep(path, rect_profile(0.08, -0.01, 0.045), 'trim', up=(1, 0, 0), outward=(0.0, car.wheel_y, z0))
                body.merge(m)
    if lod < 2:
        # the wheel humps inside the bed
        r = car.radius + b.s.get('arch_gap', 0.06)
        top = car.wheel_y + r + 0.03
        for side in (1, -1):
            body.box((side * (b.half - 0.2), (0.2 + top) / 2, car.rear_z), (0.27, top - 0.2, 2 * r + 0.04), 'trim', bevel=0.04 if lod == 0 else 0)
    if lod == 0:
        body.box((0, 0.56, b.zr - 0.01), (0.2, 0.04, 0.03), 'chrome')


def spec(car):
    zr = -car.hz
    return {
        'z_front': car.hz, 'z_rear': -car.hz,
        'half_width': car.hx,
        'corner_front': 0.12, 'corner_rear': 0.07,
        'y_bottom': [(-2.65, 0.06), (-2.5, 0.0), (-2.0, -0.04), (1.9, -0.04), (2.4, 0.0), (2.65, 0.06)],
        'y_top': [(-2.65, 0.63), (-2.6, 0.662), (-1.0, 0.665), (-0.35, 0.665), (0.2, 0.67), (1.62, 0.672), (2.3, 0.664), (2.55, 0.655),
                  (2.62, 0.635), (2.65, 0.6)],
        'crown': 0.015,
        'greenhouse': {
            'ws_base': 1.62, 'roof_front': 1.05, 'roof_rear': -0.12, 'rw_base': -0.3, 'c_z': 0.12,
            'b_pillar': None,
            'top': [(-0.3, 0.67), (-0.26, 1.2), (-0.18, 1.37), (-0.1, 1.392), (0.5, 1.4), (0.95, 1.392), (1.05, 1.37), (1.3, 1.06), (1.62, 0.672)],
            'belt_inset': 0.08, 'tumble': 0.18, 'rail': 0.06, 'crown': 0.02, 'rear_seat': False,
        },
        'arch_gap': 0.06, 'arch_lift': 0.0, 'well_inner': 0.45,
        'cuts': [
            # the bed, with a black liner, and the gap between the cab and the bed
            {'pos': (0.0, 0.62, (zr + 0.07 - 0.4) / 2), 'size': (2 * (car.hx - 0.07), 0.8, (-0.4) - (zr + 0.07)), 'mat': 'trim'},
            {'pos': (0.0, 0.6, -0.335), 'size': (2.4, 0.9, 0.022), 'mat': 'trim', 'lods': (0,)},
        ],
        'extra_stations': [-0.42, -0.4, -0.35, -0.32, zr + 0.07],
        'doors': [(0.15, 1.24)],
        'seams': [1.24, 0.15],
        'hood_z': 1.66,
        'hood_front_margin': 0.06,
        'mirror': {'z': 1.15, 'y': 0.8, 'mat': 'trim'},
        'handle_y': 0.5,
        'head': {'x_in': 0.52, 'y': (0.42, 0.58), 'wrap': 25},
        'tail': {'x_in': 0.86, 'y': (0.3, 0.62), 'wrap': 40, 'reverse': 0.03},
        'grille': {'half_width': 0.48, 'y': (0.22, 0.6), 'bars': 1, 'vbars': 1, 'bar_h': 0.06, 'frame': 0.05, 'badge': False},
        'bumper_front': {'y': 0.13, 'h': 0.26, 'depth': 0.14, 'offset': 0.05, 'wrap': 0.25, 'mat': 'chrome', 'strip': False},
        'bumper_rear': {'y': 0.15, 'h': 0.22, 'depth': 0.12, 'offset': 0.05, 'wrap': 0.15, 'mat': 'chrome', 'strip': False},
        'plate_rear': {'y': 0.36},
        'exhaust': [(-0.62, 0.0, zr + 0.04)],
        'extra_parts': [flares_and_handle],
        'wheel': {'rim': 0.55, 'face': 'chrome', 'dish': 'chrome', 'spokes': 6, 'spoke_w': 0.045, 'spoke_mat': 'trim', 'lugs': 6},
        'smooth_angle': 36,
    }


def build(asset='pickup'):
    car = handling.Car(handling.load('pickup'))
    return assemble(asset, spec(car), car)
