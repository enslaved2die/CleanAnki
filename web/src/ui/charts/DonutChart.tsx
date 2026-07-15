/**
 * Small, pure-presentational ring/donut chart. No data-fetching — the parent
 * (the Profile page) is expected to pass already-loaded numbers (e.g. card
 * counts by state) straight through as `segments`.
 *
 * The arc-angle math lives in `computeDonutArcs`, a plain function with no
 * React/DOM dependency, so it can be unit tested without a rendering
 * environment (see web/tests/ui/charts.test.ts).
 */

export interface DonutSegment {
  label: string
  value: number
  /** A Tailwind `fill-*` utility class, e.g. `'fill-indigo-500'`. Applied
   * directly to the segment's `<path>`, so it must be a `fill-` class (not
   * `bg-`/`text-`) for the color to actually take effect on an SVG shape. */
  colorClass: string
}

export interface DonutArc {
  label: string
  value: number
  colorClass: string
  /** 0-100, this segment's share of the total. */
  percentage: number
  /** Degrees, clockwise from 12 o'clock. */
  startAngle: number
  endAngle: number
  /** Ready-to-use SVG path `d` attribute for the ring segment. */
  path: string
}

const VIEWBOX_SIZE = 100
const CENTER = VIEWBOX_SIZE / 2
const DEFAULT_OUTER_RADIUS = 46
const DEFAULT_INNER_RADIUS = 30
/** Below this sweep, the two-arc-flag math for a "full circle" path becomes
 * ambiguous (SVG arcs can't describe a 360° sweep in one command), so a
 * total sweep this close to 360 is drawn as two 180° halves instead. */
const FULL_CIRCLE_THRESHOLD = 359.99

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  // -90 so angle 0 points to 12 o'clock instead of 3 o'clock, and increasing
  // angle sweeps clockwise (matches how people read a donut chart).
  const angleRad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + radius * Math.cos(angleRad), y: cy + radius * Math.sin(angleRad) }
}

/** Builds the filled-annulus ("washer") path for one ring segment between
 * `startAngle` and `endAngle`, going from `innerRadius` out to `outerRadius`. */
function annularSectorPath(
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle
  if (sweep >= FULL_CIRCLE_THRESHOLD) {
    // A single sector can't sweep a full 360° (start/end points coincide, and
    // the large-arc-flag is ambiguous), so split it into two halves.
    const mid = startAngle + sweep / 2
    return (
      annularSectorPath(innerRadius, outerRadius, startAngle, mid) +
      ' ' +
      annularSectorPath(innerRadius, outerRadius, mid, endAngle)
    )
  }

  const largeArcFlag = sweep > 180 ? 1 : 0
  const outerStart = polarToCartesian(CENTER, CENTER, outerRadius, startAngle)
  const outerEnd = polarToCartesian(CENTER, CENTER, outerRadius, endAngle)
  const innerEnd = polarToCartesian(CENTER, CENTER, innerRadius, endAngle)
  const innerStart = polarToCartesian(CENTER, CENTER, innerRadius, startAngle)

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

/**
 * Pure arc-angle math for the donut: turns raw `{ label, value, colorClass }`
 * segments into ready-to-render ring-segment paths, sized proportionally to
 * `value / sum(all values)`.
 *
 * All-zero (or empty) input is handled gracefully: rather than dividing by
 * zero, a single flat neutral-gray full ring is returned.
 */
export function computeDonutArcs(
  segments: DonutSegment[],
  options: { innerRadius?: number; outerRadius?: number } = {},
): DonutArc[] {
  const innerRadius = options.innerRadius ?? DEFAULT_INNER_RADIUS
  const outerRadius = options.outerRadius ?? DEFAULT_OUTER_RADIUS
  const total = segments.reduce((sum, s) => sum + Math.max(s.value, 0), 0)

  if (total <= 0) {
    return [
      {
        label: 'No data',
        value: 0,
        colorClass: 'fill-neutral-200 dark:fill-neutral-800',
        percentage: 0,
        startAngle: 0,
        endAngle: 360,
        path: annularSectorPath(innerRadius, outerRadius, 0, 360),
      },
    ]
  }

  let cursor = 0
  return segments
    .filter((s) => s.value > 0)
    .map((segment) => {
      const percentage = (segment.value / total) * 100
      const sweep = (segment.value / total) * 360
      const startAngle = cursor
      const endAngle = cursor + sweep
      cursor = endAngle
      return {
        label: segment.label,
        value: segment.value,
        colorClass: segment.colorClass,
        percentage,
        startAngle,
        endAngle,
        path: annularSectorPath(innerRadius, outerRadius, startAngle, endAngle),
      }
    })
}

export default function DonutChart({
  segments,
  centerLabel,
}: {
  segments: DonutSegment[]
  centerLabel?: string
}) {
  const arcs = computeDonutArcs(segments)
  const hasData = segments.some((s) => s.value > 0)

  return (
    <div className="w-full max-w-xs rounded-2xl border border-neutral-200 p-4 shadow-sm dark:border-neutral-800">
      <div className="relative mx-auto w-full max-w-[200px]">
        <svg
          viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
          className="w-full"
          role="img"
          aria-label={centerLabel ? `Donut chart: ${centerLabel}` : 'Donut chart'}
        >
          {arcs.map((arc, i) => (
            <path
              key={`${arc.label}-${i}`}
              d={arc.path}
              className={`${arc.colorClass} stroke-white dark:stroke-neutral-900`}
              strokeWidth={1}
            >
              <title>
                {arc.label}: {arc.value} ({Math.round(arc.percentage)}%)
              </title>
            </path>
          ))}
        </svg>
        {centerLabel && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
              {centerLabel}
            </span>
          </div>
        )}
      </div>

      {hasData && (
        <ul className="mt-3 space-y-1">
          {segments
            .filter((s) => s.value > 0)
            .map((segment) => (
              <li
                key={segment.label}
                className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400"
              >
                <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0">
                  <rect width={10} height={10} rx={2} className={segment.colorClass} />
                </svg>
                <span className="truncate">{segment.label}</span>
                <span className="ml-auto tabular-nums">{segment.value}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
