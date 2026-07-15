import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  getDeckTree,
  setCurrentDeck,
  deleteDeck,
  createDeck,
  type DeckTreeNode,
} from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import ImportView from '../ImportView'
import type { StudyQueueInfo } from '../../App'
import { gradientForDeck } from '../deckGradients'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 7h16" />
      <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

/** One New/Learn/Due figure within a deck card. Keeps the same blue/red/green
 * semantic coloring the old table used (real Anki's own convention) — full
 * saturation now that this sits in the card's plain white/dark footer rather
 * than on the gradient itself, where the same colors read as washed out. */
function DeckStat({
  label,
  value,
  colorClass,
  compact,
}: {
  label: string
  value: number
  colorClass: string
  compact: boolean
}) {
  return (
    <div>
      <p className={`font-bold tabular-nums ${colorClass} ${compact ? 'text-base' : 'text-lg'}`}>
        {value}
      </p>
      <p
        className={`uppercase tracking-wide text-neutral-400 dark:text-neutral-500 ${compact ? 'text-[10px]' : 'text-[11px]'}`}
      >
        {label}
      </p>
    </div>
  )
}

/**
 * One deck card (recursing into its children). Uses the real nested tree +
 * due counts from `wasm_get_deck_tree` (rslib's own `Collection::deck_tree`)
 * rather than re-deriving a hierarchy from flat `::`-joined names — rslib
 * already builds the tree and computes New/Learn/Due for us, matching the
 * counts real Anki's own deck-overview screen shows.
 *
 * Styled like HomeView's deck cards (same gradient palette) rather than a
 * plain table row, just bigger and with the New/Learn/Due breakdown inline
 * instead of one aggregate number. All actions (expand/collapse, delete) are
 * icon-only, matching the rest of the app's nav/back-button convention.
 *
 * `gradient` is passed down from the top-level ancestor rather than looked
 * up per-node — a whole deck tree shares its root's color so subdecks read as
 * part of the same deck, distinguished by size/indent instead.
 */
function DeckCard({
  node,
  depth,
  gradient,
  onStudy,
  onDelete,
}: {
  node: DeckTreeNode
  depth: number
  gradient: string
  onStudy: (node: DeckTreeNode) => void
  onDelete: (id: bigint, name: string) => void
}) {
  // Subdecks start collapsed — with any real depth this is a lot of full-size
  // gradient cards to scroll past just to see the top-level decks.
  const [expanded, setExpanded] = useState(false)
  const hasChildren = node.children.length > 0
  // Subdecks render smaller than their top-level parent so the hierarchy
  // reads at a glance without needing a second color.
  const compact = depth > 0

  return (
    <div style={{ marginLeft: `${depth * 1.25}rem` }}>
      {/* `overflow-hidden` on this wrapper is what clips the gradient header
          and the plain stats footer below into one rounded card shape,
          rather than each needing its own rounded corners. */}
      <div className="overflow-hidden rounded-2xl shadow-md">
        {/* Gradient band: just the name + delete action. Kept separate from
            the stats footer below so the New/Learn/Due colors (blue/red/
            green) sit on a plain white/dark background instead of the
            saturated gradient, where they'd wash out and be hard to read. */}
        <div className={`bg-gradient-to-br ${gradient} text-white ${compact ? 'p-3' : 'p-4'}`}>
          <div className="flex items-start gap-1">
            <button
              type="button"
              onClick={() => onStudy(node)}
              className={`flex-1 truncate text-left font-semibold ${compact ? 'text-sm' : 'text-base'}`}
              title="Study this deck"
            >
              {node.name}
            </button>
            <button
              type="button"
              onClick={() => onDelete(node.deckId, node.name)}
              aria-label={`Delete ${node.name}`}
              title={hasChildren ? 'Delete this deck and all its subdecks' : 'Delete this deck'}
              className={`flex shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white ${compact ? 'h-6 w-6' : 'h-7 w-7'}`}
            >
              <TrashIcon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
            </button>
          </div>
        </div>

        <div
          className={`bg-white dark:bg-neutral-900 ${compact ? 'p-3 pt-2.5' : 'p-4 pt-3'}`}
        >
          <div className="flex gap-5">
            <DeckStat
              label="New"
              value={node.newCount}
              colorClass="text-blue-600 dark:text-blue-400"
              compact={compact}
            />
            <DeckStat
              label="Learn"
              value={node.learnCount}
              colorClass="text-red-600 dark:text-red-400"
              compact={compact}
            />
            <DeckStat
              label="Due"
              value={node.reviewCount}
              colorClass="text-green-600 dark:text-green-400"
              compact={compact}
            />
          </div>

          {/* Expand/collapse toggle for subdecks lives at the bottom of the
              card, not beside the name, so the name itself stays flush left. */}
          {hasChildren && (
            <div className="mt-2 flex justify-start">
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-label={expanded ? 'Collapse subdecks' : 'Expand subdecks'}
                title={expanded ? 'Collapse subdecks' : 'Expand subdecks'}
                className="flex h-6 w-12 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <ChevronDownIcon
                  className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
              </button>
            </div>
          )}
        </div>
      </div>

      {hasChildren && expanded && (
        <div className="mt-3 space-y-3">
          {node.children.map((child) => (
            <DeckCard
              key={child.deckId.toString()}
              node={child}
              depth={depth + 1}
              gradient={gradient}
              onStudy={onStudy}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
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
 * modal here) or creating a new, empty deck by name (a thin inline form
 * calling `createDeck`, matching real Anki desktop's own "Create Deck"
 * dialog — just a name, no notes/cards).
 */
export default function DecksView({
  onStudyDeck,
}: {
  onStudyDeck: (queue: StudyQueueInfo) => void
}) {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [tree, setTree] = useState<DeckTreeNode | null>(null)
  const bootstrapped = useRef(false)

  const [menuOpen, setMenuOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newDeckName, setNewDeckName] = useState('')
  const [creating, setCreating] = useState(false)

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
        onStudyDeck({
          total: node.newCount + node.learnCount + node.reviewCount,
          newCount: node.newCount,
          learnCount: node.learnCount,
          reviewCount: node.reviewCount,
        })
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

  const closeCreate = useCallback(() => {
    setCreateOpen(false)
    setNewDeckName('')
  }, [])

  const handleCreateDeck = useCallback(
    async () => {
      const name = newDeckName.trim()
      if (!name) return

      setCreating(true)
      try {
        await createDeck(name)
        await persistCollection()
        await refresh()
        closeCreate()
      } catch (err) {
        setErrorMsg(errorMessage(err))
        setStatus('error')
      } finally {
        setCreating(false)
      }
    },
    [newDeckName, refresh, closeCreate],
  )

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
                    onClick={() => {
                      setMenuOpen(false)
                      setCreateOpen(true)
                    }}
                    className="block w-full px-4 py-3 text-left text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  >
                    Create new deck
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
        <div className="space-y-3">
          {tree.children.map((node) => (
            <DeckCard
              key={node.deckId.toString()}
              node={node}
              depth={0}
              gradient={gradientForDeck(node.deckId)}
              onStudy={handleStudy}
              onDelete={handleDelete}
            />
          ))}
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

      <AnimatePresence>
        {createOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => closeCreate()}
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
                <h3 className="text-base font-semibold">Create new deck</h3>
                <button
                  type="button"
                  onClick={() => closeCreate()}
                  aria-label="Close"
                  className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  ✕
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  handleCreateDeck()
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Deck name
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={newDeckName}
                    onChange={(e) => setNewDeckName(e.target.value)}
                    placeholder="e.g. Spanish::Verbs"
                    disabled={creating}
                    className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-indigo-900"
                  />
                  <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Use "::" to nest under a parent deck, e.g. "Spanish::Verbs".
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => closeCreate()}
                    disabled={creating}
                    className="flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || newDeckName.trim().length === 0}
                    className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
                  >
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
