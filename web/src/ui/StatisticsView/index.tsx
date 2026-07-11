import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getStats, type Stats } from '../../wasm/backend'
import { ensureCollectionReady } from '../../db/collection'

type Status = 'loading' | 'ready' | 'error'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone?: 'blue' | 'red' | 'green' | 'neutral'
}) {
  const toneClass = {
    blue: 'text-blue-600 dark:text-blue-400',
    red: 'text-red-600 dark:text-red-400',
    green: 'text-green-600 dark:text-green-400',
    neutral: 'text-neutral-900 dark:text-neutral-100',
  }[tone ?? 'neutral']

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}

/**
 * Real-data statistics screen — every number here comes from
 * `Collection::graphs`/`Collection::studied_today` (see `wasm_get_stats` in
 * rust/wasm-bridge/src/main.rs), the same computation real Anki desktop's
 * stats screen is built from. Scoped to headline numbers (today's study
 * count, card-state breakdown, due forecast) rather than the full
 * chart-rendering payload real Anki's stats screen shows — see `Stats`'s doc
 * comment in wasm/backend.ts for why.
 */
export default function StatisticsView() {
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const bootstrapped = useRef(false)

  const refresh = useCallback(async () => {
    const s = await getStats()
    setStats(s)
    return s
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl space-y-6"
    >
      <h2 className="text-lg font-semibold">Statistics</h2>

      {status === 'loading' && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {status === 'ready' && stats && (
        <>
          <div>
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {stats.studiedTodayText}
            </p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Scheduling algorithm: {stats.fsrs ? 'FSRS' : 'SM-2 (legacy)'}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Today
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Answered" value={stats.today.answerCount} />
              <StatCard
                label="Correct"
                value={
                  stats.today.answerCount > 0
                    ? `${Math.round((stats.today.correctCount / stats.today.answerCount) * 100)}%`
                    : '—'
                }
                tone="green"
              />
              <StatCard
                label="Time studied"
                value={`${Math.round(stats.today.answerMillis / 60000)} min`}
              />
              <StatCard label="Mature correct" value={stats.today.matureCorrect} tone="green" />
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Due forecast
            </h3>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <StatCard label="Due today" value={stats.dueToday} tone="blue" />
              <StatCard label="Due this week" value={stats.dueThisWeek} tone="blue" />
              <StatCard label="Overdue" value={stats.backlog} tone="red" />
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Card counts
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="New" value={stats.cardCounts.newCards} tone="blue" />
              <StatCard
                label="Learning"
                value={stats.cardCounts.learn + stats.cardCounts.relearn}
                tone="red"
              />
              <StatCard
                label="Review"
                value={stats.cardCounts.young + stats.cardCounts.mature}
                tone="green"
              />
              <StatCard label="Suspended/buried" value={stats.cardCounts.suspended + stats.cardCounts.buried} />
            </div>
          </div>
        </>
      )}
    </motion.div>
  )
}
