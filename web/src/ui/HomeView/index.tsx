import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getDeckTree, type DeckTreeNode } from '../../wasm/backend'
import { ensureCollectionReady } from '../../db/collection'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Light dashboard/landing screen. Deck management (the full expand/collapse
 * table, delete, import) moved to the Decks tab (see `ui/DecksView`) — this
 * view only surfaces the day's aggregate due count and a "keep going" studying
 * shortcut, matching a typical mobile app's home tab rather than a management
 * table.
 *
 * The root `tree` node returned by `getDeckTree` is rslib's own synthetic
 * root — its `newCount`/`learnCount`/`reviewCount` already aggregate across
 * the whole collection (every deck's already-limited counts summed), so no
 * extra math is needed here; `tree.children` are the real top-level decks.
 */
export default function HomeView({ onStudyDeck }: { onStudyDeck: (total: number) => void }) {
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

  const total = tree ? tree.newCount + tree.learnCount + tree.reviewCount : 0

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
        <>
          <section className="rounded-2xl bg-indigo-600 p-6 text-white shadow-md dark:bg-indigo-500">
            <p className="text-sm font-medium text-indigo-100 dark:text-indigo-950/80">
              Due today
            </p>
            <p className="mt-1 text-5xl font-bold tabular-nums">{total}</p>
            <button
              type="button"
              onClick={() => onStudyDeck(total)}
              disabled={total === 0}
              className="mt-5 w-full rounded-2xl bg-white px-4 py-3 text-base font-semibold text-indigo-700 shadow transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-950 dark:text-indigo-300 dark:hover:bg-neutral-900"
            >
              {total > 0 ? 'Continue studying' : 'All caught up'}
            </button>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Your decks
            </h2>
            <ul className="divide-y divide-neutral-100 rounded-2xl border border-neutral-200 shadow-sm dark:divide-neutral-800 dark:border-neutral-800">
              {tree.children.map((node) => {
                const due = node.newCount + node.learnCount + node.reviewCount
                return (
                  <li
                    key={node.deckId.toString()}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <span className="truncate text-sm font-medium">{node.name}</span>
                    <span className="ml-3 shrink-0 text-sm tabular-nums text-indigo-600 dark:text-indigo-400">
                      {due}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </motion.div>
  )
}
