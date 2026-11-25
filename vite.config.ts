import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'MultiModalNav',
        short_name: 'MultiModalNav',
        description: 'Park-and-ride and multimodal trip planner with live traffic',
        theme_color: '#1e293b',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,webmanifest}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Station lists change rarely; tiles are requested on a fixed grid so they cache well.
            urlPattern: ({ url }) => url.pathname === '/api/transit/v6/map/stops',
            handler: 'CacheFirst',
            options: {
              cacheName: 'transit-stops',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 2000, maxAgeSeconds: 14 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    // MapLibre alone is ~800 kB; the service worker caches it after the first load.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
});
