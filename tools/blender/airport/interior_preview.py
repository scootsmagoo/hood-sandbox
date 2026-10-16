"""Quick-look Cycles renders of the walk-in airport heroes (CPU, headless). The game swaps every material by name, so the exported
ones are plain; for a picture this puts in look-alikes (vertex colour times its baked occlusion; the interior lit from within, see-through
windows, emissive screens), renders the views, and puts everything back, so the export is the same with or without previews.

`install(views, setup)` replaces `hoodlib.preview.render` (which build_asset.py calls after `build()`): `views` is {name: dict(cam=(x, y, z),
at=(x, y, z), lens=mm, ortho=size, clip=(near, far), samples=n, show=fn(object name) -> bool)}; `setup()` adds preview-only things
(placeholder aircraft) and returns a function that removes them.
"""
import math

import bpy

from hoodlib.frame import to_bl

VC = 'Col'    # the colour attribute's name (the glTF importer calls it 'Color')

LOOK = {
    'bld_wall': dict(rough=0.8),
    'bld_glass': dict(metal=0.55, rough=0.12),
    'bld_roof': dict(rough=0.95),
    'lm_stone': dict(rough=0.85),
    'lm_flood': dict(rough=0.85),
    'lm_lit': dict(rough=0.7),
    'lm_metal': dict(metal=0.55, rough=0.4),
    'lm_gold': dict(metal=0.9, rough=0.3),
    'lm_glass': dict(metal=0.35, rough=0.12),
    'lm_glow': dict(emit_vc=True, strength=1.5),
    'lm_dark': dict(rough=0.4),
    'lm_interior': dict(rough=0.65, self_lit=0.3),
    'lm_floor': dict(rough=0.25, self_lit=0.25),
    'lm_window': dict(glass=True),
    'lm_screen': dict(emit_vc=True, strength=2.4),
}


def _make(name, spec):
    m = bpy.data.materials.new(f'preview_{name}')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    if spec.get('glass'):
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    else:
        # the game draws these single-sided: a back face is not there
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(geo.outputs['Backfacing'], mx.inputs['Fac'])
        nt.links.new(bsdf.outputs['BSDF'], mx.inputs[1])
        nt.links.new(tr.outputs['BSDF'], mx.inputs[2])
        nt.links.new(mx.outputs['Shader'], out.inputs['Surface'])
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = VC
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(vc.outputs['Color'], mul.inputs['A'])
    nt.links.new(vc.outputs['Alpha'], mul.inputs['B'])
    if spec.get('glass'):
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.03
        bsdf.inputs['Alpha'].default_value = 0.16
        return m
    if spec.get('emit_vc'):
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Emission Color'])
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
        return m
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    if spec.get('self_lit'):
        nt.links.new(mul.outputs['Result'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = spec['self_lit']
    bsdf.inputs['Metallic'].default_value = spec.get('metal', 0.0)
    bsdf.inputs['Roughness'].default_value = spec.get('rough', 0.5)
    return m


def plain(name, rgb, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.4
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
    return m


def box_object(name, centre, size, yaw, mat):
    """A preview-only box (game frame: centre (x, y, z), size (x, y, z), turned yaw about +Y as a ped's yaw: local +z to (sin, cos))."""
    me = bpy.data.meshes.new(name)
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    s, c = math.sin(yaw), math.cos(yaw)
    vs = []
    for x, y, z in [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz), (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]:
        gx, gz = x * c + z * s, -x * s + z * c
        vs.append(to_bl(centre[0] + gx, centre[1] + y, centre[2] + gz))
    fs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
    me.from_pydata(vs, [], fs)
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def aircraft(prefix, stand, yaw, mat, length=37.6, span=35.8, r=1.98, cy=3.55, gear_to_nose=5.06):
    """A placeholder airliner of boxes (fuselage, wings, fin) at a stand (the nose-gear stop) whose nose points (sin yaw, cos yaw)."""
    fx, fz = math.sin(yaw), math.cos(yaw)
    nose = (stand[0] + fx * gear_to_nose, stand[1] + fz * gear_to_nose)
    cen = (nose[0] - fx * length / 2, nose[1] - fz * length / 2)
    obs = [box_object(prefix + '_fus', (cen[0], cy, cen[1]), (2 * r, 2 * r, length), yaw, mat)]
    wc = (cen[0] + fx * 1.0, cen[1] + fz * 1.0)
    obs.append(box_object(prefix + '_wing', (wc[0], 2.5, wc[1]), (span, 0.4, 5.0), yaw, mat))
    tc = (nose[0] - fx * (length - 2.5), nose[1] - fz * (length - 2.5))
    obs.append(box_object(prefix + '_fin', (tc[0], 8.4, tc[1]), (0.4, 6.0, 4.0), yaw, mat))
    obs.append(box_object(prefix + '_tp', (tc[0], 4.4, tc[1]), (12.4, 0.3, 3.0), yaw, mat))
    return obs


def _render(prefix, views, setup=None, size=(960, 540), ground=600.0):
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
    sun.rotation_euler = (math.radians(45), 0, math.radians(-30))
    added.append(sun)
    gme = bpy.data.meshes.new('preview_ground')
    s = ground
    gme.from_pydata([to_bl(-s, -0.01, -s), to_bl(s, -0.01, -s), to_bl(s, -0.01, s), to_bl(-s, -0.01, s)], [], [(0, 1, 2, 3)])
    gmat = plain('preview_groundmat', (0.3, 0.3, 0.29))
    gme.materials.append(gmat)
    gob = bpy.data.objects.new('preview_ground', gme)
    sc.collection.objects.link(gob)
    added.append(gob)
    cam_data = bpy.data.cameras.new('preview_cam')
    cam = bpy.data.objects.new('preview_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    added.append(cam)
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
        show = v.get('show', lambda n: n.startswith('lod0') or n.startswith('preview'))
        for o in meshes:
            o.hide_render = not show(o.name)
        cam.location = to_bl(*v['cam'])
        d = to_bl(*v['at']) - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        if v.get('ortho'):
            cam_data.type = 'ORTHO'
            cam_data.ortho_scale = v['ortho']
        else:
            cam_data.type = 'PERSP'
            cam_data.lens = v.get('lens', 35)
        cam_data.clip_start, cam_data.clip_end = v.get('clip', (0.05, 3000.0))
        sc.cycles.samples = v.get('samples', 24)
        sun_data.energy = v.get('sun', 3.5)
        sc.render.resolution_x, sc.render.resolution_y = v.get('size', size)
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


def install(views, setup=None, size=(960, 540)):
    import hoodlib.preview as hp
    hp.render = lambda prefix, *a, **k: _render(prefix, views, setup, size)


def placeholders(planes):
    """A setup function: placeholder aircraft [(stand (x, z), yaw)] (removed after the renders)."""
    def setup():
        mat = plain('preview_aircraft', (0.85, 0.86, 0.88))
        obs = []
        for k, (stand, yaw) in enumerate(planes):
            obs += aircraft(f'preview_ac{k}', stand, yaw, mat)

        def undo():
            for o in obs:
                me = o.data
                bpy.data.objects.remove(o)
                bpy.data.meshes.remove(me)
            bpy.data.materials.remove(mat)
        return undo
    return setup
