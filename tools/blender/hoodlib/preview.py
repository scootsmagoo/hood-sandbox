"""Quick look renders (Cycles on the CPU, headless): a few views of a built asset on a grey
ground under a sun, so a script's result can be checked without opening Blender.

  blender -b --factory-startup --python tools/blender/build_asset.py -- --module cars.sedan \
      --asset sedan --out /tmp/sedan.glb --preview /tmp/sedan
writes /tmp/sedan-front.png, -rear.png, -side.png, -top.png, -lod1.png, -lod2.png.
"""
import math

import bpy
from mathutils import Vector

from .frame import to_bl

VIEWS = {
    'front': ((3.6, 1.1, 5.0), 0),
    'rear': ((-3.4, 1.4, -5.2), 0),
    'side': ((6.5, 0.6, 0.0), 0),
    'top': ((2.5, 6.0, 2.5), 0),
    'close': ((2.2, 0.5, 2.6), 0),
    'lod1': ((3.6, 1.1, 5.0), 1),
    'lod2': ((3.6, 1.1, 5.0), 2),
}


def render(prefix, ground_y=-0.34, size=(640, 400), views=None, samples=24):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.film_transparent = False
    world = bpy.data.worlds.new('preview') if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.55, 0.65, 0.8, 1)
    bg.inputs['Strength'].default_value = 0.9
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 3.5
    sun = bpy.data.objects.new('sun', sun_data)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    gme = bpy.data.meshes.new('ground')
    s = 30
    gme.from_pydata([to_bl(-s, ground_y, -s), to_bl(s, ground_y, -s), to_bl(s, ground_y, s), to_bl(-s, ground_y, s)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.new('ground_preview')
    gmat.use_nodes = True
    gmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.25, 0.25, 1)
    gme.materials.append(gmat)
    ground = bpy.data.objects.new('ground_preview', gme)
    sc.collection.objects.link(ground)
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 40
    cam = bpy.data.objects.new('cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    lods = {o.name: o for o in bpy.data.objects if o.name in ('lod0', 'lod1', 'lod2')}
    # the game draws the one wheel four times: so does the preview
    extra = []
    anchors = {o.name: o for o in bpy.data.objects if o.name.startswith('anchor_wheel_')}
    for lo in lods.values():
        w = next((c for c in lo.children if c.name.endswith('_wheel')), None)
        if not w:
            continue
        for n in ('FR', 'RL', 'RR'):
            a = anchors.get(f'anchor_wheel_{n}')
            if not a:
                continue
            d = bpy.data.objects.new(f'{w.name}_{n}', w.data)
            sc.collection.objects.link(d)
            d.parent = lo
            d.location = a.location
            if n in ('FR', 'RR'):
                d.rotation_euler = (0, 0, math.pi)
            extra.append(d)
    for name, (pos, level) in (views or VIEWS).items():
        for n, o in lods.items():
            hide = n != f'lod{level}'
            for c in [o] + list(o.children_recursive):
                c.hide_render = hide
        cam.location = to_bl(*pos)
        target = to_bl(0, 0.25, 0)
        d = (target - cam.location)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        if name == 'close':
            cam_data.lens = 28
        else:
            cam_data.lens = 40
        sc.render.filepath = f'{prefix}-{name}.png'
        bpy.ops.render.render(write_still=True)
    # leave the scene as it was for the export
    for o in [sun, ground, cam] + extra:
        bpy.data.objects.remove(o)
    for o in lods.values():
        for c in [o] + list(o.children_recursive):
            c.hide_render = False
