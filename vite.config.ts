import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Web MIDI requires a secure context; localhost qualifies.
    host: 'localhost',
    port: 5173,
  },
  build: { target: 'es2022' },
});
