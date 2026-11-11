import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(),{name:'development-csp',transformIndexHtml(html,context){return context.server?html.replace("script-src 'self'","script-src 'self' 'unsafe-inline'").replace("connect-src 'self'","connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"):html;}}],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist/renderer', emptyOutDir: true, sourcemap: false },
});
