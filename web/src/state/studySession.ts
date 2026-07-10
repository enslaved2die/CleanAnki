// Explicit state machine driving the Study View.
//
// No real card data flows through this yet — `BackendCard` is an opaque
// placeholder from src/wasm/backend.ts until rust/wasm-bridge/ defines a real
// shape for what `get_next_card()` returns. This module only defines the
// *shape* of the session lifecycle so the (not-yet-built) Study View has a
// well-defined state/transition contract to render against and dispatch into.

import type { BackendCard } from '../wasm/backend'

export type StudySessionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'reviewing'; card: BackendCard }
  | { status: 'answered'; card: BackendCard; ease: number }
  | { status: 'error'; message: string }

export type StudySessionEvent =
  /** User starts (or resumes) a study session; begins fetching the first card. */
  | { type: 'START' }
  /** Backend returned a card to review. */
  | { type: 'CARD_LOADED'; card: BackendCard }
  /** Backend reported it has no more cards due right now. */
  | { type: 'QUEUE_EMPTY' }
  /** User graded the card currently being reviewed. */
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
 * `ANSWER` while `idle`) are ignored and return `state` unchanged rather than
 * throwing, so callers can dispatch freely from UI event handlers.
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
      return { status: 'reviewing', card: event.card }

    case 'QUEUE_EMPTY':
      if (state.status !== 'loading') return state
      return { status: 'idle' }

    case 'ANSWER':
      if (state.status !== 'reviewing') return state
      return { status: 'answered', card: state.card, ease: event.ease }

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
