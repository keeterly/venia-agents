import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { statSync } from 'node:fs';

// Built into dist/ and committed: the site publishes the repo as-is with no
// build step, so the module ships its own compiled files.
export default defineConfig({
  base: '/modules/boards/dist/',
  plugins: [react()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000, sourcemap: false,
    // The drawing tool and React sit in their own file, so a Boards update
    // changes only the small app file and phones keep the big one cached.
    rollupOptions: { output: { manualChunks: (id) => (
      /node_modules\/(react|react-dom|scheduler)\//.test(id)
      // the drawing tool's own code, but not its 1.8 MB font file, which it
      // loads only when needed
      || (/node_modules\/@excalidraw\/excalidraw\/dist\/prod\/(index|chunk-[A-Z0-9]+)\.js$/.test(id) && statSync(id).size < 1000000)
      ? 'vendor' : undefined) } } },
});
