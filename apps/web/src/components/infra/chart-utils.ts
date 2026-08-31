// Shared helpers for the infra detail charts (host + k8s). The two chart files
// keep their own <ChartView> (different units, container chrome, heights) but
// share the row→series transform, grid/empty conventions, and the unit-aware
// value formatting used by tooltips, legend chips, and axes. Series colors come
// from `resolveSeriesColors` — a host/pod/zone keeps its color across windows.

import {
	formatBytes,
	formatBytesPerSecond,
	formatLatency,
	formatLoad,
	formatPercent,
	formatThroughput,
} from "@maple/ui/lib/format"

/**
 * Bucket width for the timeseries charts: aim for ~100 points, floored at the
 * poller's 5-minute granularity and rounded to whole 5-minute steps.
 */
export function chartBucketSeconds(startTime: string, endTime: string): number {
	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const windowSeconds = Math.max((endMs - startMs) / 1000, 300)
	return Math.max(300, Math.ceil(windowSeconds / 100 / 300) * 300)
}

/** Every value unit an infra chart can carry. Drives unit-aware formatting. */
export type ChartUnit =
	| "percent"
	| "cores"
	| "seconds"
	| "load"
	| "bytes_per_second"
	| "bytes"
	// Service-side units, so a span metric can share a strip stack with a
	// kubeletstats gauge. `seconds` cannot stand in for latency: it rounds to
	// whole seconds and renders anything at or below zero as an em dash.
	| "milliseconds"
	| "rate"

/** Compact, human duration ("45s", "12m", "3h 20m", "2d 4h"). */
export function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "—"
	if (seconds < 60) return `${Math.round(seconds)}s`
	const m = Math.floor(seconds / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

/**
 * Format a value WITH its unit so a tooltip/legend reads "9.5%", "0.067 cores",
 * "12 MB/s" — never a bare, ambiguous number. This is the single place that
 * decides how each unit renders.
 */
export function formatValueWithUnit(value: number, unit: ChartUnit): string {
	if (!Number.isFinite(value)) return "—"
	switch (unit) {
		case "percent":
			return formatPercent(value)
		case "cores":
			return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} cores`
		case "seconds":
			return formatSeconds(value)
		case "load":
			return formatLoad(value)
		case "bytes_per_second":
			return formatBytesPerSecond(value)
		case "bytes":
			return formatBytes(value)
		case "milliseconds":
			return formatLatency(value)
		case "rate":
			return formatThroughput(value, "/s")
	}
}

/** Shown when a series query returns no points for the selected window. */
export const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

/**
 * Series key for a gauge with no group-by attribute (a single line). Charts
 * swap this placeholder for the metric's human `seriesLabel` in legends and
 * tooltips so it never surfaces as a bare "value".
 */
export const UNNAMED_SERIES_KEY = "value"

export interface TransformedPoint extends Record<string, string | number> {
	bucket: string
	time: string
}

/** Axis label for a bucket timestamp ("14:35"). */
export function isoToLabel(iso: string): string {
	const d = new Date(iso)
	return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

/** Compact time-of-day for a dated label: "3pm", or "3:35pm" off the hour. */
function compactTimeOfDay(d: Date): string {
	const hours24 = d.getHours()
	const minutes = d.getMinutes()
	const hour = hours24 % 12 === 0 ? 12 : hours24 % 12
	const suffix = hours24 < 12 ? "am" : "pm"
	return minutes === 0 ? `${hour}${suffix}` : `${hour}:${String(minutes).padStart(2, "0")}${suffix}`
}

/**
 * Window-aware axis labeler: plain time-of-day while the plotted buckets span
 * a single day, "Jul 3, 2pm" once they cross 24h — the multi-day presets
 * (4d/10d/6w/…) make bare times ambiguous. The time is compact there because
 * the date already takes the width; multi-day buckets land on the hour, so
 * the minutes only appear when they carry information.
 */
export function makeBucketLabeler(bucketIsos: ReadonlyArray<string>): (iso: string) => string {
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY
	for (const iso of bucketIsos) {
		const ms = new Date(iso).getTime()
		if (Number.isFinite(ms)) {
			min = Math.min(min, ms)
			max = Math.max(max, ms)
		}
	}
	if (max - min <= 24 * 60 * 60 * 1000) return isoToLabel
	return (iso) => {
		const d = new Date(iso)
		return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${compactTimeOfDay(d)}`
	}
}

/** Pivot long-form `{bucket, attributeValue, value}` rows into per-bucket points keyed by series. */
export function transformRows(
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>,
	labeler: (iso: string) => string = isoToLabel,
): { data: TransformedPoint[]; series: string[] } {
	const seriesSet = new Set<string>()
	const byBucket = new Map<string, TransformedPoint>()
	for (const row of rows) {
		const series = row.attributeValue || UNNAMED_SERIES_KEY
		seriesSet.add(series)
		const existing: TransformedPoint = byBucket.get(row.bucket) ?? {
			bucket: row.bucket,
			time: labeler(row.bucket),
		}
		existing[series] = row.value
		byBucket.set(row.bucket, existing)
	}
	const data = Array.from(byBucket.values()).toSorted((a, b) =>
		String(a.bucket).localeCompare(String(b.bucket)),
	)
	return { data, series: [...seriesSet] }
}
