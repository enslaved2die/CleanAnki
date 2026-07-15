import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
  type Variants,
} from 'framer-motion'
import { studySessionTransition, initialStudySessionState } from '../../state/studySession'
import { getNextCard, getCurrentCardContent, answerCard } from '../../wasm/backend'
import { ensureCollectionReady, persistCollection } from '../../db/collection'
import { resolveMediaInHtml } from './media'
import CardFrame from './CardFrame'

/** Anki's 1..=4 ease convention, matching `Rating` in rust/wasm-bridge/src/main.rs. */
const EASE = { again: 1, hard: 2, good: 3, easy: 4 } as const

/** Direction the top card flings off when it leaves the stack. Swiping picks
 * left/right; grading via a button uses the neutral "up" slide. */
type ExitDirection = 'left' | 'right' | 'up'

/** Past this horizontal drag distance (px) a release commits the answer. */
const SWIPE_THRESHOLD = 80

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fraction of the session's daily target completed so far, clamped to 100%.
 * Returns null when we don't have a real target to divide by, so the caller
 * can render a neutral/indeterminate bar instead of fabricating a percentage.
 */
function studyProgressPercent(answered: number, total: number | undefined): number | null {
  if (typeof total !== 'number' || total <= 0) return null
  return Math.min(100, (answered / total) * 100)
}

const cardVariants: Variants = {
  // A new top card rises into place from just behind the stack.
  enter: { opacity: 0, scale: 0.92, y: 16 },
  center: {
    opacity: 1,
    scale: 1,
    x: 0,
    y: 0,
    rotate: 0,
    transition: { type: 'spring', stiffness: 320, damping: 30 },
  },
  // Flings the answered card away — sideways for a swipe, upward for a button.
  exit: (dir: ExitDirection) => ({
    x: dir === 'left' ? -480 : dir === 'right' ? 480 : 0,
    y: dir === 'up' ? -480 : 0,
    rotate: dir === 'left' ? -14 : dir === 'right' ? 14 : 0,
    opacity: 0,
    transition: { duration: 0.32, ease: 'easeIn' },
  }),
}

export default function StudyView({ initialQueueTotal }: { initialQueueTotal?: number }) {
  const [state, dispatch] = useReducer(studySessionTransition, initialStudySessionState)

  // Guards the bootstrap effect against running twice under React
  // StrictMode's dev-mode double-invoke — initBackend() is idempotent on its
  // own (see wasm/backend.ts), but re-fetching the starter fixture and
  // re-opening/re-persisting the collection would be wasteful and racy.
  const bootstrapped = useRef(false)

  // Cards graded this session. Drives both the progress bar and the card
  // stack's `key` (each answer bumps it, which is what tells AnimatePresence
  // the top card left and a fresh one arrived). Session-local — a reload
  // legitimately starts the count over.
  const [answeredCount, setAnsweredCount] = useState(0)

  // Which way the just-answered card should fly out. Held in React state (not
  // a ref) so AnimatePresence re-renders with the fresh value and hands it to
  // the exit variant via its `custom` prop.
  const [exitDir, setExitDir] = useState<ExitDirection>('up')

  // Live horizontal drag offset, feeding the GOOD/AGAIN feedback labels. Kept
  // separate from the card's own (framer-managed) drag transform so animating
  // the card's exit never fights a motion value we own.
  const dragX = useMotionValue(0)
  const goodOpacity = useTransform(dragX, [0, 60, 140], [0, 0.55, 1])
  const goodScale = useTransform(dragX, [0, 140], [0.7, 1])
  const againOpacity = useTransform(dragX, [-140, -60, 0], [1, 0.55, 0])
  const againScale = useTransform(dragX, [-140, 0], [1, 0.7])

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
    // Resolve media references (audio/images) into inline data: URLs before
    // handing the HTML to CardFrame — see media.ts. data: URLs need no
    // cleanup, so there's no per-card blob-URL lifecycle to manage here.
    const [question, answer] = await Promise.all([
      resolveMediaInHtml(content.question),
      resolveMediaInHtml(content.answer),
    ])
    dispatch({ type: 'CONTENT_LOADED', content: { ...content, question, answer } })
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
    (ease: number, dir: ExitDirection = 'up') => {
      if (state.status !== 'reviewing' || !state.revealed) return
      // Order matters: set the fling direction and bump the stack key in the
      // same render so AnimatePresence exits the card the right way, then hand
      // the grade to the real Anki scheduler.
      setExitDir(dir)
      setAnsweredCount((c) => c + 1)
      dragX.set(0)
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
    [state, fetchCardAndContent, dragX],
  )

  const handleDrag = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    dragX.set(info.offset.x)
  }

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.x > SWIPE_THRESHOLD) {
      handleAnswer(EASE.good, 'right')
    } else if (info.offset.x < -SWIPE_THRESHOLD) {
      handleAnswer(EASE.again, 'left')
    } else {
      // Not far enough — the card snaps home (dragSnapToOrigin); glide the
      // feedback labels back to neutral alongside it.
      animate(dragX, 0, { duration: 0.2 })
    }
  }

  const canDrag = state.status === 'reviewing' && state.revealed
  const canFlip = state.status === 'reviewing' && state.content !== null && !state.revealed
  const showStack =
    state.status === 'reviewing' || state.status === 'loading' || state.status === 'answered'

  const progressPercent = studyProgressPercent(answeredCount, initialQueueTotal)
  const hasTarget = progressPercent !== null

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Progress bar pinned to the top of the study view. */}
      <div className="w-full max-w-lg">
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          {hasTarget && (
            <motion.div
              className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400"
              initial={false}
              animate={{ width: `${progressPercent}%` }}
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
            />
          )}
        </div>
        {hasTarget && (
          <p className="mt-1.5 text-right text-xs font-medium tabular-nums text-neutral-500 dark:text-neutral-400">
            {answeredCount} / {initialQueueTotal}
          </p>
        )}
      </div>

      {/* Card area: 2 decorative layers peeking out behind the live top card,
          giving the physical "stack of flashcards" affordance. */}
      <div className="relative w-full max-w-lg">
        {showStack && (
          <>
            <div
              aria-hidden
              className="absolute inset-0 -z-20 translate-y-4 scale-90 rounded-2xl border-2 border-neutral-200 bg-white/70 shadow-sm dark:border-neutral-700 dark:bg-neutral-900/70"
            />
            <div
              aria-hidden
              className="absolute inset-0 -z-10 translate-y-2 scale-95 rounded-2xl border-2 border-neutral-200 bg-white/85 shadow-sm dark:border-neutral-700 dark:bg-neutral-900/85"
            />
          </>
        )}

        <AnimatePresence custom={exitDir} mode="popLayout" initial={false}>
          <motion.div
            key={answeredCount}
            custom={exitDir}
            variants={cardVariants}
            initial="enter"
            animate="center"
            exit="exit"
            drag={canDrag ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.7}
            dragSnapToOrigin
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            onTap={canFlip ? handleReveal : undefined}
            whileDrag={{ scale: 1.03 }}
            className={`relative overflow-hidden rounded-2xl border-2 border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900 ${
              canDrag ? 'cursor-grab active:cursor-grabbing' : canFlip ? 'cursor-pointer' : ''
            }`}
          >
            {/* Tinder-style feedback labels — grow/fade proportionally to the
                drag distance rather than flipping on at the threshold. */}
            {canDrag && (
              <>
                <motion.div
                  aria-hidden
                  style={{ opacity: goodOpacity, scale: goodScale }}
                  className="pointer-events-none absolute left-4 top-4 z-10 rotate-[-12deg] rounded-lg border-4 border-green-500 px-3 py-1 text-lg font-extrabold uppercase tracking-wide text-green-500"
                >
                  Good
                </motion.div>
                <motion.div
                  aria-hidden
                  style={{ opacity: againOpacity, scale: againScale }}
                  className="pointer-events-none absolute right-4 top-4 z-10 rotate-[12deg] rounded-lg border-4 border-red-500 px-3 py-1 text-lg font-extrabold uppercase tracking-wide text-red-500"
                >
                  Again
                </motion.div>
              </>
            )}

            <div className="flex min-h-48 flex-col items-center justify-center p-4">
              {(state.status === 'loading' || state.status === 'answered') && (
                <p className="py-16 text-sm font-medium text-neutral-500 dark:text-neutral-400">
                  Loading next card…
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
        </AnimatePresence>
      </div>

      {canFlip && (
        <button
          type="button"
          onClick={handleReveal}
          className="rounded-full bg-indigo-600 px-8 py-3 text-base font-semibold text-white shadow-md transition-colors hover:bg-indigo-500 active:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400"
        >
          Show Answer
        </button>
      )}

      {state.status === 'reviewing' && state.revealed && (
        <div className="flex w-full max-w-lg flex-col items-center gap-3">
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            Swipe right = Good, swipe left = Again, or tap a button
          </p>
          <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
            <button
              type="button"
              onClick={() => handleAnswer(EASE.again, 'left')}
              className="rounded-2xl bg-red-100 px-4 py-3.5 text-base font-semibold text-red-800 transition-colors hover:bg-red-200 active:scale-95 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
            >
              Again
            </button>
            <button
              type="button"
              onClick={() => handleAnswer(EASE.hard, 'up')}
              className="rounded-2xl bg-orange-100 px-4 py-3.5 text-base font-semibold text-orange-800 transition-colors hover:bg-orange-200 active:scale-95 dark:bg-orange-950 dark:text-orange-200 dark:hover:bg-orange-900"
            >
              Hard
            </button>
            <button
              type="button"
              onClick={() => handleAnswer(EASE.good, 'right')}
              className="rounded-2xl bg-green-100 px-4 py-3.5 text-base font-semibold text-green-800 transition-colors hover:bg-green-200 active:scale-95 dark:bg-green-950 dark:text-green-200 dark:hover:bg-green-900"
            >
              Good
            </button>
            <button
              type="button"
              onClick={() => handleAnswer(EASE.easy, 'up')}
              className="rounded-2xl bg-blue-100 px-4 py-3.5 text-base font-semibold text-blue-800 transition-colors hover:bg-blue-200 active:scale-95 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
            >
              Easy
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
