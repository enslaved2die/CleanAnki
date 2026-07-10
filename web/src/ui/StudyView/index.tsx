import { useCallback, useEffect, useReducer, useRef } from 'react'
import { motion, type PanInfo } from 'framer-motion'
import { studySessionTransition, initialStudySessionState } from '../../state/studySession'
import { getNextCard, answerCard } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'

/** Anki's 1..=4 ease convention, matching `Rating` in rust/wasm-bridge/src/main.rs. */
const EASE = { again: 1, hard: 2, good: 3, easy: 4 } as const

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function StudyView() {
  const [state, dispatch] = useReducer(studySessionTransition, initialStudySessionState)

  // Guards the bootstrap effect against running twice under React
  // StrictMode's dev-mode double-invoke — initBackend() is idempotent on its
  // own (see wasm/backend.ts), but re-fetching the starter fixture and
  // re-opening/re-persisting the collection would be wasteful and racy.
  //
  // Deliberately NOT using a `cancelled`-on-cleanup flag alongside this ref:
  // StrictMode's double-invoke fires the *first* mount's cleanup (setting
  // `cancelled = true`) before the async work below resolves, while the
  // *second* mount's effect exits immediately via the `bootstrapped` guard
  // and starts no work of its own. The two guards together would mean the
  // only run that ever does real work has its own dispatch permanently
  // swallowed by its own cleanup — the state gets stuck on `loading`
  // forever with no error. `bootstrapped` alone is sufficient: it already
  // guarantees this effect's body runs exactly once per real mount.
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    dispatch({ type: 'START' })
    ;(async () => {
      try {
        // Shared with the import/deck-picker UI (db/collection.ts) — safe
        // regardless of which view mounts first.
        await ensureCollectionReady()

        const card = await getNextCard()
        dispatch(card ? { type: 'CARD_LOADED', card } : { type: 'QUEUE_EMPTY' })
      } catch (err) {
        dispatch({ type: 'ERROR', message: errorMessage(err) })
      }
    })()
  }, [])

  const handleAnswer = useCallback(
    (ease: number) => {
      if (state.status !== 'reviewing') return
      dispatch({ type: 'ANSWER', ease })
      ;(async () => {
        try {
          await answerCard(ease)
          await persistCollection()
        } catch (err) {
          dispatch({ type: 'ERROR', message: errorMessage(err) })
        }
      })()
    },
    [state.status],
  )

  const handleNext = useCallback(() => {
    dispatch({ type: 'NEXT' })
    ;(async () => {
      try {
        const card = await getNextCard()
        dispatch(card ? { type: 'CARD_LOADED', card } : { type: 'QUEUE_EMPTY' })
      } catch (err) {
        dispatch({ type: 'ERROR', message: errorMessage(err) })
      }
    })()
  }, [])

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const swipeThreshold = 80
    if (info.offset.x > swipeThreshold) {
      handleAnswer(EASE.good)
    } else if (info.offset.x < -swipeThreshold) {
      handleAnswer(EASE.again)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center gap-8">
      <motion.div
        drag={state.status === 'reviewing' ? 'x' : false}
        dragConstraints={{ left: -100, right: 100 }}
        onDragEnd={handleDragEnd}
        className="w-full max-w-sm cursor-grab rounded-xl border-2 border-neutral-200 bg-white p-8 shadow-sm transition-shadow active:cursor-grabbing dark:border-neutral-700 dark:bg-neutral-900"
        whileDrag={{ scale: 1.02 }}
      >
        <div className="flex h-64 flex-col items-center justify-center gap-4">
          {state.status === 'loading' && (
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Loading collection…
            </p>
          )}

          {state.status === 'idle' && (
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              No cards due right now.
            </p>
          )}

          {state.status === 'reviewing' && (
            <div className="text-center">
              <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                Card id
              </p>
              <p className="mt-2 text-lg text-neutral-900 dark:text-neutral-100">
                {state.card.id}
              </p>
              <p className="mt-4 text-xs text-neutral-400 dark:text-neutral-500">
                Swipe right = Good, swipe left = Again, or use the buttons below
              </p>
            </div>
          )}

          {state.status === 'answered' && (
            <div className="text-center">
              <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                Answered card {state.card.id}
              </p>
              <p className="mt-2 text-lg text-neutral-900 dark:text-neutral-100">
                ease: {state.ease}
              </p>
            </div>
          )}

          {state.status === 'error' && (
            <div className="text-center">
              <p className="text-sm font-medium text-red-500">Error</p>
              <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
                {state.message}
              </p>
            </div>
          )}
        </div>
      </motion.div>

      {state.status === 'reviewing' && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleAnswer(EASE.again)}
            className="rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-200 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
          >
            Again
          </button>
          <button
            type="button"
            onClick={() => handleAnswer(EASE.hard)}
            className="rounded-lg bg-orange-100 px-4 py-2 text-sm font-medium text-orange-800 hover:bg-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:hover:bg-orange-900"
          >
            Hard
          </button>
          <button
            type="button"
            onClick={() => handleAnswer(EASE.good)}
            className="rounded-lg bg-green-100 px-4 py-2 text-sm font-medium text-green-800 hover:bg-green-200 dark:bg-green-950 dark:text-green-200 dark:hover:bg-green-900"
          >
            Good
          </button>
          <button
            type="button"
            onClick={() => handleAnswer(EASE.easy)}
            className="rounded-lg bg-blue-100 px-4 py-2 text-sm font-medium text-blue-800 hover:bg-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
          >
            Easy
          </button>
        </div>
      )}

      {state.status === 'answered' && (
        <button
          type="button"
          onClick={handleNext}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Next card
        </button>
      )}
    </div>
  )
}
