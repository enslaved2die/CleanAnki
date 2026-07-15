/**
 * Cycled by deck *identity* (not list position!) so each deck reads as
 * visually distinct at a glance — `bg-gradient-to-br` pairs picked to stay in
 * the same saturated, mid-dark range so white text/counts stay readable in
 * both light and dark mode without needing a separate dark-mode palette.
 * Shared between HomeView and DecksView so a given deck's card is the same
 * color in both places.
 */
const DECK_CARD_GRADIENTS = [
  'from-indigo-500 to-violet-600',
  'from-rose-500 to-orange-500',
  'from-teal-500 to-emerald-600',
  'from-amber-500 to-orange-600',
  'from-sky-500 to-indigo-600',
  'from-fuchsia-500 to-pink-600',
]

/**
 * Picks a deck's gradient from its own id, not its position in a rendered
 * list — a list gets reordered/re-nested depending on where it's shown
 * (Home features the last-studied deck first; Decks nests subdecks under
 * their parent), and a position-keyed color would make a deck's card change
 * color whenever that changes. Deck ids are stable for the deck's whole
 * lifetime, so `deckId % palette length` gives every deck one color it keeps
 * forever.
 */
export function gradientForDeck(deckId: bigint): string {
  const index = Number(
    ((deckId % BigInt(DECK_CARD_GRADIENTS.length)) + BigInt(DECK_CARD_GRADIENTS.length)) %
      BigInt(DECK_CARD_GRADIENTS.length),
  )
  return DECK_CARD_GRADIENTS[index]
}
