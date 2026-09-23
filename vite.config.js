import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The board is published on GitHub Pages under its own domain
// (trainboard.be), so every asset lives at the site root. `base` is the
// one place that knows it; runtime fetches read it back through
// import.meta.env.BASE_URL.
export default defineConfig({
  base: '/',
  plugins: [react()],
});
