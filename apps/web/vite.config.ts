import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';

const apiTarget = `http://localhost:${process.env.HEARTH_API_PORT ?? '3000'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Consume @hearth/shared from its TypeScript source (see CLAUDE.md, "Shared package resolution").
    conditions: ['hearth-src', ...defaultClientConditions],
  },
  build: {
    // Script assets (the level meter's AudioWorklet, voice/levelWorklet.js) must stay same-origin
    // files: the CSP is `script-src 'self'`, which blocks data: URLs.
    assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined),
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
