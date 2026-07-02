import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { funnelSampleData } from "../_shared/sample-data"
import { resolveSeriesColor } from "../../../lib/semantic-series-colors"
import { useContainerSize } from "../../../hooks/use-container-size"

interface Row {
	name: string
	/** True when the source row had no usable label. */
	unnamed: boolean
	value: number
}

interface Stage extends Row {
	color: string
	/** Bar width as a fraction of the largest stage (0–1). */
	widthPct: number
	/** Share of the first stage's value (0–1). */
	pctOfFirst: number
	/** Conversion from the previous stage (0–1); null when there is no previous non-zero stage. */
	pctOfPrev: number | null
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

/**
 * Normalize source rows into named stages. Guards the mis-wired case where a
 * funnel receives timeseries rows (`{bucket, seriesA, seriesB}`) instead of a
 * breakdown (`{name, value}`): rendering one "—" row per time bucket is
 * meaningless, so aggregate each numeric series across buckets into a single
 * stage instead (MAP-49).
 */
function toRows(source: ReadonlyArray<Record<string, unknown>>, valueField: string): Row[] {
	const first = source[0]
	const isTimeseriesShaped = first != null && "bucket" in first && !("name" in first)
	if (isTimeseriesShaped) {
		const totals = new Map<string, number>()
		for (const row of source) {
			for (const [key, value] of Object.entries(row)) {
				if (key === "bucket" || typeof value !== "number") continue
				totals.set(key, (totals.get(key) ?? 0) + asFiniteNumber(value))
			}
		}
		return Array.from(totals, ([name, value]) => ({ name, unnamed: false, value })).sort(
			(a, b) => b.value - a.value,
		)
	}
	return source.map((row) => {
		const raw = row.name == null ? "" : String(row.name).trim()
		return {
			name: raw === "" ? "(no value)" : raw,
			unnamed: raw === "",
			value: asFiniteNumber(row[valueField]),
		}
	})
}

/**
 * Drop meaningless zero rows: a zero stage is kept only when a non-zero stage
 * follows it (a genuine funnel drop-to-zero step reads differently from a pile
 * of empty groups at the tail).
 */
function dropTrailingZeroRows(rows: Row[]): Row[] {
	let lastNonZero = -1
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].value > 0) {
			lastNonZero = i
			break
		}
	}
	// Keep one zero stage directly after the last non-zero one ("dropped to 0").
	return rows.slice(0, Math.min(rows.length, lastNonZero + 2))
}

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

function fmtPct(fraction: number): string {
	const pct = fraction * 100
	return `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%`
}

const ROW_GAP = 6
const ROW_MIN_H = 22
/** Label line (~11px) + gap + bar (10px). */
const ROW_FULL_H = ROW_MIN_H + ROW_GAP
const BAR_MIN_PCT = 0.04
const MORE_ROW_H = 16

export function QueryBuilderFunnelChart({ data, className, unit, funnel }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> =
		Array.isArray(data) && data.length > 0
			? data
			: (funnelSampleData as ReadonlyArray<Record<string, unknown>>)

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { height } = useContainerSize(containerRef)

	const stages = React.useMemo(() => {
		const rows = dropTrailingZeroRows(toRows(source, valueField))
		const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
		const first = rows[0]?.value ?? 0
		if (max <= 0) return [] as Stage[]
		return rows.map((row, idx): Stage => {
			const prev = rows[idx - 1]?.value
			const color = resolveSeriesColor(row.name, idx)
			return {
				...row,
				color,
				widthPct: Math.max(BAR_MIN_PCT, row.value / max),
				pctOfFirst: first > 0 ? row.value / first : 0,
				pctOfPrev: idx === 0 || prev == null || prev <= 0 ? null : row.value / prev,
			}
		})
	}, [source, valueField])

	// Render only the rows that fit the measured container, with a muted
	// "+N more" row when stages are cut — rows must never spill out of the
	// card (MAP-49). Before the first measurement (height 0) render everything;
	// the card clips and the next frame corrects.
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - MORE_ROW_H) / ROW_FULL_H)) : stages.length
	const truncated = stages.length > maxRows
	const visibleStages = truncated ? stages.slice(0, maxRows) : stages
	const hiddenCount = stages.length - visibleStages.length

	const [hover, setHover] = React.useState<number | null>(null)
	const showStepPercent = funnel?.showStepPercent === true

	if (stages.length === 0) {
		return (
			<div className={cn("relative h-full w-full grid place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			className={cn(
				"flex h-full w-full flex-col gap-1.5 overflow-hidden px-1 select-none",
				truncated ? "justify-start" : "justify-center",
				className,
			)}
			style={{ rowGap: ROW_GAP }}
			onPointerLeave={() => setHover(null)}
		>
			{visibleStages.map((stage, i) => {
				const isHover = hover === i
				const fade = hover !== null && !isHover ? 0.55 : 1
				return (
					<div
						key={`${stage.name}-${i}`}
						className="flex min-h-0 flex-col justify-center gap-0.5"
						style={{ minHeight: ROW_MIN_H }}
						onPointerEnter={() => setHover(i)}
					>
						{/* Label row */}
						<div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
							<span
								className={cn(
									"truncate",
									stage.unnamed ? "italic text-muted-foreground" : "text-foreground/90",
								)}
								title={stage.name}
							>
								{stage.name}
							</span>
							<span className="shrink-0 tabular-nums text-muted-foreground">
								<span className="text-foreground/90">{fmtValue(stage.value, unit)}</span>
								<span className="px-1 text-muted-foreground/50">·</span>
								<span>{fmtPct(stage.pctOfFirst)}</span>
								{showStepPercent && stage.pctOfPrev != null && (
									<>
										<span className="px-1 text-muted-foreground/50">↓</span>
										<span>{fmtPct(stage.pctOfPrev)}</span>
									</>
								)}
							</span>
						</div>
						{/* Bar */}
						<div className="relative h-2.5 w-full overflow-hidden rounded-[3px] bg-foreground/5">
							<div
								className="absolute inset-y-0 left-0 rounded-[3px]"
								style={{
									width: `${stage.widthPct * 100}%`,
									backgroundColor: stage.color,
									opacity: fade,
									transition: "opacity 140ms ease, width 220ms ease",
								}}
							/>
						</div>
					</div>
				)
			})}
			{hiddenCount > 0 && (
				<div className="shrink-0 text-[10px] leading-none text-muted-foreground">
					+{hiddenCount} more
				</div>
			)}
		</div>
	)
}
