import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// `injectRegister: false` in vite.config.ts turns off vite-plugin-pwa's
// default auto-injected register script — that one is a bare
// `navigator.serviceWorker.register()` with no update-checking or
// reload-on-update logic at all, so `registerType: 'autoUpdate'` there never
// actually did what it promises (detect a new worker, reload to use it).
// Registering through this module instead gets that behavior for real.
//
// It still doesn't check *when* to look for a new worker on its own, though —
// browsers only do that natively on navigation, at most once/day. A PWA a
// user leaves open for a whole study session could go a long time without
// ever discovering a new version exists. Polling `registration.update()`
// ourselves is the standard fix (see vite-plugin-pwa's own docs for this
// exact pattern).
const UPDATE_CHECK_INTERVAL_MS = 60_000

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    setInterval(() => {
      registration.update().catch(() => {
        // A failed check (offline, transient network error) just means we
        // try again on the next interval — nothing to surface to the user.
      })
    }, UPDATE_CHECK_INTERVAL_MS)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
