import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../service/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/node': 'http://localhost:7702',
      '/graph': 'http://localhost:7702',
      '/sessions': 'http://localhost:7702',
      '/events': 'http://localhost:7702',
      '/health': 'http://localhost:7702',
      '/compute_influences': 'http://localhost:7702',
    },
  },
});
