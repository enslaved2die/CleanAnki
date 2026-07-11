import { useState } from 'react'
import type { Deck } from '../../wasm/backend'

// rslib's storage has no tree structure at all — deck hierarchy is purely
// encoded in the name string via `::` separators (e.g.
// "Ankizin::M1_Vorklinik::Anatomie"). `listDecks()` returns the flat list of
// full names as-is; this module parses that back into a real tree client-side
// so the UI reads as a hierarchy instead of dumping every leaf deck as an
// unrelated-looking flat row (real Anki's desktop deck browser does the same
// client-side parsing — rslib itself never materializes a tree).

/** Exported for unit testing (tests/ui/DeckTree.test.ts) — the tree-building
 * logic is the part worth testing in isolation; the JSX below is a thin,
 * mostly-mechanical render of it. */
export interface DeckTreeNode {
  /** This segment's own name (not the full `::` path). */
  name: string
  /** Full `::`-joined path — doubles as a stable React key. */
  fullName: string
  /** The real deck at this exact path, if one exists. Anki normally
   * auto-creates every ancestor deck when a nested deck is created, so this
   * is usually non-null for every node, but it's handled defensively in case
   * an intermediate level is somehow missing (a purely virtual grouping
   * node with no cards of its own, e.g. "no cards directly in this group"). */
  deck: Deck | null
  children: DeckTreeNode[]
}

export function buildDeckTree(decks: Deck[]): DeckTreeNode[] {
  const roots: DeckTreeNode[] = []
  const nodesByPath = new Map<string, DeckTreeNode>()

  function getOrCreateNode(path: string[]): DeckTreeNode {
    const fullName = path.join('::')
    const existing = nodesByPath.get(fullName)
    if (existing) return existing

    const node: DeckTreeNode = { name: path[path.length - 1], fullName, deck: null, children: [] }
    nodesByPath.set(fullName, node)
    if (path.length === 1) {
      roots.push(node)
    } else {
      const parent = getOrCreateNode(path.slice(0, -1))
      parent.children.push(node)
    }
    return node
  }

  // Sort shallowest-first so parent nodes exist before children reference
  // them (getOrCreateNode also recurses upward on demand, so this isn't
  // strictly required, but keeps insertion order predictable).
  const sorted = [...decks].sort((a, b) => a.name.split('::').length - b.name.split('::').length)
  for (const deck of sorted) {
    const node = getOrCreateNode(deck.name.split('::'))
    node.deck = deck
  }

  const sortChildren = (nodes: DeckTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((n) => sortChildren(n.children))
  }
  sortChildren(roots)

  return roots
}

function DeckTreeItem({
  node,
  depth,
  selectedDeckId,
  onSelect,
  onDelete,
}: {
  node: DeckTreeNode
  depth: number
  selectedDeckId: bigint | null
  onSelect: (id: bigint) => void
  onDelete: (id: bigint, name: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const isSelected = node.deck !== null && selectedDeckId === node.deck.id
  const deck = node.deck

  return (
    <li>
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

        {deck ? (
          <button
            type="button"
            onClick={() => onSelect(deck.id)}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors ${
              isSelected
                ? 'border-neutral-900 bg-neutral-100 font-medium dark:border-neutral-100 dark:bg-neutral-800'
                : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900'
            }`}
          >
            {node.name}
            {isSelected && (
              <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                (studying this deck)
              </span>
            )}
          </button>
        ) : (
          <span className="flex-1 px-3 py-1.5 text-sm text-neutral-400 dark:text-neutral-500">
            {node.name}
          </span>
        )}

        {deck && (
          <button
            type="button"
            onClick={() => onDelete(deck.id, node.fullName)}
            aria-label={`Delete ${node.fullName}`}
            title={hasChildren ? 'Delete this deck and all its subdecks' : 'Delete this deck'}
            className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
          >
            Delete
          </button>
        )}
      </div>

      {hasChildren && expanded && (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <DeckTreeItem
              key={child.fullName}
              node={child}
              depth={depth + 1}
              selectedDeckId={selectedDeckId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function DeckTree({
  decks,
  selectedDeckId,
  onSelect,
  onDelete,
}: {
  decks: Deck[]
  selectedDeckId: bigint | null
  onSelect: (id: bigint) => void
  onDelete: (id: bigint, name: string) => void
}) {
  const roots = buildDeckTree(decks)
  return (
    <ul className="space-y-1">
      {roots.map((node) => (
        <DeckTreeItem
          key={node.fullName}
          node={node}
          depth={0}
          selectedDeckId={selectedDeckId}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}
