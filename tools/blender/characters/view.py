"""Quick look at characters (Cycles, CPU). Run:
  blender -b --factory-startup --python tools/blender/characters/view.py -- --arch kudzu --lod 0 --out /tmp/k
"""
import math, os, sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opts = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1, 2) if argv[i].startswith('--')}

import bpy
from mathutils import Vector

from hoodlib import scene
from hoodlib.frame import to_bl

from characters import build as cb

scene.reset()
arch = opts.get('arch', 'kudzu')
lod = int(opts.get('lod', 0))
pose = opts.get('pose')
cb.build_scene([arch], lods=[lod], armature=True)
if pose:
    from characters import anim
    anim.apply_test_pose(pose)
    if opts.get('shift'):
        for o in bpy.data.objects: pass
def srgb(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1]
from characters import outfits as _o
for k, v in _o.ARCHETYPES[arch].palette.items():
    m = bpy.data.materials.get(k)
    if m:
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = srgb(v)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = int(opts.get('samples', 16))
sc.cycles.use_denoising = False
W, H = int(opts.get('w', 480)), int(opts.get('h', 720))
sc.render.resolution_x, sc.render.resolution_y = W, H
world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.5, 0.6, 0.75, 1); bg.inputs['Strength'].default_value = 0.8
sun_d = bpy.data.lights.new('sun', 'SUN'); sun_d.energy = 3.0
sun = bpy.data.objects.new('sun', sun_d); sc.collection.objects.link(sun); sun.rotation_euler = (math.radians(55), 0, math.radians(30))
gme = bpy.data.meshes.new('g'); s = 8
gme.from_pydata([to_bl(-s, 0, -s), to_bl(s, 0, -s), to_bl(s, 0, s), to_bl(-s, 0, s)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new('g'); gm.use_nodes = True; gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.3, 0.3, 0.3, 1)
gme.materials.append(gm); sc.collection.objects.link(bpy.data.objects.new('g', gme))
cam_d = bpy.data.cameras.new('c'); cam = bpy.data.objects.new('c', cam_d); sc.collection.objects.link(cam); sc.camera = cam
views = {
    'front': ((0, 1.0, 3.3), (0, 0.9, 0), 45),
    'q': ((1.9, 1.3, 2.6), (0, 0.9, 0), 45),
    'back': ((0.4, 1.2, -3.3), (0, 0.9, 0), 45),
    'side': ((3.3, 1.0, 0), (0, 0.9, 0), 45),
    'head': ((0.7, 1.7, 1.1), (0, 1.6, 0), 50),
    'hip': ((0.9, 1.0, 1.5), (0, 0.95, 0), 50),
    'feet': ((1.1, 0.45, 1.3), (0, 0.15, 0.05), 50),
    'hand': ((0.9, 0.9, 0.9), (0.28, 0.85, 0.05), 50),
    'upper': ((0.9, 1.5, 1.7), (0, 1.3, 0), 50),
    'upperb': ((-0.9, 1.5, -1.7), (0, 1.3, 0), 50),
    'headq': ((0.35, 1.68, 0.7), (0, 1.62, 0), 50),
    'headside': ((0.85, 1.64, 0.1), (0, 1.62, 0), 50),
}
out = opts.get('out', '/tmp/char')
for name in opts.get('views', 'front,q,back').split(','):
    pos, tgt, lens = views[name]
    cam.location = to_bl(*pos); cam_d.lens = lens
    cam.rotation_euler = (to_bl(*tgt) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = f'{out}-{name}.png'
    bpy.ops.render.render(write_still=True)
print('done')
