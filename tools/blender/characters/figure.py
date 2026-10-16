"""Puts a figure together from an archetype: torso, arms, hands, legs, shoes, head, then the
archetype's extras (pockets, straps, bags, hats...)."""
from mathutils import Vector

from . import body as B
from .head import Head, make_ears
from .shapes import Curve, Layer, Tube, Weighter


def _plain(layers, lod):
    """The smallest level of detail has no hems: a garment is just the surface."""
    if lod < 2:
        return layers
    for l in layers:
        l.hem0 = l.hem1 = False
    return layers


def assemble(m, a, lod):
    b = a.build
    L = B.LODS[lod]
    ctx = dict(lod=lod, build=b, tubes={}, mesh=m, arch=a)
    tw = Weighter(['pelvis', 'spine', 'chest', 'neck', 'head', 'clavicle_L', 'clavicle_R'], scale={'head': 0.6, 'clavicle_L': 0.6, 'clavicle_R': 0.6})
    torso = Tube(m, (0, 0, 0), (0, 1, 0), (0, 0, 1), B.torso_curve(b), B.torso_stations(lod), L['torso_n'], 'skin', _plain(a.torso_layers(b), lod), tw, 1, a.torso_masks, B.torso_deform(b))
    ctx['tubes']['torso'] = torso
    for side in (1, -1):
        nm = 'L' if side == 1 else 'R'
        ctx['tubes'][f'arm_{nm}'] = B.make_arm(m, b, lod, side, _plain(a.arm_layers(b, side), lod), a.arm_masks)
        ctx['tubes'][f'hand_{nm}'] = B.make_hand(m, b, lod, side, _plain(a.hand_layers(b, side), lod))
        ctx['tubes'][f'leg_{nm}'] = B.make_leg(m, b, lod, side, _plain(a.leg_layers(b, side), lod), a.leg_masks)
        shoe = a.shoe
        ctx['tubes'][f'shoe_{nm}'] = B.make_shoe(m, lod, side, shoe.get('style', 'sneaker'), shoe.get('upper', 'shoe'), shoe.get('sole', 'sole'), shoe.get('size', 1.0))
    ctx['head'] = Head(m, a.head, lod)
    make_ears(m, a.head, lod)
    for ex in a.extras:
        ex(ctx)
    fill_weights(m)
    return ctx


def fill_weights(m):
    """Anything that was added without weights follows the nearest bones."""
    from hoodlib.frame import from_bl
    from .shapes import set_weights
    from .skeleton import BONE_NAMES
    layer = m.bm.verts.layers.deform.verify()
    w = Weighter([n for n in BONE_NAMES if n != 'root'])
    for v in m.bm.verts:
        if len(v[layer]) == 0:
            set_weights(m, v, w(from_bl(v.co)))
