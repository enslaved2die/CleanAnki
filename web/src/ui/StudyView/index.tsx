import { useCallback, useEffect, useReducer, useRef } from 'react'
import { motion, type PanInfo } from 'framer-motion'
import { studySessionTransition, initialStudySessionState } from '../../state/studySession'
import { getNextCard, getCurrentCardContent, answerCard } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import CardFrame from './CardFrame'

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
  const bootstrapped = useRef(false)

  // Fetches the next due card's id, then its rendered content — the same
  // two-step sequence is needed both on first mount and after answering, so
  // it's factored out rather than duplicated.
  const fetchCardAndContent = useCallback(async () => {
    const card = await getNextCard()
    if (!card) {
      dispatch({ type: 'QUEUE_EMPTY' })
      return
    }
    dispatch({ type: 'CARD_LOADED', card })
    const content = await getCurrentCardContent()
    dispatch({ type: 'CONTENT_LOADED', content })
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    dispatch({ type: 'START' })
    ;(async () => {
      try {
        // Shared with the import/deck-picker UI (db/collection.ts) — safe
        // regardless of which view mounts first.
        await ensureCollectionReady()
        await fetchCardAndContent()
      } catch (err) {
        dispatch({ type: 'ERROR', message: errorMessage(err) })
      }
    })()
  }, [fetchCardAndContent])

  const handleReveal = useCallback(() => {
    dispatch({ type: 'REVEAL' })
  }, [])

  const handleAnswer = useCallback(
    (ease: number) => {
      if (state.status !== 'reviewing' || !state.revealed) return
      dispatch({ type: 'ANSWER', ease })
      ;(async () => {
        try {
          await answerCard(ease)
          await persistCollection()
          dispatch({ type: 'NEXT' })
          await fetchCardAndContent()
        } catch (err) {
          dispatch({ type: 'ERROR', message: errorMessage(err) })
        }
      })()
    },
    [state, fetchCardAndContent],
  )

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const swipeThreshold = 80
    if (info.offset.x > swipeThreshold) {
      handleAnswer(EASE.good)
    } else if (info.offset.x < -swipeThreshold) {
      handleAnswer(EASE.again)
    }
  }

  const canDrag = state.status === 'reviewing' && state.revealed

  return (
    <div className="flex flex-col items-center gap-6">
      <motion.div
        drag={canDrag ? 'x' : false}
        dragConstraints={{ left: -100, right: 100 }}
        onDragEnd={handleDragEnd}
        className="w-full max-w-lg cursor-grab rounded-xl border-2 border-neutral-200 bg-white shadow-sm transition-shadow active:cursor-grabbing dark:border-neutral-700 dark:bg-neutral-900"
        whileDrag={{ scale: 1.02 }}
      >
        <div className="flex min-h-48 flex-col items-center justify-center p-4">
          {state.status === 'loading' && (
            <p className="py-16 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Loading collection…
            </p>
          )}

          {state.status === 'idle' && (
            <p className="py-16 text-sm font-medium text-neutral-500 dark:text-neutral-400">
              No cards due right now.
            </p>
          )}

          {state.status === 'reviewing' &&
            (state.content ? (
              <CardFrame
                html={state.revealed ? state.content.answer : state.content.question}
                css={state.content.css}
              />
            ) : (
              <p className="py-16 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                Rendering card…
              </p>
            ))}

          {state.status === 'answered' && (
            <CardFrame html={state.content.answer} css={state.content.css} />
          )}

          {state.status === 'error' && (
            <div className="py-8 text-center">
              <p className="text-sm font-medium text-red-500">Error</p>
              <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
                {state.message}
              </p>
            </div>
          )}
        </div>
      </motion.div>

      {state.status === 'reviewing' && state.content && !state.revealed && (
        <button
          type="button"
          onClick={handleReveal}
          className="rounded-lg bg-neutral-900 px-6 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Show Answer
        </button>
      )}

      {state.status === 'reviewing' && state.revealed && (
        <>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            Swipe right = Good, swipe left = Again, or use the buttons below
          </p>
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
        </>
      )}
    </div>
  )
}
