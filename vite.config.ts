import { defineConfig } from 'vitest/config';

// Cross-origin isolation (SharedArrayBuffer for the sim worker). The same pair of headers goes
// in public/_headers for Cloudflare.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { port: 5180, host: '127.0.0.1', headers: isolation },
  preview: { port: 5181, host: '127.0.0.1', headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
