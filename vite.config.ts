import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/__tts_proxy': {
        target: 'https://translate.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__tts_proxy/, '/translate_tts'),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor';
          }
          if (id.includes('node_modules/jszip')) {
            return 'jszip';
          }
        },
      },
    },
  },
});
