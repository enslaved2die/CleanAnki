import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { importApkg, listDecks, setCurrentDeck, type Deck } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'

type Status = 'loading' | 'ready' | 'importing' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Import a real `.apkg` file and pick which deck `StudyView` should study.
 *
 * Deck selection works by calling `setCurrentDeck`, which durably updates the
 * *backend's own* current-deck config (persisted to OPFS via
 * `persistCollection`) — there's no separate "selected deck" state to lift
 * up to `StudyView`. `StudyView` remounts (and re-fetches `getNextCard`)
 * whenever the user navigates back to the Study tab (see App.tsx), so it
 * naturally picks up whatever deck was last selected here.
 */
export default function ImportView() {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [selectedDeckId, setSelectedDeckId] = useState<bigint | null>(null)
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const [lastImportMs, setLastImportMs] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const bootstrapped = useRef(false)

  const refreshDecks = useCallback(async () => {
    const list = await listDecks()
    setDecks(list)
    return list
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      try {
        await ensureCollectionReady()
        await refreshDecks()
        setStatus('ready')
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      }
    })()
  }, [refreshDecks])

  const handleImport = useCallback(async () => {
    if (!pickedFile) return
    setStatus('importing')
    setErrorMsg(null)
    try {
      const previousIds = new Set(decks.map((d) => d.id))
      const bytes = new Uint8Array(await pickedFile.arrayBuffer())
      const t0 = performance.now()
      await importApkg(bytes)
      const elapsed = performance.now() - t0
      await persistCollection()

      const updated = await refreshDecks()
      setLastImportMs(elapsed)
      setStatus('ready')

      // Quality-of-life: if exactly one new deck appeared, select it
      // automatically instead of leaving the user on "Default".
      const newDecks = updated.filter((d) => !previousIds.has(d.id))
      if (newDecks.length === 1) {
        await setCurrentDeck(newDecks[0].id)
        await persistCollection()
        setSelectedDeckId(newDecks[0].id)
      }

      setPickedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setErrorMsg(errorMessage(err))
      setStatus('error')
    }
  }, [pickedFile, decks, refreshDecks])

  const handleSelectDeck = useCallback(async (id: bigint) => {
    try {
      await setCurrentDeck(id)
      await persistCollection()
      setSelectedDeckId(id)
    } catch (err) {
      setErrorMsg(errorMessage(err))
      setStatus('error')
    }
  }, [])

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
          Last import took {lastImportMs.toFixed(0)}ms.
        </p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      <div>
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Decks {status === 'loading' && '(loading…)'}
        </p>
        <ul className="mt-2 space-y-1">
          {decks.map((deck) => (
            <li key={deck.id.toString()}>
              <button
                type="button"
                onClick={() => handleSelectDeck(deck.id)}
                className={`w-full rounded-lg border px-4 py-2 text-left text-sm transition-colors ${
                  selectedDeckId === deck.id
                    ? 'border-neutral-900 bg-neutral-100 font-medium dark:border-neutral-100 dark:bg-neutral-800'
                    : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900'
                }`}
              >
                {deck.name}
                {selectedDeckId === deck.id && (
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                    (studying this deck)
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Pick a deck, then switch to the Study tab.
        </p>
      </div>
    </motion.div>
  )
}
