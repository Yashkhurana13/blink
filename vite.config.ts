import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
