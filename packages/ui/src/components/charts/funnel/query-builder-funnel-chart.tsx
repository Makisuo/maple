import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { pickValueField, toBreakdownRows, type BreakdownRow } from "../_shared/breakdown-rows"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { useContainerSize } from "../../../hooks/use-container-size"

interface Stage extends BreakdownRow {
	color: string
	/** Bar width as a fraction of the largest stage (0–1). */
	widthPct: number
	/** Share of the first stage's value (0–1). */
	pctOfFirst: number
	/** Conversion from the previous stage (0–1); null when there is no previous non-zero stage. */
	pctOfPrev: number | null
}

/**
 * Drop meaningless zero rows: a zero stage is kept only when a non-zero stage
 * follows it (a genuine funnel drop-to-zero step reads differently from a pile
 * of empty groups at the tail).
 */
function dropTrailingZeroRows(rows: BreakdownRow[]): BreakdownRow[] {
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

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

export function QueryBuilderFunnelChart({ data, className, unit, funnel }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { height } = useContainerSize(containerRef)

	const stages = React.useMemo(() => {
		const rows = dropTrailingZeroRows(toBreakdownRows(source, valueField))
		const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
		const first = rows[0]?.value ?? 0
		if (max <= 0) return [] as Stage[]
		const colors = resolveSeriesColors(rows.map((row) => row.name))
		return rows.map((row, idx): Stage => {
			const prev = rows[idx - 1]?.value
			const color = colors.get(row.name) ?? ""
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
	// `showStepPercent` gates BOTH percentage labels, not just the step-to-step
	// one: setting it `false` used to leave the "share of the first stage" label
	// on screen, so a widget that explicitly asked for no percentages still got
	// them. Unset keeps the long-standing default — share of the first stage,
	// no step conversion — so persisted funnels render as before.
	const showShareOfFirst = funnel?.showStepPercent !== false
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
								{showShareOfFirst && (
									<>
										<span className="px-1 text-muted-foreground/50">·</span>
										<span>{fmtPct(stage.pctOfFirst)}</span>
									</>
								)}
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
