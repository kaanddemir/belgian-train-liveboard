import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The board is published as a GitHub Pages project site, so every asset
// lives under the repository path. `base` is the one place that knows it;
// runtime fetches read it back through import.meta.env.BASE_URL.
export default defineConfig({
  base: '/belgian-train-liveboard/',
  plugins: [react()],
});
