import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  syncLogin,
  syncCollection,
  syncFullDownload,
  syncFullUpload,
  syncMedia,
  getStats,
  resetProgress,
  checkMedia,
  getAnkiVersion,
  FullSyncRequiredError,
  type SyncProgress,
  type Stats,
  type MediaCheckReport,
  type AnkiVersion,
} from '../../wasm/backend'
import {
  ensureCollectionReady,
  persistCollection,
  persistMedia,
  persistMediaDb,
  restoreMediaToBackend,
  checkAndDeleteUnusedMedia,
} from '../../db/collection'
import DonutChart from '../charts/DonutChart'
import ForecastBarChart from '../charts/ForecastBarChart'

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
// Remembered so the logged-in view can greet the user by name without a
// server round-trip — purely cosmetic, cleared on log out alongside the hkey.
const USERNAME_STORAGE_KEY = 'cleananki.sync.username'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * Renders whatever `wasm_sync_progress_json` last reported (see its doc
 * comment in rust/wasm-bridge/src/main.rs). `full_sync` has a real known
 * total (one file of a known size), so it gets a real percentage bar;
 * `normal_sync`/`media_sync` are incremental round-trips with no fixed
 * total, so they get a live counter with an indeterminate (striped) bar
 * instead — still much more informative than a bare "Syncing…" spinner.
 */
function SyncProgressDisplay({ progress }: { progress: SyncProgress | null }) {
  if (!progress || progress.kind === 'other') return null

  if (progress.kind === 'full_sync') {
    const pct =
      progress.totalBytes > 0
        ? Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
        : 0
    return (
      <div className="space-y-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full rounded-full bg-indigo-600 transition-[width] dark:bg-indigo-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)} ({pct}%)
        </p>
      </div>
    )
  }

  if (progress.kind === 'normal_sync') {
    const stageLabel =
      progress.stage === 'connecting'
        ? 'Connecting…'
        : progress.stage === 'finalizing'
          ? 'Finalizing…'
          : 'Syncing…'
    const changes =
      progress.localUpdate + progress.localRemove + progress.remoteUpdate + progress.remoteRemove
    return (
      <div className="space-y-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-600 dark:bg-indigo-500" />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {stageLabel} {changes > 0 && `${changes} change${changes === 1 ? '' : 's'} so far`}
        </p>
      </div>
    )
  }

  // media_sync
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-600 dark:bg-indigo-500" />
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {progress.checked} checked
        {progress.downloadedFiles > 0 && `, ${progress.downloadedFiles} downloaded`}
        {progress.uploadedFiles > 0 && `, ${progress.uploadedFiles} uploaded`}
        {(progress.downloadedDeletions > 0 || progress.uploadedDeletions > 0) &&
          `, ${progress.downloadedDeletions + progress.uploadedDeletions} deletion(s)`}
      </p>
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone?: 'indigo' | 'red' | 'green' | 'neutral'
}) {
  const toneClass = {
    indigo: 'text-indigo-600 dark:text-indigo-400',
    red: 'text-red-600 dark:text-red-400',
    green: 'text-green-600 dark:text-green-400',
    neutral: 'text-neutral-900 dark:text-neutral-100',
  }[tone ?? 'neutral']

  return (
    <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm dark:border-neutral-800">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}

/**
 * The Profile page — merges the former SyncSettings (login + collection/media
 * sync) and StatisticsView (real-data stats + reset) into one screen. When
 * logged out it shows the login form; when logged in it shows the sync
 * controls plus the stats section.
 *
 * `onBusyChange`: the wasm bridge runs a login/sync on a background thread
 * while holding the collection mutex for its whole duration (see
 * `wasm_sync_collection`'s doc comment in rust/wasm-bridge/src/main.rs) — the
 * bridge has only one collection lock, so any other bridge call that needs it
 * (`getDeckTree`, `getNextCard`, ...) would block. Emscripten's pthread-backed
 * `Mutex::lock` blocks via `Atomics.wait`, which browsers do not allow on the
 * main thread, so navigating to another tab mid-sync — which would fire that
 * tab's own bootstrap call — risks a hard crash, not just a stall. App.tsx
 * uses this to disable switching away from Profile while a login/sync runs.
 *
 * `onAuthChange`: fires with the current hkey (or null) whenever auth state
 * changes, and once on mount, so the parent (App.tsx) can show "Log In" vs
 * "Profile" in the nav without duplicating this component's localStorage logic.
 */
export default function ProfileView({
  onBusyChange,
  onAuthChange,
}: {
  onBusyChange?: (busy: boolean) => void
  onAuthChange?: (hkey: string | null) => void
}) {
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_STORAGE_KEY) ?? '')
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

  // Live progress for whichever sync phase is currently running (collection,
  // full download/upload, or media) — see `wasm_sync_progress_json`'s doc
  // comment in rust/wasm-bridge/src/main.rs. Shared across phases: each
  // handler passes `setSyncProgress` as the `onProgress` callback, so it
  // naturally shows the collection sync's progress, then the media sync's,
  // without needing separate state per phase.
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)

  // Stats (moved from the former StatisticsView) — same real rslib data.
  type StatsStatus = 'loading' | 'ready' | 'error'
  const [statsStatus, setStatsStatus] = useState<StatsStatus>('loading')
  const [statsError, setStatsError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting'>('idle')
  const statsBootstrapped = useRef(false)

  // Check Media (Tools → Check Media in real Anki): a two-step maintenance
  // action — scan+report first, then an explicit delete of the unused files.
  const [mediaCheckStatus, setMediaCheckStatus] = useState<'idle' | 'checking' | 'deleting'>('idle')
  const [mediaCheckReport, setMediaCheckReport] = useState<MediaCheckReport | null>(null)
  const [mediaCheckError, setMediaCheckError] = useState<string | null>(null)

  // Real rslib version this build's wasm bridge was compiled against (see
  // `wasm_anki_version` in rust/wasm-bridge/src/main.rs) — a plain function
  // call, no collection lock needed, so it's fetched independently of the
  // stats bootstrap above. Purely informational for the version footer
  // below; a failure here just leaves it blank rather than surfacing an
  // error to the user.
  const [ankiVersion, setAnkiVersion] = useState<AnkiVersion | null>(null)

  // Notify the parent of the current auth state, including once on mount.
  useEffect(() => {
    onAuthChange?.(hkey)
  }, [hkey, onAuthChange])

  useEffect(() => {
    getAnkiVersion()
      .then(setAnkiVersion)
      .catch(() => {})
  }, [])

  const refreshStats = useCallback(async () => {
    const s = await getStats()
    setStats(s)
    return s
  }, [])

  useEffect(() => {
    if (statsBootstrapped.current) return
    statsBootstrapped.current = true
    ;(async () => {
      try {
        await ensureCollectionReady()
        await refreshStats()
        setStatsStatus('ready')
      } catch (err) {
        setStatsError(errorMessage(err))
        setStatsStatus('error')
      }
    })()
  }, [refreshStats])

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
      localStorage.setItem(USERNAME_STORAGE_KEY, username)
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
    localStorage.removeItem(USERNAME_STORAGE_KEY)
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
      await syncMedia(currentHkey, effectiveEndpoint, setSyncProgress)
      await persistMedia()
      await persistMediaDb()
      setMediaSyncStatus('done')
    } catch (err) {
      setMediaSyncError(errorMessage(err))
      setMediaSyncStatus('error')
    } finally {
      setSyncProgress(null)
    }
  }

  const handleSyncNow = async () => {
    if (!hkey) return
    setSyncStatus('busy')
    setSyncError(null)
    setNeedsFullSync(false)
    onBusyChange?.(true)
    try {
      await syncCollection(hkey, effectiveEndpoint, setSyncProgress)
      await persistCollection()
      setSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
      await refreshStats()
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
      setSyncProgress(null)
    }
  }

  const handleFullDownload = async () => {
    if (!hkey) return
    // Destructive to local data — mirrors HomeView's confirm-before-destroying
    // pattern.
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
      await syncFullDownload(hkey, effectiveEndpoint, setSyncProgress)
      await persistCollection()
      setNeedsFullSync(false)
      setFullSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
      await refreshStats()
    } catch (err) {
      setFullSyncError(errorMessage(err))
      setFullSyncStatus('error')
    } finally {
      onBusyChange?.(false)
      setSyncProgress(null)
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
      await syncFullUpload(hkey, effectiveEndpoint, setSyncProgress)
      await persistCollection()
      setNeedsFullSync(false)
      setFullSyncStatus('done')
      await syncMediaAfterCollectionSync(hkey)
      await refreshStats()
    } catch (err) {
      setFullSyncError(errorMessage(err))
      setFullSyncStatus('error')
    } finally {
      onBusyChange?.(false)
      setSyncProgress(null)
    }
  }

  const handleReset = useCallback(async () => {
    // Destructive and irreversible (no undo across a reload — OPFS gets
    // overwritten by the very next persistCollection()), same confirm
    // pattern as HomeView's delete-deck.
    const ok = window.confirm(
      'Reset all progress and stats? Every card goes back to "new" and all review history is deleted. Decks, notes, and cards themselves are kept. This cannot be undone.',
    )
    if (!ok) return

    setResetStatus('resetting')
    try {
      await resetProgress()
      await persistCollection()
      await refreshStats()
      setResetStatus('idle')
    } catch (err) {
      setStatsError(errorMessage(err))
      setStatsStatus('error')
      setResetStatus('idle')
    }
  }, [refreshStats])

  const handleCheckMedia = useCallback(async () => {
    setMediaCheckError(null)
    setMediaCheckStatus('checking')
    try {
      // The scan reads the media folder in the backend's in-memory FS, which
      // is wiped on reload and NOT eagerly repopulated (see
      // restoreMediaToBackend's doc comment). Restore first so the scan sees
      // the real persisted library, not an empty folder — otherwise it would
      // report 0 unused files on any post-reload check.
      await restoreMediaToBackend()
      const report = await checkMedia()
      setMediaCheckReport(report)
      setMediaCheckStatus('idle')
    } catch (err) {
      setMediaCheckError(errorMessage(err))
      setMediaCheckStatus('idle')
    }
  }, [])

  const handleDeleteUnusedMedia = useCallback(async () => {
    const count = mediaCheckReport?.unusedCount ?? 0
    if (count === 0) return
    // Destructive: matches the confirm-before-destroying pattern of
    // full-download/upload and reset-progress above.
    const ok = window.confirm(
      `Delete ${count} unused media file${count === 1 ? '' : 's'}? ` +
        'They are referenced by no note and will be removed from this browser and, ' +
        'on your next media sync, from the server too. This cannot be undone.',
    )
    if (!ok) return

    setMediaCheckStatus('deleting')
    try {
      await checkAndDeleteUnusedMedia()
      // Re-run the scan so the displayed report refreshes (should now show 0
      // unused).
      const report = await checkMedia()
      setMediaCheckReport(report)
      setMediaCheckStatus('idle')
    } catch (err) {
      setMediaCheckError(errorMessage(err))
      setMediaCheckStatus('idle')
    }
  }, [mediaCheckReport])

  const primaryButton =
    'w-full rounded-2xl bg-indigo-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-indigo-500 dark:hover:bg-indigo-400'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-2xl space-y-6"
    >
      {!hkey && (
        <div className="mx-auto max-w-md space-y-6">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Username
            </label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-indigo-900"
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
                className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 pr-11 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-indigo-900"
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
                className="rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-600"
              />
              Use custom sync server
            </label>
            {useCustomServer && (
              <input
                type="url"
                placeholder="http://192.168.1.100:8081"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-indigo-900"
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
            className={`mt-2 ${primaryButton}`}
          >
            {loginStatus === 'busy' ? 'Logging in…' : 'Log in'}
          </button>
        </div>
      )}

      {hkey && (
        <section className="mx-auto max-w-md space-y-6">
            <div className="rounded-2xl border border-neutral-200 p-4 shadow-sm dark:border-neutral-800">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Signed in as{' '}
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                  {username || 'AnkiWeb user'}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {useCustomServer && endpoint ? endpoint : 'AnkiWeb'}
              </p>
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
              className={primaryButton}
            >
              {syncStatus === 'busy'
                ? 'Syncing…'
                : mediaSyncStatus === 'busy'
                  ? 'Syncing media…'
                  : 'Sync now'}
            </button>

            {(syncStatus === 'busy' || mediaSyncStatus === 'busy') && (
              <SyncProgressDisplay progress={syncProgress} />
            )}

            {needsFullSync && (
              <div className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/50">
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
                {(fullSyncStatus === 'busy' || mediaSyncStatus === 'busy') && (
                  <SyncProgressDisplay progress={syncProgress} />
                )}
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
              className="w-full rounded-2xl border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Log out
            </button>
          </section>
      )}

      {/* Stats are real local collection data (rslib's own computation, same
          as real Anki desktop's stats screen) — nothing to do with sync/login
          state, so this shows regardless of whether you're signed in. */}
      <section className="mx-auto max-w-2xl space-y-6 border-t border-neutral-200 pt-6 dark:border-neutral-800">
            <h2 className="text-lg font-semibold">Statistics</h2>

            {statsStatus === 'loading' && (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
            )}

            {statsStatus === 'error' && statsError && (
              <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {statsError}
              </div>
            )}

            {statsStatus === 'ready' && stats && (
              <>
                <div>
                  <p className="text-sm text-neutral-700 dark:text-neutral-300">
                    {stats.studiedTodayText}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    Scheduling algorithm: {stats.fsrs ? 'FSRS' : 'SM-2 (legacy)'}
                  </p>
                </div>

                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    Today
                  </h3>
                  <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatCard label="Answered" value={stats.today.answerCount} />
                    <StatCard
                      label="Correct"
                      value={
                        stats.today.answerCount > 0
                          ? `${Math.round((stats.today.correctCount / stats.today.answerCount) * 100)}%`
                          : '—'
                      }
                      tone="green"
                    />
                    <StatCard
                      label="Time studied"
                      value={`${Math.round(stats.today.answerMillis / 60000)} min`}
                    />
                    <StatCard label="Mature correct" value={stats.today.matureCorrect} tone="green" />
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    Due forecast
                  </h3>
                  <div className="mt-2 grid grid-cols-3 gap-3">
                    <StatCard label="Due today" value={stats.dueToday} tone="indigo" />
                    <StatCard label="Due this week" value={stats.dueThisWeek} tone="indigo" />
                    <StatCard label="Overdue" value={stats.backlog} tone="red" />
                  </div>
                  <div className="mt-3">
                    <ForecastBarChart data={stats.dueForecast} />
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    Card counts
                  </h3>
                  <div className="mt-2">
                    <DonutChart
                      segments={[
                        {
                          label: 'New',
                          value: stats.cardCounts.newCards,
                          colorClass: 'fill-indigo-500 dark:fill-indigo-400',
                        },
                        {
                          label: 'Learning',
                          value: stats.cardCounts.learn + stats.cardCounts.relearn,
                          colorClass: 'fill-red-500 dark:fill-red-400',
                        },
                        {
                          label: 'Review',
                          value: stats.cardCounts.young + stats.cardCounts.mature,
                          colorClass: 'fill-green-500 dark:fill-green-400',
                        },
                        {
                          label: 'Suspended/buried',
                          value: stats.cardCounts.suspended + stats.cardCounts.buried,
                          colorClass: 'fill-neutral-400 dark:fill-neutral-500',
                        },
                      ]}
                      centerLabel={String(
                        stats.cardCounts.newCards +
                          stats.cardCounts.learn +
                          stats.cardCounts.relearn +
                          stats.cardCounts.young +
                          stats.cardCounts.mature +
                          stats.cardCounts.suspended +
                          stats.cardCounts.buried,
                      )}
                    />
                  </div>
                </div>

                <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={resetStatus === 'resetting'}
                    className="rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950"
                  >
                    {resetStatus === 'resetting' ? 'Resetting…' : 'Reset all progress and stats'}
                  </button>
                  <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Every card goes back to "new" and all review history is deleted. Decks, notes, and
                    cards are kept.
                  </p>
                </div>

                <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    Check media
                  </h3>
                  <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Scans for media files (audio/images) that no note references anymore — for
                    example after deleting a deck. Deleting a deck never removes its media
                    automatically (files can be shared between notes), just like Anki desktop; this
                    is how you clean them up.
                  </p>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={handleCheckMedia}
                      disabled={mediaCheckStatus !== 'idle'}
                      className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
                    >
                      {mediaCheckStatus === 'checking' ? 'Checking…' : 'Check media'}
                    </button>
                  </div>

                  {mediaCheckError && (
                    <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                      {mediaCheckError}
                    </div>
                  )}

                  {mediaCheckReport && (
                    <div className="mt-3 space-y-3">
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        {mediaCheckReport.unusedCount} unused file
                        {mediaCheckReport.unusedCount === 1 ? '' : 's'} found
                      </p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                        {mediaCheckReport.summary}
                      </pre>
                      {mediaCheckReport.unusedCount > 0 && (
                        <button
                          type="button"
                          onClick={handleDeleteUnusedMedia}
                          disabled={mediaCheckStatus !== 'idle'}
                          className="rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950"
                        >
                          {mediaCheckStatus === 'deleting'
                            ? 'Deleting…'
                            : `Delete ${mediaCheckReport.unusedCount} unused file${mediaCheckReport.unusedCount === 1 ? '' : 's'}`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>

      <p className="text-center text-xs text-neutral-400 dark:text-neutral-600">
        CleanAnki v{__APP_VERSION__} ({__GIT_COMMIT__})
        {ankiVersion && ` · Anki ${ankiVersion.version}`}
      </p>
    </motion.div>
  )
}
