import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'demo/src'),
  build: {
    outDir: resolve(__dirname, 'demo/static'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'demo/src/index.html'),
    },
  },
  server: {
    port: 2500,
  },
});
