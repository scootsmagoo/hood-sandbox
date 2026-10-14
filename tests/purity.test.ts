import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

// The simulation (and the shared code it uses) must run in a worker and on a server.
describe('headless code stays headless', () => {
  const banned: [RegExp, string][] = [
    [/from\s+['"]three(\/|['"])/, 'imports three.js'],
    [/from\s+['"][./]+\/(client|world)\//, 'imports client or world code'],
    [/\b(document|window|localStorage|navigator|HTMLElement|requestAnimationFrame)\b/, 'touches the DOM'],
  ];
  for (const dir of ['src/sim', 'src/shared']) {
    for (const file of files(dir)) {
      it(file, () => {
        const text = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const [re, why] of banned) expect(re.test(text), `${file} ${why}`).toBe(false);
      });
    }
  }
});
