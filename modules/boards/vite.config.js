import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into dist/ and committed: the site publishes the repo as-is with no
// build step, so the module ships its own compiled files.
export default defineConfig({
  base: '/modules/boards/dist/',
  plugins: [react()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000, sourcemap: false },
});
