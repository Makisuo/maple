import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { heatmapSampleData } from "../_shared/sample-data"

interface HeatmapPoint {
  x: string
  y: string
  value: number
}

function asFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function deriveHeatmapPoints(rows: Record<string, unknown>[]): HeatmapPoint[] {
  if (rows.length === 0) return []

  const first = rows[0]
  if ("x" in first && "y" in first && "value" in first) {
    return rows.map((row) => ({
      x: String(row.x ?? ""),
      y: String(row.y ?? ""),
      value: asFiniteNumber(row.value),
    }))
  }

  const numericKeys = Object.keys(first).filter(
    (k) => k !== "name" && k !== "bucket" && typeof first[k] === "number",
  )
  const labelKey = "name" in first ? "name" : "bucket" in first ? "bucket" : null
  if (!labelKey || numericKeys.length === 0) return []

  const points: HeatmapPoint[] = []
  for (const row of rows) {
    const yLabel = String(row[labelKey] ?? "")
    for (const xKey of numericKeys) {
      points.push({
        x: xKey,
        y: yLabel,
        value: asFiniteNumber(row[xKey]),
      })
    }
  }
  return points
}

const COLOR_SCALES: Record<string, string[]> = {
  blues: [
    "rgb(247, 251, 255)",
    "rgb(198, 219, 239)",
    "rgb(107, 174, 214)",
    "rgb(33, 113, 181)",
    "rgb(8, 48, 107)",
  ],
  reds: [
    "rgb(255, 245, 240)",
    "rgb(252, 187, 161)",
    "rgb(251, 106, 74)",
    "rgb(203, 24, 29)",
    "rgb(103, 0, 13)",
  ],
  viridis: [
    "rgb(68, 1, 84)",
    "rgb(59, 82, 139)",
    "rgb(33, 145, 140)",
    "rgb(94, 201, 98)",
    "rgb(253, 231, 37)",
  ],
  magma: [
    "rgb(0, 0, 4)",
    "rgb(80, 18, 123)",
    "rgb(183, 55, 121)",
    "rgb(251, 135, 97)",
    "rgb(252, 253, 191)",
  ],
  cividis: [
    "rgb(0, 32, 76)",
    "rgb(56, 88, 120)",
    "rgb(123, 124, 117)",
    "rgb(191, 168, 89)",
    "rgb(255, 233, 69)",
  ],
}

function colorForValue(t: number, scale: string[]): string {
  if (scale.length === 0) return "rgb(0,0,0)"
  if (t <= 0) return scale[0]
  if (t >= 1) return scale[scale.length - 1]
  const segment = (scale.length - 1) * t
  const lower = Math.floor(segment)
  return scale[Math.min(lower + 1, scale.length - 1)]
}

export function QueryBuilderHeatmapChart({
  data,
  className,
  tooltip,
  unit,
  heatmap,
}: BaseChartProps) {
  const source = Array.isArray(data) && data.length > 0 ? data : heatmapSampleData
  const points = React.useMemo(() => deriveHeatmapPoints(source), [source])

  const xValues = React.useMemo(
    () => Array.from(new Set(points.map((p) => p.x))),
    [points],
  )
  const yValues = React.useMemo(
    () => Array.from(new Set(points.map((p) => p.y))).reverse(),
    [points],
  )

  const max = points.reduce((acc, p) => Math.max(acc, p.value), 0)
  const min = points.reduce((acc, p) => Math.min(acc, p.value), Number.POSITIVE_INFINITY)
  const span = max - min

  const scale = COLOR_SCALES[heatmap?.colorScale ?? "blues"] ?? COLOR_SCALES.blues

  const lookup = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const point of points) {
      map.set(`${point.x}::${point.y}`, point.value)
    }
    return map
  }, [points])

  const [hover, setHover] = React.useState<{
    x: string
    y: string
    value: number
    cx: number
    cy: number
  } | null>(null)

  if (xValues.length === 0 || yValues.length === 0) {
    return (
      <div className={className}>
        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
          No data
        </div>
      </div>
    )
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <div
        className="grid h-full w-full gap-px"
        style={{
          gridTemplateColumns: `auto repeat(${xValues.length}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${yValues.length}, minmax(0, 1fr)) auto`,
        }}
      >
        {yValues.map((y, yi) =>
          [
            <div
              key={`y-${y}`}
              className="text-[10px] text-muted-foreground pr-2 flex items-center justify-end whitespace-nowrap"
              style={{ gridColumn: 1, gridRow: yi + 1 }}
            >
              {y}
            </div>,
            ...xValues.map((x, xi) => {
              const value = lookup.get(`${x}::${y}`) ?? 0
              const t = span > 0 ? (value - min) / span : 0
              return (
                <div
                  key={`${x}-${y}`}
                  className="rounded-sm cursor-default transition-opacity hover:opacity-80"
                  style={{
                    gridColumn: xi + 2,
                    gridRow: yi + 1,
                    backgroundColor: value === 0 && span > 0 ? "var(--muted)" : colorForValue(t, scale),
                  }}
                  onMouseEnter={(e) =>
                    setHover({
                      x,
                      y,
                      value,
                      cx: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2,
                      cy: e.currentTarget.offsetTop,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              )
            }),
          ],
        )}
        <div style={{ gridColumn: 1, gridRow: yValues.length + 1 }} />
        {xValues.map((x, xi) => (
          <div
            key={`x-${x}`}
            className="text-[10px] text-muted-foreground pt-1 text-center truncate"
            style={{ gridColumn: xi + 2, gridRow: yValues.length + 1 }}
          >
            {x}
          </div>
        ))}
      </div>

      {tooltip !== "hidden" && hover && (
        <div
          className="absolute pointer-events-none bg-popover border border-border rounded-md px-2 py-1.5 text-[11px] shadow-md z-10 -translate-x-1/2 -translate-y-full"
          style={{ left: hover.cx, top: hover.cy - 4 }}
        >
          <div className="font-medium">
            {hover.x} × {hover.y}
          </div>
          <div className="text-muted-foreground font-mono">
            {unit ? formatValueByUnit(hover.value, unit) : formatNumber(hover.value)}
          </div>
        </div>
      )}
    </div>
  )
}
