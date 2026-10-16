"""
Blender entry point: builds one asset and exports it as an (uncompressed) .glb.

  blender --background --factory-startup --python tools/blender/build_asset.py -- \
      --module cars.sedan --asset sedan --out /tmp/sedan.raw.glb

`npm run assets` (tools/blender/build.mjs) runs this for every entry of tools/blender/assets.json,
then compresses and checks the results.
"""
import importlib
import json
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ in the repo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opts = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1, 2) if argv[i].startswith('--')}

from hoodlib import export  # noqa: E402

mod = importlib.import_module(opts['module'])
report = mod.build(opts['asset'])
if opts.get('blend'):
    import bpy
    bpy.ops.wm.save_as_mainfile(filepath=opts['blend'])
if opts.get('preview'):
    from hoodlib import preview
    preview.render(opts['preview'])
export.glb(opts['out'], getattr(mod, 'VERTEX_COLOR', 'NONE'), getattr(mod, 'SKINS', False), getattr(mod, 'ANIMATIONS', False), getattr(mod, 'ATTRIBUTES', False))
print('ASSET_REPORT ' + json.dumps(report))
