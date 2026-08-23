import * as React from "react"

import type { QueryBuilderFunnelChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { asFiniteNumber, pickValueField, toBreakdownRows, type BreakdownRow } from "../_shared/breakdown-rows"
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
	/**
	 * One bar per breakdown group, in group order; empty for an unsegmented
	 * funnel. `value`/`widthPct` above are then the stage's total across groups.
	 */
	groups: ReadonlyArray<StageGroup>
}

interface StageGroup {
	name: string
	color: string
	value: number
	/** Width as a fraction of the largest group bar anywhere in the funnel (0–1). */
	widthPct: number
	/** Share of this group's first-stage value (0–1). */
	pctOfFirst: number
}

/**
 * Drop meaningless zero rows: a zero stage is kept only when a non-zero stage
 * follows it (a genuine funnel drop-to-zero step reads differently from a pile
 * of empty groups at the tail).
 */
function dropTrailingZeroRows<T extends BreakdownRow>(rows: T[]): T[] {
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
/** A group bar (6px) + its gap (2px) in a broken-down stage. */
const GROUP_BAR_H = 8
/** The legend line above a broken-down funnel. */
const LEGEND_H = 18

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

/**
 * A breakdown arrives as one `{ name, value, group }` row per group per step —
 * the product-event funnel route's shape when `breakdownBy` is set. Detected by
 * the `group` column rather than a prop so the same widget data that fed the
 * unsegmented chart keeps working, and so a share-API tile needs no extra flag.
 */
function isGroupedRow(row: Record<string, unknown>): row is Record<string, unknown> & { group: string } {
	return typeof row.group === "string"
}

/**
 * Fold grouped rows into stages: the distinct step names in first-seen order,
 * each carrying one entry per group (groups in first-seen order, which is the
 * route's rank), with the stage's `value` as the total across groups.
 */
function toGroupedStages(
	source: ReadonlyArray<Record<string, unknown> & { group: string }>,
	valueField: string,
): { stages: Array<BreakdownRow & { byGroup: Map<string, number> }>; groups: string[] } {
	const groups: string[] = []
	const stages: Array<BreakdownRow & { byGroup: Map<string, number> }> = []
	const stageByName = new Map<string, BreakdownRow & { byGroup: Map<string, number> }>()
	for (const row of source) {
		if (!groups.includes(row.group)) groups.push(row.group)
		const raw = row.name == null ? "" : String(row.name).trim()
		const name = raw === "" ? "(no value)" : raw
		let stage = stageByName.get(name)
		if (!stage) {
			stage = { name, unnamed: raw === "", value: 0, byGroup: new Map() }
			stageByName.set(name, stage)
			stages.push(stage)
		}
		const value = asFiniteNumber(row[valueField])
		stage.byGroup.set(row.group, (stage.byGroup.get(row.group) ?? 0) + value)
		stage.value += value
	}
	return { stages, groups }
}

export function QueryBuilderFunnelChart({
	data,
	className,
	unit,
	showStepPercent,
}: QueryBuilderFunnelChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { height } = useContainerSize(containerRef)

	const { stages, legend } = React.useMemo((): {
		stages: Stage[]
		legend: ReadonlyArray<{ name: string; color: string }>
	} => {
		const groupedSource = source.filter(isGroupedRow)
		const grouped = groupedSource.length > 0 && groupedSource.length === source.length

		if (grouped) {
			const { stages: folded, groups } = toGroupedStages(groupedSource, valueField)
			const rows = dropTrailingZeroRows(folded)
			const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
			if (max <= 0) return { stages: [], legend: [] }
			const groupMax = rows.reduce(
				(acc, r) => Math.max(acc, ...groups.map((group) => r.byGroup.get(group) ?? 0)),
				0,
			)
			const colors = resolveSeriesColors(groups)
			const first = rows[0]
			const legend = groups.map((name) => ({ name, color: colors.get(name) ?? "" }))
			const stages = rows.map((row, idx): Stage => {
				const prev = rows[idx - 1]?.value
				return {
					name: row.name,
					unnamed: row.unnamed,
					value: row.value,
					// The stage colour is unused when grouped; the bars take the
					// group colours.
					color: "",
					widthPct: Math.max(BAR_MIN_PCT, row.value / max),
					pctOfFirst: first.value > 0 ? row.value / first.value : 0,
					pctOfPrev: idx === 0 || prev == null || prev <= 0 ? null : row.value / prev,
					groups: groups.map((group): StageGroup => {
						const value = row.byGroup.get(group) ?? 0
						const groupFirst = first.byGroup.get(group) ?? 0
						return {
							name: group,
							color: colors.get(group) ?? "",
							value,
							widthPct: groupMax > 0 ? Math.max(value > 0 ? BAR_MIN_PCT : 0, value / groupMax) : 0,
							pctOfFirst: groupFirst > 0 ? value / groupFirst : 0,
						}
					}),
				}
			})
			return { stages, legend }
		}

		const rows = dropTrailingZeroRows(toBreakdownRows(source, valueField))
		const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
		const first = rows[0]?.value ?? 0
		if (max <= 0) return { stages: [], legend: [] }
		const colors = resolveSeriesColors(rows.map((row) => row.name))
		return {
			legend: [],
			stages: rows.map((row, idx): Stage => {
				const prev = rows[idx - 1]?.value
				const color = colors.get(row.name) ?? ""
				return {
					...row,
					color,
					widthPct: Math.max(BAR_MIN_PCT, row.value / max),
					pctOfFirst: first > 0 ? row.value / first : 0,
					pctOfPrev: idx === 0 || prev == null || prev <= 0 ? null : row.value / prev,
					groups: [],
				}
			}),
		}
	}, [source, valueField])

	const isGrouped = legend.length > 0
	const groupCount = legend.length
	// A broken-down stage stacks one thin bar per group under its label.
	const rowFullH = isGrouped ? ROW_MIN_H + groupCount * GROUP_BAR_H + ROW_GAP : ROW_FULL_H
	const chromeH = MORE_ROW_H + (isGrouped ? LEGEND_H : 0)

	// Render only the rows that fit the measured container, with a muted
	// "+N more" row when stages are cut — rows must never spill out of the
	// card (MAP-49). Before the first measurement (height 0) render everything;
	// the card clips and the next frame corrects.
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - chromeH) / rowFullH)) : stages.length
	const truncated = stages.length > maxRows
	const visibleStages = truncated ? stages.slice(0, maxRows) : stages
	const hiddenCount = stages.length - visibleStages.length

	const [hover, setHover] = React.useState<number | null>(null)
	// Hovering a group (a bar or its legend chip) lifts that group in every stage.
	const [hoverGroup, setHoverGroup] = React.useState<string | null>(null)
	// `showStepPercent` gates BOTH percentage labels, not just the step-to-step
	// one: setting it `false` used to leave the "share of the first stage" label
	// on screen, so a widget that explicitly asked for no percentages still got
	// them. Unset keeps the long-standing default — share of the first stage,
	// no step conversion — so persisted funnels render as before.
	const showShareOfFirst = showStepPercent !== false
	const showStepConversion = showStepPercent === true

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
			onPointerLeave={() => {
				setHover(null)
				setHoverGroup(null)
			}}
		>
			{isGrouped && (
				<div
					className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden text-[10px] leading-none text-muted-foreground"
					style={{ maxHeight: LEGEND_H }}
					data-slot="funnel-legend"
				>
					{legend.map((entry) => (
						<button
							key={entry.name}
							type="button"
							className={cn(
								"flex min-w-0 items-center gap-1 transition-opacity",
								hoverGroup !== null && hoverGroup !== entry.name && "opacity-50",
							)}
							onPointerEnter={() => setHoverGroup(entry.name)}
							onPointerLeave={() => setHoverGroup(null)}
							title={entry.name}
						>
							<span
								className="size-2 shrink-0 rounded-[2px]"
								style={{ backgroundColor: entry.color }}
							/>
							<span className="truncate">{entry.name}</span>
						</button>
					))}
				</div>
			)}
			{visibleStages.map((stage, i) => {
				const isHover = hover === i
				const fade = hover !== null && !isHover ? 0.55 : 1
				const hoveredGroup =
					hoverGroup === null ? undefined : stage.groups.find((group) => group.name === hoverGroup)
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
								{hoveredGroup ? (
									// The hovered group's own numbers: its count here and its
									// conversion from its own first stage.
									<>
										<span
											className="mr-1 inline-block size-2 rounded-[2px] align-middle"
											style={{ backgroundColor: hoveredGroup.color }}
										/>
										<span className="text-foreground/90">
											{fmtValue(hoveredGroup.value, unit)}
										</span>
										{showShareOfFirst && (
											<>
												<span className="px-1 text-muted-foreground/50">·</span>
												<span>{fmtPct(hoveredGroup.pctOfFirst)}</span>
											</>
										)}
									</>
								) : (
									<>
										<span className="text-foreground/90">{fmtValue(stage.value, unit)}</span>
										{showShareOfFirst && (
											<>
												<span className="px-1 text-muted-foreground/50">·</span>
												<span>{fmtPct(stage.pctOfFirst)}</span>
											</>
										)}
										{showStepConversion && stage.pctOfPrev != null && (
											<>
												<span className="px-1 text-muted-foreground/50">↓</span>
												<span>{fmtPct(stage.pctOfPrev)}</span>
											</>
										)}
									</>
								)}
							</span>
						</div>
						{/* Bar(s) */}
						{isGrouped ? (
							<div className="flex w-full flex-col gap-0.5" data-slot="funnel-group-bars">
								{stage.groups.map((group) => (
									<div
										key={group.name}
										className="relative h-1.5 w-full overflow-hidden rounded-[2px] bg-foreground/5"
										onPointerEnter={() => setHoverGroup(group.name)}
										onPointerLeave={() => setHoverGroup(null)}
										title={`${group.name} · ${fmtValue(group.value, unit)}`}
									>
										<div
											className="absolute inset-y-0 left-0 rounded-[2px]"
											style={{
												width: `${group.widthPct * 100}%`,
												backgroundColor: group.color,
												opacity:
													(hoverGroup !== null && hoverGroup !== group.name ? 0.35 : 1) *
													fade,
												transition: "opacity 140ms ease, width 220ms ease",
											}}
										/>
									</div>
								))}
							</div>
						) : (
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
						)}
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
