"""
The sedan: a mid-2000s American full-size four-door, Crown Victoria and Impala proportions (a long
flat bonnet, an upright greenhouse with a black B-pillar, a long boot, body-coloured wrap-round
bumpers with rub strips, wide headlamps either side of a chrome grille, hubcaps). No maker's
badges: the grille carries a plain oval.

Every number is in the body frame of the physics (+X left, +Y up, +Z forward, metres): the
`sedan` entry of src/shared/data/handling.json puts the hull at x +-0.92, y -0.16..0.48 (cabin to
0.98), z +-2.2, the wheels (r 0.34) at z 1.35 and -1.3, and the road about 0.34 below the origin.
"""
from hoodlib import handling
from cars.builder import assemble


def spec(car):
    return {
        # plan: ends, widest half-width, corner radii in plan view
        'z_front': car.hz, 'z_rear': -car.hz,
        'half_width': car.hx + 0.005,
        'corner_front': 0.3, 'corner_rear': 0.26,
        # side view: the underside and the top line (bonnet, belt, boot), as (z, y) points
        'y_bottom': [(-2.2, -0.04), (-2.05, -0.1), (-1.75, -0.15), (-0.9, -0.165), (0.9, -0.165), (1.8, -0.15), (2.05, -0.1), (2.2, -0.05)],
        'y_top': [(-2.2, 0.43), (-2.13, 0.5), (-2.0, 0.522), (-1.7, 0.528), (-1.32, 0.522), (-0.6, 0.508), (0.4, 0.497), (0.98, 0.485),
                  (1.4, 0.47), (1.8, 0.458), (2.05, 0.44), (2.15, 0.41), (2.2, 0.365)],
        'crown': 0.02,
        'greenhouse': {
            # windscreen base, roof front and rear edges, rear window base (z), where the side glass ends (C-pillar)
            'ws_base': 0.98, 'roof_front': 0.3, 'roof_rear': -0.78, 'rw_base': -1.3, 'c_z': -0.95,
            'b_pillar': (-0.36, -0.25),
            # the roof line (z, y)
            'top': [(-1.3, 0.52), (-1.1, 0.7), (-0.9, 0.885), (-0.78, 0.945), (-0.6, 0.97), (0.0, 0.98), (0.2, 0.972), (0.3, 0.958),
                    (0.45, 0.885), (0.75, 0.68), (0.98, 0.49)],
            'belt_inset': 0.075, 'tumble': 0.3, 'rail': 0.055, 'crown': 0.025,
        },
        'arch_gap': 0.045, 'arch_lift': 0.0, 'well_inner': 0.4,
        # doors as (rear edge z, front edge z), the driver's door first; panel seams on the sides
        'doors': [(-0.25, 0.88), (-1.0, -0.25)],
        'seams': [0.88, -0.25, -1.0],
        'hood_z': 1.0,
        'mirror': {'z': 0.8, 'y': 0.55},
        'head': {'x_in': 0.4, 'y': (0.22, 0.335), 'wrap': 55},
        'tail': {'x_in': 0.2, 'y': (0.26, 0.41), 'wrap': 62, 'reverse': 0.14},
        'grille': {'half_width': 0.36, 'y': (0.13, 0.33), 'bars': 3},
        'bumper_front': {'y': 0.04, 'h': 0.25, 'depth': 0.12, 'offset': 0.04, 'wrap': 0.5, 'mat': 'paint', 'strip_y': 0.02},
        'bumper_rear': {'y': 0.07, 'h': 0.24, 'depth': 0.12, 'offset': 0.04, 'wrap': 0.5, 'mat': 'paint', 'strip_y': 0.02},
        'plate_rear': {'y': 0.31},
        'moulding': {'y': 0.19, 'h': 0.045},
        'exhaust': [(-0.5, -0.12, -2.17)],
        'wheel': {'rim': 0.6, 'face': 'chrome', 'dish': 'chrome', 'slots': 10, 'lugs': 0},
        'smooth_angle': 38,
    }


def build(asset='sedan'):
    car = handling.Car(handling.load('sedan'))
    return assemble(asset, spec(car), car)
