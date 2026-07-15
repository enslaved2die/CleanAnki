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

/**
 * Aggregate breakdown of the queue the session started from, passed in by the
 * caller (App.tsx) — real rslib counts already capped by per-deck daily
 * limits, not something we compute here. Kept structurally identical to the
 * caller's exported `StudyQueueInfo` so the two compose without importing
 * across the file boundary.
 */
export interface StudyQueueInfo {
  total: number
  newCount: number
  learnCount: number
  reviewCount: number
}

/** Anki's 1..=4 ease convention, matching `Rating` in rust/wasm-bridge/src/main.rs. */
const EASE = { again: 1, hard: 2, good: 3, easy: 4 } as const

/**
 * Cap on how many decorative "stack" layers peek out behind the live card.
 * 3 (up from the original fixed 2): three slots is the smallest count that
 * can actually show a *mix* of the three card types at once (new/learn/review),
 * so the color preview reads as a proportion rather than a single guess, while
 * still looking like a tidy deck rather than a fanned-out pile.
 */
const MAX_STACK_LAYERS = 3

/** Which real-Anki queue type a decorative layer is tinted for. Colors match
 * DecksView's table: New = blue, Learn/relearn = red, Review = green. */
type LayerTint = 'neutral' | 'new' | 'learn' | 'review'

/** Depth styling per layer, index 0 = nearest the live card. Later entries sit
 * further back (smaller, lower, deeper z). */
const LAYER_GEOMETRY = [
  '-z-10 translate-y-2 scale-95',
  '-z-20 translate-y-4 scale-90',
  '-z-30 translate-y-6 scale-[0.85]',
] as const

const LAYER_TINT_CLASS: Record<LayerTint, string> = {
  neutral: 'border-neutral-200 bg-white/80 dark:border-neutral-700 dark:bg-neutral-900/80',
  new: 'border-blue-200 bg-blue-50/80 dark:border-blue-900 dark:bg-blue-950/50',
  learn: 'border-red-200 bg-red-50/80 dark:border-red-900 dark:bg-red-950/50',
  review: 'border-green-200 bg-green-50/80 dark:border-green-900 dark:bg-green-950/50',
}

/**
 * Assign a tint to each of `count` decorative layers, proportional to the
 * aggregate new/learn/review mix of what's left.
 *
 * IMPORTANT: this is an *approximation*. We only know the aggregate counts for
 * the whole session — we have NO true lookahead into the exact type of each
 * specific upcoming card. So the layers show the overall proportion of what's
 * left (dominant type nearest the live card), not a per-card preview. With no
 * real queue data we fall back to neutral gray rather than guessing.
 */
function distributeLayerTints(count: number, queue: StudyQueueInfo | undefined): LayerTint[] {
  if (count <= 0) return []
  if (!queue) return Array<LayerTint>(count).fill('neutral')

  const cats = [
    { tint: 'new' as const, n: queue.newCount },
    { tint: 'learn' as const, n: queue.learnCount },
    { tint: 'review' as const, n: queue.reviewCount },
  ]
  const totalMix = cats.reduce((sum, c) => sum + c.n, 0)
  if (totalMix <= 0) return Array<LayerTint>(count).fill('neutral')

  // Largest-remainder apportionment: give each type its floored proportional
  // share of the `count` slots, then hand leftover slots to the largest
  // fractional remainders so the totals always add back up to `count`.
  const alloc = cats.map((c) => {
    const exact = (c.n / totalMix) * count
    const floor = Math.floor(exact)
    return { tint: c.tint, floor, rem: exact - floor }
  })
  let used = alloc.reduce((sum, a) => sum + a.floor, 0)
  const byRemainder = [...alloc].sort((a, b) => b.rem - a.rem)
  for (let i = 0; used < count; i++, used++) {
    byRemainder[i % byRemainder.length].floor += 1
  }

  // Flatten, dominant type first so it sits nearest the live card.
  const tints: LayerTint[] = []
  for (const a of [...alloc].sort((x, y) => y.floor - x.floor)) {
    for (let k = 0; k < a.floor; k++) tints.push(a.tint)
  }
  return tints
}

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

export default function StudyView({
  initialQueue,
  onBack,
}: {
  initialQueue?: StudyQueueInfo
  onBack: () => void
}) {
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

  const progressPercent = studyProgressPercent(answeredCount, initialQueue?.total)
  const hasTarget = progressPercent !== null

  // How many cards are still ahead, from the real starting total. `null` when
  // we have no real target (same situations the progress bar falls back to
  // indeterminate) — in that case we can't shrink the stack meaningfully, so
  // we keep the original fixed 2 layers.
  const remaining = initialQueue ? Math.max(initialQueue.total - answeredCount, 0) : null
  const layerCount = remaining === null ? 2 : Math.min(remaining, MAX_STACK_LAYERS)
  const layerTints = distributeLayerTints(layerCount, initialQueue)

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Back to Home. Always available — Study is no longer a permanent nav
          destination (reached only by tapping a deck), and every answer is
          persisted immediately, so leaving mid-session loses nothing. */}
      <div className="w-full max-w-lg">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          Home
        </button>
      </div>
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
            {answeredCount} / {initialQueue?.total}
          </p>
        )}
      </div>

      {/* Card area: decorative layers peeking out behind the live top card,
          giving the physical "stack of flashcards" affordance. The count
          shrinks toward zero as cards are answered (see `layerCount`), and
          each layer is tinted by the aggregate card-type mix (see
          `distributeLayerTints` — approximate, not per-card lookahead). */}
      <div className="relative w-full max-w-lg">
        {showStack &&
          layerTints.map((tint, i) => (
            <div
              key={i}
              aria-hidden
              className={`absolute inset-0 rounded-2xl border-2 shadow-sm ${LAYER_GEOMETRY[i]} ${LAYER_TINT_CLASS[tint]}`}
            />
          ))}

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
