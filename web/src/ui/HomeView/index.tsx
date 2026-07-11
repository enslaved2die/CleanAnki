import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getDeckTree, setCurrentDeck, deleteDeck, type DeckTreeNode } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One deck row (recursing into its children). Uses the real nested tree +
 * due counts from `wasm_get_deck_tree` (rslib's own `Collection::deck_tree`)
 * rather than re-deriving a hierarchy from flat `::`-joined names — unlike
 * the deck picker this replaced (see ImportView/DeckTree.tsx, now deleted),
 * rslib already builds the tree and computes New/Learn/Due for us, matching
 * the counts real Anki's own deck-overview screen shows.
 */
function DeckRow({
  node,
  depth,
  onStudy,
  onDelete,
}: {
  node: DeckTreeNode
  depth: number
  onStudy: (id: bigint) => void
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
              onClick={() => onStudy(node.deckId)}
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
 * Deck overview / home screen, matching real Anki desktop's deck list
 * ("Stapelübersicht": Neu/Nochmal/Fällig per deck). Clicking a deck's name
 * selects it (`setCurrentDeck`, persisted) and hands off to the Study tab via
 * `onStudyDeck` — there's no local "selected deck" concept here, the backend's
 * own current-deck config is the single source of truth (same design as the
 * deck picker this replaced).
 */
export default function HomeView({ onStudyDeck }: { onStudyDeck: () => void }) {
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
    async (id: bigint) => {
      try {
        await setCurrentDeck(id)
        await persistCollection()
        onStudyDeck()
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl space-y-4"
    >
      <h2 className="text-lg font-semibold">Decks</h2>

      {status === 'loading' && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {status === 'ready' && tree && tree.children.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No decks yet — import a .apkg from the Import tab.
        </p>
      )}

      {status === 'ready' && tree && tree.children.length > 0 && (
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
      )}
    </motion.div>
  )
}
