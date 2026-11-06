import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { netvizFileWatcherPlugin } from './server/watcherPlugin';

export default defineConfig({
  plugins: [react(), netvizFileWatcherPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
