"""Vehicle numbers from the game's own data, so a model is built to its physics.

Reads src/shared/data/handling.json (entries other than `sedan` only list what they change, as in
src/shared/handling.ts) and ports the anchors of src/shared/doors.ts. tests/carAssets.test.ts
checks the exported anchors against the TypeScript, so the two cannot drift apart unnoticed.
"""
import json
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
HANDLING_PATH = os.path.join(ROOT, 'src', 'shared', 'data', 'handling.json')

# src/shared/doors.ts
HIP_HEIGHT = 0.9
SEATED_SCALE = 0.92
SEAT_DROP = HIP_HEIGHT * SEATED_SCALE


def _merge(base, over):
    if over is None:
        return base
    if not isinstance(base, dict) or isinstance(over, list):
        return over
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(base.get(k), v)
    return out


def load(type_id, path=HANDLING_PATH):
    with open(path) as f:
        table = json.load(f)
    base = table['sedan']
    h = base if type_id == 'sedan' else _merge(base, table[type_id])
    h = dict(h)
    h['id'] = type_id
    return h


class Car:
    """The numbers a model is built to, in the body frame (+X left, +Y up, +Z forward)."""

    def __init__(self, h):
        self.h = h
        c = h['chassis']
        self.hx, self.hy, self.hz = c['halfExtents']
        self.ox, self.oy, self.oz = c['offset']
        cab = c['cabin']
        self.cab_half = cab['halfExtents']
        self.cab_off = cab['offset']
        w = h['wheels']
        s = h['suspension']
        self.radius = w['radius']
        self.width = w['width']
        self.front_z = w['frontZ']
        self.rear_z = w['rearZ']
        self.track_front = w['trackFront']
        self.track_rear = w['trackRear']
        self.mount_y = w['mountY']
        omega = 2 * math.pi * s['frequencyHz']
        # suspension length (mount to wheel centre) at rest under the car's own weight
        self.rest_length = max(0.04, s['travel'] * s['restRatio'] - 9.81 / (omega * omega))  # RaycastCar.restHeight
        self.wheel_y = self.mount_y - self.rest_length
        self.ground_y = self.wheel_y - self.radius
        # the hull's extents
        self.body_bottom = self.oy - self.hy
        self.body_top = self.oy + self.hy
        self.cabin_top = self.cab_off[1] + self.cab_half[1]

    def wheel_anchor(self, i):
        """Snapshot wheel order: front left, front right, rear left, rear right. At rest."""
        front = i < 2
        left = i % 2 == 0
        track = self.track_front if front else self.track_rear
        return ((1 if left else -1) * track * 0.5, self.wheel_y, self.front_z if front else self.rear_z)

    def doors(self):
        """doorGeometry() of src/shared/doors.ts."""
        hx = self.hx
        cab_top = self.cabin_top
        z = self.cab_off[2] + 0.2
        return {
            'seat': (hx * 0.45, cab_top - 0.83, z - 0.15),
            'door': (hx, z),
            'stand': (hx + 0.55, z),
            'eject': (hx + 1.15, z - 1.2),
        }
