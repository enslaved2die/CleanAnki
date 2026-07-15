import { describe, it, expect } from 'vitest'
import { computeDonutArcs, type DonutSegment } from '../../src/ui/charts/DonutChart'
import {
  computeForecastBars,
  formatDayLabel,
  type ForecastDay,
} from '../../src/ui/charts/ForecastBarChart'

// Small tolerance for float rounding when summing angles/percentages built
// from division (e.g. thirds of 360).
const EPSILON = 1e-6

function totalSweep(arcs: { startAngle: number; endAngle: number }[]): number {
  return arcs.reduce((sum, arc) => sum + (arc.endAngle - arc.startAngle), 0)
}

describe('computeDonutArcs', () => {
  it('sizes two segments proportionally to their share of the total', () => {
    const segments: DonutSegment[] = [
      { label: 'New', value: 25, colorClass: 'fill-indigo-500' },
      { label: 'Review', value: 75, colorClass: 'fill-green-500' },
    ]
    const arcs = computeDonutArcs(segments)

    expect(arcs).toHaveLength(2)
    expect(arcs[0].percentage).toBeCloseTo(25, 5)
    expect(arcs[1].percentage).toBeCloseTo(75, 5)
    // First segment starts at 12 o'clock and sweeps a quarter of the circle.
    expect(arcs[0].startAngle).toBeCloseTo(0, 5)
    expect(arcs[0].endAngle).toBeCloseTo(90, 5)
    // Second segment picks up exactly where the first left off.
    expect(arcs[1].startAngle).toBeCloseTo(90, 5)
    expect(arcs[1].endAngle).toBeCloseTo(360, 5)
  })

  it('sizes three segments proportionally and sums to a full sweep', () => {
    const segments: DonutSegment[] = [
      { label: 'A', value: 1, colorClass: 'fill-indigo-500' },
      { label: 'B', value: 1, colorClass: 'fill-green-500' },
      { label: 'C', value: 1, colorClass: 'fill-red-500' },
    ]
    const arcs = computeDonutArcs(segments)

    expect(arcs).toHaveLength(3)
    arcs.forEach((arc) => expect(arc.percentage).toBeCloseTo(100 / 3, 5))
    expect(totalSweep(arcs)).toBeCloseTo(360, EPSILON)
  })

  it('produces a path string for every arc', () => {
    const segments: DonutSegment[] = [
      { label: 'A', value: 10, colorClass: 'fill-indigo-500' },
    ]
    const arcs = computeDonutArcs(segments)
    expect(arcs[0].path).toMatch(/^M /)
    expect(arcs[0].path).toContain('A ')
    expect(arcs[0].path.trim().endsWith('Z')).toBe(true)
  })

  it('falls back to a single flat neutral-gray ring when all values are zero', () => {
    const segments: DonutSegment[] = [
      { label: 'New', value: 0, colorClass: 'fill-indigo-500' },
      { label: 'Review', value: 0, colorClass: 'fill-green-500' },
    ]
    const arcs = computeDonutArcs(segments)

    expect(arcs).toHaveLength(1)
    expect(arcs[0].colorClass).toContain('neutral')
    expect(arcs[0].value).toBe(0)
    expect(arcs[0].path.length).toBeGreaterThan(0)
    expect(totalSweep(arcs)).toBeCloseTo(360, EPSILON)
  })

  it('gracefully handles an empty segments array', () => {
    const arcs = computeDonutArcs([])
    expect(arcs).toHaveLength(1)
    expect(arcs[0].colorClass).toContain('neutral')
  })

  it('skips zero/negative-value segments among otherwise valid ones', () => {
    const segments: DonutSegment[] = [
      { label: 'Zero', value: 0, colorClass: 'fill-red-500' },
      { label: 'All', value: 40, colorClass: 'fill-indigo-500' },
    ]
    const arcs = computeDonutArcs(segments)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].label).toBe('All')
    expect(arcs[0].percentage).toBeCloseTo(100, 5)
  })
})

describe('formatDayLabel', () => {
  it('labels day 0 as "Today"', () => {
    expect(formatDayLabel(0)).toBe('Today')
  })

  it('labels future days as "+N"', () => {
    expect(formatDayLabel(1)).toBe('+1')
    expect(formatDayLabel(7)).toBe('+7')
  })
})

describe('computeForecastBars', () => {
  it('scales bar heights relative to the max count', () => {
    const data: ForecastDay[] = [
      { day: 0, count: 10 },
      { day: 1, count: 5 },
      { day: 2, count: 0 },
    ]
    const bars = computeForecastBars(data, { chartWidth: 300, chartHeight: 100, barGap: 0 })

    expect(bars).toHaveLength(3)
    expect(bars[0].height).toBeCloseTo(100, 5) // max count -> full height
    expect(bars[1].height).toBeCloseTo(50, 5) // half of max -> half height
    expect(bars[2].height).toBeCloseTo(0, 5) // zero count -> zero height
    // Bars are laid out left to right without overlapping.
    expect(bars[1].x).toBeGreaterThan(bars[0].x)
    expect(bars[2].x).toBeGreaterThan(bars[1].x)
  })

  it('labels bars using formatDayLabel', () => {
    const data: ForecastDay[] = [
      { day: 0, count: 3 },
      { day: 1, count: 2 },
    ]
    const bars = computeForecastBars(data)
    expect(bars[0].label).toBe('Today')
    expect(bars[1].label).toBe('+1')
  })

  it('returns an empty array for empty data (no crash)', () => {
    expect(computeForecastBars([])).toEqual([])
  })

  it('handles all-zero counts without dividing by zero', () => {
    const data: ForecastDay[] = [
      { day: 0, count: 0 },
      { day: 1, count: 0 },
    ]
    const bars = computeForecastBars(data)
    expect(bars).toHaveLength(2)
    bars.forEach((bar) => {
      expect(bar.height).toBe(0)
      expect(Number.isFinite(bar.height)).toBe(true)
    })
  })

  it('keeps all bar widths within the chart width', () => {
    const data: ForecastDay[] = Array.from({ length: 7 }, (_, i) => ({ day: i, count: i + 1 }))
    const bars = computeForecastBars(data, { chartWidth: 300, barGap: 4 })
    const lastBar = bars[bars.length - 1]
    expect(lastBar.x + lastBar.width).toBeLessThanOrEqual(300 + EPSILON)
  })
})
