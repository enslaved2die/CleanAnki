import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { getDeckTree, setCurrentDeck, deleteDeck, type DeckTreeNode } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import ImportView from '../ImportView'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One deck row (recursing into its children). Uses the real nested tree +
 * due counts from `wasm_get_deck_tree` (rslib's own `Collection::deck_tree`)
 * rather than re-deriving a hierarchy from flat `::`-joined names — rslib
 * already builds the tree and computes New/Learn/Due for us, matching the
 * counts real Anki's own deck-overview screen shows.
 */
function DeckRow({
  node,
  depth,
  onStudy,
  onDelete,
}: {
  node: DeckTreeNode
  depth: number
  onStudy: (node: DeckTreeNode) => void
  onDelete: (id: bigint, name: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0

  return (
    <>
      <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
        <td className="py-1.5 pr-2">
          <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 1.25}rem` }}>
            {hasChildren ? (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                className="w-4 shrink-0 text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                {expanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => onStudy(node)}
              className="truncate text-left text-sm hover:underline"
              title="Study this deck"
            >
              {node.name}
            </button>
          </div>
        </td>
        <td className="px-2 py-1.5 text-right text-sm tabular-nums text-blue-600 dark:text-blue-400">
          {node.newCount}
        </td>
        <td className="px-2 py-1.5 text-right text-sm tabular-nums text-red-600 dark:text-red-400">
          {node.learnCount}
        </td>
        <td className="px-2 py-1.5 text-right text-sm tabular-nums text-green-600 dark:text-green-400">
          {node.reviewCount}
        </td>
        <td className="py-1.5 pl-2 text-right">
          <button
            type="button"
            onClick={() => onDelete(node.deckId, node.name)}
            aria-label={`Delete ${node.name}`}
            title={hasChildren ? 'Delete this deck and all its subdecks' : 'Delete this deck'}
            className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
          >
            Delete
          </button>
        </td>
      </tr>
      {hasChildren &&
        expanded &&
        node.children.map((child) => (
          <DeckRow
            key={child.deckId.toString()}
            node={child}
            depth={depth + 1}
            onStudy={onStudy}
            onDelete={onDelete}
          />
        ))}
    </>
  )
}

/**
 * Deck management screen, matching real Anki desktop's deck list
 * ("Stapelübersicht": Neu/Nochmal/Fällig per deck). Clicking a deck's name
 * selects it (`setCurrentDeck`, persisted) and hands off to the Study tab via
 * `onStudyDeck` with that specific deck's own due total — there's no local
 * "selected deck" concept here, the backend's own current-deck config is the
 * single source of truth.
 *
 * The "+" button opens a small menu for adding content: importing a .apkg
 * (delegates entirely to the existing `ImportView`, just mounted inside a
 * modal here) or creating a new deck from scratch (deliberately left
 * disabled — not implemented yet, per explicit product direction).
 */
export default function DecksView({
  onStudyDeck,
}: {
  onStudyDeck: (total: number) => void
}) {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [tree, setTree] = useState<DeckTreeNode | null>(null)
  const bootstrapped = useRef(false)

  const [menuOpen, setMenuOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const refresh = useCallback(async () => {
    const t = await getDeckTree()
    setTree(t)
    return t
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      try {
        await ensureCollectionReady()
        await refresh()
        setStatus('ready')
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      }
    })()
  }, [refresh])

  const handleStudy = useCallback(
    async (node: DeckTreeNode) => {
      try {
        await setCurrentDeck(node.deckId)
        await persistCollection()
        onStudyDeck(node.newCount + node.learnCount + node.reviewCount)
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      }
    },
    [onStudyDeck],
  )

  const handleDelete = useCallback(
    async (id: bigint, name: string) => {
      // Real Anki behaviour: deleting a deck cascades to all its subdecks and
      // every card/note in them — confirm before doing something this
      // destructive and irreversible (no undo across a page reload; OPFS
      // gets overwritten by the very next persistCollection()).
      const ok = window.confirm(
        `Delete "${name}"? This also deletes every subdeck and all cards/notes in them. This cannot be undone.`,
      )
      if (!ok) return

      try {
        await deleteDeck(id)
        await persistCollection()
        await refresh()
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      }
    },
    [refresh],
  )

  // Closing the modal after a successful import means re-fetching the tree
  // so the newly-imported deck shows up without waiting for a manual refresh.
  const closeImport = useCallback(() => {
    setImportOpen(false)
    refresh().catch((err) => {
      setErrorMsg(errorMessage(err))
      setStatus('error')
    })
  }, [refresh])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Decks</h2>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Add"
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-xl font-medium leading-none text-white shadow-md transition-colors hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
          >
            +
          </button>

          <AnimatePresence>
            {menuOpen && (
              <>
                {/* Click-outside catcher */}
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -6 }}
                  transition={{ duration: 0.12 }}
                  className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      setImportOpen(true)
                    }}
                    className="block w-full px-4 py-3 text-left text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  >
                    Import .apkg
                  </button>
                  <div className="border-t border-neutral-100 dark:border-neutral-800" />
                  <button
                    type="button"
                    disabled
                    title="Coming soon"
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-neutral-400 disabled:cursor-not-allowed dark:text-neutral-600"
                  >
                    Create new deck
                    <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
                      Soon
                    </span>
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {status === 'loading' && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {status === 'ready' && tree && tree.children.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No decks yet — use the "+" button above to import a .apkg.
        </p>
      )}

      {status === 'ready' && tree && tree.children.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 p-2 shadow-sm dark:border-neutral-800">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
                <th className="py-1.5 pr-2 text-left font-medium">Deck</th>
                <th className="px-2 py-1.5 text-right font-medium">New</th>
                <th className="px-2 py-1.5 text-right font-medium">Learn</th>
                <th className="px-2 py-1.5 text-right font-medium">Due</th>
                <th className="py-1.5 pl-2" />
              </tr>
            </thead>
            <tbody>
              {tree.children.map((node) => (
                <DeckRow
                  key={node.deckId.toString()}
                  node={node}
                  depth={0}
                  onStudy={handleStudy}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {importOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => closeImport()}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ type: 'spring', duration: 0.35, bounce: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold">Import .apkg</h3>
                <button
                  type="button"
                  onClick={() => closeImport()}
                  aria-label="Close"
                  className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  ✕
                </button>
              </div>
              <ImportView />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
