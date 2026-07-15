import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  syncLogin,
  syncCollection,
  syncFullDownload,
  syncFullUpload,
  syncMedia,
  FullSyncRequiredError,
} from '../../wasm/backend'
import {
  persistCollection,
  persistMedia,
  persistMediaDb,
  restoreMediaToBackend,
} from '../../db/collection'

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
  // Set when a normal sync reports the server needs a full up/download
  // instead (rslib's `SyncActionRequired::FullSyncRequired` — typically the
  // very first sync between this collection and that server, since there's
  // no shared history yet for an incremental sync to reconcile). Cleared on
  // the next successful normal sync.
  const [needsFullSync, setNeedsFullSync] = useState(false)
  const [fullSyncStatus, setFullSyncStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [fullSyncError, setFullSyncError] = useState<string | null>(null)

  // Media (images/audio) sync is a separate protocol from collection sync —
  // see `syncMedia`'s doc comment in wasm/backend.ts. Tracked separately so a
  // media-sync failure (shown as a warning) doesn't look like the collection
  // sync itself failed — the notes/cards/decks are still correctly synced
  // either way.
  const [mediaSyncStatus, setMediaSyncStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [mediaSyncError, setMediaSyncError] = useState<string | null>(null)

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

  // Runs after any successful collection sync (normal, full-download, or
  // full-upload) — real Anki desktop always does both under its one "Sync"
  // button, and without this notes/cards sync fine but the images/audio they
  // reference never actually get fetched. Deliberately does NOT throw: a
  // media-sync failure is surfaced as its own warning rather than making the
  // (already-successful) collection sync look like it failed too.
  //
  // `restoreMediaToBackend()` runs first and is NOT optional now that the
  // tracking database persists across sessions (see `persistMediaDb`):
  // rslib's `register_changes` reconciles its recorded file list against
  // whatever it actually finds in the (emscripten) media folder, and MEMFS
  // starts empty on every reload. Skipping the restore would make every file
  // this database already knows about look locally deleted, which would
  // propagate as real deletions to the server on the very next sync — this
  // is a correctness fix, not just a speedup.
  const syncMediaAfterCollectionSync = async (currentHkey: string) => {
    setMediaSyncStatus('busy')
    setMediaSyncError(null)
    try {
      await restoreMediaToBackend()
      await syncMedia(currentHkey, effectiveEndpoint)
      await persistMedia()
      await persistMediaDb()
      setMediaSyncStatus('done')
    } catch (err) {
      setMediaSyncError(errorMessage(err))
      setMediaSyncStatus('error')
    }
  }

  const handleSyncNow = async () => {
    if (!hkey) return
    setSyncStatus('busy')
    setSyncError(null)
    setNeedsFullSync(false)
    onBusyChange?.(true)
    try {
      await syncCollection(hkey, effectiveEndpoint)
      await persistCollection()
      setSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
    } catch (err) {
      if (err instanceof FullSyncRequiredError) {
        setNeedsFullSync(true)
        setSyncStatus('idle')
      } else {
        setSyncError(errorMessage(err))
        setSyncStatus('error')
      }
    } finally {
      onBusyChange?.(false)
    }
  }

  const handleFullDownload = async () => {
    if (!hkey) return
    // Destructive to local data — mirrors HomeView/StatisticsView's
    // confirm-before-destroying pattern.
    const ok = window.confirm(
      'Download from server? This replaces your ENTIRE local collection with ' +
        "the server's copy. Any local changes not already on the server will be lost. " +
        'This cannot be undone.',
    )
    if (!ok) return

    setFullSyncStatus('busy')
    setFullSyncError(null)
    onBusyChange?.(true)
    try {
      await syncFullDownload(hkey, effectiveEndpoint)
      await persistCollection()
      setNeedsFullSync(false)
      setFullSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
    } catch (err) {
      setFullSyncError(errorMessage(err))
      setFullSyncStatus('error')
    } finally {
      onBusyChange?.(false)
    }
  }

  const handleFullUpload = async () => {
    if (!hkey) return
    // Destructive to remote data.
    const ok = window.confirm(
      'Upload to server? This replaces the ENTIRE collection on the server with ' +
        'your local copy. Anything on the server not already here will be lost — ' +
        'including on any other device already synced to it. This cannot be undone.',
    )
    if (!ok) return

    setFullSyncStatus('busy')
    setFullSyncError(null)
    onBusyChange?.(true)
    try {
      await syncFullUpload(hkey, effectiveEndpoint)
      await persistCollection()
      setNeedsFullSync(false)
      setFullSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
    } catch (err) {
      setFullSyncError(errorMessage(err))
      setFullSyncStatus('error')
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
            <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              <strong>Neither AnkiWeb nor a self-hosted server can be reached directly from a
              browser</strong> — confirmed against the real AnkiWeb server: it sends no
              CORS headers at all (it was only ever built for the native desktop/mobile apps,
              which don't enforce CORS). Leaving this unchecked will fail here. Run the local
              proxy in <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">tools/cors-proxy/</code>{' '}
              (works for either target — see its README), check this box, and point it at your
              proxy's own address (e.g. <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">http://localhost:8082</code>)
              instead of AnkiWeb's or your server's address directly.
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

          {syncStatus === 'done' && mediaSyncStatus !== 'error' && (
            <div className="rounded-lg bg-green-50 p-4 text-sm text-green-700 dark:bg-green-950/50 dark:text-green-300">
              {mediaSyncStatus === 'busy'
                ? 'Collection synced — syncing media (images/audio)…'
                : 'Sync complete (collection + media).'}
            </div>
          )}

          {syncStatus === 'error' && syncError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {syncError}
            </div>
          )}

          {mediaSyncStatus === 'error' && mediaSyncError && (
            <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              Collection synced, but media (images/audio) sync failed: {mediaSyncError}
            </div>
          )}

          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncStatus === 'busy' || mediaSyncStatus === 'busy'}
            className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:opacity-50"
          >
            {syncStatus === 'busy'
              ? 'Syncing…'
              : mediaSyncStatus === 'busy'
                ? 'Syncing media…'
                : 'Sync now'}
          </button>

          {needsFullSync && (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/50">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                This server has no shared history with this collection yet — typically because
                this is the first time these two have synced with each other (e.g. you already
                synced this deck from Anki desktop, but this browser copy has never talked to the
                server before). Pick a direction:
              </p>

              {fullSyncStatus === 'done' && (
                <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950/50 dark:text-green-300">
                  Done. Use "Sync now" above for ordinary syncs from here on.
                </div>
              )}
              {fullSyncStatus === 'error' && fullSyncError && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                  {fullSyncError}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleFullDownload}
                  disabled={fullSyncStatus === 'busy'}
                  className="flex-1 rounded-lg bg-amber-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {fullSyncStatus === 'busy' ? 'Working…' : 'Download from server'}
                </button>
                <button
                  type="button"
                  onClick={handleFullUpload}
                  disabled={fullSyncStatus === 'busy'}
                  className="flex-1 rounded-lg border border-amber-700 px-4 py-2.5 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-900"
                >
                  {fullSyncStatus === 'busy' ? 'Working…' : 'Upload to server'}
                </button>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                "Download" replaces what's in this browser with the server's copy. "Upload"
                replaces what's on the server with this browser's copy. Either is destructive to
                the side it overwrites — pick whichever one is actually up to date.
              </p>
            </div>
          )}

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
