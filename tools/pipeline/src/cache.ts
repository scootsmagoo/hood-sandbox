import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

/** Returns the cached file if present, otherwise runs fetch() and stores the result. */
export async function cachedFile(file: string, fetch: () => Promise<Buffer | string>): Promise<Buffer> {
  if (existsSync(file)) return readFileSync(file);
  const data = await fetch();
  ensureDir(path.dirname(file));
  writeFileSync(file, data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
