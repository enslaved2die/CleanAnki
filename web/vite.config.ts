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
      // Phase 1: basic precache-and-serve-offline for built assets. This is
      // deliberately not tuned for the .wasm/.data artifacts that will show
      // up once rust/wasm-bridge/ produces real build output — revisit the
      // caching strategy (e.g. runtimeCaching rules, workbox size limits for
      // large wasm binaries) once that artifact exists.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
      },
      manifest: {
        name: 'CleanAnki',
        short_name: 'CleanAnki',
        description: 'Anki, in the browser, backed by rslib compiled to WebAssembly.',
        theme_color: '#16171d',
        background_color: '#16171d',
        display: 'standalone',
        icons: [],
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
