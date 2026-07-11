// Explicit state machine driving the Study View.
//
// Models the real Anki review flow: a card loads, its rendered content loads
// (a separate async round trip — `getNextCard()` only returns an id,
// `getCurrentCardContent()` renders whatever's currently loaded), the
// question is shown alone, the user reveals the answer, *then* grades it.
// Grading before the answer is revealed doesn't make sense in real Anki and
// isn't a valid transition here either (see the `ANSWER` guard below).

import type { BackendCard, CardContent } from '../wasm/backend'

export type StudySessionState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `content` is `null` until `CONTENT_LOADED` arrives (a separate fetch
   * from the card id itself); `revealed` becomes true once the user asks to
   * see the answer. */
  | { status: 'reviewing'; card: BackendCard; content: CardContent | null; revealed: boolean }
  | { status: 'answered'; card: BackendCard; content: CardContent; ease: number }
  | { status: 'error'; message: string }

export type StudySessionEvent =
  /** User starts (or resumes) a study session; begins fetching the first card. */
  | { type: 'START' }
  /** Backend returned a card to review. */
  | { type: 'CARD_LOADED'; card: BackendCard }
  /** Backend reported it has no more cards due right now. */
  | { type: 'QUEUE_EMPTY' }
  /** The current card's rendered question/answer HTML arrived. */
  | { type: 'CONTENT_LOADED'; content: CardContent }
  /** User asked to see the answer side. */
  | { type: 'REVEAL' }
  /** User graded the card currently being reviewed (only valid once revealed). */
  | { type: 'ANSWER'; ease: number }
  /** Move on from the just-answered card and fetch the next one. */
  | { type: 'NEXT' }
  /** Any failure — loading the backend, opening the collection, answering, etc. */
  | { type: 'ERROR'; message: string }
  /** Return to the initial, un-started state (e.g. leaving the Study View). */
  | { type: 'RESET' }

export const initialStudySessionState: StudySessionState = { status: 'idle' }

/**
 * Pure transition function: given the current state and an event, returns
 * the next state. Events that don't make sense for the current state (e.g.
 * `ANSWER` while `idle`, or before the answer has been revealed) are ignored
 * and return `state` unchanged rather than throwing, so callers can dispatch
 * freely from UI event handlers.
 */
export function studySessionTransition(
  state: StudySessionState,
  event: StudySessionEvent,
): StudySessionState {
  switch (event.type) {
    case 'START':
      if (state.status !== 'idle' && state.status !== 'error') return state
      return { status: 'loading' }

    case 'CARD_LOADED':
      if (state.status !== 'loading') return state
      return { status: 'reviewing', card: event.card, content: null, revealed: false }

    case 'QUEUE_EMPTY':
      if (state.status !== 'loading') return state
      return { status: 'idle' }

    case 'CONTENT_LOADED':
      if (state.status !== 'reviewing') return state
      return { ...state, content: event.content }

    case 'REVEAL':
      if (state.status !== 'reviewing' || state.content === null) return state
      return { ...state, revealed: true }

    case 'ANSWER':
      if (state.status !== 'reviewing' || !state.revealed || state.content === null) return state
      return { status: 'answered', card: state.card, content: state.content, ease: event.ease }

    case 'NEXT':
      if (state.status !== 'answered') return state
      return { status: 'loading' }

    case 'ERROR':
      return { status: 'error', message: event.message }

    case 'RESET':
      return { status: 'idle' }

    default:
      return state
  }
}
