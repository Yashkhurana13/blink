import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/raw': 'http://127.0.0.1:5174',
      '/a': 'http://127.0.0.1:5174',
      '/og.png': 'http://127.0.0.1:5174',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
