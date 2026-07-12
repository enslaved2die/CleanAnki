import { useState } from 'react'
import { motion } from 'framer-motion'
import { syncLogin, syncCollection, FullSyncRequiredError } from '../../wasm/backend'
import { persistCollection } from '../../db/collection'

// Real sync, wired to rslib's actual sync protocol via the wasm bridge (see
// rust/wasm-bridge/src/main.rs `wasm_sync_login`/`wasm_sync_collection` and
// docs/ARCHITECTURE.md §20 for the transport this is built on: reqwest builds
// the request, but the actual HTTP I/O goes through Emscripten's native
// `emscripten_fetch` — reqwest's own wasm `.send()` needs wasm-bindgen JS glue
// this project deliberately never generates).
//
// The hkey (sync key returned by login) is stored in localStorage — it's a
// long-lived credential-like token (same role as the cookie real Anki desktop
// keeps in its own profile), not collection data, so it doesn't belong in
// OPFS alongside the collection itself. There's no server-side session to
// invalidate it from this UI; "Log out" just forgets the local copy.
const HKEY_STORAGE_KEY = 'cleananki.sync.hkey'
const ENDPOINT_STORAGE_KEY = 'cleananki.sync.endpoint'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `onBusyChange`: the wasm bridge runs a login/sync on a background thread
 * while holding the collection mutex for its whole duration (see
 * `wasm_sync_collection`'s doc comment in rust/wasm-bridge/src/main.rs) — the
 * bridge has only one collection lock, so any other bridge call that needs it
 * (`getDeckTree`, `getNextCard`, ...) would block. Emscripten's pthread-backed
 * `Mutex::lock` blocks via `Atomics.wait`, which browsers do not allow on the
 * main thread, so navigating to another tab mid-sync — which would fire that
 * tab's own bootstrap call — risks a hard crash, not just a stall. App.tsx
 * uses this to disable switching away from Sync while a login/sync is running.
 */
export default function SyncSettings({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [useCustomServer, setUseCustomServer] = useState(
    () => localStorage.getItem(ENDPOINT_STORAGE_KEY) !== null,
  )
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem(ENDPOINT_STORAGE_KEY) ?? '')
  const [hkey, setHkey] = useState(() => localStorage.getItem(HKEY_STORAGE_KEY))

  const [loginStatus, setLoginStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  const [loginError, setLoginError] = useState<string | null>(null)

  const [syncStatus, setSyncStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [syncError, setSyncError] = useState<string | null>(null)

  // Empty endpoint means official AnkiWeb (see `parse_endpoint` in
  // rust/wasm-bridge/src/main.rs) — only persist/use a real URL when the
  // "use custom server" checkbox is on.
  const effectiveEndpoint = useCustomServer ? endpoint : ''

  const handleLogin = async () => {
    setLoginStatus('busy')
    setLoginError(null)
    onBusyChange?.(true)
    try {
      const key = await syncLogin(username, password, effectiveEndpoint)
      setHkey(key)
      localStorage.setItem(HKEY_STORAGE_KEY, key)
      if (useCustomServer) {
        localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint)
      } else {
        localStorage.removeItem(ENDPOINT_STORAGE_KEY)
      }
      setLoginStatus('idle')
    } catch (err) {
      setLoginError(errorMessage(err))
      setLoginStatus('error')
    } finally {
      onBusyChange?.(false)
    }
  }

  const handleLogOut = () => {
    setHkey(null)
    localStorage.removeItem(HKEY_STORAGE_KEY)
    setSyncStatus('idle')
    setSyncError(null)
  }

  const handleSyncNow = async () => {
    if (!hkey) return
    setSyncStatus('busy')
    setSyncError(null)
    onBusyChange?.(true)
    try {
      await syncCollection(hkey, effectiveEndpoint)
      await persistCollection()
      setSyncStatus('done')
    } catch (err) {
      if (err instanceof FullSyncRequiredError) {
        setSyncError(
          'This collection needs a full upload/download (e.g. it has never been synced before). ' +
            'Full sync is not yet supported here — do the first full sync from Anki desktop, then ' +
            'come back here for ordinary syncs.',
        )
      } else {
        setSyncError(errorMessage(err))
      }
      setSyncStatus('error')
    } finally {
      onBusyChange?.(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md space-y-6"
    >
      {!hkey && (
        <>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Username
            </label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-neutral-800"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Password
            </label>
            <div className="relative mt-2">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 pr-11 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-neutral-800"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={useCustomServer}
                onChange={(e) => setUseCustomServer(e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600"
              />
              Use custom sync server
            </label>
            {useCustomServer && (
              <input
                type="url"
                placeholder="http://192.168.1.100:8081"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-neutral-800"
              />
            )}
            <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              Leave unchecked to sync with official AnkiWeb. Check it to sync with your own
              self-hosted <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">anki-sync-server</code>{' '}
              (plain <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">http://</code> is fine).
            </p>
          </div>

          {loginStatus === 'error' && loginError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {loginError}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogin}
            disabled={loginStatus === 'busy' || !username || !password}
            className="mt-2 w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:opacity-50"
          >
            {loginStatus === 'busy' ? 'Logging in…' : 'Log in'}
          </button>
        </>
      )}

      {hkey && (
        <>
          <div className="rounded-lg bg-green-50 p-4 text-sm text-green-700 dark:bg-green-950/50 dark:text-green-300">
            Logged in{useCustomServer && endpoint ? ` to ${endpoint}` : ' to AnkiWeb'}.
          </div>

          {syncStatus === 'done' && (
            <div className="rounded-lg bg-green-50 p-4 text-sm text-green-700 dark:bg-green-950/50 dark:text-green-300">
              Sync complete.
            </div>
          )}

          {syncStatus === 'error' && syncError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {syncError}
            </div>
          )}

          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncStatus === 'busy'}
            className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:opacity-50"
          >
            {syncStatus === 'busy' ? 'Syncing…' : 'Sync now'}
          </button>

          <button
            type="button"
            onClick={handleLogOut}
            className="w-full rounded-lg border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Log out
          </button>
        </>
      )}
    </motion.div>
  )
}
