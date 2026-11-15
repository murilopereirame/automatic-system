import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the UI runs on its own port and forwards API calls to the server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
    },
  },
});
