import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/server/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = `http://127.0.0.1:${loadConfig().port}`;

export default defineConfig({
  root: path.join(here, 'src/web'),
  plugins: [react()],
  build: { outDir: path.join(here, 'dist/web'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: false }, '/oauth': { target: apiTarget, changeOrigin: false } },
  },
});
