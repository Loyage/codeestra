import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // Assets are served by the Runtime from the repository root of apps/ui/dist.
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173 },
});
