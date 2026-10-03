import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// the app version shown in the About dialog (client/src/lib/version.js)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const target = process.env.GREANTEADAWY_URL || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/mcp': target,
      '/sandbox': target, // the generator plugin sandbox page (served by the server with its own CSP)
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  }
});
