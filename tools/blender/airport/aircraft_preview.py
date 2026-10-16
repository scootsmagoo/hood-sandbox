"""Quick-look Cycles renders of the aircraft and the airside vehicles (CPU, headless). The game replaces every material by name,
so the exported materials are plain; for the pictures this swaps in look-alike materials (the painted skin decoded from its
region code into a sample livery, vertex colour times baked occlusion, metal, glass, glowing lenses), renders, and puts
everything back, so the export is the same with or without previews.
"""
import math

import bpy

from hoodlib.frame import to_bl

# a sample livery for the pictures only (crown, belly, fin, engine, stripe, accent): white crown, navy belly, red stripe
LIVERY = [(0.93, 0.935, 0.94), (0.012, 0.025, 0.07), (0.012, 0.025, 0.07), (0.58, 0.006, 0.03), (0.58, 0.006, 0.03), (0.58, 0.006, 0.03)]
GROUND_LIVERY = [(0.85, 0.62, 0.02)] * 6   # airside vehicles: safety yellow

LOOK = {
    'ac_paint': dict(livery=True, rough=0.32),
    'ac_grey': dict(rough=0.45, metal=0.15),
    'ac_metal': dict(rough=0.28, metal=0.85),
    'ac_dark': dict(rough=0.8),
    'ac_window': dict(rough=0.06, spec=1.0),
    'ac_light': dict(emit_vc=True, strength=6.0),
}


def _srgb_to_lin(c):
    return c


def _make(name, spec, livery):
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
    if spec.get('emit_vc'):
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Emission Color'])
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
        return m
    if spec.get('livery'):
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(vc.outputs['Color'], sep.inputs['Color'])
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = 7.0
        nt.links.new(sep.outputs['Red'], mul.inputs[0])
        prev = None
        rgb0 = nt.nodes.new('ShaderNodeRGB')
        rgb0.outputs[0].default_value = (*livery[0], 1)
        prev = rgb0.outputs[0]
        for k in range(1, 6):
            cmp = nt.nodes.new('ShaderNodeMath')
            cmp.operation = 'COMPARE'
            cmp.inputs[1].default_value = float(k)
            cmp.inputs[2].default_value = 0.5
            nt.links.new(mul.outputs[0], cmp.inputs[0])
            rgb = nt.nodes.new('ShaderNodeRGB')
            rgb.outputs[0].default_value = (*livery[k], 1)
            mx = nt.nodes.new('ShaderNodeMix')
            mx.data_type = 'RGBA'
            nt.links.new(cmp.outputs[0], mx.inputs['Factor'])
            nt.links.new(prev, mx.inputs['A'])
            nt.links.new(rgb.outputs[0], mx.inputs['B'])
            prev = mx.outputs['Result']
        base = prev
    else:
        base = vc.outputs['Color']
    ao = nt.nodes.new('ShaderNodeMix')
    ao.data_type = 'RGBA'
    ao.blend_type = 'MULTIPLY'
    ao.inputs['Factor'].default_value = 1.0
    nt.links.new(base, ao.inputs['A'])
    nt.links.new(vc.outputs['Alpha'], ao.inputs['B'])
    nt.links.new(ao.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = spec.get('metal', 0.0)
    bsdf.inputs['Roughness'].default_value = spec.get('rough', 0.5)
    return m


def _render(prefix, views, size, default_show, livery, ground_y=0.0):
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
    added = []
    sun_data = bpy.data.lights.new('preview_sun', 'SUN')
    sun_data.angle = math.radians(3)
    sun = bpy.data.objects.new('preview_sun', sun_data)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(42), 0, math.radians(-35))
    added.append(sun)
    gme = bpy.data.meshes.new('preview_ground')
    s = 600
    gme.from_pydata([to_bl(-s, ground_y - 0.002, -s), to_bl(s, ground_y - 0.002, -s), to_bl(s, ground_y - 0.002, s), to_bl(-s, ground_y - 0.002, s)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.new('preview_ground')
    gmat.use_nodes = True
    gmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.3, 0.3, 0.29, 1)
    gme.materials.append(gmat)
    ground = bpy.data.objects.new('preview_ground', gme)
    sc.collection.objects.link(ground)
    added.append(ground)
    cam_data = bpy.data.cameras.new('preview_cam')
    cam = bpy.data.objects.new('preview_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    added.append(cam)
    looks = {name: _make(name, spec, livery) for name, spec in LOOK.items()}
    saved = []
    for me in bpy.data.meshes:
        for i, m in enumerate(me.materials):
            if m is not None and m.name in looks:
                saved.append((me, i, m))
                me.materials[i] = looks[m.name]
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o not in added]
    moved = []
    for name, v in views.items():
        show = v.get('show', default_show)
        for o in meshes:
            o.hide_render = not show(o.name)
        for o, loc in moved:
            o.location = loc
        moved = []
        for oname, pos in (v.get('move') or {}).items():
            o = bpy.data.objects[oname]
            moved.append((o, o.location.copy()))
            o.location = to_bl(*pos)
        cam.location = to_bl(*v['cam'])
        d = to_bl(*v['at']) - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam_data.lens = v.get('lens', 35)
        cam_data.clip_start = 0.05
        cam_data.clip_end = 5000
        sc.cycles.samples = v.get('samples', 24)
        bg.inputs['Strength'].default_value = v.get('sky', 1.0)
        sun_data.energy = v.get('sun', 3.5)
        ground.hide_render = not v.get('ground', True)
        sc.render.filepath = f'{prefix}-{name}.png'
        bpy.ops.render.render(write_still=True)
    for o, loc in moved:
        o.location = loc
    for o in meshes:
        o.hide_render = False
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


def install(views, size=(960, 540), default_show=None, livery=None):
    import hoodlib.preview as hp
    hp.render = lambda prefix, *a, **k: _render(prefix, views, size, default_show or (lambda n: True), livery or LIVERY)


def install_aircraft(T, typ):
    L, S, H = T['length'], T['span'], T['height']
    R, cy = T['fuselage']['radius'], T['fuselage']['centreY']
    nz, tz = T['noseZ'], T['tailZ']
    D = max(L, S)
    mz = (nz + tz) / 2
    xg = T['mainGearHalfTrack']
    l0 = lambda n: n.startswith('lod0')
    install({
        'side': dict(cam=(D * 2.6, H * 0.3, -0.5), at=(0.0, H * 0.3, -0.5), lens=80, show=l0),
        'front': dict(cam=(S * 0.12, H * 0.42, nz + D * 1.05), at=(0.0, H * 0.32, 0.0), lens=35, show=l0),
        'q_above': dict(cam=(D * 0.62, D * 0.42, D * 0.66), at=(0.0, H * 0.2, mz), lens=33, show=l0),
        'q_below': dict(cam=(D * 0.5, -D * 0.3, -D * 0.55), at=(0.0, H * 0.25, 0.0), lens=33, show=l0, ground=False),
        'nose': dict(cam=(R * 3.3, cy + R * 0.55, nz + R * 3.6), at=(0.0, cy - R * 0.1, nz - R * 2.2), lens=30, show=l0),
        'gear': dict(cam=(xg + R * 2.2, R * 0.45, -R * 3.4), at=(xg * 0.7, R * 0.5, 0.4), lens=26, show=l0),
        'tail': dict(cam=(R * 4.2, H * 0.62, tz - R * 3.2), at=(0.0, H * 0.55, tz + R * 3.2), lens=30, show=l0),
        'engine': dict(cam=(T['engines'][0]['x'] + R * 2.4, T['engines'][0]['y'] + R * 0.6, T['engines'][0]['z'] + R * 3.4),
                       at=(T['engines'][0]['x'], T['engines'][0]['y'], T['engines'][0]['z']), lens=30, show=l0),
        'cockpit': dict(cam=(R * 1.4, cy + R * 1.9, nz - R * 0.2), at=(0.0, cy + R * 0.6, nz - R * 3.2), lens=30, show=l0),
        'top': dict(cam=(0.0, D * 2.4, mz - 0.01), at=(0.0, 0.0, mz), lens=50, show=l0),
        'nosegear': dict(cam=(R * 1.5, R * 0.45, T['wheelbase'] + R * 2.0), at=(0.0, R * 0.45, T['wheelbase']), lens=28, show=l0),
        'lod1': dict(cam=(D * 0.62, D * 0.42, D * 0.66), at=(0.0, H * 0.2, mz), lens=33, show=lambda n: n.startswith('lod1')),
        'lod1_side': dict(cam=(D * 2.6, H * 0.3, -0.5), at=(0.0, H * 0.3, -0.5), lens=80, show=lambda n: n.startswith('lod1')),
        'lod2': dict(cam=(D * 0.62, D * 0.42, D * 0.66), at=(0.0, H * 0.2, mz), lens=33, show=lambda n: n.startswith('lod2')),
        'lod2_side': dict(cam=(D * 2.6, H * 0.3, -0.5), at=(0.0, H * 0.3, -0.5), lens=80, show=lambda n: n.startswith('lod2')),
    }, default_show=l0)
