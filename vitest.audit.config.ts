import { defineConfig } from 'vitest/config';

// The long-running audits (not part of `npm test`): `npm run audit:collision`.
export default defineConfig({
  test: { include: ['tests/audit/**/*.audit.ts'], environment: 'node', testTimeout: 3_600_000 },
});
