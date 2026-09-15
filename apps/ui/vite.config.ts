import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { channelEnvironmentVariable, markChannelHtml, readUiChannel } from './channel-value.js';

// ADR-0049: the UI channel is a build-time fact, and the dev channel is marked into the served
// HTML — `<html data-channel="dev">` plus the title suffix — so the banner's row and the orange
// accent exist before any JavaScript runs (and stay visible even if the bundle fails to load).
// The stable build leaves `index.html` byte-for-byte as it is, because no plugin touches it.
const uiChannel = readUiChannel(process.env[channelEnvironmentVariable]);

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'codeestra-ui-channel',
      transformIndexHtml(html) {
        return markChannelHtml(html, uiChannel);
      },
    },
  ],
  // Assets are served by the Runtime from the repository root of apps/ui/dist.
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173 },
});
