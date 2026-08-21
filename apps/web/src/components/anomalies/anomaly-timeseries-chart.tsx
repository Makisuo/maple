import * as React from "react"
import { areaY, d3Curve, defineChart, lineY, rect } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { curveMonotoneX } from "d3-shape"
import type { AnomalyIncidentDocument, AnomalyIncidentTimeseriesResponse } from "@maple/domain/http"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	resolvePlotColor,
	thresholdRules,
	useChartId,
	usePlotChromeColors,
	verticalGradient,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { formatSignalValue } from "./anomaly-format"

/** Tokens plus the literal each falls back to — canvas cannot read `var()`. */
const SEVERITY_STROKE = {
	critical: ["--destructive", "#ef4444"],
	warning: ["--chart-4", "#fbbf24"],
} satisfies Record<"critical" | "warning", readonly [string, string]>

/** One bucket of the observed signal. */
interface SignalPoint {
	bucket: string
	value: number
}

export function AnomalyTimeseriesChart({
	incident,
	timeseries,
	className,
}: {
	incident: AnomalyIncidentDocument
	timeseries: AnomalyIncidentTimeseriesResponse
	className?: string
}) {
	const { signalType, baselineMedian, thresholdValue } = timeseries
	const { theme } = useTheme()
	// `theme` is in the deps but not in the body on purpose: `resolvePlotColor`
	// reads computed style, so the colour has to be re-resolved when the theme
	// flips even though nothing here references it.
	const stroke = React.useMemo(() => {
		const [token, fallback] = SEVERITY_STROKE[incident.severity]
		return resolvePlotColor(token, fallback)
	}, [incident.severity, theme])
	const chromeColors = usePlotChromeColors()
	const gradientId = useChartId("anomaly-observed")
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])

	const data = React.useMemo<SignalPoint[]>(
		() =>
			[...timeseries.buckets]
				.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket))
				.map((b) => ({ bucket: b.bucket, value: b.value })),
		[timeseries.buckets],
	)

	const axisContext = React.useMemo(() => {
		if (data.length < 2) return { rangeMs: 0, bucketSeconds: timeseries.bucketSeconds }
		const first = Date.parse(data[0]!.bucket)
		const last = Date.parse(data[data.length - 1]!.bucket)
		return { rangeMs: last - first, bucketSeconds: timeseries.bucketSeconds }
	}, [data, timeseries.bucketSeconds])

	// Snap the incident window to actual bucket values so the category axis
	// can place the shading.
	const window = React.useMemo(() => {
		if (data.length === 0) return null
		const startMs = Date.parse(incident.firstTriggeredAt)
		const endMs = incident.resolvedAt !== null ? Date.parse(incident.resolvedAt) : Infinity
		let x1: string | null = null
		let x2: string | null = null
		for (const point of data) {
			const t = Date.parse(point.bucket)
			if (t >= startMs && x1 === null) x1 = point.bucket
			if (t <= endMs) x2 = point.bucket
		}
		// Window starts after the last bucket (fresh incident): pin to the edge.
		if (x1 === null) x1 = data[data.length - 1]!.bucket
		if (x2 === null || Date.parse(x2) < Date.parse(x1)) x2 = x1
		return { x1, x2 }
	}, [data, incident.firstTriggeredAt, incident.resolvedAt])

	// Pad the y-domain so both reference lines stay visible. Also the band's
	// vertical extent: a `rect` needs both edges, unlike `ReferenceArea`.
	const yDomain = React.useMemo<[number, number]>(() => {
		let maxVal = Math.max(thresholdValue, baselineMedian)
		for (const point of data) maxVal = Math.max(maxVal, point.value)
		return [0, maxVal * 1.15]
	}, [data, thresholdValue, baselineMedian])

	const valueFormatter = React.useCallback(
		(value: number) => formatSignalValue(signalType, Number.isFinite(value) ? value : 0),
		[signalType],
	)

	const tooltipSeries = React.useMemo<PlotTooltipSeries<SignalPoint>[]>(
		() => [
			{
				label: "Observed",
				color: stroke,
				value: (point: SignalPoint) => point.value,
				format: valueFormatter,
			},
		],
		[stroke, valueFormatter],
	)

	const definition = React.useMemo(() => {
		const at = (point: SignalPoint) => point.bucket
		const value = (point: SignalPoint) => point.value

		return defineChart({
			gradients: [verticalGradient(gradientId, stroke, 0.3, 0.03)],
			marks: [
				dashedGridY(),
				// The incident window. `decorative` so the shading never takes the
				// pointer away from the series underneath it.
				...(window
					? [
							decorative(
								rect([window], {
									x1: (w: { x1: string; x2: string }) => w.x1,
									x2: (w: { x1: string; x2: string }) => w.x2,
									y1: () => yDomain[0],
									y2: () => yDomain[1],
									fill: stroke,
									fillOpacity: 0.06,
									stroke: "none",
								}),
							),
						]
					: []),
				// Baseline and threshold, as labelled rules. `labelX` anchors both at
				// the last bucket, which is where `insideTopRight` put them.
				...thresholdRules(
					[
						{
							value: baselineMedian,
							color: "--muted-foreground",
							label: "Baseline",
						},
						{ value: thresholdValue, color: "--destructive", label: "Threshold" },
					],
					{ labelX: data.at(-1)?.bucket },
				),
				areaY(data, {
					x: at,
					y: value,
					y1: () => yDomain[0],
					fill: `url(#${gradientId})`,
					stroke: "none",
					curve: d3Curve(curveMonotoneX),
				}),
				lineY(data, {
					x: at,
					y: value,
					stroke,
					strokeWidth: 2,
					curve: d3Curve(curveMonotoneX),
				}),
				focusDot(data, at, value, stroke, chromeColors),
				focusCrosshair(chromeColors),
			],
			x: {
				scale: scalePoint,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (v: string) => formatBucketLabel(v, axisContext, "tick"),
					},
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				scale: scaleLinear().domain(yDomain),
				axis: { line: false, ticks: { size: 0, padding: 8, format: valueFormatter } },
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 8, right: 8, left: 70 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [
		data,
		window,
		yDomain,
		stroke,
		chromeColors,
		gradientId,
		baselineMedian,
		thresholdValue,
		axisContext,
		valueFormatter,
		focusStore,
	])

	if (data.length === 0) {
		return (
			<div
				className={cn(
					"flex h-64 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground",
					className,
				)}
			>
				No signal data in window
			</div>
		)
	}

	return (
		<div className={cn("space-y-2", className)}>
			<PlotFrame
				definition={definition}
				ariaLabel="Observed signal"
				className="h-64 w-full"
				renderTooltipBody={({ points }) => (
					<PlotTooltipBody
						points={points}
						series={tooltipSeries}
						focusStore={focusStore}
						heading={(point: SignalPoint) =>
							formatBucketLabel(point.bucket, axisContext, "tooltip")
						}
					/>
				)}
			/>
			<div className="flex items-center gap-4 text-[11px] text-muted-foreground">
				<span className="flex items-center gap-1.5">
					<span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: stroke }} />
					Observed
				</span>
				<span className="flex items-center gap-1.5">
					<span className="h-px w-4 border-t border-dashed border-muted-foreground" />
					Baseline median {formatSignalValue(signalType, baselineMedian)}
				</span>
				<span className="flex items-center gap-1.5">
					<span className="h-px w-4 border-t border-dashed border-destructive" />
					Threshold {formatSignalValue(signalType, thresholdValue)}
				</span>
			</div>
		</div>
	)
}
