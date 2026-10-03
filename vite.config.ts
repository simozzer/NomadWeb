import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works from any folder — including the
  // GitHub Pages site, which is served from /NomadWeb/ rather than the root.
  // The app's own data is fetched by relative path ("data/…") for the same reason.
  base: './',
  server: {
    // Web MIDI requires a secure context; localhost qualifies.
    host: 'localhost',
    port: 5173,
  },
  build: { target: 'es2022' },
});
