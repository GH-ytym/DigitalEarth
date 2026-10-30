import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { fileURLToPath } from 'node:url';

const cesiumRoot = normalizePath(
  fileURLToPath(new URL('./node_modules/cesium/Build/Cesium/', import.meta.url)),
);

export default defineConfig({
  base: './',
  plugins: [
    react(),
    viteStaticCopy({
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets']
        .map((directory) => ({
          src: `${cesiumRoot}/${directory}`,
          dest: 'cesium',
        }))
        .concat(
          ['LICENSE.md', 'ThirdParty.json', 'ThirdParty.extra.json'].map((file) => ({
            src: `${cesiumRoot}/../../${file}`,
            dest: 'cesium',
          })),
        ),
    }),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: { manualChunks: { cesium: ['cesium'] } },
    },
  },
});
