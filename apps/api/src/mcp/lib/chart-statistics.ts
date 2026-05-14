import type { BreakdownItem, TimeseriesPoint } from "@maple/domain"

export type ChartFlag =
	| "EMPTY"
	| "ALL_NULLS"
	| "ALL_ZEROS"
	| "SINGLE_POINT"
	| "FLAT_LINE"
	| "SUSPICIOUS_GAP"
	| "NEGATIVE_VALUES"
	| "UNREALISTIC_MAGNITUDE"
	| "SINGLE_SERIES_DOMINATES"
	| "CARDINALITY_EXPLOSION"
	| "UNIT_MISMATCH"
	| "BROKEN_BREAKDOWN"
	| "BUILDER_WARNINGS"

export type ChartVerdict = "looks_healthy" | "suspicious" | "broken"

const BROKEN_FLAGS: ReadonlySet<ChartFlag> = new Set<ChartFlag>([
	"EMPTY",
	"ALL_NULLS",
	"BROKEN_BREAKDOWN",
	"UNIT_MISMATCH",
])

const SAMPLE_HEAD = 3
const SAMPLE_TAIL = 3

export interface SeriesSample {
	bucket?: string
	value: number | null
}

export interface SeriesStat {
	name: string
	min: number | null
	max: number | null
	avg: number | null
	validCount: number
	nullCount: number
	zeroCount: number
	negativeCount: number
	samples: SeriesSample[]
}

export interface QueryStats {
	rowCount: number
	seriesCount: number
	firstBucket?: string
	lastBucket?: string
	seriesStats: SeriesStat[]
}

export function computeTimeseriesStats(points: ReadonlyArray<TimeseriesPoint>): QueryStats {
	if (points.length === 0) {
		return { rowCount: 0, seriesCount: 0, seriesStats: [] }
	}

	const seriesNames = new Set<string>()
	for (const point of points) {
		for (const name of Object.keys(point.series)) {
			seriesNames.add(name)
		}
	}

	const seriesStats: SeriesStat[] = []
	for (const name of seriesNames) {
		let min: number | null = null
		let max: number | null = null
		let sum = 0
		let validCount = 0
		let nullCount = 0
		let zeroCount = 0
		let negativeCount = 0
		const samples: SeriesSample[] = []

		points.forEach((point, idx) => {
			const includeAsSample = idx < SAMPLE_HEAD || idx >= points.length - SAMPLE_TAIL
			const value = point.series[name]
			if (value === undefined || value === null || Number.isNaN(value)) {
				nullCount++
				if (includeAsSample) samples.push({ bucket: point.bucket, value: null })
				return
			}
			validCount++
			sum += value
			if (value === 0) zeroCount++
			if (value < 0) negativeCount++
			if (min === null || value < min) min = value
			if (max === null || value > max) max = value
			if (includeAsSample) samples.push({ bucket: point.bucket, value })
		})

		seriesStats.push({
			name,
			min,
			max,
			avg: validCount > 0 ? sum / validCount : null,
			validCount,
			nullCount,
			zeroCount,
			negativeCount,
			samples,
		})
	}

	return {
		rowCount: points.length,
		seriesCount: seriesStats.length,
		firstBucket: points[0]?.bucket,
		lastBucket: points[points.length - 1]?.bucket,
		seriesStats,
	}
}

export function computeBreakdownStats(rows: ReadonlyArray<BreakdownItem>): QueryStats {
	if (rows.length === 0) {
		return { rowCount: 0, seriesCount: 0, seriesStats: [] }
	}

	let min: number | null = null
	let max: number | null = null
	let sum = 0
	let validCount = 0
	let nullCount = 0
	let zeroCount = 0
	let negativeCount = 0

	for (const row of rows) {
		const value = row.value
		if (value === undefined || value === null || Number.isNaN(value)) {
			nullCount++
			continue
		}
		validCount++
		sum += value
		if (value === 0) zeroCount++
		if (value < 0) negativeCount++
		if (min === null || value < min) min = value
		if (max === null || value > max) max = value
	}

	const sortedDesc = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
	const samples: SeriesSample[] = []
	const headLimit = Math.min(SAMPLE_HEAD, sortedDesc.length)
	for (let i = 0; i < headLimit; i++) {
		samples.push({ bucket: sortedDesc[i].name, value: sortedDesc[i].value })
	}
	if (sortedDesc.length > SAMPLE_HEAD + SAMPLE_TAIL) {
		for (let i = sortedDesc.length - SAMPLE_TAIL; i < sortedDesc.length; i++) {
			samples.push({ bucket: sortedDesc[i].name, value: sortedDesc[i].value })
		}
	}

	return {
		rowCount: rows.length,
		seriesCount: 1,
		seriesStats: [
			{
				name: "values",
				min,
				max,
				avg: validCount > 0 ? sum / validCount : null,
				validCount,
				nullCount,
				zeroCount,
				negativeCount,
				samples,
			},
		],
	}
}

export interface FlagContext {
	metric?: string
	source?: "traces" | "logs" | "metrics"
	kind?: "timeseries" | "breakdown"
	displayUnit?: string
	/** Pre-existing flags (e.g. BROKEN_BREAKDOWN detected before stats). */
	preFlags?: readonly ChartFlag[]
}

type MetricClass = "duration" | "percent" | "count" | "unknown"
type UnitClass = "duration" | "percent" | "count" | "unknown"

const DURATION_METRICS = new Set(["avg_duration", "p50_duration", "p95_duration", "p99_duration"])
const PERCENT_METRICS = new Set(["error_rate"])
const COUNT_METRICS = new Set(["count"])

const DURATION_UNIT_PATTERN =
	/^(ms|millisecond|milliseconds|sec|secs|second|seconds|us|microsecond|microseconds|ns|nanosecond|nanoseconds|duration|duration_ms|duration_seconds|latency|time)$/i
const PERCENT_UNIT_PATTERN = /^(%|pct|percent|percentage|ratio|fraction)$/i
const COUNT_UNIT_PATTERN = /^(count|requests|events|operations|ops|number|n|total|errors|spans|logs|hits)$/i

function classifyMetric(metric?: string): MetricClass {
	if (!metric) return "unknown"
	if (DURATION_METRICS.has(metric)) return "duration"
	if (PERCENT_METRICS.has(metric)) return "percent"
	if (COUNT_METRICS.has(metric)) return "count"
	return "unknown"
}

function classifyUnit(unit?: string): UnitClass {
	if (!unit) return "unknown"
	const trimmed = unit.trim()
	if (!trimmed) return "unknown"
	if (DURATION_UNIT_PATTERN.test(trimmed)) return "duration"
	if (PERCENT_UNIT_PATTERN.test(trimmed)) return "percent"
	if (COUNT_UNIT_PATTERN.test(trimmed)) return "count"
	return "unknown"
}

export function computeFlags(stats: QueryStats, ctx: FlagContext = {}): ChartFlag[] {
	const flags: ChartFlag[] = [...(ctx.preFlags ?? [])]

	if (stats.rowCount === 0) {
		if (!flags.includes("EMPTY")) flags.push("EMPTY")
		return flags
	}

	let totalValid = 0
	let totalNull = 0
	let totalZero = 0
	let totalNegative = 0
	const seriesTotals: Array<{ name: string; total: number }> = []

	for (const series of stats.seriesStats) {
		totalValid += series.validCount
		totalNull += series.nullCount
		totalZero += series.zeroCount
		totalNegative += series.negativeCount
		const total = series.avg !== null ? series.avg * series.validCount : 0
		seriesTotals.push({ name: series.name, total })
	}

	if (totalValid === 0) {
		if (!flags.includes("ALL_NULLS")) flags.push("ALL_NULLS")
		return flags
	}

	if (stats.rowCount === 1 && !flags.includes("SINGLE_POINT")) {
		flags.push("SINGLE_POINT")
	}

	const allZeros = totalValid > 0 && totalZero === totalValid
	if (allZeros && !flags.includes("ALL_ZEROS")) {
		flags.push("ALL_ZEROS")
	}

	if (!allZeros && stats.rowCount > 1 && stats.seriesStats.length > 0) {
		const allFlat = stats.seriesStats.every(
			(s) => s.min !== null && s.max !== null && s.min === s.max && s.validCount > 1,
		)
		if (allFlat && !flags.includes("FLAT_LINE")) flags.push("FLAT_LINE")
	}

	const expected = stats.rowCount * Math.max(stats.seriesCount, 1)
	if (expected > 0 && totalNull / expected > 0.3 && !flags.includes("SUSPICIOUS_GAP")) {
		flags.push("SUSPICIOUS_GAP")
	}

	const metricClass = classifyMetric(ctx.metric)
	if (
		totalNegative > 0 &&
		(metricClass === "count" || metricClass === "percent" || metricClass === "duration") &&
		!flags.includes("NEGATIVE_VALUES")
	) {
		flags.push("NEGATIVE_VALUES")
	}

	let unrealistic = false
	if (metricClass === "percent") {
		for (const series of stats.seriesStats) {
			if (series.max !== null && series.max > 1.0) {
				unrealistic = true
				break
			}
		}
	}
	if (!unrealistic && metricClass === "duration") {
		for (const series of stats.seriesStats) {
			if (series.min !== null && series.min < 0) {
				unrealistic = true
				break
			}
		}
	}
	if (unrealistic && !flags.includes("UNREALISTIC_MAGNITUDE")) {
		flags.push("UNREALISTIC_MAGNITUDE")
	}

	if (seriesTotals.length >= 2) {
		const grandTotal = seriesTotals.reduce((acc, s) => acc + Math.abs(s.total), 0)
		if (grandTotal > 0) {
			const top = seriesTotals.reduce((max, s) => (Math.abs(s.total) > Math.abs(max.total) ? s : max))
			if (Math.abs(top.total) / grandTotal > 0.99 && !flags.includes("SINGLE_SERIES_DOMINATES")) {
				flags.push("SINGLE_SERIES_DOMINATES")
			}
		}
	}

	if (stats.seriesCount > 50 && !flags.includes("CARDINALITY_EXPLOSION")) {
		flags.push("CARDINALITY_EXPLOSION")
	}

	const unitClass = classifyUnit(ctx.displayUnit)
	if (
		unitClass !== "unknown" &&
		metricClass !== "unknown" &&
		unitClass !== metricClass &&
		!flags.includes("UNIT_MISMATCH")
	) {
		flags.push("UNIT_MISMATCH")
	}

	return flags
}

export function verdictFromFlags(flags: readonly ChartFlag[]): ChartVerdict {
	if (flags.length === 0) return "looks_healthy"
	for (const flag of flags) {
		if (BROKEN_FLAGS.has(flag)) return "broken"
	}
	return "suspicious"
}
