import { defineConfig, loadEnv, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { fileURLToPath } from 'node:url';

const cesiumRoot = normalizePath(
  fileURLToPath(new URL('./node_modules/cesium/Build/Cesium/', import.meta.url)),
);

const apiProxy = {
  '/api': { target: process.env.DIGITALEARTH_API_TARGET || 'http://127.0.0.1:8080' },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DIGITALEARTH_');
  const serviceProxy = {
    '/api/v1/satellites': { target: env.DIGITALEARTH_SATELLITES_TARGET || 'http://127.0.0.1:8093' },
    ...apiProxy,
    '/geoserver': {
      target: env.DIGITALEARTH_GEOSERVER_TARGET || 'http://127.0.0.1:8081',
      changeOrigin: true,
    },
  };
  return {
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
    server: { port: 5173, strictPort: true, proxy: serviceProxy },
    preview: { port: 4173, strictPort: true, proxy: serviceProxy },
    build: {
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: { manualChunks: { cesium: ['cesium'] } },
      },
    },
  };
});
