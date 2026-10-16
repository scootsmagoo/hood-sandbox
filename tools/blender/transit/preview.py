"""Quick-look Cycles renders of the transit assets (CPU, headless). The game replaces every material by name, so the exported
materials are plain; for a picture this swaps in look-alike materials (vertex colour times its baked occlusion, metal, glass,
glowing lamps, a UV checker on the sign faces so their mapping can be checked), renders, and puts everything back, so the
export is the same with or without previews.

`install(views, setup)` replaces `hoodlib.preview.render` (which build_asset.py calls after `build()`) for this asset:
`views` is {name: dict(cam=(x, y, z), at=(x, y, z), lens=mm, show=fn(object name) -> bool, samples=n)}; `setup()` may move
things for the pictures (it returns a function that moves them back).
"""
import math

import bpy

from hoodlib.frame import to_bl

LOOK = {
    'tr_steel': dict(metal=0.6, rough=0.42),
    'tr_band': dict(rough=0.35),
    'tr_cab': dict(rough=0.3),
    'tr_glass': dict(glass=True),
    'tr_dark': dict(rough=0.75),
    'tr_interior': dict(rough=0.55),
    'tr_floor': dict(rough=0.85),
    'tr_light': dict(emit=(1.0, 0.97, 0.9), strength=9.0),
    'tr_head': dict(emit=(1.0, 0.95, 0.82), strength=12.0),
    'tr_tail': dict(emit=(1.0, 0.08, 0.04), strength=8.0),
    'tr_sign': dict(checker=((0.9, 0.45, 0.05), (0.04, 0.02, 0.0)), strength=2.0),
    'tr_concrete': dict(rough=0.9),
    'tr_tile': dict(rough=0.22),
    'tr_signface': dict(checker=((0.85, 0.85, 0.82), (0.05, 0.09, 0.2)), strength=0.0),
    'tr_screen': dict(checker=((0.95, 0.55, 0.05), (0.02, 0.01, 0.0)), strength=2.5),
    'tr_lightface': dict(emit_vc=True, strength=7.0),
}


def _make(name, spec):
    m = bpy.data.materials.new(f'preview_{name}')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(vc.outputs['Color'], mul.inputs['A'])
    nt.links.new(vc.outputs['Alpha'], mul.inputs['B'])
    if spec.get('glass'):
        bsdf.inputs['Base Color'].default_value = (0.75, 0.82, 0.85, 1)
        bsdf.inputs['Roughness'].default_value = 0.02
        bsdf.inputs['Alpha'].default_value = 0.22
        bsdf.inputs['IOR'].default_value = 1.5
        return m
    if 'checker' in spec:
        tc = nt.nodes.new('ShaderNodeTexCoord')
        ck = nt.nodes.new('ShaderNodeTexChecker')
        ck.inputs['Scale'].default_value = 8.0
        a, b = spec['checker']
        ck.inputs['Color1'].default_value = (*a, 1)
        ck.inputs['Color2'].default_value = (*b, 1)
        # a ramp along u on top of the checker: the bright end is u = 1 (the viewer's right)
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(tc.outputs['UV'], sep.inputs['Vector'])
        nt.links.new(tc.outputs['UV'], ck.inputs['Vector'])
        mixu = nt.nodes.new('ShaderNodeMix')
        mixu.data_type = 'RGBA'
        mixu.blend_type = 'MULTIPLY'
        nt.links.new(ck.outputs['Color'], mixu.inputs['A'])
        mixu.inputs['Factor'].default_value = 1.0
        ramp = nt.nodes.new('ShaderNodeMath')
        ramp.operation = 'MULTIPLY_ADD'
        ramp.inputs[1].default_value = 0.7
        ramp.inputs[2].default_value = 0.3
        nt.links.new(sep.outputs['X'], ramp.inputs[0])
        nt.links.new(ramp.outputs[0], mixu.inputs['B'])
        nt.links.new(mixu.outputs['Result'], bsdf.inputs['Base Color'])
        if spec.get('strength'):
            nt.links.new(mixu.outputs['Result'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = spec['strength']
        bsdf.inputs['Roughness'].default_value = 0.4
        return m
    if spec.get('emit_vc'):
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Emission Color'])
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
        return m
    if 'emit' in spec:
        bsdf.inputs['Base Color'].default_value = (*spec['emit'], 1)
        bsdf.inputs['Emission Color'].default_value = (*spec['emit'], 1)
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
        return m
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = spec.get('metal', 0.0)
    bsdf.inputs['Roughness'].default_value = spec.get('rough', 0.5)
    return m


def _render(prefix, views, setup=None, size=(960, 540), default_show=None, ground_y=-0.18):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('preview') if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.55, 0.66, 0.85, 1)
    bg.inputs['Strength'].default_value = 1.0
    added = []
    sun_data = bpy.data.lights.new('preview_sun', 'SUN')
    sun_data.energy = 3.5
    sun_data.angle = math.radians(3)
    sun = bpy.data.objects.new('preview_sun', sun_data)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(48), 0, math.radians(-35))
    added.append(sun)
    gme = bpy.data.meshes.new('preview_ground')
    s = 80
    gme.from_pydata([to_bl(-s, ground_y - 0.002, -s), to_bl(s, ground_y - 0.002, -s), to_bl(s, ground_y - 0.002, s), to_bl(-s, ground_y - 0.002, s)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.new('preview_ground')
    gmat.use_nodes = True
    gmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.3, 0.28, 1)
    gme.materials.append(gmat)
    ground = bpy.data.objects.new('preview_ground', gme)
    sc.collection.objects.link(ground)
    added.append(ground)
    cam_data = bpy.data.cameras.new('preview_cam')
    cam = bpy.data.objects.new('preview_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    added.append(cam)
    # swap the materials
    looks = {name: _make(name, spec) for name, spec in LOOK.items()}
    saved = []
    for me in bpy.data.meshes:
        for i, m in enumerate(me.materials):
            if m is not None and m.name in looks:
                saved.append((me, i, m))
                me.materials[i] = looks[m.name]
    undo = setup() if setup else None
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o not in added]
    for name, v in views.items():
        show = v.get('show', default_show or (lambda n: True))
        for o in meshes:
            o.hide_render = not show(o.name)
        cam.location = to_bl(*v['cam'])
        d = to_bl(*v['at']) - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam_data.lens = v.get('lens', 35)
        cam_data.clip_start = 0.05
        sc.cycles.samples = v.get('samples', 32)
        bg.inputs['Strength'].default_value = v.get('sky', 1.0)
        sun_data.energy = v.get('sun', 3.5)
        ground.hide_render = not v.get('ground', True)
        sc.render.filepath = f'{prefix}-{name}.png'
        bpy.ops.render.render(write_still=True)
    for o in meshes:
        o.hide_render = False
    if undo:
        undo()
    for me, i, m in saved:
        me.materials[i] = m
    for m in looks.values():
        bpy.data.materials.remove(m)
    for o in added:
        bpy.data.objects.remove(o)
    bpy.data.materials.remove(gmat)
    bpy.data.meshes.remove(gme)
    bpy.data.cameras.remove(cam_data)
    bpy.data.lights.remove(sun_data)


def install(views, setup=None, size=(960, 540), default_show=None, ground_y=-0.18):
    import hoodlib.preview as hp
    hp.render = lambda prefix, *a, **k: _render(prefix, views, setup, size, default_show, ground_y)
