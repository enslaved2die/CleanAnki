import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  getDeckTree,
  setCurrentDeck,
  getCurrentDeckId,
  type DeckTreeNode,
} from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import type { StudyQueueInfo } from '../../App'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True if `id` is `node` itself or anywhere in its subdeck subtree — used to
 * find which *top-level* deck card should be featured when the real current
 * deck (see `getCurrentDeckId`) turns out to be a nested subdeck rather than
 * a top-level one. */
function subtreeContains(node: DeckTreeNode, id: bigint): boolean {
  if (node.deckId === id) return true
  return node.children.some((child) => subtreeContains(child, id))
}

/**
 * Reorders top-level decks so whichever one contains the real "current deck"
 * (rslib's own concept — see `getCurrentDeckId`'s doc comment) comes first,
 * i.e. gets featured. Falls back to leaving the order alone (today's first
 * deck stays featured) if the current deck doesn't match anything here — a
 * freshly-deleted deck, or a `currentDeckId` we haven't fetched yet.
 */
function withCurrentDeckFirst(
  decks: DeckTreeNode[],
  currentDeckId: bigint | null,
): DeckTreeNode[] {
  if (currentDeckId === null) return decks
  const index = decks.findIndex((node) => subtreeContains(node, currentDeckId))
  if (index <= 0) return decks
  const reordered = decks.slice()
  const [current] = reordered.splice(index, 1)
  reordered.unshift(current)
  return reordered
}

/** Cycled by deck position so cards read as distinct decks at a glance
 * instead of a wall of identical indigo — `bg-gradient-to-br` pairs picked to
 * stay in the same saturated, mid-dark range as the original indigo card so
 * white text/counts stay readable in both light and dark mode without needing
 * a separate dark-mode palette. */
const DECK_CARD_GRADIENTS = [
  'from-indigo-500 to-violet-600',
  'from-rose-500 to-orange-500',
  'from-teal-500 to-emerald-600',
  'from-amber-500 to-orange-600',
  'from-sky-500 to-indigo-600',
  'from-fuchsia-500 to-pink-600',
]

/**
 * Light dashboard/landing screen. Deck management (the full expand/collapse
 * table, delete, import) moved to the Decks tab (see `ui/DecksView`) — this
 * view surfaces each top-level deck as its own full-card tap target (no
 * separate "continue studying" button — tapping a card *is* the action),
 * matching a Duolingo-style stack of deck cards rather than one aggregate
 * hero card over a plain list.
 *
 * The root `tree` node returned by `getDeckTree` is rslib's own synthetic
 * root; `tree.children` are the real top-level decks we render cards for.
 */
export default function HomeView({
  onStudyDeck,
}: {
  onStudyDeck: (queue: StudyQueueInfo) => void
}) {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [tree, setTree] = useState<DeckTreeNode | null>(null)
  const [currentDeckId, setCurrentDeckId] = useState<bigint | null>(null)
  const bootstrapped = useRef(false)

  const refresh = useCallback(async () => {
    const [t, curId] = await Promise.all([getDeckTree(), getCurrentDeckId()])
    setTree(t)
    setCurrentDeckId(curId)
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
      const due = node.newCount + node.learnCount + node.reviewCount
      if (due === 0) return
      try {
        await setCurrentDeck(node.deckId)
        await persistCollection()
        onStudyDeck({
          total: due,
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl space-y-6"
    >
      {status === 'loading' && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {status === 'ready' && tree && tree.children.length === 0 && (
        <div className="rounded-2xl border border-neutral-200 p-6 text-center shadow-sm dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            No decks yet
          </p>
          <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
            Head to the Decks tab and use the "+" button to import a .apkg file.
          </p>
        </div>
      )}

      {status === 'ready' && tree && tree.children.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
            Your decks
          </h2>
          {/* A single column (full-width, stacked vertically) on narrow
           * viewports — a horizontal scroller reads awkwardly here — that
           * opens up into a 2-column grid once there's actually enough width
           * for it (`sm` up) rather than staying single-column forever. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {withCurrentDeckFirst(tree.children, currentDeckId).map((node, index) => {
              const due = node.newCount + node.learnCount + node.reviewCount
              // The deck containing the real "current deck" (whichever one
              // was last selected via `setCurrentDeck` — see
              // `getCurrentDeckId`) is featured: sorted first, bigger
              // padding/text, spans both grid columns.
              const featured = index === 0
              const gradient = DECK_CARD_GRADIENTS[index % DECK_CARD_GRADIENTS.length]

              return (
                <button
                  key={node.deckId.toString()}
                  type="button"
                  onClick={() => handleStudy(node)}
                  disabled={due === 0}
                  className={`bg-gradient-to-br ${gradient} rounded-2xl text-left text-white shadow-md transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:brightness-100 ${
                    featured ? 'p-7 sm:col-span-2' : 'p-5'
                  }`}
                >
                  <p
                    className={`truncate font-semibold ${featured ? 'text-xl' : 'text-base'}`}
                  >
                    {node.name}
                  </p>
                  <p
                    className={`mt-2 font-bold tabular-nums text-white/90 ${
                      featured ? 'text-4xl' : 'text-2xl'
                    }`}
                  >
                    {due}
                  </p>
                  <p className="mt-1 text-sm text-white/80">
                    {due > 0 ? 'Due — tap to study' : 'All done'}
                  </p>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </motion.div>
  )
}
