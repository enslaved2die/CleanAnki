import { describe, it, expect } from 'vitest'
import { buildDeckTree } from '../../src/ui/ImportView/DeckTree'
import type { Deck } from '../../src/wasm/backend'

// Real deck data confirmed via `wasm_list_decks` against a real generated
// nested-deck fixture (rust/tools/make-test-collection --with-nested-decks),
// shaped like the real-world case that prompted this (an imported deck whose
// `::`-nested names were rendering as an unrelated-looking flat list) — see
// docs/ARCHITECTURE.md §11.
const realDecks: Deck[] = [
  { id: 1783721854341n, name: 'Ankizin' },
  { id: 1783721854340n, name: 'Ankizin::M1_Vorklinik' },
  { id: 1783721854342n, name: 'Ankizin::M1_Vorklinik::Anatomie' },
  { id: 1783721854343n, name: 'Ankizin::M1_Vorklinik::Physiologie' },
  { id: 1783721854344n, name: 'Ankizin::M2_Klinik' },
  { id: 1n, name: 'Default' },
]

describe('buildDeckTree', () => {
  it('groups a real nested-deck list into a hierarchy instead of a flat list', () => {
    const roots = buildDeckTree(realDecks)

    // Two top-level roots: "Ankizin" and "Default" — sorted alphabetically.
    expect(roots.map((r) => r.name)).toEqual(['Ankizin', 'Default'])

    const ankizin = roots.find((r) => r.name === 'Ankizin')!
    expect(ankizin.fullName).toBe('Ankizin')
    expect(ankizin.deck?.id).toBe(1783721854341n)

    // "Ankizin" has one child: "M1_Vorklinik" (M2_Klinik is also a child —
    // sorted alphabetically, M1 before M2).
    expect(ankizin.children.map((c) => c.name)).toEqual(['M1_Vorklinik', 'M2_Klinik'])

    const m1 = ankizin.children.find((c) => c.name === 'M1_Vorklinik')!
    expect(m1.fullName).toBe('Ankizin::M1_Vorklinik')
    expect(m1.deck?.id).toBe(1783721854340n)
    expect(m1.children.map((c) => c.name)).toEqual(['Anatomie', 'Physiologie'])

    const anatomie = m1.children.find((c) => c.name === 'Anatomie')!
    expect(anatomie.fullName).toBe('Ankizin::M1_Vorklinik::Anatomie')
    expect(anatomie.deck?.id).toBe(1783721854342n)
    expect(anatomie.children).toEqual([])

    const m2 = ankizin.children.find((c) => c.name === 'M2_Klinik')!
    expect(m2.fullName).toBe('Ankizin::M2_Klinik')
    expect(m2.deck?.id).toBe(1783721854344n)
    expect(m2.children).toEqual([])

    const defaultDeck = roots.find((r) => r.name === 'Default')!
    expect(defaultDeck.children).toEqual([])
    expect(defaultDeck.deck?.id).toBe(1n)
  })

  it('synthesizes a virtual (deck: null) node for a missing intermediate level', () => {
    // Defensive case: a deck exists two levels deep with no real deck at the
    // first level (shouldn't normally happen — rslib auto-creates parents —
    // but the UI must not crash if it ever does).
    const decks: Deck[] = [{ id: 42n, name: 'A::B' }]
    const roots = buildDeckTree(decks)

    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('A')
    expect(roots[0].deck).toBeNull()
    expect(roots[0].children).toHaveLength(1)
    expect(roots[0].children[0].name).toBe('B')
    expect(roots[0].children[0].deck?.id).toBe(42n)
  })

  it('returns an empty tree for no decks', () => {
    expect(buildDeckTree([])).toEqual([])
  })

  it('handles a flat (non-nested) deck list as a flat tree', () => {
    const decks: Deck[] = [
      { id: 1n, name: 'Default' },
      { id: 2n, name: 'Spanisch 5000' },
    ]
    const roots = buildDeckTree(decks)
    expect(roots.map((r) => r.name)).toEqual(['Default', 'Spanisch 5000'])
    expect(roots.every((r) => r.children.length === 0)).toBe(true)
  })
})
