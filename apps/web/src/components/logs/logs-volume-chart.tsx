import { Result, useAtomValue } from "@/lib/effect-atom"
import { useCallback, useMemo, useRef, useState } from "react"
import { barY, defineChart, rect, stack } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	linearYDomain,
	niceLinearDomain,
	resolvePlotColor,
	usePlotChromeColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { ChartLoading } from "@maple/ui/components/charts"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"
import { getCustomChartTimeSeriesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { computeBucketSeconds } from "@/api/warehouse/timeseries-utils"
import { formatBucketLabel, formatNumber, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
import { formatForTinybird } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import type { LogsSearchParams } from "@/routes/logs"
import { SEVERITY_COLORS, SEVERITY_ORDER } from "@maple/ui/lib/severity"

/**
 * The volume strip is deliberately short — it is a scrubber above the log list,
 * not a chart in its own right. Declared once so the plot and its loading
 * stand-in reserve the same strip.
 */
const LOGS_VOLUME_CHART_HEIGHT = 120

/** More bars than the default 40-point target for a denser histogram. */
const HISTOGRAM_TARGET_POINTS = 150

/** One severity's slice of one bucket — `stack()` groups these on `z`. */
interface SeverityCell {
	row: Record<string, unknown>
	bucket: string
	severity: string
	value: number | null
}

/**
 * The stacked severity histogram, and the drag-to-zoom overlay over it.
 *
 * Its own component because the chart is assembled inside a `Result.builder`
 * callback, which is not a component body — hooks cannot live there, and this
 * needs several.
 */
function LogsVolumePlot({
	chartData,
	seriesKeys,
	rangeMs,
	dataBucketSeconds,
	selecting,
	selection,
	onBucketHover,
	onSelectStart,
	onSelectEnd,
	onSelectCancel,
	interactive,
}: {
	chartData: Array<Record<string, unknown>>
	seriesKeys: string[]
	rangeMs: number
	dataBucketSeconds: number | undefined
	selecting: boolean
	selection: { left: string; right: string } | null
	onBucketHover: (bucket: string | null) => void
	onSelectStart: () => void
	onSelectEnd: () => void
	onSelectCancel: () => void
	interactive: boolean
}) {
	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { theme } = useTheme()

	// Severity tokens resolved to literals — canvas cannot read `var()`.
	const colorOf = useMemo(() => {
		const resolved = new Map<string, string>()
		for (const key of seriesKeys) {
			const token = SEVERITY_COLORS[key.toUpperCase()] ?? "--muted-foreground"
			resolved.set(key, resolvePlotColor(token, "#71717a"))
		}
		return resolved
	}, [seriesKeys, theme])

	const axisContext = useMemo(
		() => ({ rangeMs, bucketSeconds: dataBucketSeconds }),
		[rangeMs, dataBucketSeconds],
	)

	/**
	 * The stack's extent, which is also the selection band's — a `rect` needs
	 * both edges, unlike Recharts' `ReferenceArea`.
	 */
	const yDomain = useMemo<[number, number]>(
		() => niceLinearDomain(linearYDomain({ rows: chartData, keys: seriesKeys, stacked: true })),
		[chartData, seriesKeys],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<SeverityCell>[]>(
		() =>
			seriesKeys.map((key) => ({
				label: key.toUpperCase(),
				color: colorOf.get(key) ?? chromeColors.border,
				// Read off the bucket ROW, so hovering one band still prints every
				// severity at that bucket.
				value: (cell: SeverityCell) => {
					const value = cell.row[key]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatNumber(value),
			})),
		[seriesKeys, colorOf, chromeColors.border],
	)

	const definition = useMemo(() => {
		const cells: SeverityCell[] = chartData.flatMap((row) =>
			seriesKeys.map((severity) => ({
				row,
				bucket: String(row.bucket),
				severity,
				value: typeof row[severity] === "number" ? (row[severity] as number) : null,
			})),
		)

		return defineChart({
			marks: [
				dashedGridY(),
				barY(cells, {
					x: (cell: SeverityCell) => cell.bucket,
					y: (cell: SeverityCell) => cell.value,
					z: (cell: SeverityCell) => cell.severity,
					fill: (cell: SeverityCell) => colorOf.get(cell.severity) ?? chromeColors.border,
					radius: 0,
					layout: stack({ order: [...seriesKeys] }),
				}),
				// The drag selection. Last, so it sits above the bars — the Recharts
				// original needed an explicit `zIndex={400}` for the same reason.
				// `decorative` keeps it from swallowing the pointer mid-drag.
				...(selection
					? [
							decorative(
								rect([selection], {
									x1: (s: { left: string; right: string }) => s.left,
									x2: (s: { left: string; right: string }) => s.right,
									y1: () => yDomain[0],
									y2: () => yDomain[1],
									fill: chromeColors.border,
									fillOpacity: 0.25,
									stroke: "none",
								}),
							),
						]
					: []),
			],
			x: {
				scale: scalePoint,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 4,
						format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
					},
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				scale: scaleLinear().domain(yDomain),
				axis: {
					line: false,
					ticks: { size: 0, padding: 4, format: (value: number) => formatNumber(value) },
				},
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 4, right: 0, left: 40 },
			focus: "group-x",
			focusRing: false,
			// Suppressed mid-drag: a tooltip following the pointer through a
			// selection is noise on top of the band being drawn.
			tooltip: selecting ? false : cursorTooltip(focusStore.anchor),
		})
	}, [chartData, seriesKeys, colorOf, chromeColors, yDomain, axisContext, selecting, focusStore])

	return (
		<div
			style={{ height: LOGS_VOLUME_CHART_HEIGHT }}
			className={`w-full select-none ${interactive ? "cursor-crosshair" : ""}`}
			onPointerDown={onSelectStart}
			onPointerUp={onSelectEnd}
			onPointerLeave={onSelectCancel}
		>
			<PlotFrame
				definition={definition}
				ariaLabel="Log volume by severity"
				className="h-full w-full"
				// The replacement for Recharts' `activeLabel`: edge-triggered on the
				// focused datum, which is exactly "which bucket is the pointer on".
				onFocusChange={(point) => onBucketHover(point?.datum.bucket ?? null)}
				renderTooltipBody={({ points }) => (
					<PlotTooltipBody
						points={points}
						series={tooltipSeries}
						focusStore={focusStore}
						heading={(cell: SeverityCell) =>
							formatBucketLabel(cell.bucket, axisContext, "tooltip")
						}
					/>
				)}
			/>
		</div>
	)
}

interface LogsVolumeChartProps {
	filters?: LogsSearchParams
	onTimeRangeSelect?: (range: { startTime: string; endTime: string }) => void
}

export function LogsVolumeChart({ filters, onTimeRangeSelect }: LogsVolumeChartProps) {
	// Injected here (not via the atom option) — the custom-chart family is
	// shared with dashboard widgets, which stay unscoped for now.
	const pinnedNamespace = useGlobalNamespace()
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		filters?.startTime,
		filters?.endTime,
		filters?.timePreset ?? "12h",
	)

	const bucketSeconds = useMemo(
		() => computeBucketSeconds(effectiveStartTime, effectiveEndTime, HISTOGRAM_TARGET_POINTS),
		[effectiveStartTime, effectiveEndTime],
	)

	const timeSeriesResult = useAtomValue(
		getCustomChartTimeSeriesResultAtom({
			data: {
				source: "logs",
				metric: "count",
				groupBy: "severity",
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				bucketSeconds,
				filters: {
					serviceNames: filters?.services ? [...filters.services] : undefined,
					severities: filters?.severities ? [...filters.severities] : undefined,
					environments: filters?.deploymentEnvs ? [...filters.deploymentEnvs] : undefined,
					namespaces:
						pinnedNamespace !== null
							? [pinnedNamespace]
							: filters?.namespaces
								? [...filters.namespaces]
								: undefined,
					excludedServiceNames: filters?.excludedServices
						? [...filters.excludedServices]
						: undefined,
					excludedSeverities: filters?.excludedSeverities
						? [...filters.excludedSeverities]
						: undefined,
					excludedEnvironments: filters?.excludedDeploymentEnvs
						? [...filters.excludedDeploymentEnvs]
						: undefined,
					excludedNamespaces:
						pinnedNamespace === null && filters?.excludedNamespaces
							? [...filters.excludedNamespaces]
							: undefined,
					traceId: filters?.traceId,
				},
			},
		}),
	)

	// Brush selection state (lifted out of onSuccess so hooks are unconditional)
	const [refAreaLeft, setRefAreaLeft] = useState<string | null>(null)
	const [refAreaRight, setRefAreaRight] = useState<string | null>(null)
	const [isSelecting, setIsSelecting] = useState(false)
	const bucketSecondsRef = useRef(300)

	/**
	 * The bucket under the pointer, published by `PlotFrame`'s `onFocusChange`.
	 *
	 * A ref, not state: focus changes on every bucket crossing, and only the drag
	 * handlers read it — putting it in state would re-render the chart on hover
	 * for nothing. It replaces Recharts' `activeLabel`, which arrived on the
	 * mouse event itself.
	 */
	const hoveredBucketRef = useRef<string | null>(null)

	const handleBucketHover = useCallback(
		(bucket: string | null) => {
			hoveredBucketRef.current = bucket
			// While dragging, every crossing extends the selection.
			if (bucket != null && isSelecting) setRefAreaRight(bucket)
		},
		[isSelecting],
	)

	const handleMouseDown = useCallback(() => {
		const bucket = hoveredBucketRef.current
		if (bucket != null && onTimeRangeSelect) {
			setRefAreaLeft(bucket)
			setRefAreaRight(null)
			setIsSelecting(true)
		}
	}, [onTimeRangeSelect])

	const handleMouseUp = useCallback(() => {
		if (!isSelecting || !refAreaLeft) {
			setIsSelecting(false)
			setRefAreaLeft(null)
			setRefAreaRight(null)
			return
		}

		setIsSelecting(false)

		const left = refAreaLeft
		const right = refAreaRight ?? refAreaLeft
		const leftMs = new Date(normalizeTimestampInput(left)).getTime()
		const rightMs = new Date(normalizeTimestampInput(right)).getTime()

		if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
			setRefAreaLeft(null)
			setRefAreaRight(null)
			return
		}

		const startMs = Math.min(leftMs, rightMs)
		const endMs = Math.max(leftMs, rightMs)

		// Don't zoom if user just clicked without dragging
		if (startMs === endMs) {
			setRefAreaLeft(null)
			setRefAreaRight(null)
			return
		}

		// Extend end by one bucket width so the rightmost selected bar is included
		const endWithBucket = endMs + bucketSecondsRef.current * 1000

		onTimeRangeSelect?.({
			startTime: formatForTinybird(new Date(startMs)),
			endTime: formatForTinybird(new Date(endWithBucket)),
		})

		setRefAreaLeft(null)
		setRefAreaRight(null)
	}, [isSelecting, refAreaLeft, refAreaRight, onTimeRangeSelect])

	const handleMouseLeave = useCallback(() => {
		if (isSelecting) {
			setIsSelecting(false)
			setRefAreaLeft(null)
			setRefAreaRight(null)
		}
	}, [isSelecting])

	return Result.builder(timeSeriesResult)
		.onInitial(() => <ChartLoading variant="bar" height={LOGS_VOLUME_CHART_HEIGHT} />)
		.onError(() => null)
		.onSuccess((response, result) => {
			const points = response.data
			if (points.length === 0) return null

			// Severity is grouped by the RAW `SeverityText`, and SDKs disagree on
			// its case — one org ships `INFO`, `Info` and `info` side by side. They
			// are one severity to the reader, so fold them into one series here.
			// Leaving them apart produced three tooltip rows all labelled "INFO",
			// and three identical React keys: on every hover re-render React then
			// leaked the stale rows instead of replacing them, and the tooltip grew
			// a row per bucket crossed.
			const seriesKeysSet = new Set<string>()
			for (const point of points) {
				for (const key of Object.keys(point.series)) {
					seriesKeysSet.add(key.toUpperCase())
				}
			}

			const seriesKeys = SEVERITY_ORDER.filter((s) => seriesKeysSet.has(s))
			const seriesKeysAdded = new Set(seriesKeys)
			for (const key of seriesKeysSet) {
				if (!seriesKeysAdded.has(key)) {
					seriesKeys.push(key)
					seriesKeysAdded.add(key)
				}
			}

			const chartData = points.map((point) => {
				const bySeverity = new Map<string, number>()
				for (const [key, value] of Object.entries(point.series)) {
					if (typeof value !== "number") continue
					const canonical = key.toUpperCase()
					bySeverity.set(canonical, (bySeverity.get(canonical) ?? 0) + value)
				}
				return { bucket: point.bucket, ...Object.fromEntries(bySeverity) }
			})

			const totalCount = points.reduce((sum, point) => {
				return (
					sum +
					Object.values(point.series).reduce<number>(
						(s, v) => s + (typeof v === "number" ? v : 0),
						0,
					)
				)
			}, 0)

			const rangeMs = inferRangeMs(chartData)
			const dataBucketSeconds = inferBucketSeconds(chartData)
			bucketSecondsRef.current = dataBucketSeconds ?? 300

			return (
				<div className={`transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
					<div className="mb-1 flex items-baseline gap-2">
						<span className="text-sm font-medium">{formatNumber(totalCount)} logs</span>
						<span className="text-xs text-muted-foreground">in selected range</span>
					</div>
					<LogsVolumePlot
						chartData={chartData}
						seriesKeys={seriesKeys}
						rangeMs={rangeMs}
						dataBucketSeconds={dataBucketSeconds}
						selecting={isSelecting}
						selection={
							refAreaLeft && refAreaRight ? { left: refAreaLeft, right: refAreaRight } : null
						}
						onBucketHover={handleBucketHover}
						onSelectStart={handleMouseDown}
						onSelectEnd={handleMouseUp}
						onSelectCancel={handleMouseLeave}
						interactive={onTimeRangeSelect != null}
					/>
				</div>
			)
		})
		.render()
}
