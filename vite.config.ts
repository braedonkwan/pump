import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep frontend modules such as /api.ts out of the backend proxy.
      '/api/': {
        target: 'http://127.0.0.1:3001',
        // Preserve the browser host so the API can enforce its origin check.
        changeOrigin: false,
      },
    },
  },
  build: { outDir: '../../dist/client', emptyOutDir: true },
});
