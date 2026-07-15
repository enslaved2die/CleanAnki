import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getDeckTree, setCurrentDeck, type DeckTreeNode } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import type { StudyQueueInfo } from '../../App'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
  const bootstrapped = useRef(false)

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
          {/* Narrow/touch viewports get a swipeable horizontal carousel (one
           * card mostly-visible at a time, snapping); from `sm` up there's
           * enough width that a horizontal scroller feels awkward, so it
           * switches to a static grid instead. */}
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0">
            {tree.children.map((node, index) => {
              const due = node.newCount + node.learnCount + node.reviewCount
              // The first deck in the list is rendered "featured" (bigger
              // padding/text), giving the stack the same slightly-expanded
              // top-card look as the reference screenshots. Simplest stable
              // choice: whatever rslib returns first, rather than re-sorting
              // by due count and shuffling card positions as counts change
              // during a study session.
              const featured = index === 0

              return (
                <button
                  key={node.deckId.toString()}
                  type="button"
                  onClick={() => handleStudy(node)}
                  disabled={due === 0}
                  className={`min-w-[80%] shrink-0 snap-center rounded-2xl bg-indigo-600 text-left text-white shadow-md transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-indigo-500 dark:hover:bg-indigo-400 sm:min-w-0 sm:shrink ${
                    featured ? 'p-7' : 'p-5'
                  }`}
                >
                  <p
                    className={`truncate font-semibold ${featured ? 'text-xl' : 'text-base'}`}
                  >
                    {node.name}
                  </p>
                  <p
                    className={`mt-2 font-bold tabular-nums text-indigo-100 dark:text-indigo-950/80 ${
                      featured ? 'text-4xl' : 'text-2xl'
                    }`}
                  >
                    {due}
                  </p>
                  <p className="mt-1 text-sm text-indigo-100 dark:text-indigo-950/80">
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
