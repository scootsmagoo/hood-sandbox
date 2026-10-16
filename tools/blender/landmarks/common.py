"""What every landmark script shares: the real footprint it is built to (footprints.json), the levels of
detail, the collision hull and the report build.mjs turns into `<id>.json` next to the .glb.

A script is:

    ID = 'westin-peachtree-plaza'
    VERTEX_COLOR = 'ACTIVE'; ATTRIBUTES = True        # the exporter settings (see lm.py)
    def build(asset):
        fp = common.footprint(ID)
        lods = [lm.Lod(0), lm.Lod(1)]
        ...fill them...
        return common.report(asset, ID, lods, hull=[...], lod_from=[0, 500])

`hull` is the collision: a list of `(ring, height)` prisms (ring: (x, z) points in the model frame, height above the
datum). The pipeline extrudes each one as a building, so what the player can hit is what the hull says; make it the
drawn silhouette of the lowest metres, a little inside it. `lod_from` is the camera distance (m, before the tier's
lod scale) from which each level is drawn.
"""
import json
import os

from hoodlib import scene
from . import lm

HERE = os.path.dirname(os.path.abspath(__file__))
_FP = None


def footprint(lid):
    """The footprints.json entry of a landmark: anchor, ring, height, parts (all in the model frame: metres from the anchor)."""
    global _FP
    if _FP is None:
        _FP = json.load(open(os.path.join(HERE, 'footprints.json')))
    return _FP['landmarks'][lid]


def start():
    scene.reset()


def report(asset, lid, lods, hull, lod_from, cutout=None, replaces=None, extra=None, clear=None):
    fp = footprint(lid)
    counts = lm.emit(lods, asset)
    lo, hi = [1e9] * 3, [-1e9] * 3
    for part in lods[0].all_parts():
        for p in part.p:
            for k in range(3):
                lo[k] = min(lo[k], p[k])
                hi[k] = max(hi[k], p[k])
    r = max(abs(lo[0]), abs(hi[0]), abs(lo[2]), abs(hi[2]))
    side = {
        'id': lid,
        'anchor': fp['anchor'],
        'yaw': 0,
        'height': round(hi[1], 1),
        'bounds': {'min': [round(v, 1) for v in lo], 'max': [round(v, 1) for v in hi]},
        'radius': round(r, 1),
        'lods': [{'tris': c, 'from': lod_from[i]} for i, c in enumerate(counts)],
        'hull': [{'ring': [[round(p[0], 2), round(p[1], 2)] for p in ring], 'height': round(h, 1)} for ring, h in hull if abs(lm.area2(ring)) >= 12.0],
        'cutout': cutout if cutout is not None else fp['ring'],
        'replaces': replaces if replaces is not None else {'overture': [fp['overture']] if fp.get('overture') else [], 'also': fp.get('alsoInside', []), 'overlap': 0.4},
    }
    if clear:
        side['clear'] = [[[round(p[0], 2), round(p[1], 2)] for p in r] for r in clear]
    if extra:
        side.update(extra)
    return {'asset': asset, 'tris': counts, 'sidecar': side}
