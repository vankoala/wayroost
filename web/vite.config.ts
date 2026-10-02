import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // Keep every asset a real file so the CSP never needs inline data.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
