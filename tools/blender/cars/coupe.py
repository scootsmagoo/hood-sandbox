"""
The coupe: a mid-2000s American muscle coupe (two doors, a long bonnet with a scoop, a fastback
roof, haunches over the rear wheels, a ducktail, a wide dark grille with the lamps at its ends,
five-spoke wheels and twin pipes). No maker's badges.

It shares the sedan's physics hull (the `coupe` entry of handling.json changes only the handling),
so it is built to the same plan and wheel positions, with a roof about 9 cm lower.
"""
from hoodlib import handling
from cars.builder import assemble


def spoiler(b, lod, body):
    if lod == 2:
        return
    z = b.zr + 0.09
    body.box((0, b.y_top(z) + 0.03, z), (1.5, 0.035, 0.12), 'paint', bevel=0.012 if lod == 0 else 0, rot=(-0.12, 0, 0))


def spec(car):
    return {
        'z_front': car.hz, 'z_rear': -car.hz,
        'half_width': car.hx - 0.02,
        'corner_front': 0.26, 'corner_rear': 0.22,
        'bulge': [(-1.3, 0.62, 0.035)],
        'y_bottom': [(-2.2, -0.02), (-2.0, -0.1), (-1.7, -0.155), (1.7, -0.155), (2.0, -0.11), (2.2, -0.04)],
        'y_top': [(-2.2, 0.45), (-2.15, 0.53), (-2.06, 0.556), (-1.8, 0.545), (-1.45, 0.535), (-0.6, 0.515), (0.3, 0.495), (0.85, 0.47),
                  (1.2, 0.448), (1.6, 0.43), (2.0, 0.405), (2.15, 0.37), (2.2, 0.32)],
        'crown': 0.025,
        'greenhouse': {
            'ws_base': 0.85, 'roof_front': 0.15, 'roof_rear': -0.5, 'rw_base': -1.45, 'c_z': -0.95,
            'b_pillar': None,
            'top': [(-1.45, 0.535), (-1.2, 0.64), (-0.9, 0.76), (-0.6, 0.86), (-0.45, 0.88), (0.0, 0.895), (0.15, 0.885), (0.35, 0.8),
                    (0.6, 0.64), (0.85, 0.475)],
            'belt_inset': 0.095, 'tumble': 0.36, 'rail': 0.045, 'crown': 0.03, 'rear_seat': True,
        },
        'arch_gap': 0.05, 'arch_lift': 0.0, 'well_inner': 0.4,
        'doors': [(-0.45, 0.8)],
        'seams': [0.8, -0.45],
        'hood_z': 0.88,
        'scoop': {'pos': (0.0, 0.475, 1.35), 'size': (0.42, 0.07, 0.62)},
        'mirror': {'z': 0.68, 'y': 0.54},
        'head': {'x_in': 0.43, 'y': (0.24, 0.335), 'wrap': 40},
        'tail': {'x_in': 0.12, 'y': (0.33, 0.45), 'wrap': 30, 'reverse': 0.1},
        'grille': {'half_width': 0.4, 'y': (0.12, 0.34), 'bars': 1, 'frame_mat': 'trim', 'bar_mat': 'chrome', 'badge': False},
        'bumper_front': {'y': 0.05, 'h': 0.22, 'depth': 0.12, 'offset': 0.035, 'wrap': 0.45, 'mat': 'paint', 'strip': False},
        'bumper_rear': {'y': 0.13, 'h': 0.21, 'depth': 0.12, 'offset': 0.035, 'wrap': 0.45, 'mat': 'paint', 'strip': False},
        'plate_rear': {'y': 0.13 + 0.0},
        'exhaust': [(0.55, -0.08, -2.17), (-0.55, -0.08, -2.17)],
        'extra_parts': [spoiler],
        'wheel': {'rim': 0.66, 'face': 'chrome', 'dish': 'trim', 'spokes': 5, 'spoke_w': 0.05, 'lugs': 5},
        'smooth_angle': 38,
    }


def build(asset='coupe'):
    car = handling.Car(handling.load('coupe'))
    return assemble(asset, spec(car), car)
