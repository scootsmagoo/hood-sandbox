// Fails the deploy when the baked tile is missing from dist/: without it the game falls back to the procedural ground.
import { existsSync } from 'node:fs';

const f = 'dist/tiles/atlanta/m1-five-points/tile.json';
if (!existsSync(f)) {
  console.error(`MISSING ${f}: bake the tile first (cd tools/pipeline && npm run bake).`);
  process.exit(1);
}
console.log(`tile ok: ${f}`);
