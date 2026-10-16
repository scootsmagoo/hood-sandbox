"""Material slots by name.

Every object gets the same slot list in the same order, so a face's material index means the same
thing in every object, and a boolean's cutter hands its faces' materials to the body unchanged.
The glTF keeps only the names (and a plain colour, for viewers): the game swaps each for its own
material by name (src/client/render/carAssets.ts).
"""
import bpy

# name: (base colour RGBA, metallic, roughness)
SLOTS = [
    ('paint', (0.55, 0.08, 0.06, 1), 0.4, 0.35),
    ('livery', (0.9, 0.9, 0.9, 1), 0.3, 0.4),
    ('trim', (0.03, 0.03, 0.035, 1), 0.0, 0.7),
    ('chrome', (0.8, 0.8, 0.82, 1), 1.0, 0.15),
    ('glass', (0.05, 0.07, 0.08, 1), 0.0, 0.05),
    ('interior', (0.09, 0.085, 0.08, 1), 0.0, 0.85),
    ('tyre', (0.02, 0.02, 0.02, 1), 0.0, 0.9),
    ('light_head', (1.0, 0.97, 0.88, 1), 0.0, 0.1),
    ('light_tail', (0.6, 0.02, 0.02, 1), 0.0, 0.2),
    ('light_reverse', (0.95, 0.95, 0.95, 1), 0.0, 0.2),
    ('light_bar_a', (0.1, 0.3, 1.0, 1), 0.0, 0.2),
    ('light_bar_b', (1.0, 0.1, 0.1, 1), 0.0, 0.2),
]
NAMES = [s[0] for s in SLOTS]
INDEX = {n: i for i, n in enumerate(NAMES)}


def use(slots):
    """Swaps the slot list (for a family of assets that is not a car: the characters). `slots` is a
    list of (name, base colour RGBA, metallic, roughness); call it before any mesh is built."""
    global SLOTS, NAMES, INDEX
    SLOTS = list(slots)
    NAMES = [s[0] for s in SLOTS]
    INDEX = {n: i for i, n in enumerate(NAMES)}


def ensure():
    """Creates the materials once per scene; returns them in slot order."""
    mats = []
    for name, col, metal, rough in SLOTS:
        m = bpy.data.materials.get(name)
        if m is None:
            m = bpy.data.materials.new(name)
            m.use_nodes = True
            bsdf = m.node_tree.nodes.get('Principled BSDF')
            if bsdf:
                bsdf.inputs['Base Color'].default_value = col
                bsdf.inputs['Metallic'].default_value = metal
                bsdf.inputs['Roughness'].default_value = rough
                if name.startswith('light_'):
                    bsdf.inputs['Emission Color'].default_value = col
                    bsdf.inputs['Emission Strength'].default_value = 1.0
            m.diffuse_color = col
        mats.append(m)
    return mats


def slot(name):
    return INDEX[name]
