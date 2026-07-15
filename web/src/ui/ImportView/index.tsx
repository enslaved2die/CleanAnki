import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { importApkg, listDecks, setCurrentDeck } from '../../wasm/backend'
import {
  ensureCollectionReady,
  persistCollection,
  persistMedia,
  persistMediaDb,
} from '../../db/collection'

type Status = 'loading' | 'ready' | 'importing' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Import a real `.apkg` file. Deck selection/management (which deck to
 * study, deleting decks) lives on the Home tab (see `ui/HomeView`), which
 * shows the real deck tree with per-deck New/Learn/Due counts matching real
 * Anki's deck-overview screen — this view used to duplicate a second,
 * counts-less deck picker (`DeckTree.tsx`, now deleted); consolidated so
 * there's a single place deck state is shown and changed.
 */
export default function ImportView() {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const [lastImportMs, setLastImportMs] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      try {
        await ensureCollectionReady()
        setStatus('ready')
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      }
    })()
  }, [])

  const handleImport = useCallback(async () => {
    if (!pickedFile) return
    setStatus('importing')
    setErrorMsg(null)
    try {
      const previousIds = new Set((await listDecks()).map((d) => d.id))
      const bytes = new Uint8Array(await pickedFile.arrayBuffer())
      const t0 = performance.now()
      await importApkg(bytes)
      const elapsed = performance.now() - t0
      await persistCollection()
      // Copy the imported media (audio/images, written into the backend's
      // in-memory FS by import_apkg) out to OPFS so it survives a reload —
      // see db/collection.ts and docs/ARCHITECTURE.md §13.
      const mediaT0 = performance.now()
      const mediaCount = await persistMedia()
      if (mediaCount > 0) {
        console.log(
          `[import] persisted ${mediaCount} media files to OPFS in ${(performance.now() - mediaT0).toFixed(0)}ms`,
        )
      }
      // import_apkg registers imported files in the media sync tracking
      // database too (same one `syncMedia` uses) — persist it so a later
      // session's first sync already knows about them instead of relying
      // solely on the folder-mtime rescan to rediscover them.
      await persistMediaDb()

      const updated = await listDecks()
      setLastImportMs(elapsed)
      setStatus('ready')

      // Quality-of-life: if exactly one new deck appeared, select it
      // automatically instead of leaving the user on "Default". The Home tab
      // is the place to see/change this afterward.
      const newDecks = updated.filter((d) => !previousIds.has(d.id))
      if (newDecks.length === 1) {
        await setCurrentDeck(newDecks[0].id)
        await persistCollection()
      }

      setPickedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setErrorMsg(errorMessage(err))
      setStatus('error')
    }
  }, [pickedFile])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md space-y-6"
    >
      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Import a .apkg file
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".apkg"
          disabled={status === 'loading' || status === 'importing'}
          onChange={(e) => setPickedFile(e.target.files?.[0] ?? null)}
          className="mt-2 w-full text-sm text-neutral-700 file:mr-4 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-800 dark:text-neutral-300 dark:file:bg-neutral-100 dark:file:text-neutral-900 dark:hover:file:bg-neutral-200"
        />
        <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          Cards come in as new (scheduling/due dates from the source deck are not preserved).
        </p>
      </div>

      <button
        type="button"
        onClick={handleImport}
        disabled={!pickedFile || status === 'loading' || status === 'importing'}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {status === 'importing' ? 'Importing…' : 'Import'}
      </button>

      {lastImportMs !== null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Last import took {lastImportMs.toFixed(0)}ms. See the Home tab for your decks.
        </p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}
    </motion.div>
  )
}
