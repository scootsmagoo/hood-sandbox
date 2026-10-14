import { defineConfig, type Plugin } from 'vitest/config';

// Cross-origin isolation (SharedArrayBuffer for the sim worker). The same pair of headers goes
// in public/_headers for Cloudflare.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Rapier's "compat" build carries its 3.3 MB WASM as a 4.4 MB base64 string inside the JS, which
 * ends up twice in the bundle (the sim worker and the loopback transport) and has to be decoded on
 * the heap. The package also ships the raw `.wasm` next to the JS, but its `exports` map hides it, so
 * this plugin rewrites the one call that decodes the string into a URL to the file, imported with
 * `?url` so Vite emits it once as a hashed asset. Rapier then fetches and compiles it as a stream.
 * It fails loudly if a new Rapier release changes the shape of that call.
 */
function rapierExternalWasm(): Plugin {
  const call = /\b\w+\.toByteArray\("[A-Za-z0-9+/=]{10000,}"\)\.buffer/;
  return {
    name: 'rapier-external-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!/rapier3d-simd-compat\/dist\/rapier\.mjs$/.test(id.split('?')[0])) return null;
      if (!call.test(code)) throw new Error('rapier-external-wasm: the inline WASM call was not found; update the plugin in vite.config.ts for this Rapier version');
      return { code: `import __rapierWasmUrl from './rapier_wasm3d_bg.wasm?url';\n${code.replace(call, '__rapierWasmUrl')}`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [rapierExternalWasm()],
  base: './',
  server: { port: 5180, host: '127.0.0.1', headers: isolation },
  preview: { port: 5181, host: '127.0.0.1', headers: isolation },
  worker: { format: 'es', plugins: () => [rapierExternalWasm()] },
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
