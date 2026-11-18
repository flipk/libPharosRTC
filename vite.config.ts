import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/ts/index.ts'),
      name: 'libPharosRTC',
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: [],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/ts/**/*.test.ts'],
  },
});
