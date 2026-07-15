/**
 * Small, pure-presentational forecast bar chart — one bar per upcoming day
 * (`day: 0` = today), scaled relative to the largest count in the data. No
 * data-fetching; the parent (the Profile page) passes in the already-computed
 * per-day due counts.
 *
 * The scaling/layout math lives in `computeForecastBars`, a plain function
 * with no React/DOM dependency, so it can be unit tested without a rendering
 * environment (see web/tests/ui/charts.test.ts).
 */

export interface ForecastDay {
  /** 0 = today, 1 = tomorrow, etc. */
  day: number
  count: number
}

export interface ForecastBar {
  day: number
  count: number
  /** Short label for the axis, e.g. "Today" / "+1". */
  label: string
  x: number
  y: number
  width: number
  height: number
}

const CHART_WIDTH = 300
const CHART_HEIGHT = 100
const BAR_GAP = 4

/** Turns `day` into a short label that reads cleanly in a narrow card. */
export function formatDayLabel(day: number): string {
  if (day === 0) return 'Today'
  if (day < 0) return `${day}`
  return `+${day}`
}

/**
 * Pure layout math for the forecast bars: turns raw `{ day, count }` points
 * into SVG rect geometry (within a `CHART_WIDTH` x `CHART_HEIGHT` viewBox),
 * heights scaled relative to the largest count.
 *
 * Handles an empty array (returns `[]`) and all-zero counts (every bar gets
 * height 0, no divide-by-zero) gracefully.
 */
export function computeForecastBars(
  data: ForecastDay[],
  options: { chartWidth?: number; chartHeight?: number; barGap?: number } = {},
): ForecastBar[] {
  if (data.length === 0) return []

  const chartWidth = options.chartWidth ?? CHART_WIDTH
  const chartHeight = options.chartHeight ?? CHART_HEIGHT
  const barGap = options.barGap ?? BAR_GAP

  const maxCount = Math.max(...data.map((d) => d.count), 0)
  const n = data.length
  const totalGap = barGap * (n - 1)
  const barWidth = Math.max((chartWidth - totalGap) / n, 0)

  return data.map((d, i) => {
    const height = maxCount > 0 ? (Math.max(d.count, 0) / maxCount) * chartHeight : 0
    return {
      day: d.day,
      count: d.count,
      label: formatDayLabel(d.day),
      x: i * (barWidth + barGap),
      y: chartHeight - height,
      width: barWidth,
      height,
    }
  })
}

export default function ForecastBarChart({ data }: { data: ForecastDay[] }) {
  const bars = computeForecastBars(data)
  const labelAreaHeight = 16
  const viewBoxHeight = CHART_HEIGHT + labelAreaHeight

  return (
    <div className="w-full max-w-md rounded-2xl border border-neutral-200 p-4 shadow-sm dark:border-neutral-800">
      {bars.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No forecast data</p>
      ) : (
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${viewBoxHeight}`}
          className="w-full"
          role="img"
          aria-label="Upcoming reviews forecast"
        >
          {bars.map((bar) => (
            <g key={bar.day}>
              <rect
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={Math.max(bar.height, bar.count > 0 ? 2 : 0)}
                rx={3}
                className="fill-indigo-500 dark:fill-indigo-400"
              >
                <title>
                  {bar.label}: {bar.count}
                </title>
              </rect>
              <text
                x={bar.x + bar.width / 2}
                y={CHART_HEIGHT + labelAreaHeight - 4}
                textAnchor="middle"
                className="fill-neutral-500 dark:fill-neutral-400"
                style={{ fontSize: 9 }}
              >
                {bar.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  )
}
