import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// COOP/COEP are required for cross-origin isolation, which is required to use
// SharedArrayBuffer, which is required by the Emscripten-compiled Rust core
// (rslib via wasm-bridge) because it uses pthread emulation backed by real Web
// Workers for its SQLite storage layer and its tokio/rayon thread pools.
//
// These headers must be present on every response in both dev and prod. The
// dev-server half is configured here; the prod half lives in public/_headers
// (Netlify/Cloudflare Pages convention) since vite-plugin-pwa's generated
// service worker does not set response headers for you.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The default injected script is a bare `navigator.serviceWorker.
      // register()` with no update-checking or reload-on-update logic at
      // all — none of what `registerType: 'autoUpdate'` actually promises
      // (detecting a new worker and reloading to use it) lives there; that
      // logic only exists in the `virtual:pwa-register` module. Registering
      // explicitly via that module in src/main.tsx instead — see the comment
      // there for the periodic update-check this also adds.
      injectRegister: false,
      // Phase 1: basic precache-and-serve-offline for built assets. This is
      // deliberately not tuned for the .wasm/.data artifacts that will show
      // up once rust/wasm-bridge/ produces real build output — revisit the
      // caching strategy (e.g. runtimeCaching rules, workbox size limits for
      // large wasm binaries) once that artifact exists.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
      manifest: {
        name: 'CleanAnki',
        short_name: 'CleanAnki',
        description: 'Anki, in the browser, backed by rslib compiled to WebAssembly.',
        theme_color: '#16171d',
        background_color: '#16171d',
        display: 'standalone',
        // Generated via IconKitchen — public/favicon.ico + apple-touch-icon.png
        // cover the plain <link> tags in index.html; these cover the install/
        // home-screen icon Android/desktop installers read from the manifest.
        // "maskable" variants have safe-area padding baked in so OS icon
        // masks (circle, squircle, ...) don't clip the artwork.
        icons: [
          { src: '/favicon.ico', sizes: '16x16 32x32', type: 'image/x-icon' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  // The Emscripten build in rust/wasm-bridge/ will emit a glue .js file plus
  // a .wasm binary. Vite doesn't treat *.wasm as a known asset type out of
  // the box, so we opt it in explicitly to allow `import wasmUrl from
  // './x.wasm'`-style asset imports (see src/wasm/backend.ts).
  assetsInclude: ['**/*.wasm'],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
